'use client';

import { useState } from 'react';

import { MIN_PASSWORD } from './use-auth';

export type AuthMode = 'upgrade' | 'login';

/**
 * 注册 / 登录表单（同一个组件两种模式）。
 *
 * 为什么注册走"游客升级"而不是新建账号：用户可能已经聊了半天，
 * 说过"花生过敏"、点过几样想要的。新建账号等于换一个人，
 * 那些记忆全落在老 id 上，用户会觉得"注册完它就把我忘了"。
 * 所以注册 = 给当前游客 id 补邮箱密码，id 不变、记忆原地继承。
 */
export function AuthDialog({
  mode,
  busy,
  error,
  onClose,
  onSubmit,
  onSwitch,
}: {
  mode: AuthMode;
  busy: boolean;
  /** 服务端返回的错误（邮箱被占用、密码不对……） */
  error: string | null;
  onClose: () => void;
  onSubmit: (email: string, password: string) => void;
  onSwitch: (mode: AuthMode) => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  /** 本地校验错误优先于服务端错误：邮箱格式错时没必要发请求 */
  const [localError, setLocalError] = useState<string | null>(null);

  const upgrading = mode === 'upgrade';
  const shown = localError || error;

  function submit() {
    const clean = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) {
      setLocalError('邮箱看着不太对，检查一下');
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setLocalError(`密码至少 ${MIN_PASSWORD} 位`);
      return;
    }
    setLocalError(null);
    onSubmit(clean, password);
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div className="relative w-full max-w-sm animate-fade-in rounded-2xl bg-white p-5 shadow-xl">
        <div className="mb-1 flex items-start justify-between">
          <div>
            <h2 className="text-base font-bold text-cx-700">{upgrading ? '注册个账号' : '登录'}</h2>
            <p className="mt-1 text-xs leading-relaxed text-cx-400">
              {upgrading
                ? '现在记住的忌口、口味都会跟着走，换手机也不丢'
                : '登录后接着用你原来的记忆，一件不落'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-cx-400 hover:bg-cx-50"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="mt-4 space-y-3">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-cx-500">邮箱</span>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder="you@example.com"
              autoComplete="email"
              className="w-full rounded-xl border border-cx-200 bg-white px-3.5 py-2.5 text-sm outline-none transition placeholder:text-cx-300 focus:border-cx-300 focus:ring-2 focus:ring-cx-100"
            />
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-cx-500">密码</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') submit();
              }}
              placeholder={`至少 ${MIN_PASSWORD} 位`}
              autoComplete={upgrading ? 'new-password' : 'current-password'}
              className="w-full rounded-xl border border-cx-200 bg-white px-3.5 py-2.5 text-sm outline-none transition placeholder:text-cx-300 focus:border-cx-300 focus:ring-2 focus:ring-cx-100"
            />
          </label>

          {shown && (
            <p className="rounded-xl bg-red-50 px-3 py-2 text-xs leading-relaxed text-red-500">
              {shown}
            </p>
          )}

          <button
            onClick={submit}
            disabled={busy}
            className="w-full rounded-xl bg-cx-300 px-4 py-3 text-sm font-bold text-white shadow transition hover:bg-cx-400 disabled:opacity-40"
          >
            {busy ? '稍等…' : upgrading ? '注册并继续用' : '登录'}
          </button>

          <button
            onClick={() => {
              setLocalError(null);
              onSwitch(upgrading ? 'login' : 'upgrade');
            }}
            className="w-full text-center text-xs text-cx-500 underline-offset-2 hover:underline"
          >
            {upgrading ? '我已有账号，直接登录' : '还没有账号？用当前记录注册一个'}
          </button>
        </div>
      </div>
    </div>
  );
}
