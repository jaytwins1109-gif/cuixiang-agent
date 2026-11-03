/**
 * 一次性数据迁移：data/memory.json → SQLite（Prisma）
 *
 * V2.0 把长期记忆从「一个 JSON 文件」搬进数据库后，老用户的历史记忆必须跟着搬，
 * 否则上线那一刻所有人都失忆——包括那些记了「花生过敏」的人，这是安全问题，不是体验问题。
 *
 * 用法：
 *   node scripts/migrate-memory-json.mjs            # 默认试运行，只统计不写库
 *   node scripts/migrate-memory-json.mjs --apply    # 真的写库，并把 memory.json 改名留档
 *
 * 几条刻意的取舍：
 *   - **不做 200 条截断**：迁移时全量搬，别在上线瞬间又丢一批老记录。
 *     截断是「写入路径」的兜底策略（writeMemory 里），下一轮写入时自然生效。
 *   - **幂等**：memory.id 沿用 JSON 里的 `m_xxx`，库里已有的按 id 跳过，重复跑不会翻倍。
 *   - data/memory-archive-*.json 里是 7 天未活跃用户的归档，不迁：
 *     那些用户本来就不活跃，需要时人工捞；迁进来只会让库变脏。
 */
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

const args = process.argv.slice(2);
const apply = args.includes('--apply');

const prisma = new PrismaClient();
const DATA_DIR = path.join(process.cwd(), 'data');
const FILE = path.join(DATA_DIR, 'memory.json');

/** 与 lib/memory/store.ts 的联合类型保持一致；库里存的是文本，这里负责挡脏数据 */
const LAYERS = new Set(['core_profile', 'summary_memory', 'fragment_memory']);
const STATUSES = new Set(['active', 'pending', 'resolved', 'superseded', 'deleted']);
const POLARITIES = new Set(['喜欢', '不喜欢', '拒绝', '接受', '中立', '不确定']);
/** 与 lib/chat/handlers.ts 的 normalizeUserId 同一套字符白名单 */
const SAFE_ID = /^[a-zA-Z0-9_-]{1,64}$/;

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const date = (v) => {
  const t = Date.parse(typeof v === 'string' ? v : '');
  return Number.isFinite(t) ? new Date(t) : new Date();
};

async function main() {
  if (!fs.existsSync(FILE)) {
    console.log('没有 data/memory.json，没什么可迁的（新部署直接开始用库）');
    return;
  }

  let store;
  try {
    store = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (e) {
    console.log(`data/memory.json 解析失败，先别迁：${e.message}`);
    process.exitCode = 1;
    return;
  }
  if (!store || typeof store !== 'object') {
    console.log('data/memory.json 结构不对（不是对象），停下');
    process.exitCode = 1;
    return;
  }

  const report = { users: 0, skippedUsers: [], records: 0, badRecords: [], dup: 0 };

  for (const [rawUid, list] of Object.entries(store)) {
    const uid = String(rawUid);
    const records = Array.isArray(list) ? list : [];
    if (!SAFE_ID.test(uid)) {
      // 早期脏 key（保留字、带不可见字符）不进库：normalizeUserId 也会把它们挡在外面
      report.skippedUsers.push(`${uid}（${records.length} 条）`);
      continue;
    }

    report.users++;

    if (!apply) {
      report.records += records.length;
      console.log(`  ${uid}: ${records.length} 条`);
      continue;
    }

    // 游客一律 isGuest: true；已经注册过的（同一个 id）不动邮箱密码
    await prisma.user.upsert({
      where: { id: uid },
      create: { id: uid, isGuest: true },
      update: {},
    });

    const existing = new Set(
      (await prisma.memory.findMany({ where: { userId: uid }, select: { id: true } })).map(
        (m) => m.id,
      ),
    );

    for (const r of records) {
      const keyword = str(r?.keyword);
      const content = str(r?.content);
      const layer = str(r?.layer);
      if (!keyword || !content || !LAYERS.has(layer)) {
        report.badRecords.push(`${uid}/${r?.id ?? '?'}`);
        continue;
      }
      const id = str(r?.id) || `m_mig_${report.records + 1}`;
      if (existing.has(id)) {
        report.dup++;
        continue;
      }
      const status = STATUSES.has(str(r?.status)) ? str(r.status) : 'active';
      const polarity = POLARITIES.has(str(r?.polarity)) ? str(r.polarity) : null;

      await prisma.memory.create({
        data: {
          id,
          userId: uid,
          layer,
          keyword,
          content,
          status,
          context: str(r?.context) || null,
          category: str(r?.category) || null,
          polarity,
          source: str(r?.source) || null,
          createdAt: date(r?.created_at),
          updatedAt: date(r?.updated_at),
        },
      });
      existing.add(id);
      report.records++;
    }
    console.log(`  ${uid}: ${records.length} 条 → 已入库`);
  }

  console.log('');
  console.log(
    `${apply ? '已迁移' : '将迁移'}：用户 ${report.users} 个、记忆 ${report.records} 条` +
      (report.dup ? `（库里已有、跳过 ${report.dup} 条）` : ''),
  );
  if (report.skippedUsers.length) {
    console.log(`跳过的用户 ${report.skippedUsers.length} 个（id 不合法）：`);
    report.skippedUsers.forEach((u) => console.log('  - ' + u));
  }
  if (report.badRecords.length) {
    console.log(
      `跳过的记录 ${report.badRecords.length} 条（缺 keyword/content 或 layer 不认识）：`,
    );
    report.badRecords.slice(0, 20).forEach((r) => console.log('  - ' + r));
    if (report.badRecords.length > 20) console.log(`  …还有 ${report.badRecords.length - 20} 条`);
  }

  if (!apply) {
    console.log('\n这是试运行。确认数字对得上，再加 --apply 真迁。');
    return;
  }

  // 迁移完成才改名：留原文件是为了"库里写坏了还能从 JSON 重来"
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const backup = path.join(DATA_DIR, `memory.json.migrated-${stamp}`);
  fs.renameSync(FILE, backup);
  console.log(`\n原文件已改名留档：${path.relative(process.cwd(), backup)}`);
}

main()
  .catch((e) => {
    console.log(`迁移脚本自身跑挂了：${e?.message || e}`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
