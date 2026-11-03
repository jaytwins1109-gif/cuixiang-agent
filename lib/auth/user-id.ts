// lib/auth/user-id.ts
//
// 用户标识的清洗与保留字防御。
//
// 2026-11-03 从 lib/chat/handlers.ts 搬出来：鉴权层（/api/auth/*）也要用它，
// 而 handlers 会把整个 LLM 链路拖进来。搬完之后 handlers 只是 re-export，
// 调用方一行都不用改。

/** 撞上原型链属性的 id 一律不认：`store['constructor']` 拿到的是函数而不是数组 */
const RESERVED_USER_ID =
  /^(proto|constructor|prototype|__proto__|tostring|valueof|hasownproperty|isprototypeof)$/i;

/**
 * 把前端传来的 id 洗成可用形态。
 *
 * 规则：只留字母/数字/下划线/连字符，撞保留字或洗成空的，发一个一次性 guest id。
 * 注意 guest id 是「兜底发的」而不是「报错的」——老前端可能压根没带 id，
 * 这时候给个临时身份比直接 400 友好。
 */
export function normalizeUserId(raw?: unknown): string {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');
  // 撞保留字的（比如前端被塞了个 constructor）也发一次性 id，不给它落盘的机会
  const safe = cleaned && !RESERVED_USER_ID.test(cleaned) ? cleaned : '';
  return safe || `guest_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 严格模式：不符合字符白名单就返回 null，用于"必须原样匹配"的场合（如游客升级） */
export function strictUserId(raw?: unknown): string | null {
  const cleaned = String(raw ?? '')
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, '');
  if (!cleaned || cleaned.length > 64) return null;
  if (RESERVED_USER_ID.test(cleaned)) return null;
  return cleaned;
}
