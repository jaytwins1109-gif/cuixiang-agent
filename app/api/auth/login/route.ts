// app/api/auth/login/route.ts
//
// 邮箱 + 密码登录。成功签一个 HttpOnly JWT cookie，失败统一话术。
//
// 两个刻意的做法：
//   1. 「邮箱不存在」与「密码错」回同一句「邮箱或密码不对」——
//      分开说等于给了一个免费的邮箱枚举接口。
//   2. 游客行（isGuest=true）即使 password 有值也不许登录：正常流程里游客没有密码，
//      真有值说明是脏数据，放进来会让"升级"这条唯一入口形同虚设。

import { NextRequest, NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/db';
import {
  GUEST_COOKIE,
  TOKEN_COOKIE,
  TOKEN_MAX_AGE,
  clearCookieString,
  cookieString,
  signUserToken,
  normalizeRole,
} from '@/lib/auth/jwt';

export const runtime = 'nodejs';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    email?: unknown;
    password?: unknown;
  } | null;

  const email = String(body?.email ?? '')
    .trim()
    .toLowerCase();
  const password = String(body?.password ?? '');

  if (!EMAIL_PATTERN.test(email)) {
    return NextResponse.json({ error: '邮箱格式不对' }, { status: 400 });
  }
  if (password.length < 8) {
    return NextResponse.json({ error: '密码至少 8 位' }, { status: 400 });
  }

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user || !user.password || user.isGuest) {
      return NextResponse.json({ error: '邮箱或密码不对' }, { status: 401 });
    }

    const matched = await bcrypt.compare(password, user.password);
    if (!matched) {
      return NextResponse.json({ error: '邮箱或密码不对' }, { status: 401 });
    }

    const token = await signUserToken(user.id, normalizeRole(user.role));
    const res = NextResponse.json({ userId: user.id, email: user.email });
    res.headers.append('Set-Cookie', cookieString(TOKEN_COOKIE, token, TOKEN_MAX_AGE));
    // 登录成功清掉游客票据：后续 upgrade 不该再拿老游客 id 来改东西
    res.headers.append('Set-Cookie', clearCookieString(GUEST_COOKIE));
    return res;
  } catch (err) {
    console.error('[auth/login]', err);
    return NextResponse.json({ error: '登录服务出了点问题' }, { status: 500 });
  }
}
