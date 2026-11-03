// app/api/auth/me/route.ts
//
// 「我现在是谁」+ 当前记忆快照。
//
// 为什么要带 memory：游客升级成正式用户后，前端手里的 profile 缓存已经过期
// （升级前是本地攒的，升级后真源在库里）。少一次往返，让它一次拿全，
// 直接覆盖本地缓存，避免防抖定时器把旧 profile 又写回去。
//
// 未登录/票据过期不报错，返回游客态空快照——前端按这个状态渲染登录入口即可，
// 401 会让控制台一片红，反而干扰真问题的排查。

import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { TOKEN_COOKIE, verifyUserToken } from '@/lib/auth/jwt';
import { recallMemory } from '@/lib/memory/store';

export const runtime = 'nodejs';

const EMPTY_MEMORY = { core_profile: [], summary_memory: [], active_fragments: [] };

export async function GET(req: NextRequest) {
  const userId = await verifyUserToken(req.cookies.get(TOKEN_COOKIE)?.value);
  if (!userId) {
    return NextResponse.json({ userId: null, email: null, isGuest: null, memory: EMPTY_MEMORY });
  }

  try {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      // 票据有效但用户被删了：当未登录处理，别让前端卡在"半登录"状态
      return NextResponse.json({ userId: null, email: null, isGuest: null, memory: EMPTY_MEMORY });
    }

    const memory = await recallMemory(userId);
    return NextResponse.json({
      userId: user.id,
      email: user.email,
      isGuest: user.isGuest,
      memory: {
        core_profile: memory.core_profile,
        summary_memory: memory.summary_memory,
        active_fragments: memory.active_fragments,
      },
    });
  } catch (err) {
    console.error('[auth/me]', err);
    return NextResponse.json({ error: '读取账号信息失败' }, { status: 500 });
  }
}
