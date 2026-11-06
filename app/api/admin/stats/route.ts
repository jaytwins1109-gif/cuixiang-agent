// app/api/admin/stats/route.ts — 数据看板（V3.0 Admin）
//
// GET：总用户 / 总对话（user 轮）/ 近 7 天活跃（去重）/ 近 7 天每日对话量趋势。
// 第一行 requireAdmin（lib/auth/guard.ts）：真正的安全边界在这里，middleware 只是体验层。
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth/guard';
import { prisma } from '@/lib/db';

const DAY_MS = 24 * 60 * 60 * 1000;

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * DAY_MS);

    // 7 天趋势：SQLite 没有 date_trunc，拉出这轮的时间戳在 JS 里按天聚合。
    // 量级 = 一周内用户轮数（几百到几千），内存聚合零压力。
    const recent = await prisma.message.findMany({
      where: { role: 'user', createdAt: { gte: sevenDaysAgo } },
      select: { createdAt: true, userId: true },
    });

    // 按本地日期键聚合；补零到完整 7 天，前端画折线不用处理缺日
    const byDay = new Map<string, number>();
    for (let i = 6; i >= 0; i--) {
      byDay.set(new Date(Date.now() - i * DAY_MS).toISOString().slice(0, 10), 0);
    }
    for (const r of recent)
      byDay.set(
        r.createdAt.toISOString().slice(0, 10),
        (byDay.get(r.createdAt.toISOString().slice(0, 10)) ?? 0) + 1,
      );

    const [totalUsers, totalMessages, activeProducts] = await Promise.all([
      prisma.user.count(),
      prisma.message.count({ where: { role: 'user' } }),
      prisma.product.count({ where: { active: true } }),
    ]);

    return NextResponse.json({
      totalUsers,
      totalMessages,
      activeUsers7d: new Set(recent.map((r) => r.userId)).size,
      activeProducts,
      trend7d: Array.from(byDay, ([date, count]) => ({ date, count })),
    });
  } catch (err) {
    console.error('[admin/stats]', err);
    return NextResponse.json({ error: '看板数据读取失败' }, { status: 500 });
  }
}
