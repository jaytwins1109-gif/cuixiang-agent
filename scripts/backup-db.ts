/**
 * SQLite 在线备份。
 *
 * 为什么不用"复制 .db 文件"：V2.0 用的是 WAL 模式，`cuixiang.db` 旁边还有
 * `-wal` / `-shm`。只 copy 主文件会漏掉尚未 checkpoint 的事务，恢复出来是半截数据；
 * 三个文件一起 copy 又有"拷到一半又有人写"的竞态。
 *
 * 所以用 SQLite 自带的 `VACUUM INTO`：它在**一个读事务里**把整库重写成一份新文件，
 * 不用停服务、不用管 wal，产物还是一个干净的、可以直接打开的 .db。
 *
 * 用法：
 *   node --import ./scripts/ts-alias-register.mjs scripts/backup-db.ts        # 备份到 data/backups/
 *   ... --out=d:/tmp/cx.db                                                  # 指定目标文件（必须不存在）
 *   ... --keep=30                                                           # 只留最近 30 份自动备份
 *
 * 保留策略只作用于**自动命名**的备份（`cuixiang-<时间戳>.db`），
 * `--out` 指定的文件永远不参与清理——那是用户自己指名要的。
 */
import fs from 'node:fs';
import path from 'node:path';

import { prisma } from '@/lib/db';

const args = process.argv.slice(2);
const outArg = args.find((a) => a.startsWith('--out='));
const keepArg = args.find((a) => a.startsWith('--keep='));
const keep = Number(keepArg ? keepArg.split('=')[1] : 10);

if (!Number.isFinite(keep) || keep < 1) {
  console.log('--keep 得是 ≥1 的整数，比如 --keep=30');
  process.exit(1);
}

const BACKUP_DIR = path.join(process.cwd(), 'data', 'backups');
/**
 * 2026-11-03-21-30-15：排序即时间序，人眼也认得。
 * 注意要把 `T` 也换成 `-`——留着 T 的话文件名对不上下面的清理正则，
 * 保留策略就成了摆设（第一次跑就踩到了）。
 */
const stamp = new Date().toISOString().replace(/[:]/g, '-').replace('T', '-').slice(0, 19);
const AUTO_NAME = `cuixiang-${stamp}.db`;

async function main() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const target = outArg ? path.resolve(outArg.split('=')[1]) : path.join(BACKUP_DIR, AUTO_NAME);

  // VACUUM INTO 要求目标不存在，覆盖会被 SQLite 直接拒绝；提前说清楚比让用户看报错强
  if (fs.existsSync(target)) {
    console.log(`目标已存在：${target}\n换个名字，或先把它挪走。`);
    process.exitCode = 1;
    return;
  }

  // 路径来自命令行，转义单引号防注入（VACUUM 不支持占位符绑定）
  const escaped = target.replace(/'/g, "''");
  await prisma.$executeRawUnsafe(`VACUUM INTO '${escaped}'`);

  const size = fs.statSync(target).size;
  console.log(`已备份：${target}（${(size / 1024).toFixed(1)} KB）`);

  // 只清自动命名的旧备份；--out 指定的文件不碰
  if (!outArg) {
    const files = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^cuixiang-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    const extra = files.slice(0, Math.max(0, files.length - keep));
    for (const f of extra) {
      fs.unlinkSync(path.join(BACKUP_DIR, f));
    }
    if (extra.length) console.log(`清理旧备份 ${extra.length} 份（保留最近 ${keep} 份）`);
  }

  // 顺带报一下库里的规模，备份时最想知道的就是"这个文件里到底有什么"
  const [users, memories] = await Promise.all([prisma.user.count(), prisma.memory.count()]);
  console.log(`当前库：${users} 个用户、${memories} 条记忆`);
}

main()
  .catch((err) => {
    console.error('[backup-db]', err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
