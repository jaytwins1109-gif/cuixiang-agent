// lib/admin/page-auth.ts — Admin 页面层鉴权（server-only）
//
// middleware 只是体验层（edge 验不了 node:crypto 的 HMAC），页面必须自己再验：
// 两条路任一通过即算 authed——
//   1. V3.0 ADMIN 登录票（cx_token，role 快照）
//   2. V1 口令票据（cx_admin，HMAC 验签）
import { cookies } from 'next/headers';
import { TOKEN_COOKIE, verifyUserToken } from '@/lib/auth/jwt';
import { ADMIN_SESSION_COOKIE, verifySessionTicket } from '@/lib/admin/session';

export async function isAdminPageAuthed(): Promise<boolean> {
  const store = await cookies();
  const tokenTicket = await verifyUserToken(store.get(TOKEN_COOKIE)?.value);
  if (tokenTicket?.role === 'ADMIN') return true;
  return verifySessionTicket(
    store.get(ADMIN_SESSION_COOKIE)?.value,
    process.env.ADMIN_PASSWORD_HASH,
  );
}
