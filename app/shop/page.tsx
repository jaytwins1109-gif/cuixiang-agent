// app/shop/page.tsx — 「0 Token 极速转化货架」
//
// 这是 **Server Component**：商品直接查 Prisma Product 表（唯一数据源，Admin 改库后生效），
// 不经过 product-cache 内存视图、不经过 /api/ai、更不碰 LLM。
// 客户端只在 _components/shop-shelf.tsx 里做筛选 / 加购 / 弹窗，全部是本地 state。
//
// ⚠️ 为什么不能 `import { PRODUCTS } from '@/lib/data/snacks'`：
// 那份是「库为源、内存为算」的**内存视图**，客户端 import 只会拿到 RAW 静态兜底，
// Admin 后台改了价、下架了商品，货架上还是老数据。
//
// scripts/shop-guard.ts 会扫描 app/shop/** 的 import 链，确保这里永远不出现 LLM 调用。
import { rowToProduct } from '@/lib/data/product-cache';
import { prisma } from '@/lib/db';

import { ShopShelf, type ShopProduct } from './_components/shop-shelf';

export const runtime = 'nodejs';
/** ISR：60 秒回源查一次库。默认动态 SSR 也行，但那样每次进页面都读库，没必要 */
export const revalidate = 60;

export default async function ShopPage() {
  let products: ShopProduct[] = [];
  try {
    const rows = await prisma.product.findMany({
      where: { active: true, stock: 'in_stock' },
      orderBy: { name: 'asc' },
    });
    // 只下发货架用得到的字段：margin / quality / 内部索引没必要进客户端 bundle
    products = rows.map(rowToProduct).map((p) => ({
      sku_id: p.sku_id,
      name: p.name,
      category: p.category,
      price: p.price,
      reason: p.reason,
      emoji: p.emoji,
      taste_tags: p.taste_tags,
      allergens: p.allergens,
      scenes: p.scenes,
      spicy: p.spicy,
    }));
  } catch (err) {
    // 读库失败不该白屏：给空货架 + 一句提示，也绝不能为了兜底去调模型
    console.error('[shop] 读商品库失败', err);
  }

  // 分类从真实数据去重生成，不写死商品清单（与提示词里 describeCatalog 同一条纪律）
  const categories = ['全部', ...Array.from(new Set(products.map((p) => p.category)))];

  return <ShopShelf products={products} categories={categories} />;
}
