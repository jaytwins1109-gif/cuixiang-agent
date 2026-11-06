// middleware.ts — /admin 前端拦截（V3.0）
//
// 把没带 ADMIN 票的请求弹回首页，B 端入口在导航上不暴露给普通用户。
//
// ⚠️ 这只是**体验层**，不是安全边界：middleware 匹配不到 /api/* 的细粒度规则，
// Admin API 的真正防线是每个路由第一行的 requireAdmin()（lib/auth/guard.ts）。
// 页面内部（app/admin）也各自再验一次——纵深防御，任何一层失手都进不来。
//
// ⚠️ 运行在 edge runtime：只能 import 纯 jose 的 lib/auth/jwt（不碰 prisma / node:fs），
// 什么"顺手查一下库核对 role"的念头都不许有——那是编译期就会炸掉全站的坑。
import { NextResponse, type NextRequest } from 'next/server';
import { TOKEN_COOKIE, verifyUserToken } from '@/lib/auth/jwt';
import { ADMIN_SESSION_COOKIE } from '@/lib/admin/session';

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const ticket = await verifyUserToken(req.cookies.get(TOKEN_COOKIE)?.value);
  if (ticket?.role === 'ADMIN') return NextResponse.next();
  // V1 口令票据（cx_admin）：edge 验不了 node:crypto 的 HMAC，这里只看"有没有"，
  // 真伪与有效期由 layout / page 层 verifySessionTicket 验签——安全边界不在 middleware。
  if (req.cookies.get(ADMIN_SESSION_COOKIE)?.value) return NextResponse.next();
  return NextResponse.redirect(new URL('/', req.url));
}

export const config = {
  // /admin 本身 + 所有子路径（步骤 6 的 /admin/messages 等一并覆盖）
  matcher: ['/admin', '/admin/:path*'],
};
