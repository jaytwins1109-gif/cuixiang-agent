// app/api/admin/products/route.ts — 商品管理（V3.0 Admin）
//
// GET  ：全量返回（**含 active=false 的下架商品**——管理页要能看见并重新上架）
// POST ：新增商品（skuId / name 唯一，重复 409）
// PUT  ：按 skuId 更新（部分字段皆可；active=false 即软下架，不删数据）
//
// 核心红线：**任何写操作成功后必须 forceProductSync()**——内存缓存是 C 端检索
// 的唯一视图（库为源、内存为算），不刷新 = Admin 改了库但 C 端永远看不到。
import { NextResponse, type NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { requireAdmin } from '@/lib/auth/guard';
import { forceProductSync } from '@/lib/data/product-cache';
import { prisma } from '@/lib/db';

/** 数组字段：Admin UI 传 string[]，落库前 stringify（SQLite 无 scalar list） */
const ARRAY_FIELDS = [
  ['tasteTags', 'tasteTagsJson'],
  ['scenes', 'scenesJson'],
  ['emotions', 'emotionsJson'],
  ['sellingPoints', 'sellingPointsJson'],
  ['allergens', 'allergensJson'],
] as const;

/** 标量字段与取值域校验 */
const SCALARS = ['name', 'category', 'price', 'reason', 'emoji', 'spicy', 'giftOk', 'childOk', 'stock', 'quality', 'margin', 'active'] as const;

interface ProductInput {
  skuId?: string;
  name?: string;
  category?: string;
  price?: number;
  reason?: string;
  emoji?: string;
  tasteTags?: string[];
  scenes?: string[];
  emotions?: string[];
  sellingPoints?: string[];
  allergens?: string[];
  spicy?: number;
  giftOk?: boolean;
  childOk?: boolean;
  stock?: string;
  quality?: number;
  margin?: number;
  active?: boolean;
}

/** 校验 + 形状转换：非法字段直接报错，不让脏数据进库（内存缓存没有二次防线） */
function buildData(body: ProductInput): Record<string, unknown> {
  const data: Record<string, unknown> = {};

  for (const f of SCALARS) {
    if (body[f] === undefined) continue;
    data[f] = body[f];
  }
  if (data.price !== undefined && (typeof data.price !== 'number' || data.price < 0)) {
    throw new Error('price 必须是非负数字');
  }
  if (data.spicy !== undefined && (typeof data.spicy !== 'number' || data.spicy < 0 || data.spicy > 3)) {
    throw new Error('spicy 取值 0-3');
  }
  if (data.stock !== undefined && data.stock !== 'in_stock' && data.stock !== 'out_of_stock') {
    throw new Error('stock 只能是 in_stock / out_of_stock');
  }

  for (const [inputKey, rowKey] of ARRAY_FIELDS) {
    const v = body[inputKey];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.some((s) => typeof s !== 'string')) {
      throw new Error(`${inputKey} 必须是字符串数组`);
    }
    data[rowKey] = JSON.stringify(v);
  }
  return data;
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const rows = await prisma.product.findMany({ orderBy: { skuId: 'asc' } });
    // 数组字段还原成数组再出：管理页直接展示，不再自己做 JSON.parse
    return NextResponse.json({
      items: rows.map((r) => ({
        ...r,
        tasteTags: JSON.parse(r.tasteTagsJson),
        scenes: JSON.parse(r.scenesJson),
        emotions: JSON.parse(r.emotionsJson),
        sellingPoints: JSON.parse(r.sellingPointsJson),
        allergens: JSON.parse(r.allergensJson),
      })),
      total: rows.length,
    });
  } catch (err) {
    console.error('[admin/products GET]', err);
    return NextResponse.json({ error: '商品读取失败' }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const body = (await req.json()) as ProductInput;
    // 业务必填前置：reason/emoji 是 DB 非空字段，在这里拦住比让 Prisma 报裸校验错误体面
    if (
      !body.skuId?.trim() ||
      !body.name?.trim() ||
      !body.category?.trim() ||
      !body.reason?.trim() ||
      !body.emoji?.trim() ||
      typeof body.price !== 'number'
    ) {
      return NextResponse.json(
        { error: 'skuId / name / category / price / reason / emoji 必填' },
        { status: 400 },
      );
    }
    const data = buildData(body);
    const created = await prisma.product.create({
      data: { skuId: body.skuId.trim(), ...data } as Prisma.ProductUncheckedCreateInput,
    });
    const synced = await forceProductSync();
    return NextResponse.json({ ok: true, product: created, cacheSize: synced });
  } catch (err: unknown) {
    const e = err as { code?: string; message?: string };
    // P2002 = 唯一键冲突（skuId / name 已存在）→ 409；其余校验错 → 400
    if (e?.code === 'P2002' || (e?.message ?? '').includes('Unique constraint')) {
      return NextResponse.json({ error: 'skuId 或 name 已存在' }, { status: 409 });
    }
    if (!e?.code?.startsWith('P')) {
      return NextResponse.json({ error: e?.message || '参数不合法' }, { status: 400 });
    }
    console.error('[admin/products POST]', err);
    return NextResponse.json({ error: '商品创建失败' }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const body = (await req.json()) as ProductInput;
    if (!body.skuId?.trim()) return NextResponse.json({ error: '缺少 skuId' }, { status: 400 });
    const data = buildData(body);
    if (!Object.keys(data).length) {
      return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 });
    }
    const updated = await prisma.product.update({ where: { skuId: body.skuId.trim() }, data });
    const synced = await forceProductSync();
    return NextResponse.json({ ok: true, product: updated, cacheSize: synced });
  } catch (err: unknown) {
    const code = (err as { code?: string })?.code;
    if (code === 'P2025') return NextResponse.json({ error: 'skuId 不存在' }, { status: 404 });
    if (!code?.startsWith('P')) {
      return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
    }
    console.error('[admin/products PUT]', err);
    return NextResponse.json({ error: '商品更新失败' }, { status: 500 });
  }
}
