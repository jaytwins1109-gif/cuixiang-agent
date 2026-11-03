// app/api/auth/logout/route.ts
//
// 退出登录。cookie 是 HttpOnly 的，前端 delete 不了，只能由服务端下发一条 Max-Age=0。
//
// 注意只清 cx_token，不清 cx_guest：退出后这个人回到游客态，
// 但他这轮用的游客 id 还是要带着的（否则记忆换桶，等于"退出登录记忆就没了"）。

import { NextResponse } from 'next/server';
import { TOKEN_COOKIE, clearCookieString } from '@/lib/auth/jwt';

export const runtime = 'nodejs';

export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.headers.append('Set-Cookie', clearCookieString(TOKEN_COOKIE));
  return res;
}
