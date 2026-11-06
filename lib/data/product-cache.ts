// lib/data/product-cache.ts — V3.0「库为源、内存为算」的 DB 读取层
//
// Product 表是商品唯一数据源（Admin 后台改库）；本文件只负责「从库读出 + 还原成
// Product 接口形状」。内存缓存本体在 snacks.ts（PRODUCTS 数组与两个索引 Map 的
// 引用绝不能换，业务代码 import 的就是那个对象）。
//
// ⚠️ 本文件是 server-only：只允许被 instrumentation / Admin API（步骤 5）引用。
// snacks.ts 必须保持纯数据（会被打进客户端 bundle），它只暴露纯内存的
// installProducts；本文件负责读库 + 调 installProducts 灌缓存。
//
// ⚠️ prisma 必须动态 import：不读 .env 的环境（guard / vitest）万一被拖进
// import 链，会在构造 client 时就因缺 DATABASE_URL 崩掉。
import type { Product } from './snacks';
import { installProducts } from './snacks';

/** Product 表行的形状（与 schema.prisma 对齐） */
export interface ProductRow {
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
  active: boolean;
}

/** 库行 → Product 接口形状（数组字段 JSON.parse；tags 按原派生逻辑重算） */
export function rowToProduct(row: ProductRow): Product {
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
    // 与 snacks.ts 原派生逻辑一致：taste_tags + scenes 并集去重（emotions 恒空不参与）
    tags: Array.from(new Set([...taste_tags, ...scenes])),
  };
}

/** 拉取全部上架商品（软下架 active=false 不进缓存） */
export async function fetchActiveProductRows(): Promise<ProductRow[]> {
  const { prisma } = await import('@/lib/db');
  return prisma.product.findMany({ where: { active: true } });
}

/** 启动惰性同步的单例；Admin 写路径走 forceProductSync 绕开它 */
let syncSingleton: Promise<number> | null = null;

async function doSync(): Promise<number> {
  const rows = await fetchActiveProductRows();
  if (!rows.length) {
    // 空库 = 没 seed 过，内置静态数据兜底（新环境首次启动的正确行为）
    console.warn('[product-cache] Product 表为空，沿用内置静态数据（先跑 npm run db:seed）');
    return 0;
  }
  installProducts(rows.map(rowToProduct));
  return rows.length;
}

/** 启动时惰性同步一次（instrumentation.ts 调用）；失败不炸启动，下个请求可重试 */
export function syncProductCache(): Promise<number> {
  if (!syncSingleton) {
    syncSingleton = doSync().catch((e) => {
      syncSingleton = null; // 允许重试
      console.error('[product-cache] 同步失败，沿用内置静态数据', e);
      return 0;
    });
  }
  return syncSingleton;
}

/** 强制重载（Admin 商品 CRUD 后调用）：不等单例，直接读库覆盖缓存 */
export async function forceProductSync(): Promise<number> {
  syncSingleton = null;
  const n = await doSync();
  syncSingleton = Promise.resolve(n);
  return n;
}
