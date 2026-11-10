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

/**
 * 拿服务端快照校正本地 profile：**服务端没有的，界面就不许挂**。
 *
 * 2026-11-09 的现场：用户问「我喜欢什么口味」，后端一条记忆都没有，侧栏却还挂着「口味·辣味」——
 * 那是上一轮留在 localStorage 里的缓存，服务端从来没记过它
 * （"今天想吃辣"这类一次性需求按设计就不写长期记忆）。界面挂着、选品却不按它来，
 * 用户看到的是系统自己造出来的幻觉，跟"失忆"是同一枚硬币的两面。
 *
 * 匹配用宽口径：记忆文本形如「不吃辣：不吃辣」「辣=喜欢辣」，
 * 所以除了原文包含，还把 `辣味` 折成 `辣` 再比一次（profile 里口味值带"味"后缀，
 * 记忆里存的是轴字）。
 */
export function reconcileProfileWithMemory(
  prev: Record<string, string>,
  memory:
    | { core_profile?: string[]; summary_memory?: string[]; active_fragments?: string[] }
    | null
    | undefined,
): Record<string, string> {
  const texts = [
    ...(memory?.core_profile || []),
    ...(memory?.summary_memory || []),
    ...(memory?.active_fragments || []),
  ];
  // 服务端一条都没有 → 本地也一条都不留
  if (!texts.length) return {};

  /**
   * 忌口标记：记忆里「不吃辣」和「喜欢辣」都含一个「辣」字，
   * 把 `辣味` 折成 `辣` 去比时必须先排掉带这些词的句子，
   * 否则"记着不吃辣"会被当成"记着喜欢辣"，口味标签照样挂回去。
   */
  const AVOID_MARK = /不吃|不想吃|不要|忌|戒|不碰|不嗜|不喜/;
  const hit = (v: string) => {
    const axis = v.replace(/味$/, '');
    return texts.some((t) => {
      if (t.includes(v)) return true;
      if (axis !== v && t.includes(axis) && !AVOID_MARK.test(t)) return true;
      return false;
    });
  };

  const next: Record<string, string> = {};
  for (const [k, v] of Object.entries(prev)) {
    if (hit(v)) next[k] = v;
  }
  return next;
}
