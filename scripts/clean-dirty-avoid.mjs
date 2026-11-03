/**
 * 一次性清理：把「幽灵忌口」软删除。
 *
 * 背景（2026-11-03）：V1.5 的 `NO_SPICY_PATTERN` 末尾有个裸 `不辣`，把
 * 「这些也不辣」这类**对上一轮推荐的不满**抽成了 `avoid='不吃辣'`，
 * 记进长期记忆后反过来把辣款全过滤掉——用户越抱怨越吃不到。
 * 代码侧已经修了（提交 `a0e3aa0`），但**已经写进库的脏记录不会自己消失**：
 * 侧栏照样挂着「忌口·不吃辣」，硬过滤照样拦。
 *
 * 判定口径（只认铁证，宁可少删）：
 *   1. 只看 `category='过敏忌口'` 且 `status='active'` 的记录。
 *   2. content 命中**已知过敏原** → 永远保留（花生/坚果/海鲜/乳制品/鸡蛋/小麦/大豆/芒果）。
 *      真实过敏是安全问题，误删会让人吃到过敏原，这条没有任何例外。
 *   3. content 是**口味**（辣/酸/甜/苦/咸）却挂在「过敏忌口」下 → 幽灵：
 *      人不"过敏"于辣。默认只清游客与测试号；正式账号是真人注册的，
 *      确实可能亲口说过"我不吃辣"，要 `--include-accounts` 才动。
 *   4. 其余归不了类的，只报告、不动手。
 *   5. 删除一律**软删除**（`status='deleted'`），原文留痕可追溯；
 *      `--apply` 前先把命中的完整记录导出到 `data/dirty-avoid-<时间>.json`。
 *
 * 为什么不用 `source` 判：`source` 只存「对话提取」/「冲突确认」，
 * 库里没有原始用户消息，没法回溯"这句话到底是不是用户说的"。所以只认
 * "分类与内容对不上"这种结构证据，不猜。
 *
 * 用法：
 *   node scripts/clean-dirty-avoid.mjs                    # 试运行，只报告
 *   node scripts/clean-dirty-avoid.mjs --apply            # 真删（软删除）
 *   node scripts/clean-dirty-avoid.mjs --include-accounts # 连正式账号一起清
 *   node scripts/clean-dirty-avoid.mjs --user=u_abc123    # 只看一个用户
 *   node scripts/clean-dirty-avoid.mjs --apply --json     # 额外输出机器可读清单
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/* ── 环境变量兜底：Prisma Client 不读 .env，脚本直接连库必须先补上 ── */
function ensureDatabaseUrl() {
  if (process.env.DATABASE_URL) return;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
      if (m) {
        process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '');
        return;
      }
    }
  } catch {
    // 没有 .env 就交给 Prisma 自己报错，它的提示更准
  }
}
ensureDatabaseUrl();

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeAccounts = args.includes('--include-accounts');
const asJson = args.includes('--json');
const userArg = args.find((a) => a.startsWith('--user='));
const onlyUser = userArg ? userArg.split('=')[1] : null;

const prisma = new PrismaClient();
const DATA_DIR = path.join(process.cwd(), 'data');

/** 过敏原白名单：命中即保留，任何情况下都不动 */
const ALLERGENS = [
  '花生',
  '坚果',
  '海鲜',
  '海产品',
  '虾',
  '蟹',
  '贝',
  '乳制品',
  '牛奶',
  '奶',
  '鸡蛋',
  '蛋',
  '小麦',
  '麸质',
  '大豆',
  '芒果',
  '过敏',
];

/** 口味词：挂在「过敏忌口」分类下就是误抽 */
const TASTES = ['辣', '酸', '甜', '苦', '咸', '清淡'];

/** 脚本/联调造的号：这些用户身上的忌口一律视为污染 */
const TEST_USER = /^(smoke_|probe_|u_probe|test_)/i;

const hitAllergen = (s) => ALLERGENS.some((a) => s.includes(a));
const hitTaste = (s) => TASTES.filter((t) => s.includes(t));

/** 掩码：日志里不打印完整 id，但保留可核对的前缀 */
const mask = (id) => (id.length <= 12 ? id : `${id.slice(0, 12)}…`);

async function main() {
  const users = await prisma.user.findMany({
    where: onlyUser ? { id: onlyUser } : {},
    select: {
      id: true,
      email: true,
      isGuest: true,
      memories: {
        select: {
          id: true,
          layer: true,
          keyword: true,
          content: true,
          category: true,
          polarity: true,
          status: true,
          source: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'asc' },
      },
    },
  });

  if (!users.length) {
    console.log(onlyUser ? `没有这个用户：${onlyUser}` : '库里一个用户都没有，没什么可清');
    return;
  }

  const totalMem = users.reduce((n, u) => n + u.memories.length, 0);
  const avoidRows = [];
  for (const u of users) {
    for (const m of u.memories) {
      if (m.category !== '过敏忌口') continue;
      avoidRows.push({
        user: u,
        mem: m,
        text: `${m.keyword} ${m.content}`,
      });
    }
  }

  const toDelete = [];
  const skippedAccount = [];
  const keptReal = [];
  const unknown = [];

  for (const r of avoidRows) {
    if (r.mem.status !== 'active') continue; // pending / deleted / superseded 不动

    if (hitAllergen(r.text)) {
      keptReal.push(r);
      continue;
    }

    const tastes = hitTaste(r.text);
    if (!tastes.length) {
      unknown.push(r);
      continue;
    }

    const isTest = TEST_USER.test(r.user.id);
    const isGuest = r.user.isGuest;
    if (isTest || isGuest || includeAccounts) {
      toDelete.push({ ...r, tastes, why: isTest ? '测试残留' : isGuest ? '游客' : '正式账号(显式指定)' });
    } else {
      skippedAccount.push({ ...r, tastes });
    }
  }

  // ── 报告 ──────────────────────────────────────────────
  console.log(
    `扫描 ${users.length} 个用户 / ${totalMem} 条记忆；其中「过敏忌口」${avoidRows.length} 条（active ${
      avoidRows.filter((r) => r.mem.status === 'active').length
    } 条）`,
  );

  const dump = (list, title, note) => {
    if (!list.length) return;
    console.log(`\n${title}（${list.length} 条）${note ? ` — ${note}` : ''}`);
    for (const r of list) {
      const who = `${r.user.isGuest ? '游客' : '账号'} ${mask(r.user.id)}`;
      const tag = r.tastes ? ` [口味:${r.tastes.join('/')}]` : '';
      const why = r.why ? ` 【${r.why}】` : '';
      console.log(
        `  · ${who}${tag}${why}  ${r.mem.status}/${r.mem.layer}  ${r.mem.content}  (${r.mem.source || '无来源'}, ${r.mem.createdAt
          .toISOString()
          .slice(0, 10)})`,
      );
    }
  };

  dump(toDelete, '将软删除', 'status → deleted');
  dump(skippedAccount, '仅报告不删', '正式账号，确认要清请加 --include-accounts');
  dump(unknown, '归不了类，保留', '既不沾过敏原也不沾口味，需要人看');

  // 小计也打出来：0 条同样要显示，否则"没删"和"没扫到"在日志里长得一样
  console.log(
    `\n分组小计：将删 ${toDelete.length} / 仅报告 ${skippedAccount.length} / 归不了类 ${unknown.length} / 真过敏原保留 ${keptReal.length}`,
  );

  if (!toDelete.length) {
    console.log('\n没有需要清理的记录。');
    return;
  }

  if (!apply) {
    console.log(
      `\n试运行：以上 ${toDelete.length} 条**未改动**。确认无误后加 --apply 执行（软删除，可回滚）。`,
    );
    return;
  }

  // ── 归档 → 软删除 ─────────────────────────────────────
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '-').slice(0, 19);
  const archive = path.join(DATA_DIR, `dirty-avoid-${stamp}.json`);
  fs.writeFileSync(
    archive,
    JSON.stringify(
      toDelete.map((r) => ({
        id: r.mem.id,
        userId: r.user.id,
        isGuest: r.user.isGuest,
        layer: r.mem.layer,
        keyword: r.mem.keyword,
        content: r.mem.content,
        category: r.mem.category,
        polarity: r.mem.polarity,
        status: r.mem.status,
        source: r.mem.source,
        createdAt: r.mem.createdAt,
        why: r.why,
      })),
      null,
      2,
    ),
    'utf8',
  );

  const ids = toDelete.map((r) => r.mem.id);
  const hit = await prisma.memory.updateMany({
    where: { id: { in: ids }, status: 'active' },
    data: { status: 'deleted' },
  });

  console.log(`\n已软删除 ${hit.count} 条，归档：${path.relative(process.cwd(), archive)}`);
  console.log(`回滚：把这些 id 的 status 改回 active ——`);
  console.log(`  ${JSON.stringify(ids)}`);

  if (asJson) {
    console.log(JSON.stringify({ deleted: ids, archive }, null, 2));
  }
}

main()
  .catch((e) => {
    console.error('清理失败：', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
