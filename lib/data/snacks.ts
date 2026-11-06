// lib/data/snacks.ts
// 商品知识库：对接真实商品清单（50 SKU）
//
// V3.0「库为源、内存为算」：Product 表是唯一数据源（Admin 后台改库），
// 本文件的 PRODUCTS / PRODUCT_BY_NAME / PRODUCT_BY_SKU 是**内存视图**——
// 引用永远不变（业务代码 import 的就是那个数组/Map 对象），内容在启动时
// 从库同步（syncProductCache）。RAW 派生的静态数据只作启动兜底：
// 未 seed 的空库 / 读库失败时沿用，并打警告。
// 对外接口（数组形状、Map、allergensOf）与 V2 完全一致，检索链路零改动。
//
// ⚠️ 本文件必须保持**纯数据**（无 DB / 无 node 内置模块 import）：它会被
// webpack 打进客户端 bundle（前端经 promos 等间接引用）。从库读商品、
// 触发同步的逻辑全部在 lib/data/product-cache.ts（server-only），
// 那边通过本文件导出的 installProducts 原位灌数据。

export type Spicy = 0 | 1 | 2 | 3 // 0=不辣 1=微辣 2=中辣 3=重辣
export type StockStatus = 'in_stock' | 'out_of_stock'

export interface Product {
  sku_id: string
  name: string
  category: string
  price: number
  /** 一句话卖点，卡片上直接展示 */
  reason: string
  emoji: string
  /** 口味 / 口感标签 */
  taste_tags: string[]
  /** 适用场景 */
  scenes: string[]
  /** 情绪倾向（真实数据暂无，默认空数组） */
  emotions: string[]
  spicy: Spicy
  selling_points: string[]
  /** 过敏原：海产品 / 坚果 / 乳制品 等 */
  allergens: string[]
  gift_ok: boolean
  child_ok: boolean
  stock: StockStatus
  quality: number
  margin: number
  /** 兼容旧的内置库：taste_tags + scenes + emotions 的并集 */
  tags: string[]
}

type Raw = {
  sku_id?: string
  name: string
  category: string
  price: number
  taste_tags_str: string
  scene_tags_str: string
  people_tags_str: string
  avoid_tags_str: string
  selling_points_str: string
  stock: StockStatus
  margin_ratio: number
}

// 从文字标签中推导辣度
function deriveSpicy(tags: string): Spicy {
  if (tags.includes('重辣') || tags.includes('魔鬼辣')) return 3
  if (tags.includes('中辣') || tags.includes('麻辣') || tags.includes('香辣')) return 2
  if (tags.includes('微辣')) return 1
  return 0
}

// 从文字标签中推导 Emoji
function deriveEmoji(category: string): string {
  if (category.includes('海苔')) return '🍙'
  if (category.includes('果干')) return '🍇'
  if (category.includes('膨化')) return '🍟'
  if (category.includes('坚果')) return '🥜'
  if (category.includes('糕点')) return '🍪'
  if (category.includes('肉脯')) return '🥩'
  if (category.includes('糖果') || category.includes('巧克力')) return '🍫'
  if (category.includes('辣条')) return '🌶️'
  if (category.includes('果蔬')) return '🥬'
  if (category.includes('礼盒')) return '🎁'
  return '🍪'
}

// 从 avoid_tags 提取过敏原
function deriveAllergens(avoid: string): string[] {
  const list = []
  if (avoid.includes('海产品')) list.push('海产品')
  if (avoid.includes('坚果')) list.push('坚果')
  if (avoid.includes('乳制品')) list.push('乳制品')
  if (avoid.includes('麸质')) list.push('麸质')
  if (avoid.includes('蛋类')) list.push('蛋类')
  if (avoid.includes('花生')) list.push('花生')
  if (avoid.includes('芒果')) list.push('芒果')
  if (avoid.includes('香蕉')) list.push('香蕉')
  if (avoid.includes('草莓')) list.push('草莓')
  if (avoid.includes('黄桃')) list.push('黄桃')
  if (avoid.includes('马铃薯')) list.push('马铃薯')
  if (avoid.includes('牛肉')) list.push('牛肉')
  if (avoid.includes('猪肉')) list.push('猪肉')
  if (avoid.includes('可可')) list.push('可可')
  if (avoid.includes('秋葵')) list.push('秋葵')
  return list
}

// 把真实库的描述型口味词归一化成系统内部词（辣味/甜味/咸味/酸味/清淡/坚果）。
// 检索链路的硬约束、positive_terms、理由校验全认这套内部词；不归一化，
// "要甜"的用户会因 taste_tags 没有字面"甜味"而被全部硬过滤成 0 候选。
function normalizeTasteTags(str: string): string[] {
  const out = new Set<string>()
  if (/微辣|中辣|麻辣|香辣|重辣|魔鬼辣|酸辣|藤椒|爆辣|特辣|巨辣|超辣|辣味/.test(str))
    out.add('辣味')
  if (/甜|糖/.test(str)) out.add('甜味')
  if (/咸|盐|椒|烧烤/.test(str)) out.add('咸味')
  if (/酸/.test(str)) out.add('酸味')
  if (/清淡|低盐|低负担|轻/.test(str)) out.add('清淡')
  if (/坚果/.test(str)) out.add('坚果')
  return [...out]
}

const RAW: Raw[] = [
  {
    sku_id: 'SKU001', name: '海苔脆片原味装', category: '海苔', price: 29.9, 
    taste_tags_str: '咸香、清淡、不辣', scene_tags_str: '办公室、追剧、分享', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '独立小包、口味清淡、海苔香浓', stock: 'in_stock', margin_ratio: 0.436
  },
  {
    sku_id: 'SKU002', name: '芝麻海苔卷', category: '海苔', price: 32.9, 
    taste_tags_str: '咸香、芝麻香、不辣', scene_tags_str: '办公室、儿童零食', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '芝麻香明显、小包便携、酥脆可口', stock: 'in_stock', margin_ratio: 0.22
  },
  {
    sku_id: 'SKU003', name: '夹心海苔脆', category: '海苔', price: 36.9, 
    taste_tags_str: '咸香、微甜、不辣', scene_tags_str: '下午茶、办公室、聚会', 
    people_tags_str: '大众', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '夹心口感、酥脆轻负担', stock: 'in_stock', margin_ratio: 0.456
  },
  {
    sku_id: 'SKU004', name: '辣味海苔脆', category: '海苔', price: 31.9, 
    taste_tags_str: '微辣、咸香', scene_tags_str: '追剧、夜宵、宿舍', 
    people_tags_str: '大众', avoid_tags_str: '海产品过敏慎选、不吃辣人群慎选', 
    selling_points_str: '解馋口味、适合追剧', stock: 'out_of_stock', margin_ratio: 0.086
  },
  {
    sku_id: 'SKU005', name: '低盐海苔片', category: '海苔', price: 34.9, 
    taste_tags_str: '清淡、低盐、不辣', scene_tags_str: '儿童零食、办公室', 
    people_tags_str: '儿童可适量、大众', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '低盐配方、口味清淡', stock: 'in_stock', margin_ratio: 0.12
  },
  {
    sku_id: 'SKU006', name: '海苔肉松卷', category: '海苔', price: 39.9, 
    taste_tags_str: '咸香、肉松香、不辣', scene_tags_str: '早餐、办公室、追剧', 
    people_tags_str: '大众', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '肉松夹心、咸香酥脆', stock: 'in_stock', margin_ratio: 0.23
  },
  {
    sku_id: 'SKU007', name: '海苔礼盒分享装', category: '海苔', price: 79.9, 
    taste_tags_str: '咸香、清淡、不辣', scene_tags_str: '送人、家庭分享、节日', 
    people_tags_str: '大众', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '礼盒包装、适合分享', stock: 'in_stock', margin_ratio: 0.32
  },
  {
    sku_id: 'SKU008', name: '海苔脆片大包装', category: '海苔', price: 45.9, 
    taste_tags_str: '咸香、清淡、不辣', scene_tags_str: '家庭分享、追剧', 
    people_tags_str: '大众', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '分量更足、适合家庭', stock: 'in_stock', margin_ratio: 0.11
  },
  {
    sku_id: 'SKU009', name: '儿童海苔小片', category: '海苔', price: 42.9, 
    taste_tags_str: '清淡、低盐、不辣', scene_tags_str: '儿童零食、早餐、外出', 
    people_tags_str: '儿童可适量', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '小片设计、低盐口味', stock: 'in_stock', margin_ratio: 0.55
  },
  {
    sku_id: 'SKU010', name: '海苔香脆混合包', category: '海苔', price: 35.9, 
    taste_tags_str: '咸香、微辣', scene_tags_str: '追剧、宿舍、分享', 
    people_tags_str: '大众', avoid_tags_str: '海产品过敏慎选、不吃辣人群慎选', 
    selling_points_str: '海苔香脆组合、小包装', stock: 'in_stock', margin_ratio: 0.31
  },
  {
    sku_id: 'SKU011', name: '阳光芒果干轻甜装', category: '果干', price: 39.9, 
    taste_tags_str: '香甜、果香浓郁、不辣', scene_tags_str: '下午茶、办公室、追剧', 
    people_tags_str: '大众、女性', avoid_tags_str: '芒果过敏慎选、控糖人群适量', 
    selling_points_str: '泰芒原切、轻甜不腻', stock: 'in_stock', margin_ratio: 0.549
  },
  {
    sku_id: 'SKU012', name: '无糖芒果干', category: '果干', price: 45.9, 
    taste_tags_str: '自然果香、低甜、不辣', scene_tags_str: '健身加餐、办公室、旅行', 
    people_tags_str: '控糖人群、成人', avoid_tags_str: '芒果过敏慎选', 
    selling_points_str: '0添加蔗糖、果肉厚实', stock: 'in_stock', margin_ratio: 0.521
  },
  {
    sku_id: 'SKU013', name: '炭烤薯角原味', category: '膨化零食', price: 29.9, 
    taste_tags_str: '咸香、薯香、不辣', scene_tags_str: '追剧、聚会、夜宵', 
    people_tags_str: '大众', avoid_tags_str: '马铃薯过敏慎选', 
    selling_points_str: '厚切薯角、酥脆耐嚼', stock: 'in_stock', margin_ratio: 0.599
  },
  {
    sku_id: 'SKU014', name: '黑胡椒薯角', category: '膨化零食', price: 32.9, 
    taste_tags_str: '黑胡椒、咸香、微辣', scene_tags_str: '追剧、宿舍、聚会', 
    people_tags_str: '成人、重口味爱好者', avoid_tags_str: '不吃辣人群慎选', 
    selling_points_str: '现磨黑胡椒、厚切酥脆', stock: 'in_stock', margin_ratio: 0.574
  },
  {
    sku_id: 'SKU015', name: '蜂蜜黄油薯角', category: '膨化零食', price: 33.9, 
    taste_tags_str: '香甜、黄油香、微咸', scene_tags_str: '下午茶、追剧、分享', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '乳制品过敏慎选', 
    selling_points_str: '甜咸平衡、奶香浓郁', stock: 'in_stock', margin_ratio: 0.558
  },
  {
    sku_id: 'SKU016', name: '麻辣小薯角', category: '膨化零食', price: 31.9, 
    taste_tags_str: '麻辣、咸香、中辣', scene_tags_str: '夜宵、追剧、宿舍', 
    people_tags_str: '成人、辣味爱好者', avoid_tags_str: '不吃辣人群慎选', 
    selling_points_str: '川味麻辣、越吃越香', stock: 'out_of_stock', margin_ratio: 0.592
  },
  {
    sku_id: 'SKU017', name: '每日坚果混合包', category: '坚果炒货', price: 59.9, 
    taste_tags_str: '坚果香、原味、微甜', scene_tags_str: '早餐、办公室、健身加餐', 
    people_tags_str: '成人、健身人群', avoid_tags_str: '坚果过敏慎选', 
    selling_points_str: '7日配比、每日一包', stock: 'in_stock', margin_ratio: 0.482
  },
  {
    sku_id: 'SKU018', name: '巴旦木原味罐装', category: '坚果炒货', price: 49.9, 
    taste_tags_str: '坚果香、清淡、不辣', scene_tags_str: '办公室、早餐、家庭分享', 
    people_tags_str: '大众', avoid_tags_str: '坚果过敏慎选', 
    selling_points_str: '颗粒饱满、原味烘焙', stock: 'in_stock', margin_ratio: 0.499
  },
  {
    sku_id: 'SKU019', name: '蜂蜜琥珀核桃仁', category: '坚果炒货', price: 52.9, 
    taste_tags_str: '香甜、核桃香、不辣', scene_tags_str: '下午茶、送礼、家庭分享', 
    people_tags_str: '大众、女性', avoid_tags_str: '坚果过敏慎选', 
    selling_points_str: '琥珀脆壳、核桃仁完整', stock: 'in_stock', margin_ratio: 0.49
  },
  {
    sku_id: 'SKU020', name: '椒盐腰果', category: '坚果炒货', price: 46.9, 
    taste_tags_str: '椒盐、坚果香、微辣', scene_tags_str: '追剧、下酒菜、办公室', 
    people_tags_str: '成人', avoid_tags_str: '坚果过敏慎选、不吃辣人群慎选', 
    selling_points_str: '咸香开胃、腰果饱满', stock: 'in_stock', margin_ratio: 0.51
  },
  {
    sku_id: 'SKU021', name: '手剥奶油味夏威夷果', category: '坚果炒货', price: 69.9, 
    taste_tags_str: '奶油香、坚果香、不辣', scene_tags_str: '送礼、家庭分享、下午茶', 
    people_tags_str: '大众', avoid_tags_str: '坚果过敏慎选、乳制品过敏慎选', 
    selling_points_str: '开口易剥、果仁饱满', stock: 'in_stock', margin_ratio: 0.442
  },
  {
    sku_id: 'SKU022', name: '海盐开心果', category: '坚果炒货', price: 58.9, 
    taste_tags_str: '海盐、坚果香、不辣', scene_tags_str: '办公室、聚会、家庭分享', 
    people_tags_str: '大众', avoid_tags_str: '坚果过敏慎选', 
    selling_points_str: '自然开口、盐焗入味', stock: 'in_stock', margin_ratio: 0.491
  },
  {
    sku_id: 'SKU023', name: '黄油曲奇礼盒', category: '饼干糕点', price: 68.9, 
    taste_tags_str: '奶香、香甜、不辣', scene_tags_str: '送礼、下午茶、节日', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '乳制品过敏慎选、麸质过敏慎选', 
    selling_points_str: '丹麦风味、铁盒精装', stock: 'in_stock', margin_ratio: 0.492
  },
  {
    sku_id: 'SKU024', name: '全麦燕麦饼干', category: '饼干糕点', price: 28.9, 
    taste_tags_str: '麦香、微甜、不辣', scene_tags_str: '早餐、办公室、健身加餐', 
    people_tags_str: '成人、健身人群', avoid_tags_str: '麸质过敏慎选', 
    selling_points_str: '全麦谷物、饱腹感强', stock: 'in_stock', margin_ratio: 0.585
  },
  {
    sku_id: 'SKU025', name: '芝士夹心饼干', category: '饼干糕点', price: 35.9, 
    taste_tags_str: '芝士香、咸甜、不辣', scene_tags_str: '下午茶、儿童零食、追剧', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '乳制品过敏慎选、麸质过敏慎选', 
    selling_points_str: '浓郁芝士夹心、松脆饼体', stock: 'in_stock', margin_ratio: 0.526
  },
  {
    sku_id: 'SKU026', name: '红枣核桃软糕', category: '饼干糕点', price: 42.9, 
    taste_tags_str: '枣香、微甜、不辣', scene_tags_str: '早餐、办公室、送礼', 
    people_tags_str: '大众、长辈', avoid_tags_str: '坚果过敏慎选', 
    selling_points_str: '红枣软糯、核桃颗粒丰富', stock: 'in_stock', margin_ratio: 0.51
  },
  {
    sku_id: 'SKU027', name: '黑糖沙琪玛', category: '饼干糕点', price: 26.9, 
    taste_tags_str: '黑糖香、香甜、不辣', scene_tags_str: '早餐、办公室、旅行', 
    people_tags_str: '大众', avoid_tags_str: '麸质过敏慎选', 
    selling_points_str: '松软不粘牙、独立包装', stock: 'in_stock', margin_ratio: 0.591
  },
  {
    sku_id: 'SKU028', name: '原味猪肉脯', category: '肉脯卤味', price: 49.9, 
    taste_tags_str: '鲜甜、肉香、不辣', scene_tags_str: '追剧、办公室、旅行', 
    people_tags_str: '大众', avoid_tags_str: '猪肉过敏慎选', 
    selling_points_str: '肉片厚实、炭烤香浓', stock: 'in_stock', margin_ratio: 0.459
  },
  {
    sku_id: 'SKU029', name: '香辣牛肉粒', category: '肉脯卤味', price: 56.9, 
    taste_tags_str: '香辣、肉香、中辣', scene_tags_str: '夜宵、追剧、下酒菜', 
    people_tags_str: '成人、辣味爱好者', avoid_tags_str: '牛肉过敏慎选、不吃辣人群慎选', 
    selling_points_str: '真牛肉粒、嚼劲十足', stock: 'in_stock', margin_ratio: 0.455
  },
  {
    sku_id: 'SKU030', name: '五香鹌鹑蛋', category: '肉脯卤味', price: 32.9, 
    taste_tags_str: '五香、咸香、不辣', scene_tags_str: '早餐、办公室、郊游', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '蛋类过敏慎选', 
    selling_points_str: '真空卤制、即食方便', stock: 'in_stock', margin_ratio: 0.514
  },
  {
    sku_id: 'SKU031', name: '藤椒凤爪', category: '肉脯卤味', price: 38.9, 
    taste_tags_str: '藤椒、酸辣、中辣', scene_tags_str: '追剧、夜宵、聚会', 
    people_tags_str: '成人、辣味爱好者', avoid_tags_str: '不吃辣人群慎选', 
    selling_points_str: '脱骨凤爪、藤椒清香', stock: 'in_stock', margin_ratio: 0.486
  },
  {
    sku_id: 'SKU032', name: '手撕鱿鱼丝', category: '肉脯卤味', price: 44.9, 
    taste_tags_str: '鲜香、微甜、不辣', scene_tags_str: '办公室、追剧、旅行', 
    people_tags_str: '大众', avoid_tags_str: '海产品过敏慎选', 
    selling_points_str: '纤维细长、鲜香耐嚼', stock: 'in_stock', margin_ratio: 0.465
  },
  {
    sku_id: 'SKU033', name: '海盐焦糖爆米花', category: '膨化零食', price: 24.9, 
    taste_tags_str: '焦糖香、咸甜、不辣', scene_tags_str: '追剧、聚会、下午茶', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '乳制品过敏慎选', 
    selling_points_str: '咸甜焦糖、颗粒饱满', stock: 'in_stock', margin_ratio: 0.598
  },
  {
    sku_id: 'SKU034', name: '玉米脆条烧烤味', category: '膨化零食', price: 27.9, 
    taste_tags_str: '烧烤、咸香、微辣', scene_tags_str: '追剧、宿舍、夜宵', 
    people_tags_str: '大众', avoid_tags_str: '不吃辣人群慎选', 
    selling_points_str: '粗粮玉米、烧烤风味', stock: 'in_stock', margin_ratio: 0.606
  },
  {
    sku_id: 'SKU035', name: '芝士玉米片', category: '膨化零食', price: 30.9, 
    taste_tags_str: '芝士香、咸香、不辣', scene_tags_str: '追剧、聚会、下午茶', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '乳制品过敏慎选', 
    selling_points_str: '薄脆玉米片、芝士浓郁', stock: 'in_stock', margin_ratio: 0.579
  },
  {
    sku_id: 'SKU036', name: '香辣海苔天妇罗', category: '海苔', price: 36.9, 
    taste_tags_str: '香辣、海苔香、中辣', scene_tags_str: '追剧、夜宵、聚会', 
    people_tags_str: '成人、辣味爱好者', avoid_tags_str: '海产品过敏慎选、不吃辣人群慎选', 
    selling_points_str: '海苔裹粉、酥香可口', stock: 'in_stock', margin_ratio: 0.485
  },
  {
    sku_id: 'SKU037', name: '椰香香蕉片', category: '果干', price: 29.9, 
    taste_tags_str: '椰香、香甜、不辣', scene_tags_str: '下午茶、办公室、旅行', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '香蕉过敏慎选', 
    selling_points_str: '低温脆化、椰香浓郁', stock: 'in_stock', margin_ratio: 0.565
  },
  {
    sku_id: 'SKU038', name: '红薯脆片原味', category: '果蔬脆', price: 31.9, 
    taste_tags_str: '薯香、微甜、不辣', scene_tags_str: '追剧、办公室、儿童零食', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '薯类过敏慎选', 
    selling_points_str: '低温脆化、薄脆少负担', stock: 'in_stock', margin_ratio: 0.561
  },
  {
    sku_id: 'SKU039', name: '秋葵脆蔬菜干', category: '果蔬脆', price: 35.9, 
    taste_tags_str: '清香、咸香、不辣', scene_tags_str: '办公室、健身加餐、下午茶', 
    people_tags_str: '成人、健身人群', avoid_tags_str: '秋葵过敏慎选', 
    selling_points_str: '整根秋葵、真空低温脆化', stock: 'in_stock', margin_ratio: 0.526
  },
  {
    sku_id: 'SKU040', name: '综合蔬菜脆片', category: '果蔬脆', price: 39.9, 
    taste_tags_str: '清香、咸香、不辣', scene_tags_str: '追剧、办公室、家庭分享', 
    people_tags_str: '大众', avoid_tags_str: '多种蔬菜过敏慎选', 
    selling_points_str: '胡萝卜南瓜秋葵混合', stock: 'in_stock', margin_ratio: 0.499
  },
  {
    sku_id: 'SKU041', name: '草莓冻干', category: '果干', price: 46.9, 
    taste_tags_str: '草莓香、酸甜、不辣', scene_tags_str: '下午茶、烘焙、办公室', 
    people_tags_str: '大众、女性', avoid_tags_str: '草莓过敏慎选', 
    selling_points_str: '整颗冻干、酥脆酸甜', stock: 'in_stock', margin_ratio: 0.488
  },
  {
    sku_id: 'SKU042', name: '黄桃果脯', category: '果干', price: 27.9, 
    taste_tags_str: '果香、香甜、不辣', scene_tags_str: '办公室、旅行、下午茶', 
    people_tags_str: '大众、儿童可适量', avoid_tags_str: '黄桃过敏慎选', 
    selling_points_str: '果肉厚实、酸甜平衡', stock: 'in_stock', margin_ratio: 0.57
  },
  {
    sku_id: 'SKU043', name: '陈皮梅', category: '糖果蜜饯', price: 22.9, 
    taste_tags_str: '陈皮香、酸甜、不辣', scene_tags_str: '办公室、旅行、饭后', 
    people_tags_str: '大众', avoid_tags_str: '胃酸人群适量', 
    selling_points_str: '酸甜开胃、陈皮回甘', stock: 'in_stock', margin_ratio: 0.607
  },
  {
    sku_id: 'SKU044', name: '薄荷润喉糖', category: '糖果巧克力', price: 19.9, 
    taste_tags_str: '薄荷、清凉、不辣', scene_tags_str: '办公室、通勤、旅行', 
    people_tags_str: '成人', avoid_tags_str: '儿童适量', 
    selling_points_str: '清凉口感、铁盒便携', stock: 'in_stock', margin_ratio: 0.648
  },
  {
    sku_id: 'SKU045', name: '榛子夹心巧克力', category: '糖果巧克力', price: 42.9, 
    taste_tags_str: '巧克力香、榛子香、香甜', scene_tags_str: '送礼、下午茶、节日', 
    people_tags_str: '大众', avoid_tags_str: '坚果过敏慎选、乳制品过敏慎选', 
    selling_points_str: '榛子夹心、丝滑浓郁', stock: 'in_stock', margin_ratio: 0.464
  },
  {
    sku_id: 'SKU046', name: '黑巧克力72%', category: '糖果巧克力', price: 39.9, 
    taste_tags_str: '可可香、微苦、不辣', scene_tags_str: '办公室、下午茶、送礼', 
    people_tags_str: '成人', avoid_tags_str: '可可过敏慎选', 
    selling_points_str: '72%可可、低甜醇厚', stock: 'in_stock', margin_ratio: 0.499
  },
  {
    sku_id: 'SKU047', name: '辣条大礼包', category: '辣条', price: 36.9, 
    taste_tags_str: '香辣、咸香、中辣', scene_tags_str: '追剧、宿舍、聚会', 
    people_tags_str: '成人、辣味爱好者', avoid_tags_str: '不吃辣人群慎选', 
    selling_points_str: '多口味组合、独立分装', stock: 'in_stock', margin_ratio: 0.566
  },
  {
    sku_id: 'SKU048', name: '麻辣魔芋爽', category: '辣条', price: 29.9, 
    taste_tags_str: '麻辣、Q弹、中辣', scene_tags_str: '夜宵、追剧、宿舍', 
    people_tags_str: '成人、辣味爱好者', avoid_tags_str: '不吃辣人群慎选', 
    selling_points_str: '魔芋低脂、麻辣解馋', stock: 'in_stock', margin_ratio: 0.599
  },
  {
    sku_id: 'SKU049', name: '海苔肉松小贝', category: '饼干糕点', price: 45.9, 
    taste_tags_str: '肉松香、海苔香、微甜', scene_tags_str: '早餐、办公室、下午茶', 
    people_tags_str: '大众', avoid_tags_str: '海产品过敏慎选、蛋类过敏慎选', 
    selling_points_str: '肉松饱满、松软可口', stock: 'in_stock', margin_ratio: 0.477
  },
  {
    sku_id: 'SKU050', name: '零食综合分享礼盒', category: '综合礼盒', price: 99.9, 
    taste_tags_str: '咸甜混合、口味丰富', scene_tags_str: '送礼、节日、家庭分享', 
    people_tags_str: '大众', avoid_tags_str: '按单品过敏原提示', 
    selling_points_str: '12款人气零食、一盒满足', stock: 'in_stock', margin_ratio: 0.479
  }
]

/** 商品表（包含派生逻辑）。静态构建结果只作启动兜底，见文件头说明 */
const BUILT_IN: Product[] = RAW.map((r, i) => {
  const taste_tags = normalizeTasteTags(r.taste_tags_str)
  const scenes = r.scene_tags_str.split('、').map(s => s.trim())
  const emotions: string[] = [] // 新数据无情绪标签，留空
  const tags = Array.from(new Set([...taste_tags, ...scenes]))
  
  return {
    sku_id: r.sku_id || `SKU${String(i + 1).padStart(3, '0')}`,
    name: r.name,
    category: r.category,
    price: r.price,
    reason: r.selling_points_str.split('、')[0] || r.name, // 默认拿第一个卖点当理由
    emoji: deriveEmoji(r.category),
    taste_tags,
    scenes,
    emotions,
    spicy: deriveSpicy(r.taste_tags_str),
    selling_points: r.selling_points_str.split('、').map(s => s.trim()),
    allergens: deriveAllergens(r.avoid_tags_str),
    gift_ok: r.scene_tags_str.includes('送礼') || r.scene_tags_str.includes('礼盒') || r.people_tags_str.includes('长辈'),
    child_ok: r.people_tags_str.includes('儿童'),
    stock: r.stock,
    quality: 85, // 默认质量分
    margin: Math.round(r.margin_ratio * 100),
    tags
  }
})

export const PRODUCT_BY_NAME = new Map<string, Product>(BUILT_IN.map(p => [p.name, p]))
export const PRODUCT_BY_SKU = new Map<string, Product>(BUILT_IN.map(p => [p.sku_id, p]))

/**
 * 对外出口：业务代码 import 的就是**这个数组**（V2 同名导出）。
 * 内容启动后被库数据原位替换（installProducts），引用永远不变。
 */
export const PRODUCTS: Product[] = BUILT_IN

// ── V3.0：库为源、内存为算 ─────────────────────────────────────────
// PRODUCTS 与两个索引 Map 的**引用**永远不变（原位替换内容），检索链路
// （local-workflow / orchestrator / system-prompt 节选）与守卫零感知。
// 读库 + 调度的逻辑在 product-cache.ts（server-only）；这里只暴露纯内存操作。

/**
 * 用列表原位替换三个缓存对象的内容（引用不变）。
 * 供 product-cache.ts（server-only）灌数据；业务代码不要调它。
 */
export function installProducts(list: Product[]): void {
  PRODUCTS.length = 0;
  PRODUCTS.push(...list);
  PRODUCT_BY_NAME.clear();
  for (const p of list) PRODUCT_BY_NAME.set(p.name, p);
  PRODUCT_BY_SKU.clear();
  for (const p of list) PRODUCT_BY_SKU.set(p.sku_id, p);
}

/** 文案里的"不吃辣""花生过敏" → 过敏原 / 忌口标签 */
const ALLERGEN_WORDS: Record<string, string[]> = {
  花生: ['花生', '坚果'],
  坚果: ['坚果'],
  海鲜: ['海产品'],
  海产品: ['海产品'],
  奶: ['乳制品'],
  乳制品: ['乳制品'],
  麸质: ['麸质'],
  蛋类: ['蛋类']
}

export function allergensOf(avoidText?: string): string[] {
  const t = (avoidText || '').trim()
  if (!t) return []
  const out = new Set<string>()
  for (const [word, list] of Object.entries(ALLERGEN_WORDS)) {
    if (t.includes(word)) list.forEach(a => out.add(a))
  }
  return [...out]
}