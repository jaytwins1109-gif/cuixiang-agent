// lib/llm/reply-composer.ts
//
// 推荐话术合成：Coze 工作流里那个「客服回复生成器」节点的本地版。
//
// 为什么不用大模型来写这一段：商品名、活动、到手价、注意事项全是硬数据，
// 让模型照着卡片复述一遍必然会错（漏一款、写错价、编出没有的活动都是事故）。
// 所以这里按结构化结果**本地拼人话**——模型的活只有开头那句"接住人"的过渡语，
// 它写完我们再把明细挂在后面。
//
// 对应用户要的那几条：
//   1. 每款都要说明「为什么适合他 / 什么活动 / 到手价 / 注意什么」
//   2. 要说清主推和备选的差异，最后给明确选择建议
//   3. 略超预算必须如实说超了，不许说成预算内
//   4. 有优惠时结尾补「具体优惠以结算页显示为准」，不制造紧迫感

import type { RankedProduct } from '@/lib/llm/local-workflow'
import { PRODUCT_BY_NAME } from '@/lib/data/snacks'

/** 用户明显在问优惠时才重点说活动，平时有就提一句、没有就不提，别整天像在促销 */
const PROMO_ASK = /优惠|便宜|活动|券|划算|折扣|赠|促销|满减|省钱/

/** 凑单句 Seeding：有人愿意为了满减多买一件，但要如实把差额说出来 */
function addOnLine(list: RankedProduct[]): string | null {
  const categories = new Set(list.map(it => it.category))
  for (const it of list) {
    const add = it.promo.add_on
    // 差额太大就别劝人凑单了（差 18 元省 5 元纯属添堵）；
    // 顺着同一个品类凑：买巧克力推荐加麻辣魔芋爽，看着像串台
    const addCat = PRODUCT_BY_NAME.get(add?.name || '')?.category
    if (add && add.gap > 0 && add.gap <= 12 && (!addCat || categories.has(addCat))) {
      return `想凑<｜hy_place▁holder▁no▁813｜>的话加${add.name}，差${add.gap}元能再省${add.extra_saved}元`
    }
  }
  return null
}

/** 单款的话术块：名字 + 价格 + 为什么 + 活动 + 到手价 + 注意事项 */
function itemBlock(item: RankedProduct, index: number, pushPromo: boolean): string {
  const lines: string[] = []

  // 为什么适合他：卡片理由里前两条足够，写多了像说明书
  const why = item.user_visible_reasons.slice(0, 2).join('；') || item.reason

  const promoBits: string[] = []
  if (item.promo.activity) promoBits.push(item.promo.activity)
  if (item.promo.coupon) promoBits.push(item.promo.coupon)
  if (item.promo.saved > 0) promoBits.push(`到手约${item.promo.final_price}元，省${item.promo.saved}元`)
  else if (pushPromo) promoBits.push('这款现在没活动')

  const head = `${index + 1}. ${item.name}｜${item.price}元`
  lines.push(head)
  lines.push(`   ${why}`)
  if (promoBits.length) lines.push(`   ${promoBits.join(' · ')}`)
  if (item.risk_notes.length) lines.push(`   ⚠ ${item.risk_notes.join('；')}`)

  return lines.join('\n')
}

/** 主推 / 备选的差异 + 明确选择建议 */
function choiceGuidance(list: RankedProduct[]): string | null {
  if (list.length < 2) return null

  const main = list[0]
  const cheapest = list.reduce((a, b) => (b.price < a.price ? b : a))

  const bits: string[] = []
  if (cheapest.name !== main.name) {
    bits.push(`想综合实力最强选${main.name}，想少花点选${cheapest.name}（${cheapest.price}元）`)
  } else {
    bits.push(`这几样里我更站${main.name}`)
  }
  const add = addOnLine(list)
  if (add) bits.push(add)

  return bits.join('；')
}

/**
 * 合成推荐轮的完整 reply。
 * @param transition 大脑写的开头那句（接住人 + 挑选方向）；没有就用系统兜底
 * @param recommendations 本地工作流选出来的 1-3 款（按 rank 顺序，别打乱）
 * @param message 用户原话，用来判断他是不是在问优惠
 * @param hint 候选不足 3 款且用户点名了口味时，气泡末句的诚实说明（"海边带辣的确实少"）
 */
export function composeRecommendReply({
  transition,
  recommendations,
  message = '',
  hint,
}: {
  transition?: string
  recommendations: RankedProduct[]
  message?: string
  hint?: string
}): string {
  if (!recommendations.length) return transition?.trim() || ''

  const list = recommendations.slice(0, 3)
  const askedPromo = PROMO_ASK.test(message)
  const hasPromo = list.some(it => it.promo.saved > 0 || it.promo.activity || it.promo.coupon)
  // 主动问了优惠 → 没活动也要说清楚没有，别让人以为藏着；没问但有活动 → 顺手带一句
  const pushPromo = askedPromo || hasPromo

  const blocks: string[] = []

  const head = (transition || '').trim()
  blocks.push(head || '这几个你挑挑——')

  if (askedPromo && !hasPromo) {
    blocks.push('这几样现在都没赶上活动，我按你说的要求挑的：')
  }

  list.forEach((it, i) => blocks.push(itemBlock(it, i, askedPromo)))

  const guidance = choiceGuidance(list)
  if (guidance) blocks.push(guidance)

  if (hasPromo) blocks.push('具体优惠以结算页显示为准')

  blocks.push(
    list.length >= 3 ? '这三样你更想吃哪一挂的？' : hint || '要不要我再换一批？',
  )

  return blocks.join('\n')
}
