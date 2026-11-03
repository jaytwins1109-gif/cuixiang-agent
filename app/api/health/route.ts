// app/api/health/route.ts
//
// 容器/负载均衡的探活口。只回答两件事：进程活着吗？数据库连得上吗？
//
// 为什么不复用 `/`：首页是客户端组件，探活要能区分"进程在但库挂了"。
// 这个路由会真的打一次 `SELECT 1`，库断了直接 503——编排层据此重启或摘流量。
// 不返回任何连接串、文件路径、错误堆栈：探活接口通常是公网可打的，不该成为信息源。

import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';

// 禁止静态化：探活必须每次真查
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET() {
  const startedAt = Date.now();

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json(
      {
        status: 'ok',
        db: 'connected',
        latencyMs: Date.now() - startedAt,
        uptimeSec: Math.round(process.uptime()),
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    // 具体原因只进服务端日志（可能含绝对路径），响应里只给结论
    console.error('[health] 数据库探测失败', error);
    return NextResponse.json(
      { status: 'degraded', db: 'error', latencyMs: Date.now() - startedAt },
      { status: 503, headers: NO_STORE },
    );
  }
}
