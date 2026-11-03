// lib/llm/local-workflow.ts
// 本地工作流：把 Coze 工作流（workflow.txt）里那条商品链路搬到代码里，不依赖任何外部编排。
//
// 节点对应关系（括号内是 workflow.txt 里的节点名 / id）：
//   需求抽取        （139202 信息需求提取）
//   信息完整判断    （167988）→ 只在真正没法推时才追问，避免"来点吃的"被追问劝退
//   检索 Query 生成 （104415 query生成）
//   知识库检索      （183290）
//   硬过滤          （138157）
//   推荐排序        （117173，含活动 / 优惠券 / 凑单 / 风险边界）
//   推荐理由        （180266）
//   安全与合规      （175174）
//
// 排序权重沿用工作流第五节：需求匹配 35 / 优惠 20 / 质量 15 / 转化 10 / 毛利 10 / 库存 5 / 售后 5

import { VAGUE_EAT_PATTERN } from '@/lib/rules/patterns';
import type { Preferences, Filters } from '@/lib/llm';
import { PRODUCTS, type Product } from '@/lib/data/snacks';
import { pricePlan, getMember, describePlan, type PricePlan } from '@/lib/data/promos';
import { extractCategories, CATEGORY_TRIGGERS } from '@/lib/llm/category-words';
import { timeContext } from '@/lib/llm/time-context';
import type { RecalledMemory } from '@/lib/memory/store';

// ─── 需求（139202 的输出口径）─────────────────────────
export interface Need {
  budget_min: number | null;
  budget_max: number | null;
  category_preference: string[];
  taste_preference: string[];
  scene: string;
  purpose: string;
  package_preference: string[];
  people: string[];
  avoid_tags: string[];
  must_have_tags: string[];
  quantity_preference: string;
  gift_need: boolean;
  missing_fields: string[];
  raw_user_need: string;
  /** 用户原话。检索时要从里面捞出"点名的那一款"，光靠归类后的 category 会丢掉精准度 */
  raw_message: string;
  /** 本轮情绪，排序时给"烦→辣、难过→甜"这类软倾向 */
  emotion: string;
}

// ─── 检索（104415 + 183290）──────────────────────────
export interface RagQuery {
  rag_query: string;
  positive_terms: string[];
  negative_terms: string[];
  retrieval_focus: string[];
  /**
   * 品类词（坚果炒货 / 饼干膨化 …）。
   * 单独拎出来是因为它的命中价值比口味、场景高得多——用户点名要坚果，
   * 就该先把坚果捞上来，而不是让"场景/情绪"的软命中占着前排。
   */
  category_terms: string[];
  /**
   * 用户点名的具体款（"薯片""巧克力"这类钩子词），在商品**名字**里命中就大幅加分。
   * 只靠归类后的 category（饼干膨化/糖果）会把真正的那一款淹没在同品类兄弟里。
   */
  name_terms: string[];
  top_k: number;
}

// ─── 排序输出（117173 + 180266）──────────────────────
export interface RankedProduct {
  sku_id: string;
  name: string;
  category: string;
  price: number;
  reason: string;
  emoji: string;
  taste_tags: string[];
  matched_tags: string[];
  score: number;
  rank: number;
  /** 面向用户的推荐理由，2-3 条 */
  user_visible_reasons: string[];
  promo: {
    activity?: string;
    coupon?: string;
    final_price: number;
    saved: number;
    notes: string[];
    add_on?: { name: string; gap: number; extra_saved: number };
    estimated: boolean;
  };
  risk_notes: string[];
}

export interface FilteredProduct {
  name: string;
  filter_reason: string;
}

export interface LocalWorkflowResult {
  need: Need;
  query: RagQuery;
  /** 知识库检索出来的候选（硬过滤前） */
  candidates: Product[];
  /** 硬过滤掉的，带原因，便于排查"为什么没推这个" */
  filtered_out: FilteredProduct[];
  /** 最终 3 款 */
  recommendations: RankedProduct[];
  /** 需要追问时才非空 */
  follow_up?: string;
  /** 候选不足 3 款且用户点名了口味（被口味卡得严）时，给气泡一句诚实说明 */
  shortfall_note?: string;
}

export interface LocalWorkflowInput {
  message: string;
  prefs: Preferences;
  filters?: Filters;
  memory: RecalledMemory;
  userId?: string;
  /** 上一轮推过的款，"换一个"时要避开 */
  exclude?: string[];
  /** 上一轮是不是刚推过卡片：推荐进行中的改条件/换一批不算信息不足，不再追问 */
  inRecommendContext?: boolean;
  /**
   * 用户**亲口给过**的口味（本轮/最近几轮原话、长期 profile、左侧栏选择）。
   * 追问闸用它区分「长期偏好」和「模型当轮脑补」：
   * 模型看见上一句"能嚼着"就填 texture=嚼感，模糊请求下会把追问闸整个绕开——
   * 那是推测不是约束。不传 = 全部算数（兼容没有出处的调用方）。
   */
  statedTaste?: string[];
}

const BUDGET_MAP: Record<string, { min: number | null; max: number | null }> = {
  '30元内': { min: null, max: 30 },
  '30-60元': { min: 30, max: 60 },
  '60元以上': { min: 60, max: null },
  不限: { min: null, max: null },
};

/** 预算文案 → 区间。兜底链路也用这张表，别各写一份 */
export function budgetFromText(budget?: string): {
  min: number | null;
  max: number | null;
} {
  return BUDGET_MAP[budget || ''] || { min: null, max: null };
}

/**
 * 忌口文案 → 硬过滤标签。
 *
 * 辣度由 spicy 分级接管（见 `violateHardConstraint`），标签只用来兜住其它忌口。
 * 过敏原必须映射到 `allergens` 字段里用的那几个词（花生 / 坚果 / 海产品 / 乳制品），
 * 两边对不上就会漏：以前"花生过敏"只映射成「坚果」，结果 allergens 里写「花生」的商品
 * 一条都拦不住——鱿鱼丝（allergens=['海产品']、category 是「海味零食」）也是同一个漏法。
 */
const AVOID_TAGS: Record<string, string[]> = {
  不吃辣: ['辣味'],
  不想吃辣: ['辣味'],
  不能吃辣: ['辣味'],
  忌辣: ['辣味'],
  不吃甜: ['甜味'],
  不想吃甜: ['甜味'],
  不吃酸: ['酸味'],
  花生过敏: ['坚果', '花生'],
  坚果过敏: ['坚果'],
  海鲜过敏: ['海产品'],
  海产品过敏: ['海产品'],
  奶过敏: ['乳制品'],
  乳制品过敏: ['乳制品'],
  乳糖不耐: ['乳制品'],
};

/** 场景与辣味的冲突：这些场景下没人想啃变态辣 */
const CALM_SCENES = ['海边', '户外', '办公室', '看剧', '爬山'];

/** 一句用户原话 / 记忆文本 → 它表达的忌口标签（没有则空数组） */
export function avoidTagsFromText(text?: string): string[] {
  const t = (text || '').trim();
  if (!t) return [];
  const out = new Set<string>();
  for (const [k, tags] of Object.entries(AVOID_TAGS)) {
    if (t.includes(k)) tags.forEach((x) => out.add(x));
  }
  return [...out];
}

/**
 * 从长期记忆里捞出安全硬约束（过敏 / 禁食 / 明确忌口）。
 *
 * 公开导出：出卡片前那道闸（点名要货 / 兜底）也要用同一份口径，
 * 不能只有主工作流记得忌口。
 */
export function memoryAvoidTags(memory: RecalledMemory): string[] {
  const texts = [...memory.core_profile, ...memory.summary_memory, ...memory.active_fragments];
  const out = new Set<string>();
  for (const t of texts) avoidTagsFromText(t).forEach((x) => out.add(x));
  return [...out];
}

/** 硬约束的入参：`Need` 是它的超集，兜底链路自己拼一份最小的 */
export interface HardConstraints {
  avoid_tags: string[];
  budget_min: number | null;
  budget_max: number | null;
  scene?: string;
  gift_need?: boolean;
  people?: string[];
  exclude?: string[];
  /** 忌辣时是否容忍微辣。默认 false——忌口是死命令，微辣也得出局 */
  allow_mild_spicy?: boolean;
  /** 允许超出预算的比例，沿用工作流的 20% */
  over_budget_ratio?: number;
  /** 用户明确点名的口味强诉求（辣味/甜味/咸味/酸味/清淡），必须真有才合格；口感词不算 */
  required_taste?: string[];
}

/** 口味强诉求白名单：只有这些才算"要什么口味"，口感词（脆/软/嚼感解压）只是软偏好 */
export const HARD_TASTE_WORDS = new Set(['辣味', '甜味', '咸味', '酸味', '清淡']);

/**
 * 对应 Coze 工作流节点 138157：硬过滤（单品判定）
 *
 * 138157 硬过滤的**单品判定**。
 *
 * 单独抽出来是为了让兜底链路（`orchestrator.matchLocalFallback`）跟主链路用同一份口径。
 * 以前两处各判各的，兜底更松：忌辣时只砍到 spicy<2（微辣放行）、过敏只看标签不看
 * allergens、连「已售罄」都不查——主流程一报错，卖不出去的和不能吃的就一起端上来了。
 *
 * @returns 出局原因；返回 `null` 表示这件商品合格
 */
export function violateHardConstraint(p: Product, c: HardConstraints): string | null {
  if (c.exclude?.includes(p.name)) return '上一轮刚推过，这一轮先避开';
  if (p.stock === 'out_of_stock') return '没货了';

  const hay = [...p.taste_tags, ...p.scenes, ...p.category, ...p.name];
  const noSpicy = c.avoid_tags.includes('辣味');

  // 忌辣是死命令：微辣也一并避开，不能拿"就一点点辣"糊弄
  if (noSpicy && p.spicy > (c.allow_mild_spicy ? 1 : 0)) return '用户不吃辣';

  // 口味是强诉求：要什么口味，商品就得真有，否则别进候选。
  // 口感词（脆/软/嚼感解压）不算——那是软偏好，留给 rank 打分，不能硬砍。
  const wantsTaste = (c.required_taste || []).filter((t) => HARD_TASTE_WORDS.has(t));
  const wantsSpicy = wantsTaste.includes('辣味');

  // 轻松场景下不推重辣——但用户**明说要辣**时，场景不能反客为主把口味强诉求压掉
  // （旧逻辑：海边+要辣，火鸡面/辣味花生被"海边场景不适合重辣"砍掉，反而推了不辣的雪饼）
  const calmScene = c.scene && CALM_SCENES.includes(c.scene);
  if (!noSpicy && !wantsSpicy && calmScene && p.spicy >= 2) return `${c.scene}场景不适合重辣`;

  if (wantsSpicy && p.spicy === 0) return '用户要辣的，这个不辣';

  // 忌口：命中标签即出局
  const badTag = c.avoid_tags.find((t) => t !== '辣味' && hay.some((h) => h.includes(t)));
  if (badTag) return `用户明确不要${badTag}`;

  // 过敏原：只看标签不够，allergens 字段里写明的一律挡掉
  const badAllergen = p.allergens.find((a) => c.avoid_tags.includes(a));
  if (badAllergen) return `含${badAllergen}，用户过敏`;

  if (c.gift_need && !p.gift_ok) return '不适合送礼';
  if ((c.people || []).includes('孩子') && !p.child_ok) return '不适合儿童';

  // 其他口味（甜/咸/酸/清淡）：必须落在商品 taste_tags 里才算数
  const otherTaste = wantsTaste.filter((t) => t !== '辣味');
  if (otherTaste.length && !otherTaste.some((t) => p.taste_tags.some((x) => x.includes(t))))
    return `用户要${otherTaste.join('、')}的`;

  // 预算：工作流规则是超出 20% 才砍，略微超预算的留着当备选
  const ratio = c.over_budget_ratio ?? 0.2;
  if (c.budget_max != null && p.price > c.budget_max * (1 + ratio)) {
    return `超出预算（${p.price}元 > ${c.budget_max}元）`;
  }
  return null;
}

/** 139202：把大脑抽的偏好 + 左侧栏 + 长期记忆合成一份推荐需求 */
export function buildNeed(input: LocalWorkflowInput): Need {
  const { prefs, filters, memory, message } = input;
  const taste = new Set<string>();
  if (filters?.flavor) taste.add(filters.flavor);
  if (prefs.flavor && prefs.flavor !== 'null') taste.add(prefs.flavor);
  if (prefs.texture && prefs.texture !== 'null') taste.add(prefs.texture);

  const budget = BUDGET_MAP[filters?.budget || prefs.budget || ''] || {
    min: null,
    max: null,
  };

  const avoid = new Set<string>();
  const avoidText = (prefs.avoid || '').trim();
  if (avoidText && avoidText !== 'null') {
    for (const [k, tags] of Object.entries(AVOID_TAGS)) {
      if (avoidText.includes(k)) tags.forEach((t) => avoid.add(t));
    }
    if (/花生过敏|坚果过敏/.test(avoidText)) avoid.add('坚果');
    if (/海鲜|海产品/.test(avoidText)) avoid.add('海产品');
    if (/奶|乳糖/.test(avoidText)) avoid.add('乳制品');
  }
  memoryAvoidTags(memory).forEach((t) => avoid.add(t));

  /**
   * 本轮明说要辣，就别再拿旧忌口把"辣味"一起躲掉。
   *
   * 两边都留着会得到 `taste=['辣味']` + `avoid=['辣味']` 的自相矛盾需求，
   * `hardFilter` 把辣款全踢光 → 0 候选 → 回一句"这个条件有点刁钻"。
   * 用户明明说了想吃什么，系统却把它当成不讲理的要求。
   *
   * "不吃辣"是口味忌口（不是过敏），当面说"想吃辣的"本身就意味着改口；
   * 要不要真改由记忆层的 pending 追问决定，**本轮先按用户此刻说的来**。
   * 过敏原（花生/坚果/海鲜/乳制品）不在此列——那是死命令，绝不为口味让路。
   */
  if (taste.has('辣味')) avoid.delete('辣味');

  const scene = (prefs.scene || '').trim();
  const gift_need = /送礼|送人|送朋友|送客户|送同事|伴手礼/.test(message);

  const missing: string[] = [];
  if (!taste.size) missing.push('口味');
  if (!scene) missing.push('场景');
  if (budget.max == null) missing.push('预算');

  // 品类必须落到 the_query 的正排里：历史上 category_preference 一直是空数组，
  // 结果"想吃坚果"捞不上坚果，被场景/情绪的软命中顶掉——这是用户看得见的硬伤
  const category_preference = extractCategories(message, prefs.category);

  return {
    budget_min: budget.min,
    budget_max: budget.max,
    category_preference,
    taste_preference: [...taste],
    scene,
    purpose: gift_need ? '送人' : '自己吃',
    package_preference: [],
    people: gift_need ? ['朋友'] : ['自己'],
    avoid_tags: [...avoid],
    must_have_tags: [],
    quantity_preference: '',
    gift_need,
    missing_fields: missing,
    raw_user_need: describeNeed(message, [...taste], scene, budget.max, [...avoid], gift_need),
    raw_message: message,
    emotion: (prefs.emotion || '').trim(),
  };
}

function describeNeed(
  message: string,
  taste: string[],
  scene: string,
  budgetMax: number | null,
  avoid: string[],
  gift: boolean,
): string {
  const parts: string[] = [];
  if (taste.length) parts.push(`想要${taste.join('、')}`);
  if (scene) parts.push(`${scene}吃`);
  if (budgetMax != null) parts.push(`${budgetMax}元以内`);
  if (avoid.length) parts.push(`避开${avoid.join('、')}`);
  if (gift) parts.push('用来送人');
  return parts.length
    ? `用户说「${message}」，${parts.join('，')}`
    : `用户说「${message}」，没有附加条件`;
}

/** 104415：需求 → 检索词。负向词单独列出，硬过滤阶段要用 */
export function buildQuery(need: Need, exclude: string[] = []): RagQuery {
  const positive = [...need.taste_preference];
  if (need.scene) positive.push(need.scene);
  if (need.emotion) positive.push(need.emotion);
  if (need.gift_need) positive.push('礼盒', '包装好');
  if (need.category_preference.length) positive.push(...need.category_preference);

  const negative = [...need.avoid_tags];
  if (need.avoid_tags.includes('辣味')) negative.push('中辣', '重辣', '麻辣', '香辣');

  return {
    rag_query: [need.scene, ...need.taste_preference, ...need.category_preference, need.purpose]
      .filter(Boolean)
      .join(' '),
    positive_terms: Array.from(new Set(positive)),
    negative_terms: Array.from(new Set([...negative, ...exclude])),
    retrieval_focus: need.scene ? [need.scene] : need.taste_preference,
    category_terms: need.category_preference,
    name_terms: Array.from(
      new Set([
        ...CATEGORY_TRIGGERS.filter((w) => (need.raw_message || '').includes(w)),
        ...need.taste_preference,
      ]),
    ),
    top_k: 8,
  };
}

/** 183290：知识库检索。没有向量库，按标签命中打分取 top_k */
export function retrieve(query: RagQuery, pool: Product[] = PRODUCTS): Product[] {
  const scored = pool.map((p) => {
    const haystack = [...p.taste_tags, ...p.scenes, ...p.emotions, p.category, p.name];
    const hit = query.positive_terms.filter((t) => haystack.some((h) => h.includes(t))).length;
    const neg = query.negative_terms.filter((t) => haystack.some((h) => h.includes(t))).length;
    // 品类是硬需求（"我要坚果"），命中一次抵三次普通过词：不能被场景/情绪的软命中挤下去
    const catHit = query.category_terms.filter((c) => p.category.includes(c)).length;
    // 点名某个具体款（"来点薯片"）时，名字命中的必须站到最前，不能被同品类的兄弟盖掉
    const nameHit = query.name_terms.filter((t) => p.name.includes(t)).length;
    return { p, score: hit + catHit * 3 + nameHit * 5 - neg * 2 };
  });
  return scored
    .sort((a, b) => b.score - a.score || b.p.quality - a.p.quality)
    .slice(0, query.top_k)
    .map((x) => x.p);
}

/** 138157：硬过滤。命中任一硬约束就出局，并写明原因 */
export function hardFilter(
  candidates: Product[],
  need: Need,
  exclude: string[] = [],
): { qualified: Product[]; filtered_out: FilteredProduct[] } {
  const qualified: Product[] = [];
  const filtered_out: FilteredProduct[] = [];
  for (const p of candidates) {
    // 口径统一收敛到 violateHardConstraint：兜底链路也走同一份判定
    const reason = violateHardConstraint(p, {
      ...need,
      exclude,
      required_taste: need.taste_preference,
    });
    if (reason) {
      filtered_out.push({ name: p.name, filter_reason: reason });
      continue;
    }
    qualified.push(p);
  }

  return { qualified, filtered_out };
}

/** 117173 + 180266：排序、算优惠、写理由、标风险 */
export function rank(
  qualified: Product[],
  need: Need,
  query: RagQuery,
  userId?: string,
): RankedProduct[] {
  const member = getMember(userId);
  // 时间上下文：白天推"深夜款"（商品理由里就写着"深夜也不腻"）等于当着人面念错台词
  const { isNight } = timeContext();
  const userSaidNight = /深夜|夜宵|熬夜|通宵|睡前|加班到/.test(need.raw_message || '');

  const scored = qualified.map((p) => {
    const hay = [...p.taste_tags, ...p.scenes, ...p.emotions, p.category, p.name];
    const matched = query.positive_terms.filter((t) => hay.some((h) => h.includes(t)));
    const plan = pricePlan([{ product: p, qty: 1 }], member);
    // 点了某一类货，这类必须站前排：标签层面的软命中（"嚼感"）抢不过"我要坚果"
    const categoryBonus = need.category_preference.some((c) => p.category.includes(c)) ? 25 : 0;
    // 点了名这一款（"来点薯片"），名字命中的直接顶到第一
    const nameBonus = query.name_terms.some((t) => p.name.includes(t)) ? 18 : 0;
    /**
     * 辣度匹配：用户要辣时，中辣(2)最合适，重辣(3)次之，微辣(1)只能算"有个辣字"。
     *
     * 不加这一段的话，「想吃辣的」会把黑胡椒薯角（微辣）这种 quality/毛利高的款
     * 顶到前三——它们标签里确实有"辣"，但用户咬一口就知道不辣，
     * 接着就是"这些也不辣"的质疑。实测就是这么翻车的。
     */
    const wantsSpicy = need.taste_preference.includes('辣味');
    const spicyBonus = wantsSpicy
      ? p.spicy === 2
        ? 18
        : p.spicy === 3
          ? 14
          : p.spicy === 1
            ? 4
            : 0
      : 0;
    // 时段对得上才推：白天把"深夜"场景的款压下去（用户明说熬夜/夜宵除外），夜里反过来给点优势
    const nightScene = p.scenes.includes('深夜');
    const timeBonus =
      nightScene && !isNight && !userSaidNight ? -20 : nightScene && isNight ? 8 : 0;

    const needScore = (matched.length / Math.max(1, query.positive_terms.length)) * 35;
    const promoScore = Math.min(1, plan.saved / Math.max(1, p.price)) * 20;
    const qualityScore = (p.quality / 100) * 15;
    const convertScore = (matched.length ? 8 : 4) + (p.quality >= 85 ? 2 : 0);
    const marginScore = (p.margin / 100) * 10;
    const stockScore = p.stock === 'in_stock' ? 5 : 0;
    const riskScore = p.allergens.length === 0 ? 5 : p.allergens.length === 1 ? 3 : 1;

    const score = Math.round(
      needScore +
        promoScore +
        qualityScore +
        convertScore +
        marginScore +
        stockScore +
        riskScore +
        categoryBonus +
        nameBonus +
        timeBonus +
        spicyBonus,
    );

    return {
      product: p,
      matched,
      plan,
      score,
      reasons: buildReasons(p, need, plan),
      risk_notes: buildRiskNotes(p, need, plan),
    };
  });

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x, i) => ({
      sku_id: x.product.sku_id,
      name: x.product.name,
      category: x.product.category,
      price: x.product.price,
      reason: x.product.reason,
      emoji: x.product.emoji,
      taste_tags: x.product.taste_tags,
      matched_tags: x.matched,
      score: x.score,
      rank: i + 1,
      user_visible_reasons: x.reasons,
      promo: {
        activity: x.plan.activity?.name,
        coupon: x.plan.coupon?.name,
        final_price: x.plan.final_price,
        saved: x.plan.saved,
        notes: describePlan(x.plan),
        add_on: x.plan.add_on
          ? {
              name: x.plan.add_on.product.name,
              gap: x.plan.add_on.gap,
              extra_saved: x.plan.add_on.extra_saved,
            }
          : undefined,
        estimated: x.plan.estimated,
      },
      risk_notes: x.risk_notes,
    }));
}

/**
 * 卡片上的推荐理由。这段是给用户看的"朋友话术"，
 * 写成字段校验报告（"对得上你说的XX"）就没人读了。
 * 价格、省钱、过敏原这些硬信息照准，只是换个说法。
 */
const SCENE_REASON: Record<string, string> = {
  海边: '吹着海风吃这个刚好',
  户外: '带出门扛饿，还不占地方',
  看剧: '追剧的时候嘴别闲着',
  加班: '加班垫一口正好',
  办公室: '抽屉里备着，摸鱼来一口',
};

/**
 * 对应 Coze 工作流节点 180266：推荐理由
 *
 * 卡片上那两三行"为什么是它"。话术要像朋友在挑，不能像字段校验报告
 * （"对得上你说的XX"这种没人读）。价格、省钱、过敏原照准，只是换个说法。
 */
function buildReasons(p: Product, need: Need, _plan: PricePlan): string[] {
  // _plan 现在用不上：价格/省钱那几句已归卡片（气泡里不许报价，见 reply-composer），
  // 留着这个形参是为了和 180266 节点的入参口径一致，调用方不必跟着改。
  const out: string[] = [p.reason];

  // 口味理由必须落到商品自己身上：要辣得真辣，要甜/咸/酸/清淡得 taste_tags 真有。
  // 否则就会出现"不辣的雪饼，理由写冲着你要的辣味挑的"这种指鹿为马。
  const tasteWords = (need.taste_preference || []).filter((t) => HARD_TASTE_WORDS.has(t));
  /**
   * 辣味门槛是 `>= 2`：微辣(1)只是"有个辣字"，拿它写"冲着你要的辣味挑的"
   * 就是当面扯谎——用户下一句必然是"这些也不辣"。
   * 微辣的款单独诚实交代一句，放下面。
   */
  const realTaste = tasteWords.filter((t) =>
    t === '辣味' ? p.spicy >= 2 : p.taste_tags.some((x) => x.includes(t)),
  );
  const tags = realTaste.filter((t) => t !== need.scene && !need.category_preference.includes(t));
  if (tags.length) out.push(`冲着你要的${tags.slice(0, 2).join('、')}挑的`);
  // 要辣却只有微辣：给就得说清楚，别让"冲着你要的辣味"替它背书
  if (!tags.includes('辣味') && tasteWords.includes('辣味') && p.spicy === 1) {
    out.push('微辣，只能提个味（不算重辣）');
  }

  // 场景是软偏好，不强求商品带场景标签：带就写专属句；不带就诚实说"不一定是专属但吃着也爽"
  if (need.scene) {
    if (p.scenes.includes(need.scene)) {
      out.push(SCENE_REASON[need.scene] || `${need.scene}吃这个刚好`);
    } else {
      out.push(`虽然不一定是${need.scene}专属，但在${need.scene}吃也很爽`);
    }
  }
  // 到手价不写在这里：推荐话术块（reply-composer）会按同一份 plan 说一遍，写两次就是复读
  if (p.allergens.length === 0) out.push('没常见过敏原，吃着省心');
  return out.slice(0, 3);
}

/**
 * 对应 Coze 工作流节点 175174：安全与合规
 *
 * 过敏原、超预算、辣度、优惠口径这些**硬事实**。
 * 本地生成，不交给模型——让模型写风险提示等于让它现编。
 */
function buildRiskNotes(p: Product, need: Need, plan: PricePlan): string[] {
  const out: string[] = [];
  if (need.budget_max != null && p.price > need.budget_max) out.push(`略超预算（${p.price}元）`);
  if (p.allergens.length) out.push(`含${p.allergens.join('、')}`);
  if (plan.saved > 0) out.push('具体优惠以结算页显示为准');
  if (p.spicy >= 2) out.push('辣度较高，肠胃敏感慎入');
  return out;
}

/** 175174：合规复核。本地生成的话术不会吹牛，主要防"把忌口商品推出来"这类硬事故 */
export function complianceCheck(list: RankedProduct[], need: Need): RankedProduct[] {
  return list.filter((item) => {
    const p = PRODUCTS.find((x) => x.sku_id === item.sku_id);
    if (!p) return false;
    if (need.avoid_tags.includes('辣味') && p.spicy > 0) return false;
    for (const tag of need.avoid_tags) {
      if (tag === '辣味') continue;
      if ([...p.taste_tags, ...p.scenes, ...p.category, p.name].some((h) => h.includes(tag)))
        return false;
    }
    return true;
  });
}

/**
 * 167988 信息完整判断——追问话术池。约束不足时先问方向，等用户报完偏好再出卡片。
 * （原 Coze 工作流的追问节点被移植时丢了"约束计数"语义，这里补回来）
 */
const INTAKE_QUESTIONS = [
  '先给我个方向呗——爱吃甜的还是咸的？辣的能不能来？有预算也报个数',
  '想吃哪一口的？甜口咸口辣口都行，说个场景也行（加班垫肚子、追剧解馋、送人）',
  '别急，先说你想吃啥味的？我按口味给你排',
];

/**
 * "想吃点啥""来点吃的"这类**没开口说清要什么**的请求。
 * 这时候如果拿前几轮攒下的场景（办公室/加班）当约束，就会直接甩一堆卡片出去——
 * 用户会觉得：我明明什么都没说，你怎么就替我决定了。
 */
// 「想吃点啥」这类没说清要什么的说法：见 lib/rules/patterns.ts 的 VAGUE_EAT_PATTERN

function pickIntakeQuestion(seed: string): string {
  let h = 0;
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return INTAKE_QUESTIONS[h % INTAKE_QUESTIONS.length];
}

/**
 * 167988 信息完整判断（检索前的闸门）：数有效约束
 * （预算/品类/口味/场景/目的/包装/忌口/送礼对象/特殊人群）。
 *
 * - 0 个约束 → 追问一次，本轮不出卡片，等用户报完偏好下一轮再推
 * - 有任一明确约束 → 直接推。不按原工作流"至少 3 个"卡死——
 *   "推荐个不辣的"这种带着明确条件的请求，追问反而招人烦
 * - 安全缺口优先：送礼不写对象、孩子/孕妇没说忌口，先问再推
 * - 已经在推荐流程里（改条件/换一批）不追问，直接推
 */
export function recommendIntake(
  need: Need,
  input: Pick<LocalWorkflowInput, 'inRecommendContext' | 'message' | 'statedTaste'>,
): string | undefined {
  if (input.inRecommendContext) return undefined;

  if (need.gift_need && !need.people.some((x) => x !== '自己'))
    return '这份是送谁呀？我按对象挑包装';
  if (need.people.some((x) => /孩子|孕妇|老人/.test(x)) && !need.avoid_tags.length) {
    return '给孩子吃的话，有没有要避开的（辣、坚果、海鲜）？';
  }

  // 口味/口感要能在用户原话里找到对应字眼才算数——
  // 模型有时会从情绪脑补出口感（"烦"→嚼感），那是推测不是约束
  const statedInMessage = (vals: string[]) =>
    vals.some((v) => !!v && !!input.message && input.message.includes(v));

  // 模糊请求下，旧场景不算数：必须本轮自己提到（"看海配点零食"才是有效场景约束），
  // 否则几轮前聊过"上班"，这轮一句"想吃点啥"就会被当成"信息够了"直接推
  const vague = VAGUE_EAT_PATTERN.test(input.message || '');
  const sceneCounts = vague ? statedInMessage([need.scene]) : !!need.scene;

  // 口味/口感**不算**"本轮才说出口"的东西：它是长期偏好——"我爱吃甜的"记进
  // profile，十轮之后依然成立，跨轮有效正是记它的意义。UI 侧栏选的 flavor 同理。
  // 以前这里也要求"原话里带口味字眼"，结果偏好明晃晃记着"甜味"，
  // 张口还问"爱吃甜的还是咸的"——同一个偏好，过滤时信、判定时不信，自相矛盾。
  // 场景不走这条：它是临时语境，不是持久偏好，所以只保留上面的本轮验证。
  //
  // 但"长期偏好"不等于"模型当轮的推测"。这里只看 **`statedTaste`**（用户原话 /
  // profile / 左侧栏，有出处的那部分）：模型看见上一句自己写的"配点能嚼着的"就填
  // texture=嚼感，看见"烦"也填嚼感——拿它当约束会把追问闸整个绕开，
  // 等于我们把自己的推销稿、自己的情绪解读当成了用户提的要求。
  // 用户明说的话本地抽得到（见 extractPrefsFromText），那份一样算数。
  const tasteCounts = input.statedTaste
    ? need.taste_preference.some((t) => input.statedTaste!.includes(t))
    : need.taste_preference.length > 0;

  const hasConstraint = [
    need.budget_min !== null || need.budget_max !== null,
    need.category_preference.length > 0,
    tasteCounts,
    sceneCounts,
    // '自己吃' 是 buildNeed 的默认值，不是用户说出来的约束，不能计数
    !!need.purpose && need.purpose !== '自己吃',
    need.package_preference.length > 0,
    need.avoid_tags.length > 0,
    need.people.some((x) => x !== '自己'),
  ].some(Boolean);

  return hasConstraint ? undefined : pickIntakeQuestion(input.message || '推荐');
}

/**
 * 167988 的另一半：检索排序之后，够格商品不足 3 款时引导放宽条件。
 * 约束不足的追问已前移到 recommendIntake，这里只管"条件太刁钻没货"。
 */
export function needFollowUp(qualifiedCount: number, tasteBlocked = false): string | undefined {
  // 有货就出卡片，别为凑 3 张硬推不想要的；一款都没有才追问
  if (qualifiedCount >= 1) return undefined;
  // "条件刁钻"这四个字把锅甩给用户，而且含糊——用户根本不知道自己哪条要求过分。
  // 分开说：被口味卡住就直说这批货没有对得上的，其余按预算/库存说明。
  if (tasteBlocked) {
    return '你要的这个口味这批里确实没有完全对得上的，换成微辣/中辣，还是换个味道我再找？';
  }
  return '这批里没有完全对得上的，换个口味或放宽点预算我再找？';
}

/** 整条链路：需求 → 检索 → 硬过滤 → 排序 → 合规 */
export function runLocalWorkflow(input: LocalWorkflowInput): LocalWorkflowResult {
  const exclude = input.exclude || [];
  const need = buildNeed(input);
  const query = buildQuery(need, exclude);

  // 167988 信息完整判断前移到检索之前：约束不足先追问，不出卡片
  const intake = recommendIntake(need, input);
  if (intake) {
    return {
      need,
      query,
      candidates: [],
      filtered_out: [],
      recommendations: [],
      follow_up: intake,
    };
  }

  const candidates = retrieve(query);
  const { qualified, filtered_out } = hardFilter(candidates, need, exclude);

  // 检索层太窄时放宽一次：先去掉 exclude，再把候选池扩到全库。
  //
  // 注意这一步必须**绕开 retrieve**：它按 query 打分后只留 top_k，
  // 而"辣味""嚼感"这类软命中会把辣款顶满前排，紧接着又被忌辣硬约束砍掉——
  // 于是"不吃辣 + 10元内"只剩一两款，放宽了个寂寞（以前 `retrieve(query, PRODUCTS)` 就是这么写的）。
  // 放宽时改成全库直接过硬约束：忌口 / 预算 / 库存一条不放，
  // 贴不贴合交给 rank 的评分去体现（命中 query 的自然排在前面），总比只给一张卡强。
  const finalQualified = qualified;
  let allFiltered = filtered_out;
  if (qualified.length < 3) {
    const wider = hardFilter(PRODUCTS, need, []);
    for (const p of wider.qualified) {
      if (!finalQualified.some((x) => x.sku_id === p.sku_id)) finalQualified.push(p);
    }
    allFiltered = wider.filtered_out;
  }

  const ranked = complianceCheck(rank(finalQualified, need, query, input.userId), need);

  // 候选不足 3 款、且用户点名了口味（被口味卡得严）→ 气泡诚实说一声，别假装很丰富
  const hasTasteWant = (need.taste_preference || []).some((t) => HARD_TASTE_WORDS.has(t));
  const shortfall_note =
    ranked.length > 0 && ranked.length < 3 && hasTasteWant
      ? `符合要求的就这几款${need.scene ? `，${need.scene}带辣的确实不多` : ''}，我先按最对味的来，要不要看看别的？`
      : undefined;

  return {
    need,
    query,
    candidates,
    filtered_out: allFiltered,
    recommendations: ranked,
    // 被口味卡住时（"要辣的"但全库只剩微辣/不辣），追问话术要说人话
    follow_up: needFollowUp(ranked.length, hasTasteWant),
    shortfall_note,
  };
}
