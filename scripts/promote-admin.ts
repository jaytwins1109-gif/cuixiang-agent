// scripts/promote-admin.ts — 提权脚本（V3.0）
//
// Admin 不开放注册：唯一产生路径就是运维在服务器上跑这个脚本。
//   node --import ./scripts/ts-alias-register.mjs scripts/promote-admin.ts <email 或 userId>
// （npm run promote-admin -- <email 或 userId>）
//
// 提权后**必须重新登录**拿新票：cx_token 是签发时快照，旧票里 role 还是 USER，
// 降到 token 自然过期前都进不了后台。脚本结尾会明确提示这一点。
import { normalizeRole, type UserRole } from '../lib/auth/jwt';
import { prisma } from '../lib/db';

async function main(): Promise<void> {
  const target = process.argv[2]?.trim();
  if (!target) {
    console.error('用法：npm run promote-admin -- <email 或 userId>');
    console.error('例如：npm run promote-admin -- admin@cuixiang.cn');
    process.exit(1);
  }

  const isEmail = target.includes('@');
  const user = await prisma.user.findUnique({
    where: isEmail ? { email: target } : { id: target },
  });

  if (!user) {
    console.error(`找不到用户：${target}（${isEmail ? '按 email 查' : '按 userId 查'}）`);
    process.exit(1);
  }

  const current: UserRole = normalizeRole(user.role);
  if (current === 'ADMIN') {
    console.log(`已是 ADMIN，无需操作：${user.id}（${user.email ?? '无邮箱'}）`);
    return;
  }

  await prisma.user.update({ where: { id: user.id }, data: { role: 'ADMIN' } });
  console.log(`已提权：${user.id}（${user.email ?? '无邮箱'}）USER → ADMIN`);
  console.log(
    '⚠️ 该用户需重新登录（/api/auth/login 或 upgrade）拿新票，旧票里的 role 快照仍是 USER。',
  );
}

main()
  .catch((e) => {
    console.error('PROMOTE FAILED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
