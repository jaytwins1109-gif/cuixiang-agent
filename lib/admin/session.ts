/**
 * 后台（`/admin`）会话票据的签发与校验。
 *
 * 为什么不能把 `cx_admin=1` 直接当登录态：cookie 是客户端说了算的东西，
 * 任何人在 DevTools 手写一条同名 cookie 就能进后台，口令形同虚设。
 * 所以票据必须带上服务端才知道的签名——没有 `ADMIN_PASSWORD_HASH` 就签不出来。
 *
 * 票据格式：`<过期时间戳>.<HMAC-SHA256(密钥, 过期时间戳) 的 hex>`
 * 密钥由 `ADMIN_PASSWORD_HASH` 派生：改口令即让所有已签发会话立即失效，
 * 不需要额外维护一张会话表。
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** 会话有效期，与 cookie 的 maxAge 保持一致（8 小时） */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 8;

/** V1 口令会话 cookie 名（middleware 只看存在性，验签在页面层） */
export const ADMIN_SESSION_COOKIE = 'cx_admin';

/** 派生密钥时掺进去的固定标签，避免拿口令哈希直接当 HMAC key */
const KEY_LABEL = 'cx_admin_session_v1';

function sessionKey(secret: string): string {
  return createHmac('sha256', secret).update(KEY_LABEL).digest('hex');
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', sessionKey(secret)).update(payload).digest('hex');
}

/** 签发一条会话票据（登录成功后写进 cookie 的就是这个值） */
export function createSessionTicket(secret: string, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = String(exp);
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * 校验票据：签名对不对 + 有没有过期，两个都过才算登录。
 *
 * 任何异常形态（缺字段、长度不对、非数字、非 hex）一律当作未登录，
 * 不做「宽松解析」——宽松解析正是伪造 cookie 能混进来的入口。
 */
export function verifySessionTicket(
  ticket: string | undefined | null,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!ticket || !secret) return false;

  const dot = ticket.lastIndexOf('.');
  if (dot <= 0 || dot === ticket.length - 1) return false;

  const payload = ticket.slice(0, dot);
  const given = ticket.slice(dot + 1);

  if (!/^\d{1,12}$/.test(payload)) return false;
  if (!/^[0-9a-f]{64}$/i.test(given)) return false;

  const exp = Number(payload);
  if (exp * 1000 <= now) return false;

  const expected = sign(payload, secret);

  // 长度已经由正则保证一致，timingSafeEqual 只用于消除逐字节比较的时间差
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** 口令比对：同样用常量时间比较，避免按前缀逐位试出口令 */
export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
