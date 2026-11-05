// lib/llm/category-words.ts
// 品类词表：label → 用户可能说出的口语句。大脑（preferences.category）和本地抽取共用一份，
// 谁先抽到都算——大脑偶尔把"想吃坚果"抽成 scene/口味，本地这层就是它的兜底。

export const CATEGORY_WORDS: Record<string, string[]> = {
  坚果炒货: [
    '坚果',
    '花生',
    '瓜子',
    '腰果',
    '核桃',
    '杏仁',
    '巴旦木',
    '夏威夷果',
    '栗子',
    '开心果',
    '碧根果',
    '松子',
  ],
  饼干膨化: [
    '饼干',
    '锅巴',
    '薯片',
    '膨化',
    '米饼',
    '苏打饼',
    '威化',
    '玉米棒',
    '曲奇',
    '虾条',
    '雪饼',
    '蛋卷',
    '米果',
    '薯条',
  ],
  肉类零食: [
    '肉干',
    '肉脯',
    '猪肉脯',
    '牛肉',
    '肉松',
    '烤肠',
    '凤爪',
    '鸡爪',
    '鸡翅',
    '鸭脖',
    '卤味',
    '鸭货',
    '鸭翅',
  ],
  素食零食: ['魔芋', '素食', '蒟蒻'],
  豆制品: ['豆干', '辣条', '豆腐干', '腐竹', '素牛排', '辣片', '豆筋'],
  方便速食: ['方便面', '泡面', '火鸡面', '速食', '自热', '拌面', '螺蛳粉', '酸辣粉', '热干面'],
  海苔: ['海苔', '紫菜'],
  海味零食: ['鱿鱼', '海鲜', '鱼片', '虾', '鳕鱼', '小鱼干', '鱼豆腐'],
  果脯蜜饯: ['果脯', '蜜饯', '话梅', '酸梅', '梅子', '山楂', '酸枣', '果丹皮', '果干'],
  糖果: [
    '糖果',
    '巧克力',
    '软糖',
    '牛奶糖',
    '棒棒糖',
    '口香糖',
    '牛轧糖',
    '棉花糖',
    '跳跳糖',
    '酥糖',
  ],
  糕点: ['蛋糕', '糕点', '蛋黄酥', '面包', '麻薯', '凤梨酥', '老婆饼'],
  果冻布丁: ['果冻', '布丁', '啫喱'],
  礼盒: ['礼盒', '礼包', '伴手礼', '手信'],
};

/** 全部触发词的扁平列表，给「用户是不是在要货」的判断用 */
export const CATEGORY_TRIGGERS: string[] = Array.from(
  new Set(Object.values(CATEGORY_WORDS).flat()),
);

/** 从用户原话抽品类（可再合并大脑给的 category） */
export function extractCategories(message: string, modelCategory?: string): string[] {
  const out = new Set<string>();
  for (const [category, words] of Object.entries(CATEGORY_WORDS)) {
    if (words.some((w) => message.includes(w))) out.add(category);
  }
  const c = (modelCategory || '').trim();
  if (c && c !== 'null' && Object.prototype.hasOwnProperty.call(CATEGORY_WORDS, c)) out.add(c);
  return [...out];
}

/** 原话里有没有点名某一类货（不含"过敏/不吃"这类反向说法） */
export function mentionsGoods(message: string): boolean {
  const t = (message || '').trim();
  if (!t) return false;
  if (/过敏|不吃|不想吃|戒|忌/.test(t)) return false; // "坚果过敏"是在忌口，不是在要货
  return CATEGORY_TRIGGERS.some((w) => t.includes(w));
}
