// prisma/seed.ts — 商品知识库导入（V3.0「库为源、内存为算」的第一步）
//
// 把 lib/data/snacks.ts 的 50 SKU 全量 upsert 进 Product 表：
//   - 按 skuId 幂等（重复执行 = 刷新，不产生重复行）
//   - 完整承载 Product 接口的 16 个字段（缺一个就是静默丢数据，检索/卡片/守卫都在用）
//   - 导入后立即自验：库内数据与内存版逐字段 diff 必须为空
//
// 跑法：npm run db:seed
import { PrismaClient } from '@prisma/client';
import { PRODUCTS, type Product } from '../lib/data/snacks';

const prisma = new PrismaClient();

/** 库行 → Product 接口形状（数组字段 JSON.parse；tags 按原派生逻辑重算） */
function rowToProduct(row: {
  skuId: string;
  name: string;
  category: string;
  price: number;
  reason: string;
  emoji: string;
  tasteTagsJson: string;
  scenesJson: string;
  emotionsJson: string;
  sellingPointsJson: string;
  allergensJson: string;
  spicy: number;
  giftOk: boolean;
  childOk: boolean;
  stock: string;
  quality: number;
  margin: number;
}): Product {
  const taste_tags = JSON.parse(row.tasteTagsJson) as string[];
  const scenes = JSON.parse(row.scenesJson) as string[];
  const emotions = JSON.parse(row.emotionsJson) as string[];
  return {
    sku_id: row.skuId,
    name: row.name,
    category: row.category,
    price: row.price,
    reason: row.reason,
    emoji: row.emoji,
    taste_tags,
    scenes,
    emotions,
    spicy: row.spicy as Product['spicy'],
    selling_points: JSON.parse(row.sellingPointsJson) as string[],
    allergens: JSON.parse(row.allergensJson) as string[],
    gift_ok: row.giftOk,
    child_ok: row.childOk,
    stock: row.stock as Product['stock'],
    quality: row.quality,
    margin: row.margin,
    tags: Array.from(new Set([...taste_tags, ...scenes])),
  };
}

async function main(): Promise<void> {
  // ── 导入（幂等 upsert）───────────────────────────────────────────
  for (const p of PRODUCTS) {
    await prisma.product.upsert({
      where: { skuId: p.sku_id },
      create: {
        skuId: p.sku_id,
        name: p.name,
        category: p.category,
        price: p.price,
        reason: p.reason,
        emoji: p.emoji,
        tasteTagsJson: JSON.stringify(p.taste_tags),
        scenesJson: JSON.stringify(p.scenes),
        emotionsJson: JSON.stringify(p.emotions),
        sellingPointsJson: JSON.stringify(p.selling_points),
        allergensJson: JSON.stringify(p.allergens),
        spicy: p.spicy,
        giftOk: p.gift_ok,
        childOk: p.child_ok,
        stock: p.stock,
        quality: p.quality,
        margin: p.margin,
      },
      update: {
        // Admin 后台上线前，库以 seed 为准：重复执行直接刷新成代码里的版本
        name: p.name,
        category: p.category,
        price: p.price,
        reason: p.reason,
        emoji: p.emoji,
        tasteTagsJson: JSON.stringify(p.taste_tags),
        scenesJson: JSON.stringify(p.scenes),
        emotionsJson: JSON.stringify(p.emotions),
        sellingPointsJson: JSON.stringify(p.selling_points),
        allergensJson: JSON.stringify(p.allergens),
        spicy: p.spicy,
        giftOk: p.gift_ok,
        childOk: p.child_ok,
        stock: p.stock,
        quality: p.quality,
        margin: p.margin,
      },
    });
  }

  // ── 自验 1：行数一致 ─────────────────────────────────────────────
  const dbCount = await prisma.product.count();
  if (dbCount !== PRODUCTS.length) {
    throw new Error(`行数不一致：库 ${dbCount} vs 源 ${PRODUCTS.length}`);
  }

  // ── 自验 2：逐字段 diff（Product 接口全量 16 字段 + 派生 tags）────
  const rows = await prisma.product.findMany();
  const diffs: string[] = [];
  for (const p of PRODUCTS) {
    const row = rows.find((r) => r.skuId === p.sku_id);
    if (!row) {
      diffs.push(`${p.sku_id} 缺行`);
      continue;
    }
    const restored = rowToProduct(row);
    for (const key of Object.keys(p) as (keyof Product)[]) {
      const a = JSON.stringify(p[key]);
      const b = JSON.stringify(restored[key]);
      if (a !== b) diffs.push(`${p.sku_id}.${String(key)}: 源=${a} 库=${b}`);
    }
  }
  if (diffs.length) {
    throw new Error(`字段 diff ${diffs.length} 处：\n${diffs.slice(0, 10).join('\n')}`);
  }

  console.log(`seed 完成：Product ${dbCount}/${PRODUCTS.length} 条，逐字段 diff 为空`);
  console.log(
    `存量完好：User ${(await prisma.user.count()).toLocaleString()} 个、Memory ${(
      await prisma.memory.count()
    ).toLocaleString()} 条`,
  );
}

main()
  .catch((e) => {
    console.error('SEED FAILED:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
