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

/**
 * 口味轴：同一个轴上的「口味」和「忌口」互斥（2026-11-03 截图事故：
 * 侧栏同时挂着「口味·辣味」和「忌口·不吃辣」，下一轮推荐精神分裂）。
 *
 * 过敏原（花生/坚果/海鲜/乳制品）不属于口味轴——吃辣口味和花生过敏
 * 完全可以并存，绝不能被互斥逻辑误伤。
 */
const TASTE_AXIS_CHARS = ['辣', '甜', '咸', '酸'];
const ALLERGEN_PATTERN = /花生|坚果|海鲜|海产品|乳|奶|蛋|麸质|过敏|不耐/;

function axisOf(value: string | undefined): string {
  if (!value || ALLERGEN_PATTERN.test(value)) return '';
  return TASTE_AXIS_CHARS.find((a) => value.includes(a)) || '';
}

/**
 * 带「同维度互斥」的 profile 合并。
 *
 * 后端回的 profile 只含本轮**有出处**的偏好（pickTrustedProfile 核过），
 * 但合并进 localStorage 旧状态时是裸 spread——用户改口后旧标签原样留下：
 * 「不想吃辣了，想吃甜的」→ 忌口·不吃辣 加进去，口味·辣味 还挂在那。
 *
 * 规则（后端同口径，见 lib/chat/handlers.ts 的 avoidAxisOf）：
 *   - 本轮说了忌口 → 同轴的旧口味标签立刻让位（用户明说的作废，不用确认）
 *   - 本轮说了口味 → 同轴的旧**口味类**忌口让位；过敏原一律不动
 *   - incoming 自身相撞 → 忌口赢（同一句话里不会出现，兜一手）
 */
export function mergeProfileExclusive(
  prev: Record<string, string>,
  incoming: Record<string, string>,
): Record<string, string> {
  const next = { ...prev };

  const incomingAvoid = incoming.avoid || next.avoid;
  const incomingFlavor = incoming.flavor || next.flavor;
  const avoidAxis = axisOf(incomingAvoid);
  const flavorAxis = axisOf(incomingFlavor);

  for (const [k, v] of Object.entries(incoming)) {
    next[k] = v;
  }

  // 忌口落到轴 X → X 轴口味标签作废（包括 incoming 自己带的）
  if (avoidAxis) {
    for (const k of Object.keys(next)) {
      if (k === 'flavor' && axisOf(next[k]) === avoidAxis) delete next[k];
    }
  }
  // 口味落到轴 X → X 轴的口味类忌口作废（过敏原不动）
  if (flavorAxis) {
    if (next.avoid && axisOf(next.avoid) === flavorAxis) delete next.avoid;
  }
  return next;
}
