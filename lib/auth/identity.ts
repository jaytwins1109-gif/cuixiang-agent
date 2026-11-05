// lib/auth/identity.ts
//
// 一次请求「我是谁」的唯一判定处。两个 AI 入口（/api/ai、/api/ai/stream）都从这里拿 userId，
// 不许各自再写一套——分叉了就会出现"流式认得登录态、非流式不认"这种灵异现象。
//
// 优先级（从强到弱）：
//   1. cx_token cookie  —— 已登录用户，服务端签名，userId 以票据为准（不再清洗）
//   2. x-guest-id 请求头 —— 前端主路径
//   3. 都没有            —— 现发一个 guest id
//
// **没有 `body.userId` 这一档了**（V2.1 删除）。留着它等于允许客户端自报身份：
// 谁都能把 body 里的 userId 写成别人的 id，读走别人的记忆。旧前端在 V2.0 就已经
// 统一改成发 `x-guest-id` 头，这条兼容通道只剩攻击面，没有使用者。
//
// 顺带负责"补发票据"：游客第一次来（或票据与 id 对不上）时签一张 cx_guest，
// 由调用方塞进响应头。没有这张票，/api/auth/upgrade 拒绝升级——这是刻意设计的。

import type { NextRequest } from 'next/server';
import {
  GUEST_COOKIE,
  TOKEN_COOKIE,
  signGuestTicket,
  verifyGuestTicket,
  verifyUserToken,
} from './jwt';
import { normalizeUserId } from './user-id';
import { tracePrefix } from '@/lib/chat/trace';

export type IdentitySource = 'token' | 'guest-header' | 'new-guest';

export interface Identity {
  userId: string;
  isGuest: boolean;
  /** 这轮身份从哪来，写进 trace 日志，排查时一眼看出是谁 */
  source: IdentitySource;
  /** 需要下发给浏览器的游客票据（只在游客身份且票据缺失/不匹配时非空） */
  guestTicket?: string;
}

export async function resolveIdentity(req: NextRequest): Promise<Identity> {
  // 1) 登录态：票据说你是谁就是谁，请求体里传什么都盖不掉
  const tokenUserId = await verifyUserToken(req.cookies.get(TOKEN_COOKIE)?.value);
  if (tokenUserId) {
    return { userId: tokenUserId, isGuest: false, source: 'token' };
  }

  // 2) 游客：只认请求头，没有就现发一个
  const headerRaw = req.headers.get('x-guest-id') || '';
  const source: IdentitySource = headerRaw ? 'guest-header' : 'new-guest';
  const userId = normalizeUserId(headerRaw);

  // 3) 票据自检：对得上就不重发，对不上（没票 / 换了 id / 过期）就签一张新的。
  //    正常浏览器一次签发后随 Set-Cookie 落住，之后每请求都走上面的"对得上"早退——
  //    签发只发生在首次 / 过期 / 换 id，不是高频热路径。
  //    打点日志（2026-11-05 外审建议）：若线上这条日志刷屏，说明前端 cookie 没落住
  //    或有人在无 cookie 客户端裸奔，那是前端问题，别拿重签发逻辑背锅
  const ticketGuest = await verifyGuestTicket(req.cookies.get(GUEST_COOKIE)?.value);
  if (ticketGuest === userId) {
    return { userId, isGuest: true, source };
  }

  const guestTicket = await signGuestTicket(userId).catch(() => undefined);
  if (guestTicket) {
    console.log(
      `${tracePrefix()}[Identity] 补发游客票据 uid=${userId} source=${source}（首次/过期/换id）`,
    );
  }
  return { userId, isGuest: true, source, guestTicket };
}
