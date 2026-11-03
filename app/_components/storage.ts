import { BUDGET_LABELS, PROFILE_TRUSTED_KEYS, USER_KEY } from './constants';

/**
 * 取（或首次生成）本浏览器的用户标识。
 * 放在函数里而不是 state：send 可能在 state 生效前就被触发，直接读 localStorage 最稳。
 */
export function ensureUserId(): string {
  try {
    let uid = localStorage.getItem(USER_KEY);
    if (!uid) {
      uid = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(USER_KEY, uid);
    }
    return uid;
  } catch {
    // 隐私模式写不了 localStorage，退回匿名桶，至少不报错
    return 'anonymous';
  }
}

/**
 * 只留可信字段，其余一律丢掉。
 *
 * 白名单而不是黑名单：黑名单只能挡住今天想到的 scene / emotion，
 * 后端哪天多吐一个字段，脏数据就又混进来了。
 */
export function stripVolatileProfile(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const k of PROFILE_TRUSTED_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== 'string' || !v.trim()) continue;
    if (k === 'budget' && !BUDGET_LABELS.includes(v.trim())) continue;
    out[k] = v.trim();
  }
  return out;
}
