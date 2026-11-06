// lib/auth/guard.ts — Admin API 守卫（V3.0）
//
// 安全边界原则：middleware 只是体验层（把非管理员弹回首页），
// **API 层的安全靠这里**。所有 /api/admin/* 路由第一行调用，
// 拿不到 userId 就直接 403，不许再往下走。
//
// 为什么只认 cx_token、不认 x-guest-id：游客头是客户端自报的，
// requireAdmin 的判定必须完全建立在服务端签名的票据上——
// role 是签发时快照（拍板过的方案：降权活到 token 过期，接受这个窗口）。
import type { NextRequest } from 'next/server';
import { TOKEN_COOKIE, verifyUserToken } from './jwt';

export interface AdminIdentity {
  userId: string;
}

/**
 * ADMIN 放行（回 userId），其余（无票 / 游客 / USER / 旧票缺 role）一律 null。
 * 调用方统一这样用：
 *   const admin = await requireAdmin(req);
 *   if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });
 */
export async function requireAdmin(req: NextRequest): Promise<AdminIdentity | null> {
  const ticket = await verifyUserToken(req.cookies.get(TOKEN_COOKIE)?.value);
  if (!ticket || ticket.role !== 'ADMIN') return null;
  return { userId: ticket.userId };
}
