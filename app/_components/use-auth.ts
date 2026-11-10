'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { ensureUserId } from './storage';
import type { MemorySnapshot } from './types';

/**
 * 前端鉴权状态的唯一来源。
 *
 * 几个刻意的设计：
 *
 * 1. **userId 永远是可用值**。没登录时用 localStorage 里那个 `u_xxx`，
 *    所以"游客 → 注册"不需要换 id——服务端 upgrade 走的是 UPDATE 而不是新建，
 *    记忆、想要清单、聊天记录全都挂在同一个 id 上，天然无缝。
 *
 * 2. **服务端票据优先**。`/api/auth/me` 说你是谁就是谁：本地 localStorage 里
 *    那个 id 只在没登录时才算数。否则在另一台设备登录后，本地老 id 会一直
 *    覆盖掉登录态（换设备就看不到自己的记忆，等于没登录）。
 *
 * 3. **不把账号状态写进 localStorage**。cookie 是 HttpOnly，前端读不到也删不掉，
 *    唯一真源是 `/api/auth/me`；本地缓存一份只会出现"界面说已登录、实际没登"。
 */
export interface AuthState {
  /** 首次 /api/auth/me 还没回来：这期间别急着把用户渲染成游客 */
  loading: boolean;
  /** 未登录时是本地生成的 u_xxx / guest_xxx */
  userId: string;
  email: string | null;
  /** 服务端账号表里的昵称；null = 还没拿到 / 读失败 */
  nickname: string | null;
  isGuest: boolean;
}

export interface AuthResult {
  ok: boolean;
  error?: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const MIN_PASSWORD = 8;

/** 服务端 memory 快照 → 前端结构；字段缺失一律当空数组，别让 undefined 漏进渲染 */
function normalizeMemory(raw: unknown): MemorySnapshot {
  const m = (raw ?? {}) as Record<string, unknown>;
  const pick = (k: string) =>
    Array.isArray(m[k])
      ? (m[k] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [];
  return {
    core_profile: pick('core_profile'),
    summary_memory: pick('summary_memory'),
    active_fragments: pick('active_fragments'),
  };
}

export function useAuth() {
  const [state, setState] = useState<AuthState>({
    loading: true,
    // 首帧留空，挂载后再取：server 渲染时没有 localStorage，写死 'anonymous' 会在
    // 水合前的那一瞬间把请求头弄成匿名桶（虽然马上会纠正，但没必要制造这个窗口）
    userId: '',
    email: null,
    nickname: null,
    isGuest: true,
  });

  const mounted = useRef(true);
  /** 挂载状态要靠 effect 复位：React 严格模式下 effect 会跑两遍 */
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * 最近一次 `/api/auth/me` 签发的游客票据。
   *
   * cookie 存不住的时候（内嵌浏览器 / 预览面板 / 第三方 Cookie 被拦）注册会一直 403，
   * 所以票据还走一条 body 通道：注册时随 body 带上，服务端 cookie 认不到就验这张。
   * 只在内存里，不落 localStorage——它是凭证，不该被脚本随便读。
   */
  const guestTicket = useRef<string | null>(null);

  /** 没拿到远端 id 时退回本地 id，保证请求头里永远有值 */
  const userId = state.userId || (typeof window === 'undefined' ? '' : ensureUserId());

  /**
   * 拉一次 `/api/auth/me`：既更新登录态，也把服务端记忆快照带回来。
   *
   * 要带 `x-guest-id`：服务端凭它认游客，并在票据缺失时补发一张 `cx_guest`
   * （没有那张票，新访客点"注册"会被升级接口的防劫持校验挡成 403）。
   */
  const refresh = useCallback(async (): Promise<MemorySnapshot | null> => {
    const localId = typeof window === 'undefined' ? '' : ensureUserId();
    try {
      const res = await fetch('/api/auth/me', {
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'x-guest-id': localId },
      });
      const data = res.ok ? await res.json() : null;
      if (!mounted.current) return null;

      // 服务端补发了新票据才带这个字段；null 表示"票据本来就对得上"，留着上一张
      if (data && typeof data.guestTicket === 'string' && data.guestTicket) {
        guestTicket.current = data.guestTicket;
      }

      if (data && typeof data.userId === 'string' && data.userId) {
        setState({
          loading: false,
          userId: data.userId,
          email: typeof data.email === 'string' ? data.email : null,
          nickname: typeof data.nickname === 'string' ? data.nickname : null,
          isGuest: data.isGuest !== false,
        });
        return normalizeMemory(data.memory);
      }

      // 未登录：沿用本地 id（就是升级前的那个，所以退出登录不会"丢记忆"）
      setState({
        loading: false,
        userId: localId || state.userId,
        email: null,
        nickname: typeof data?.nickname === 'string' ? data.nickname : null,
        isGuest: true,
      });
      return null;
    } catch {
      if (mounted.current) {
        setState((prev) => ({
          loading: false,
          userId: prev.userId || localId,
          email: null,
          // 网断了别把已经显示的昵称抹掉：留着上一份，等下次 refresh 再对齐
          nickname: prev.nickname,
          isGuest: true,
        }));
      }
      return null;
    }
    // 依赖刻意留空：state.userId 只作兜底，放进依赖会让 refresh 每次都换新函数，
    // 而它在挂载 effect 的依赖里 → 无限重拉 /api/auth/me
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const post = useCallback(
    async (path: string, body: unknown, headers?: Record<string, string>) => {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        credentials: 'same-origin',
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => null);
      return { res, data };
    },
    [],
  );

  /** 注册（游客升级）：id 不变，只把邮箱密码补上 */
  const upgrade = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      const clean = email.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(clean)) return { ok: false, error: '邮箱格式不对' };
      if (password.length < MIN_PASSWORD)
        return { ok: false, error: `密码至少 ${MIN_PASSWORD} 位` };
      /**
       * 三条身份线索一起带：
       *   - `x-guest-id` 头：与所有其他接口同口径，服务端一眼看出"这条请求认的是谁"
       *   - body `guestId`：upgrade 的判定基准
       *   - body `guestTicket`：cookie 存不住 / cookie 里是旧 id 时的兜底凭证
       */
      const attempt = () =>
        post(
          '/api/auth/upgrade',
          {
            guestId: userId,
            guestTicket: guestTicket.current ?? undefined,
            email: clean,
            password,
          },
          { 'x-guest-id': userId },
        );
      try {
        let { res, data } = await attempt();
        /**
         * 403 = 手里有票据但都对不上（服务端只拦这一种）。两种来源：
         * ① 页面刚打开、`/api/auth/me` 还没回来，内存里还没有票据（竞态）
         * ② 浏览器里残留一张**旧 id** 的 cookie，而 body 票据还没拿到
         * 先刷新一次身份（会重发票据、写进内存里的 body 票据）再试一次：
         * ② 就靠 body 票据走通——这种情况刷新页面也未必好，别让用户白刷。
         */
        if (res.status === 403) {
          await refresh();
          ({ res, data } = await attempt());
        }
        if (!res.ok) {
          // 重试后仍失败：把"能自救的动作"写进提示，别只甩一句校验失败
          const msg = data?.error || '注册失败，稍后再试';
          return { ok: false, error: res.status === 403 ? `${msg}（刷新一下页面再点一次）` : msg };
        }
        await refresh();
        return { ok: true };
      } catch {
        return { ok: false, error: '网断了，稍后再试' };
      }
    },
    [post, refresh, userId],
  );

  const login = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      const clean = email.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(clean)) return { ok: false, error: '邮箱格式不对' };
      if (!password) return { ok: false, error: '密码不能空着' };
      try {
        const { res, data } = await post('/api/auth/login', { email: clean, password });
        if (!res.ok) return { ok: false, error: data?.error || '登录失败，稍后再试' };
        await refresh();
        return { ok: true };
      } catch {
        return { ok: false, error: '网断了，稍后再试' };
      }
    },
    [post, refresh],
  );

  /**
   * 退出登录：cookie 是 HttpOnly 的，只能由服务端清。
   * 退出后回到游客态，但 id 还是原来那个——所以记忆不会因为"退出"而消失。
   */
  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch {
      /* 网络失败也继续：cookie 过期后本来就会自动失效 */
    }
    await refresh();
  }, [refresh]);

  /**
   * 改昵称：PATCH 成功后**直接改 state**，不刷新页面、也不重新拉 /api/auth/me。
   *
   * 身份口径和别的接口一样带 `x-guest-id`（登录态时服务端仍以 cookie 为准），
   * body 里不传 userId——那是自报身份。
   */
  const updateNickname = useCallback(
    async (raw: string): Promise<AuthResult> => {
      try {
        const res = await fetch('/api/auth/me', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-guest-id': userId },
          credentials: 'same-origin',
          body: JSON.stringify({ nickname: raw }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) return { ok: false, error: data?.error || '昵称没存上，稍后再试' };
        const next = typeof data?.nickname === 'string' ? data.nickname : raw;
        if (mounted.current) setState((prev) => ({ ...prev, nickname: next }));
        return { ok: true };
      } catch {
        return { ok: false, error: '网断了，稍后再试' };
      }
    },
    [userId],
  );

  return {
    loading: state.loading,
    userId,
    email: state.email,
    nickname: state.nickname,
    isGuest: state.isGuest,
    refresh,
    login,
    upgrade,
    logout,
    updateNickname,
  };
}
