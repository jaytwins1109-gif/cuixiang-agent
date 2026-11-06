// app/api/auth/upgrade/route.ts
//
// 游客升级：不新建用户，直接把当前游客行补上邮箱密码、isGuest 置 false。
// 这样之前聊出来的记忆一条都不用搬——记忆本来就挂在同一个 userId 上。
//
// 安全上最关键的一步：**必须验 cx_guest 票据**。
// 只凭 body 里的 guestId 就改库，等于「知道别人的 u_xxx 就能把他账号绑到我的邮箱」，
// 而 u_xxx 是可以在浏览器地址栏/日志里看到的。票据是服务端签的，改不了。

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
  verifyGuestTicket,
} from '@/lib/auth/jwt';
import { strictUserId } from '@/lib/auth/user-id';

export const runtime = 'nodejs';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
/** bcrypt 10 轮：单次约 100ms，够挡住离线爆破，又不至于让登录明显变慢 */
const BCRYPT_ROUNDS = 10;

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    guestId?: unknown;
    email?: unknown;
    password?: unknown;
  } | null;

  // 严格校验：这里不接受"洗一洗还能用"，id 必须原样合法且与票据一致
  const guestId = strictUserId(body?.guestId);
  if (!guestId) {
    return NextResponse.json({ error: '游客身份不合法，刷新页面再试' }, { status: 400 });
  }

  const ticketGuest = await verifyGuestTicket(req.cookies.get(GUEST_COOKIE)?.value);
  if (ticketGuest !== guestId) {
    return NextResponse.json({ error: '游客身份校验失败，刷新页面再试' }, { status: 403 });
  }

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
    const guest = await prisma.user.findUnique({ where: { id: guestId } });
    if (guest && !guest.isGuest) {
      return NextResponse.json({ error: '这个账号已经注册过了，直接登录吧' }, { status: 409 });
    }

    // 邮箱唯一性：已被别人的账号占用就拒绝（自己的 id 不算冲突，重复提交要幂等）
    const taken = await prisma.user.findUnique({ where: { email } });
    if (taken && taken.id !== guestId) {
      return NextResponse.json({ error: '这个邮箱已经被注册过了' }, { status: 409 });
    }

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
    /**
     * 库里没有行是常见情况（新访客还没聊过），不能当成错误：
     * cx_guest 票据已经证明这个 id 就是他自己的，而且没有任何历史数据要继承，
     * 直接建行就是"注册"本来的含义。原先这里回 404「先聊一句再来注册」，
     * 实测把第一次进站就想注册的人挡在门外了。
     */
    const user = await prisma.user.upsert({
      where: { id: guestId },
      create: { id: guestId, email, password: hashed, isGuest: false },
      update: { email, password: hashed, isGuest: false },
    });

    const token = await signUserToken(user.id, normalizeRole(user.role));
    const res = NextResponse.json({ userId: user.id, email: user.email });
    res.headers.append('Set-Cookie', cookieString(TOKEN_COOKIE, token, TOKEN_MAX_AGE));
    // 升级完游客票据就作废，避免它继续被用来"再升级一次"
    res.headers.append('Set-Cookie', clearCookieString(GUEST_COOKIE));
    return res;
  } catch (err) {
    console.error('[auth/upgrade]', err);
    return NextResponse.json({ error: '注册服务出了点问题' }, { status: 500 });
  }
}
