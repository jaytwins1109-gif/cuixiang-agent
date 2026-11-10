// app/api/auth/me/route.ts
//
// 「我现在是谁」+ 当前记忆快照。
//
// 为什么要带 memory：游客升级成正式用户后，前端手里的 profile 缓存已经过期
// （升级前是本地攒的，升级后真源在库里）。少一次往返，让它一次拿全，
// 直接覆盖本地缓存，避免防抖定时器把旧 profile 又写回去。
// 游客也带：刷新页面后侧栏能立刻显示"一直记着"的那些偏好，不用先聊一句。
//
// 顺带负责**补发游客票据**：新访客从没发过消息，本来没有 cx_guest；
// 这时候点"注册"会被 upgrade 的票据校验挡成 403（那道校验是防账号被绑走的，
// 不能删）。所以在 identity 判定之后，票据缺失/不匹配就签一张一起带回去。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import {
  GUEST_COOKIE,
  GUEST_MAX_AGE,
  TOKEN_COOKIE,
  TOKEN_MAX_AGE,
  clearCookieString,
  cookieString,
  signUserToken,
  normalizeRole,
  userTokenRemaining,
  verifyUserToken,
} from '@/lib/auth/jwt';
import { resolveIdentity } from '@/lib/auth/identity';
import { cleanNickname, resolveNickname } from '@/lib/auth/nickname';
import { recallMemory } from '@/lib/memory/store';

export const runtime = 'nodejs';

interface MemoryPayload {
  core_profile: string[];
  summary_memory: string[];
  active_fragments: string[];
}

const EMPTY_MEMORY: MemoryPayload = {
  core_profile: [],
  summary_memory: [],
  active_fragments: [],
};

export async function GET(req: NextRequest) {
  const ticket = await verifyUserToken(req.cookies.get(TOKEN_COOKIE)?.value);
  /**
   * 票据有效但库里没这个人（账号被删）：
   * 落到游客分支，并**把过期票据清掉**——否则这张票还会在 AI 入口被当成登录态，
   * 一个已经删掉的账号能继续用、还会被 writeMemory 顺手 upsert 复活。
   */
  let staleToken = false;

  if (ticket) {
    try {
      const user = await prisma.user.findUnique({ where: { id: ticket.userId } });
      if (user) {
        const memory = await recallMemory(ticket.userId);
        const res = NextResponse.json({
          userId: user.id,
          email: user.email,
          isGuest: user.isGuest,
          // nickname 为空时按规则兜默认值并落库（2026-11-10）
          nickname: await resolveNickname(user.id),
          memory: {
            core_profile: memory.core_profile,
            summary_memory: memory.summary_memory,
            active_fragments: memory.active_fragments,
          },
        });
        /**
         * 滑动续期：票据寿命过半就换一张新的。
         *
         * 不续的话，登录 30 天后的那一刻用户会被静默踢回游客态——记忆还在，
         * 但侧栏突然"变空"，他只会觉得"这破站又抽了"。前端每次打开页面都会打
         * 这个接口，所以活跃用户永远在被踢之前就换好票了。
         * 只在过半时续，避免每次刷新都写一次 Set-Cookie。
         */
        const remaining = await userTokenRemaining(req.cookies.get(TOKEN_COOKIE)?.value);
        if (remaining !== null && remaining < TOKEN_MAX_AGE / 2) {
          const fresh = await signUserToken(user.id, normalizeRole(user.role)).catch(() => null);
          if (fresh) {
            res.headers.append('Set-Cookie', cookieString(TOKEN_COOKIE, fresh, TOKEN_MAX_AGE));
          }
        }
        return res;
      }
      staleToken = true;
    } catch (err) {
      console.error('[auth/me]', err);
      return NextResponse.json({ error: '读取账号信息失败' }, { status: 500 });
    }
  }

  // 游客分支：认 x-guest-id 头（前端每次都会带），没有就现发一个
  const identity = await resolveIdentity(req);
  let memory: typeof EMPTY_MEMORY = EMPTY_MEMORY;
  try {
    const recalled = await recallMemory(identity.userId);
    memory = {
      core_profile: recalled.core_profile,
      summary_memory: recalled.summary_memory,
      active_fragments: recalled.active_fragments,
    };
  } catch (err) {
    // 读记忆失败不该让"我是谁"也查不了：退回空快照，前端照样能显示游客态
    console.error('[auth/me]', err);
  }

  const res = NextResponse.json({
    userId: identity.userId,
    email: null,
    isGuest: true,
    // 游客也带一个默认昵称：邮箱为空时按 userId 后 4 位生成
    nickname: await resolveNickname(identity.userId),
    memory,
    /**
     * 票据同时放进 body：内嵌浏览器 / 第三方 Cookie 被拦时 cx_guest 存不住，
     * 前端注册时把它随 body 带回 /api/auth/upgrade（那边 cookie 校验有回退）。
     * 没补发（票据本来就对得上）时是 null，前端会留着上一次那张。
     */
    guestTicket: identity.guestTicket ?? null,
  });
  if (staleToken) {
    res.headers.append('Set-Cookie', clearCookieString(TOKEN_COOKIE));
  }
  if (identity.guestTicket) {
    res.headers.append(
      'Set-Cookie',
      cookieString(GUEST_COOKIE, identity.guestTicket, GUEST_MAX_AGE),
    );
  }
  return res;
}

/**
 * 改自己的昵称（2026-11-10）。
 *
 * 身份口径与 AI 入口完全一致：`resolveIdentity()` 认 cookie 或 `x-guest-id`，
 * 不收 body 里的 userId——那是自报身份，等于允许改别人的资料。
 * 游客行可能还不存在（没聊过 / 没写过记忆），所以走 upsert：
 * 建行时只带 id + isGuest，别顺手把 password / email 写成假值。
 *
 * 昵称要拼进 system prompt，`cleanNickname()` 负责挡掉换行、引号、括号和控制字符。
 */
export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { nickname?: unknown } | null;
  const nickname = cleanNickname(body?.nickname);
  if (!nickname) {
    return NextResponse.json({ error: '昵称不能是空的（最多 24 个字）' }, { status: 400 });
  }

  try {
    const identity = await resolveIdentity(req);
    await prisma.user.upsert({
      where: { id: identity.userId },
      create: { id: identity.userId, nickname, isGuest: identity.isGuest },
      update: { nickname },
    });
    const res = NextResponse.json({ ok: true, userId: identity.userId, nickname });
    if (identity.guestTicket) {
      res.headers.append(
        'Set-Cookie',
        cookieString(GUEST_COOKIE, identity.guestTicket, GUEST_MAX_AGE),
      );
    }
    return res;
  } catch (err) {
    console.error('[auth/me] PATCH', err);
    return NextResponse.json({ error: '昵称没存上，稍后再试' }, { status: 500 });
  }
}
