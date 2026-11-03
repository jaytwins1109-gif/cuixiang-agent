/**
 * 归档 / 清理长期记忆文件，防止 `data/memory.json` 无限膨胀。
 *
 * 单用户上限（`slice(-200)`）只挡得住"一个人聊太久"，挡不住"每天来一万个新用户"——
 * 文件会涨到几十 MB，而每次读写都是整份读进内存再整份写回，性能会断崖式下跌。
 *
 * 规则：把 N 天（默认 7）内没有任何更新的用户**整份挪进归档文件**，主文件里删掉。
 * 这不是物理抹除：原文完整留在 `data/memory-archive-<日期>.json`，随时可查。
 *
 * 用法：
 *   node scripts/prune-memory.mjs                 # 默认试运行，只看会清掉谁
 *   node scripts/prune-memory.mjs --apply         # 真的清
 *   node scripts/prune-memory.mjs --days=30       # 改成"30 天未活跃"
 */
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const daysArg = args.find((a) => a.startsWith('--days='));
const days = Number(daysArg ? daysArg.split('=')[1] : 7);

if (!Number.isFinite(days) || days <= 0) {
  console.log('--days 得是个正数，比如 --days=30');
  process.exit(1);
}

const file = path.join(process.cwd(), 'data', 'memory.json');
if (!fs.existsSync(file)) {
  console.log('没有 data/memory.json，没什么可清的');
  process.exit(0);
}

const store = JSON.parse(fs.readFileSync(file, 'utf8'));
const deadline = Date.now() - days * 24 * 3600 * 1000;

const stale = [];
for (const [uid, list] of Object.entries(store)) {
  const latest = list.reduce((max, r) => Math.max(max, Date.parse(r?.updated_at || '') || 0), 0);
  // 没有可解析时间戳的也一并归档：那多半是早期脏数据
  if (!latest || latest < deadline) stale.push(uid);
}

if (!stale.length) {
  console.log(`没有 ${days} 天未活跃的记忆，无需清理`);
  process.exit(0);
}

console.log(`${days} 天未活跃的用户 ${stale.length} 个：`);
for (const uid of stale) console.log('  - ' + uid);

if (!apply) {
  console.log('\n这是试运行。确认无误后加 --apply 才会真的清。');
  process.exit(0);
}

const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const archiveFile = path.join(process.cwd(), 'data', `memory-archive-${stamp}.json`);
const archived = fs.existsSync(archiveFile) ? JSON.parse(fs.readFileSync(archiveFile, 'utf8')) : {};

for (const uid of stale) {
  archived[uid] = store[uid];
}

fs.writeFileSync(archiveFile, JSON.stringify(archived, null, 2), 'utf8');

for (const uid of stale) delete store[uid];

// 原子写：临时文件 + 改名，跟服务端的 writeStore 保持一致
const tmp = `${file}.${process.pid}.tmp`;
fs.writeFileSync(tmp, JSON.stringify(store, null, 2), 'utf8');
fs.renameSync(tmp, file);

console.log(
  `\n已归档到 data/memory-archive-${stamp}.json，并从 memory.json 移除 ${stale.length} 个用户`,
);
