// app/api/admin/messages/route.ts — 对话审查（V3.0 Admin）
//
// GET：Message 分页（createdAt 倒序）+ 筛选（userId 精确 / role / keyword 模糊）。
// 只读：不做编辑/删除（审查完整性优先，要删走 DBA）。
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth/guard';
import { prisma } from '@/lib/db';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const sp = req.nextUrl.searchParams;
    // 分页上限 100：防一手 pageSize=10^9 把全表拖出来
    const page = Math.max(1, Number(sp.get('page')) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(sp.get('pageSize')) || 20));

    const where: { userId?: string; role?: string; content?: { contains: string } } = {};
    const userId = sp.get('userId')?.trim();
    const role = sp.get('role')?.trim();
    const keyword = sp.get('keyword')?.trim();
    if (userId) where.userId = userId;
    if (role === 'user' || role === 'assistant') where.role = role;
    if (keyword) where.content = { contains: keyword };

    const [items, total] = await Promise.all([
      prisma.message.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.message.count({ where }),
    ]);

    return NextResponse.json({ items, total, page, pageSize });
  } catch (err) {
    console.error('[admin/messages]', err);
    return NextResponse.json({ error: '对话审查数据读取失败' }, { status: 500 });
  }
}
