// lib/auth/nickname.ts
//
// 用户昵称的唯一口径：默认值怎么生成、写库前怎么洗、AI 入口怎么读。
//
// 三条不能省的考虑：
//   1. 昵称会**拼进 system prompt**（见 `system-prompt.ts` 的 `nicknameSection`），
//      所以用户填的换行 / 引号 / 方括号 / 反斜杠必须先洗掉，否则等于给了一条
//      "从用户资料里越权改写提示词"的通道。
//   2. 默认值只在库里那条 `nickname` 为空时才算数；用户改过之后不许被覆盖回去。
//   3. 读函数要容忍"用户行还不存在"（新访客还没聊过、没写过记忆），
//      不能因为查不到行就让「我是谁」这条对话报错。

import { prisma } from '@/lib/db';

/** 昵称最长字数：按码点算，emoji 不会把字符串切坏 */
export const NICKNAME_MAX = 24;

/** 提示词里不能出现的字符：引号 / 括号 / 注释符 / 反斜杠 / 空白 */
const UNSAFE_CHARS = /["'`\\<>()[\]{}【】#\s]/;

/**
 * 按**码点**过滤，而不是写 `[\u0000-\u001f]` 那种控制字符区间：
 * ESLint 的 no-control-regex 会拦下后者；而且按码点过滤连 C1 控制符（\u007f-\u009f）
 * 一并挡住，比列黑名单更严。
 */
function safeText(input: unknown): string {
  return Array.from(String(input ?? ''))
    .filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code > 31 && code !== 127 && !UNSAFE_CHARS.test(ch);
    })
    .join('');
}

/**
 * 默认昵称规则（产品定死）：`"用户" + 邮箱前缀前 4 位`；
 * 邮箱为空时取 `userId` 的后 4 位。
 *
 * 两处数据源都要过同一份 `safeText`：邮箱前缀和 userId 理论上都来自服务端，
 * 但前缀是用户注册时填的，别把没洗过的字符串拼进提示词。
 */
export function defaultNickname(email?: string | null, userId?: string | null): string {
  const localPart = String(email || '').split('@')[0];
  const source = localPart
    ? Array.from(safeText(localPart)).slice(0, 4).join('')
    : Array.from(safeText(String(userId || '').slice(-4))).join('');
  return `用户${source || '朋友'}`;
}

/** 用户自己填的昵称：洗掉提示词敏感字符、限长；空串返回 null（不合法） */
export function cleanNickname(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = Array.from(safeText(input)).slice(0, NICKNAME_MAX).join('');
  return cleaned || null;
}

/**
 * 给 AI 链路读昵称：库里有就用库里的，没有就按规则生成默认值并**顺手落库**，
 * 保证下次 `/api/auth/me`、注册、登录看到的是同一个名字。
 *
 * 返回 null 只可能是取数失败（或 userId 为空）——「我是谁」的兜底话术据此引导用户去设置。
 */
export async function resolveNickname(userId: string): Promise<string | null> {
  if (!userId) return null;
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { nickname: true, email: true },
    });
    const stored = user?.nickname ? cleanNickname(user.nickname) : null;
    if (stored) return stored;

    const fallback = defaultNickname(user?.email, userId);
    if (user) {
      // 并发时两轮都写同一个默认值，无害；写失败也不该拖垮整轮对话
      await prisma.user
        .update({ where: { id: userId }, data: { nickname: fallback } })
        .catch(() => undefined);
    }
    return fallback;
  } catch (err) {
    console.error('[nickname] resolveNickname', err);
    return null;
  }
}
