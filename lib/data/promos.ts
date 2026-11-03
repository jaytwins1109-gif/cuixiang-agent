// lib/data/promos.ts
// 活动表 / 优惠券表 / 会员表：对应 Coze 工作流里的 182136（优惠券查询）、180851（查询活动）、190772（用户查询）。
// 这三个节点原本查的是 Coze 数据库，这里落成内置数据表，口径保持一致：
//   member_level / coupon_sensitivity 影响是否推券、推哪张券
//   活动与优惠券能否叠加由 stackable 决定，凑单是否合理由「加购后是否真便宜」判断

import { PRODUCTS, type Product } from './snacks'

export type ActivityType = '满减' | '折扣' | '买赠' | '多件优惠' | '会员价' | '秒杀'

export interface Activity {
  id: string
  name: string
  type: ActivityType
  /** 满减门槛 / 多件优惠的件数 */
  threshold: number
  /** 满减金额 / 券面额 */
  amount: number
  /** 折扣率，0.85 = 85 折 */
  rate?: number
  gift?: string
  /** 限定 sku，空表示全场 */
  skus?: string[]
  /** 是否可以再叠券 */
  stackable: boolean
}

export interface Coupon {
  id: string
  name: string
  threshold: number
  amount: number
  skus?: string[]
  stackable: boolean
}

export interface Member {
  user_id: string
  member_level: '新客' | '普通' | '银卡' | '金卡'
  order_count: number
  total_spent: number
  coupon_sensitivity: 'high' | 'medium' | 'low'
  risk_level: 'low' | 'medium' | 'high'
}

// ─── 数据表 ────────────────────────────────────────
export const ACTIVITIES: Activity[] = [
  { id: 'A1', name: '全场满39减5', type: '满减', threshold: 39, amount: 5, stackable: true },
  { id: 'A2', name: '全场满69减12', type: '满减', threshold: 69, amount: 12, stackable: true },
  { id: 'A3', name: '坚果买赠（送海苔卷）', type: '买赠', threshold: 1, amount: 0, gift: '海苔卷', skus: ['SKU028', 'SKU032'], stackable: true },
  { id: 'A4', name: '薯片第二件半价', type: '多件优惠', threshold: 2, amount: 0, rate: 0.5, skus: ['SKU019'], stackable: false },
  { id: 'A5', name: '会员专享95折', type: '会员价', threshold: 0, amount: 0, rate: 0.95, stackable: true },
]

export const COUPONS: Coupon[] = [
  { id: 'C1', name: '新客券 满20减3', threshold: 20, amount: 3, stackable: true },
  { id: 'C2', name: '老客券 满50减8', threshold: 50, amount: 8, stackable: true },
  { id: 'C3', name: '会员无门槛2元', threshold: 0, amount: 2, stackable: false },
]

const MEMBERS: Record<string, Member> = {
  u_vip: { user_id: 'u_vip', member_level: '金卡', order_count: 42, total_spent: 3600, coupon_sensitivity: 'high', risk_level: 'low' },
}

const DEFAULT_MEMBER: Member = {
  user_id: 'anonymous', member_level: '新客', order_count: 0, total_spent: 0,
  coupon_sensitivity: 'medium', risk_level: 'low',
}

export function getMember(user_id?: string): Member {
  const m = MEMBERS[(user_id || '').trim()]
  if (m) return { ...m }
  return { ...DEFAULT_MEMBER, user_id: (user_id || 'anonymous').trim() || 'anonymous' }
}

// ─── 匹配 ─────────────────────────────────────────
const appliesTo = (skus: string[] | undefined, p: Product) =>
  !skus || skus.length === 0 || skus.includes(p.sku_id)

export interface CartItem {
  product: Product
  qty: number
}

export interface PricePlan {
  /** 原价小计 */
  subtotal: number
  activity?: Activity
  activity_discount: number
  coupon?: Coupon
  coupon_discount: number
  /** 预计到手价 */
  final_price: number
  saved: number
  /** 凑单建议：差多少、加哪款最划算 */
  add_on?: { product: Product; gap: number; extra_saved: number }
  /** 金额算不准时置 true（本实现都是精确计算，留给未来活动复杂化） */
  estimated: boolean
}

/** 会员专享：银卡及以上享受 95 折与无门槛券 */
function isPrivileged(m: Member): boolean {
  return m.member_level === '银卡' || m.member_level === '金卡'
}

/** 该用户手里可用的券（按面额从高到低） */
export function couponsFor(m: Member): Coupon[] {
  return COUPONS.filter(c => {
    if (c.id === 'C1') return m.member_level === '新客'
    if (c.id === 'C2') return m.order_count > 0 || m.member_level !== '新客'
    if (c.id === 'C3') return isPrivileged(m)
    return true
  }).sort((a, b) => b.amount - a.amount)
}

/** 单品/组合能触发的最优活动（只取省得最多的那个，避免话术里堆一堆活动） */
export function bestActivity(items: CartItem[], m: Member): { activity?: Activity; discount: number } {
  const subtotal = items.reduce((n, it) => n + it.product.price * it.qty, 0)
  let best: { activity?: Activity; discount: number } = { discount: 0 }

  for (const a of ACTIVITIES) {
    let discount = 0
    if (a.type === '满减') {
      if (subtotal >= a.threshold) discount = a.amount
    } else if (a.type === '会员价') {
      if (!isPrivileged(m)) continue
      discount = round2(subtotal * (1 - (a.rate ?? 1)))
    } else if (a.type === '折扣') {
      const hit = items.filter(it => appliesTo(a.skus, it.product))
      if (hit.length) discount = round2(hit.reduce((n, it) => n + it.product.price * it.qty, 0) * (1 - (a.rate ?? 1)))
    } else if (a.type === '多件优惠') {
      const hit = items.find(it => appliesTo(a.skus, it.product) && it.qty >= a.threshold)
      if (hit) discount = round2(hit.product.price * (1 - (a.rate ?? 1)))
    } else if (a.type === '买赠') {
      const hit = items.find(it => appliesTo(a.skus, it.product))
      if (hit) discount = 0 // 赠品不折现，只体现在话术里
    } else if (a.type === '秒杀') {
      const hit = items.filter(it => appliesTo(a.skus, it.product))
      if (hit.length) discount = round2(hit.reduce((n, it) => n + it.product.price * it.qty, 0) * (1 - (a.rate ?? 1)))
    }
    if (discount > best.discount) best = { activity: a, discount }
  }
  return best
}

/**
 * 算一笔账：活动 → 券 → 到手价 → 凑单建议。
 * 凑单只在「加购后确实更省」时才建议，不允许为了凑单而凑单。
 */
export function pricePlan(items: CartItem[], m: Member): PricePlan {
  const subtotal = round2(items.reduce((n, it) => n + it.product.price * it.qty, 0))
  const act = bestActivity(items, m)

  let coupon: Coupon | undefined
  let coupon_discount = 0
  if (!act.activity || act.activity.stackable) {
    const afterActivity = round2(subtotal - act.discount)
    for (const c of couponsFor(m)) {
      if (afterActivity < c.threshold) continue
      const hit = !c.skus || items.some(it => c.skus!.includes(it.product.sku_id))
      if (!hit) continue
      coupon = c
      coupon_discount = c.amount
      break
    }
  }

  const final_price = round2(Math.max(0, subtotal - act.discount - coupon_discount))

  return {
    subtotal,
    activity: act.activity,
    activity_discount: act.discount,
    coupon,
    coupon_discount,
    final_price,
    saved: round2(subtotal - final_price),
    add_on: suggestAddOn(items, m, act, final_price),
    estimated: false,
  }
}

/**
 * 凑单建议：差一点点就能触发更高档满减时，找一款最便宜且合规的加购商品。
 * 判断标准是「加购后总支出增加，但总到手优惠更多，且加购本身是用户会吃的东西」。
 */
function suggestAddOn(
  items: CartItem[],
  m: Member,
  cur: { activity?: Activity; discount: number },
  curFinal: number
): PricePlan['add_on'] {
  const picked = new Set(items.map(it => it.product.sku_id))
  const curSubtotal = round2(items.reduce((n, it) => n + it.product.price * it.qty, 0))

  let best: PricePlan['add_on']
  for (const p of PRODUCTS) {
    if (picked.has(p.sku_id) || p.stock === 'out_of_stock') continue
    const nextItems = [...items, { product: p, qty: 1 }]
    const next = pricePlanCore(nextItems, m)
    // 多花了 next.final_price - curFinal，但拿到了更多商品；只有当加购的边际成本
    // 明显低于它本身原价（等于享受了额外优惠）时才算"值得凑"
    const marginal = round2(next.final_price - curFinal)
    const extra_saved = round2(p.price - marginal)
    if (extra_saved < 1) continue
    // 别为了凑单让人多花一倍的钱：加购的东西不能比这单本身还贵（小单给 10 元额度）
    if (p.price > Math.max(curSubtotal, 10)) continue
    if (!best || extra_saved > best.extra_saved) {
      best = { product: p, gap: round2(Math.max(0, next.subtotal - curSubtotal)), extra_saved }
    }
  }
  return best
}

/** 不含凑单递归的核心计算 */
function pricePlanCore(items: CartItem[], m: Member): Omit<PricePlan, 'add_on'> {
  const subtotal = round2(items.reduce((n, it) => n + it.product.price * it.qty, 0))
  const act = bestActivity(items, m)
  let coupon: Coupon | undefined
  let coupon_discount = 0
  if (!act.activity || act.activity.stackable) {
    const afterActivity = round2(subtotal - act.discount)
    for (const c of couponsFor(m)) {
      if (afterActivity < c.threshold) continue
      const hit = !c.skus || items.some(it => c.skus!.includes(it.product.sku_id))
      if (!hit) continue
      coupon = c
      coupon_discount = c.amount
      break
    }
  }
  const final_price = round2(Math.max(0, subtotal - act.discount - coupon_discount))
  return {
    subtotal, activity: act.activity, activity_discount: act.discount,
    coupon, coupon_discount, final_price,
    saved: round2(subtotal - final_price), estimated: false,
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** 活动/券的可读文案，卡片和话术共用 */
export function describePlan(plan: PricePlan): string[] {
  const out: string[] = []
  if (plan.activity) {
    if (plan.activity.type === '买赠') out.push(`${plan.activity.name.replace(/（.*）/, '')}，送${plan.activity.gift}`)
    else if (plan.activity.type === '多件优惠') out.push(`${plan.activity.name}`)
    else if (plan.activity_discount > 0) out.push(`${plan.activity.name}，省${plan.activity_discount}元`)
    else out.push(plan.activity.name)
  }
  if (plan.coupon) out.push(`${plan.coupon.name}，再减${plan.coupon.amount}元`)
  if (plan.saved > 0) out.push(`到手约${plan.final_price}元`)
  return out
}
