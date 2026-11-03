// lib/auth/rate-limit.ts
//
// 极简限流：滑动固定窗口，按 userId 计数。
//
// 为什么不做成多实例安全的方案：这是个单机部署的小项目，进程级 Map 足够挡住
// 「一个脚本疯狂刷接口」。真要上多实例，这里换成 Redis 的 INCR + EXPIRE 即可，
// 调用点（两个 AI 入口）不需要改。
//
// 为什么按 userId 而不是 IP：
//   同一个 WiFi 下（宿舍、公司、奶茶店）所有人共用一个出口 IP，
//   按 IP 限流会误伤"朋友刚说完一句就被拦"的正常用户；
//   按 userId 只惩罚真正刷屏的那个人。
//   副作用是换一个 id 就能绕过——但 id 要换就得先清 cookie，恶意成本已经上去了。

const WINDOW_MS = 60 * 1000;
/** 一分钟 10 次：正常聊天一分钟说不了 10 句，刷屏脚本一秒就撞墙 */
const MAX_HITS = 10;

interface Bucket {
  windowStart: number;
  count: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitResult {
  ok: boolean;
  /** 这一分钟还剩几次 */
  remaining: number;
  /** 被限流时：多少秒后再试 */
  retryAfter: number;
}

/**
 * 记一次访问并判断是否超限。
 *
 * 惰性清理：不跑定时器（dev 热重载会把定时器留成僵尸），
 * 只在 Map 长到一定规模时顺手扫一遍过期桶。
 */
export function checkRateLimit(key: string, now: number = Date.now()): RateLimitResult {
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) {
      if (now - b.windowStart >= WINDOW_MS) buckets.delete(k);
    }
  }

  const bucket = buckets.get(key);
  if (!bucket || now - bucket.windowStart >= WINDOW_MS) {
    buckets.set(key, { windowStart: now, count: 1 });
    return { ok: true, remaining: MAX_HITS - 1, retryAfter: 0 };
  }

  if (bucket.count >= MAX_HITS) {
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, Math.ceil((bucket.windowStart + WINDOW_MS - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { ok: true, remaining: MAX_HITS - bucket.count, retryAfter: 0 };
}

/** 测试与脚本用：把计数清空 */
export function resetRateLimit(): void {
  buckets.clear();
}
