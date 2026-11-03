'use client';

import { useCallback, useEffect, useRef } from 'react';

/**
 * 把一份 state debounce 着写进 localStorage。
 *
 * 为什么要 debounce：流式回复每吐一个字就 `setMessages` 一次，
 * 原来那个"有变化就写盘"的 effect 会跟着同步 `setItem` 一遍——
 * 一句 60 字的话就是 60 次 JSON.stringify + 60 次磁盘写，
 * 主线程白白卡顿，而中间那几十版内容根本没人会读。
 *
 * 为什么还要 `ready`：首帧的 `messages` 只有欢迎语，读档 effect 还没把历史塞回来。
 * 不拦住的话，首帧会先把"只有欢迎语"的那一版写进 localStorage，
 * 历史就被覆盖了——debounce 会把这段空窗从 0ms 拉到几百毫秒，风险反而更大。
 *
 * 为什么还要 `pagehide`：debounce 的代价是"最后几百毫秒的改动还在内存里"，
 * 用户这时候关标签页就会丢。切后台 / 页面隐藏 / 组件卸载时强制 flush 一次补上。
 */
export function useDebouncedWrite(key: string, value: unknown, ready = true, delay = 300) {
  const latest = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    try {
      localStorage.setItem(key, JSON.stringify(latest.current));
    } catch {
      /* 隐私模式 / 超配额：写不了就算了，内存里的状态仍然是对的 */
    }
  }, [key]);

  // 每次变化先更新快照，真正的写盘交给下面的定时器
  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    if (!ready) return;
    latest.current = value;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delay);
    return () => {
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, [ready, value, delay, flush]);

  useEffect(() => {
    if (!ready) return;
    const onHide = () => flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', onHide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', onHide);
      document.removeEventListener('visibilitychange', onVisibility);
      // 卸载（切走页面 / 热更新）前把最后一份落盘
      flush();
    };
  }, [ready, flush]);
}
