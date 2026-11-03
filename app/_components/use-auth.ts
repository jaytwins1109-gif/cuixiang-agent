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

      if (data && typeof data.userId === 'string' && data.userId) {
        setState({
          loading: false,
          userId: data.userId,
          email: typeof data.email === 'string' ? data.email : null,
          isGuest: data.isGuest !== false,
        });
        return normalizeMemory(data.memory);
      }

      // 未登录：沿用本地 id（就是升级前的那个，所以退出登录不会"丢记忆"）
      setState({ loading: false, userId: localId || state.userId, email: null, isGuest: true });
      return null;
    } catch {
      if (mounted.current) {
        setState((prev) => ({
          loading: false,
          userId: prev.userId || localId,
          email: null,
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

  const post = useCallback(async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => null);
    return { res, data };
  }, []);

  /** 注册（游客升级）：id 不变，只把邮箱密码补上 */
  const upgrade = useCallback(
    async (email: string, password: string): Promise<AuthResult> => {
      const clean = email.trim().toLowerCase();
      if (!EMAIL_PATTERN.test(clean)) return { ok: false, error: '邮箱格式不对' };
      if (password.length < MIN_PASSWORD)
        return { ok: false, error: `密码至少 ${MIN_PASSWORD} 位` };
      try {
        const { res, data } = await post('/api/auth/upgrade', {
          guestId: userId,
          email: clean,
          password,
        });
        if (!res.ok) return { ok: false, error: data?.error || '注册失败，稍后再试' };
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

  return {
    loading: state.loading,
    userId,
    email: state.email,
    isGuest: state.isGuest,
    refresh,
    login,
    upgrade,
    logout,
  };
}
