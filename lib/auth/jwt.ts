// lib/auth/jwt.ts
//
// 用户登录态与游客票据的签发/校验（jose HS256）。
//
// 两张 cookie 各管一件事：
//   cx_token  —— 已登录用户，payload.sub = userId，30 天
//   cx_guest  —— 游客身份证明，payload.sub = 游客 id，1 年
//
// 为什么游客也要签名：`/api/auth/upgrade` 只凭 body 里的 guestId 就改库，
// 等于「知道别人的 u_xxx 就能把他的账号绑到我的邮箱」。加一张服务端签的票据，
// upgrade 时要求票据与 guestId 一致，这条路就堵死了。
//
// 与 /admin 那套（lib/admin/session.ts，HMAC 手写票据）刻意分开：
// 后台是单口令、无用户表，不需要 JWT；用户侧要带 userId 与过期时间，用 jose 更省事。
// 两套互不影响：改 AUTH_SECRET 不会踢掉后台登录，反之亦然。

import { SignJWT, jwtVerify } from 'jose';

export const TOKEN_COOKIE = 'cx_token';
export const GUEST_COOKIE = 'cx_guest';
export const TOKEN_MAX_AGE = 60 * 60 * 24 * 30; // 30 天
export const GUEST_MAX_AGE = 60 * 60 * 24 * 365; // 1 年

const ISSUER = 'cuixiang';
const ALG = 'HS256';

/** 签发用：没有密钥就是配置错误，必须抛出来，不能静默签一个空密钥的票 */
function signingKey(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error('AUTH_SECRET 未配置或太短（至少 16 字符），无法签发登录态');
  }
  return new TextEncoder().encode(secret);
}

/** 校验用：没配密钥时一律当"未登录"，不要把异常抛到请求链路上 */
function verifyKey(): Uint8Array | null {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) return null;
  return new TextEncoder().encode(secret);
}

async function sign(kind: 'user' | 'guest', id: string, maxAge: number): Promise<string> {
  return new SignJWT({ typ: kind })
    .setProtectedHeader({ alg: ALG })
    .setSubject(id)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) + maxAge)
    .sign(signingKey());
}

async function verify(token: string | undefined | null, kind: 'user' | 'guest') {
  if (!token) return null;
  const key = verifyKey();
  if (!key) return null;
  try {
    const { payload } = await jwtVerify(token, key, { issuer: ISSUER });
    // typ 也校验：不然游客票据可以当登录票据用（反之亦然）
    if (payload.typ !== kind) return null;
    return typeof payload.sub === 'string' && payload.sub ? payload.sub : null;
  } catch {
    // 过期、签名错、格式错，一律当未登录——宽松解析正是伪造票据混进来的入口
    return null;
  }
}

export const signUserToken = (userId: string) => sign('user', userId, TOKEN_MAX_AGE);
export const verifyUserToken = (token?: string | null) => verify(token, 'user');
export const signGuestTicket = (guestId: string) => sign('guest', guestId, GUEST_MAX_AGE);
export const verifyGuestTicket = (token?: string | null) => verify(token, 'guest');

/**
 * Set-Cookie 字符串。
 *
 * HttpOnly：前端读不到，XSS 也偷不走；
 * SameSite=Lax：本站导航与 fetch 会带上，跨站表单不会；
 * Secure：只在生产加，本地 http 加了浏览器会直接丢掉这条 cookie。
 */
export function cookieString(name: string, value: string, maxAge: number): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export function clearCookieString(name: string): string {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  return `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}
