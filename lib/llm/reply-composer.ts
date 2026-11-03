// lib/llm/reply-composer.ts
//
// 推荐话术合成：Coze 工作流里那个「客服回复生成器」节点的本地版。
//
// 为什么不用大模型来写这一段：商品名、活动、到手价、注意事项全是硬数据，
// 让模型照着卡片复述一遍必然会错（漏一款、写错价、编出没有的活动都是事故）。
// 所以这里按结构化结果**本地拼人话**——模型的活只有开头那句"接住人"的过渡语，
// 它写完我们再把气泡补完整。
//
// **气泡里不再列商品明细**（2026-11-03 改）：
// 名字、价格、理由、活动、省多少，卡片上都有一份，气泡再报一遍就是"1. XX｜29.9元"
// 这种货架腔，而且模型偶尔自己也写一份，两段拼起来就是缝合怪：
//   "要不你先说句「随便」，我就直接给你排上 1. 麻辣魔芋爽｜29.9元…"
// 明细只有一个出处 = `recommendations` 数组（卡片），气泡只留：
//   过渡语 + 风险提示（无价） + 主推/备选建议（无价） + 收尾话口。

import type { RankedProduct } from '@/lib/llm/local-workflow';
import { PRICE_PATTERN } from '@/lib/rules/patterns';

/** 用户明显在问优惠时才重点说活动，平时有就提一句、没有就不提，别整天像在促销 */
const PROMO_ASK = /优惠|便宜|活动|券|划算|折扣|赠|促销|满减|省钱/;

/**
 * 疑似"教用户怎么说话"或把内部判断逻辑漏出来的句式。
 *
 * 事故原型：追问两轮后用户烦了说「换一批」，气泡里出现
 * "要不你先说句「随便」，我就直接给你排上…"——那是模型把我们内部的
 * `CONSENT_PATTERN`（点头就推货）当成话讲给了用户听。
 * 这类句子必须整句切掉：用户不需要知道系统在等哪个暗号。
 */
export const META_INSTRUCTION_PATTERN =
  /说句|说一句|说个|你就说|只要说|说声|告诉我你(要|想)|我就直接|直接给你排|给你排上|如果|假如|假设|要是你(说|想)/;

/** 一眼像商品明细的行：编号开头，或带「名字｜价格」的分隔符 */
const LIST_START_PATTERN = /^\s*\d+\s*[.、)）]|｜\s*¥?\d/;

/** 按句切：保留标点，句子内部不拆 */
const SENTENCE_SPLIT = /(?<=[。！？!?；;\n])/;

/** 从第一行商品明细开始整段切掉——清单后面跟的理由/注意事项也一并不留 */
function cutFakeList(text: string): string {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => LIST_START_PATTERN.test(l));
  return (idx >= 0 ? lines.slice(0, idx) : lines).join('\n').trim();
}

/**
 * 过渡语清洗：只保留能直接说给人听的话。
 *
 * 三类一律切掉：
 *   1. 商品明细（带编号 / 带价格）——明细归卡片，气泡里报价必错
 *   2. 引导指令（"你先说句随便""如果…我就…"）——把内部逻辑漏给用户
 *
 * 全被切光就返回 undefined，由调用方拿兜底过渡语顶上，绝不留空气泡。
 */
export function sanitizeTransition(reply?: string): string | undefined {
  const text = (reply || '').replace(/\s+$/, '').trim();
  if (!text) return undefined;

  const kept = cutFakeList(text)
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => !PRICE_PATTERN.test(s) && !META_INSTRUCTION_PATTERN.test(s));

  const out = kept
    .join('')
    .replace(/\n{2,}/g, '\n')
    .trim();
  return out || undefined;
}

/** 模型那句被切光了也别空着——按"是不是在换方向"给一句最普通的过渡语 */
function defaultTransition(message: string): string {
  return /换|别的|其他|再来|还有|没有其他/.test(message)
    ? '行，换个方向给你挑——'
    : '行，这几个给你挑好了——';
}

/**
 * 风险提示行：只留不带价格的（"含海产品""辣度较高"），
 * 超预算那句带价、以及"具体优惠以结算页显示为准"下面统一说，不重复。
 */
function riskLine(list: RankedProduct[]): string | null {
  const bits: string[] = [];
  for (const it of list) {
    const notes = it.risk_notes.filter(
      (n) => !PRICE_PATTERN.test(n) && !/具体优惠以结算页/.test(n),
    );
    if (notes.length) bits.push(`${it.name}：${notes.join('，')}`);
  }
  return bits.length ? `⚠ ${bits.join('；')}` : null;
}

/** 主推 / 备选的差异 + 明确选择建议（不带价，价格在卡片上） */
function choiceGuidance(list: RankedProduct[]): string | null {
  if (list.length < 2) return null;

  const main = list[0];
  const cheapest = list.reduce((a, b) => (b.price < a.price ? b : a));

  if (cheapest.name === main.name) return `这几样里我更站${main.name}`;
  return `想综合实力最强选${main.name}，想少花点选${cheapest.name}`;
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
  transition?: string;
  recommendations: RankedProduct[];
  message?: string;
  hint?: string;
}): string {
  if (!recommendations.length) return sanitizeTransition(transition) || '';

  const list = recommendations.slice(0, 3);
  const askedPromo = PROMO_ASK.test(message);
  const hasPromo = list.some((it) => it.promo.saved > 0 || it.promo.activity || it.promo.coupon);

  const blocks: string[] = [];

  blocks.push(sanitizeTransition(transition) || defaultTransition(message));

  // 主动问了优惠 → 没活动也要说清楚没有，别让人以为藏着
  if (askedPromo && !hasPromo) blocks.push('这几样现在都没赶上活动，我按你说的要求挑的');

  const risk = riskLine(list);
  if (risk) blocks.push(risk);

  const guidance = choiceGuidance(list);
  if (guidance) blocks.push(guidance);

  if (hasPromo) blocks.push('具体优惠以结算页显示为准');

  blocks.push(list.length >= 3 ? '这三样你更想吃哪一挂的？' : hint || '要不要我再换一批？');

  return blocks.filter(Boolean).join('\n');
}
