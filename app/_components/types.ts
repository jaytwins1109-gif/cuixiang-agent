/**
 * 前端用到的数据结构。
 *
 * 从 `app/page.tsx` 里搬出来的，**只放类型、不放逻辑**：
 * 页面里那坨 1700 行的组件树跟这几个 interface 混在一起，
 * 想改一个卡片字段得先翻过半个页面的 JSX。
 */

/** 一张推荐卡片 */
export interface Rec {
  name: string;
  reason: string;
  price: number;
  image?: string;
  emoji?: string;
  /** 本地工作流算出来的优惠：到手价 / 省了多少 / 凑单建议（兜底卡片没有这些） */
  promo?: {
    activity?: string;
    coupon?: string;
    final_price: number;
    saved: number;
    estimated?: boolean;
    add_on?: { name: string; gap: number; extra_saved: number };
  };
  /** 面向用户的推荐理由，比库里的 reason 更贴合本轮需求 */
  user_visible_reasons?: string[];
  risk_notes?: string[];
}

/** 一条消息（气泡或卡片组） */
export interface Msg {
  role: 'user' | 'assistant';
  content: string;
  cards?: Rec[];
  /** 时间戳，用来插日期分隔线；旧记录没有就当没有分隔 */
  ts?: number;
  /** 流式占位气泡的临时标识：同一条消息要被反复改写，靠它定位 */
  id?: string;
  /**
   * 流式吐出来的字被 final 整段改写了（本地防呆 / 意图纠偏）。
   * 挂上淡入动画，让替换有个视觉过渡，而不是"先出一段、啪地变成另一段"
   */
  refreshed?: boolean;
}

/** 左侧栏手选的筛选条件（这轮说了要什么） */
export interface Filters {
  flavor?: string;
  budget?: string;
}

/** 后端长期记忆快照：三层，前端只负责展示，真源在服务端 */
export interface MemorySnapshot {
  core_profile: string[];
  summary_memory: string[];
  active_fragments: string[];
}
