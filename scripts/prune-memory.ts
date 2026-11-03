/**
 * 清理长期记忆，防止库无限膨胀。
 *
 * V1.0 时这段逻辑是"把 N 天没动的用户整份从 `data/memory.json` 挪进归档文件"——
 * JSON 每次读写都要整份进内存，一万个用户就能把文件撑到几十 MB。
 * V2.0 换成 SQLite 之后膨胀不再是性能问题，但**脏数据仍然要清**：
 * smoke 测试用户、一次性游客、跑联调留下的探针账号，留久了只会让库和统计失真。
 *
 * 规则（与 V1 保持兼容）：
 *   - 默认只看**游客**（`isGuest=true`）：正式账号是真人注册的，不该被自动清掉；
 *     要一起清就显式加 `--include-accounts`。
 *   - "未活跃"按**记忆最后更新时间**判断（没有记忆就看用户创建时间）。
 *     不能用 `User.updatedAt`——写记忆时只在缺失时插入用户行，不会更新它。
 *   - 归档优先：真的清之前先把原文写进 `data/memory-archive-<日期>.json`，
 *     结构与旧 memory.json 一致（`uid → 记忆数组`），需要时能人工捞回来。
 *   - 物理删除只发生在游客身上；正式账号即使被 `--include-accounts` 选中，
 *     也**只清记忆、保留账号**（用户还能登录，只是不再记得偏好）。
 *
 * 用法：
 *   node --import ./scripts/ts-alias-register.mjs scripts/prune-memory.ts            # 试运行
 *   ... --apply                                                                     # 真的清
 *   ... --days=30                                                                   # 改成"30 天未活跃"
 *   ... --include-accounts                                                          # 连正式账号的记忆一起清
 *   ... --smoke-only                                                                # 只清 smoke_ 前缀的测试用户
 */
import fs from 'node:fs';
import path from 'node:path';

import { prisma } from '@/lib/db';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const includeAccounts = args.includes('--include-accounts');
const smokeOnly = args.includes('--smoke-only');
const daysArg = args.find((a) => a.startsWith('--days='));
const days = Number(daysArg ? daysArg.split('=')[1] : 7);

if (!Number.isFinite(days) || days <= 0) {
  console.log('--days 得是个正数，比如 --days=30');
  process.exit(1);
}

const DATA_DIR = path.join(process.cwd(), 'data');

async function main() {
  const deadline = new Date(Date.now() - days * 24 * 3600 * 1000);

  const users = await prisma.user.findMany({
    where: includeAccounts || smokeOnly ? {} : { isGuest: true },
    select: {
      id: true,
      email: true,
      isGuest: true,
      createdAt: true,
      // 只要最新一条的时间戳，用来判"最后活跃"；按时间倒序取 1 条
      memories: { select: { updatedAt: true }, orderBy: { updatedAt: 'desc' }, take: 1 },
    },
  });

  const stale = users.filter((u) => {
    if (smokeOnly && !u.id.startsWith('smoke_')) return false;
    // 没有记忆的用户没必要清：空行占不了多少地方，删了反而看不懂"这个人来过"
    if (!u.memories.length) return false;
    const latest = u.memories[0].updatedAt ?? u.createdAt;
    return latest < deadline;
  });

  if (!stale.length) {
    console.log(`没有 ${days} 天未活跃的记忆，无需清理`);
    return;
  }

  console.log(`${days} 天未活跃的用户 ${stale.length} 个：`);
  for (const u of stale) {
    const tag = u.isGuest ? '游客' : '账号';
    const who = u.email ? u.email : u.id;
    console.log(
      `  - [${tag}] ${who}  最后活跃 ${u.memories[0].updatedAt.toISOString().slice(0, 10)}`,
    );
  }

  if (!apply) {
    console.log('\n这是试运行。确认无误后加 --apply 才会真的清。');
    return;
  }

  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const archiveFile = path.join(DATA_DIR, `memory-archive-${stamp}.json`);
  const archived: Record<string, unknown> = fs.existsSync(archiveFile)
    ? JSON.parse(fs.readFileSync(archiveFile, 'utf8'))
    : {};

  let removedMemories = 0;
  let removedUsers = 0;

  for (const u of stale) {
    const rows = await prisma.memory.findMany({ where: { userId: u.id } });
    // 归档结构与旧 memory.json 一致：uid → 记忆数组，字段名沿用库里的 camelCase
    archived[u.id] = rows;
    removedMemories += rows.length;

    if (u.isGuest) {
      // 游客：整行删掉（外键 onDelete: Cascade 会把记忆一起带走）
      await prisma.user.delete({ where: { id: u.id } });
      removedUsers += 1;
    } else {
      // 正式账号：只清记忆，账号本身留着——他还得能登录
      await prisma.memory.deleteMany({ where: { userId: u.id } });
    }
  }

  fs.writeFileSync(archiveFile, JSON.stringify(archived, null, 2), 'utf8');

  console.log(
    `\n已归档到 data/memory-archive-${stamp}.json：清掉 ${removedMemories} 条记忆、${removedUsers} 个游客用户`,
  );
  console.log('（正式账号只清记忆，账号保留）');
}

main()
  .catch((err) => {
    console.error('[prune-memory]', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
