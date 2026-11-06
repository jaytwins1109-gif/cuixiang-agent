import { cookies } from 'next/headers';
import { createHash } from 'crypto';
import {
  ADMIN_SESSION_COOKIE,
  createSessionTicket,
  verifySessionTicket,
  safeEqualHex,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/admin/session';
import { TOKEN_COOKIE, verifyUserToken } from '@/lib/auth/jwt';
import { DashboardClient } from '@/components/admin/dashboard-client';

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex');
}

async function login(formData: FormData) {
  'use server';
  const pw = String(formData.get('password') || '');
  const expected = process.env.ADMIN_PASSWORD_HASH;

  if (!expected) return;
  if (!safeEqualHex(sha256(pw), expected)) return;

  // 票据由服务端用 ADMIN_PASSWORD_HASH 派生密钥签名，
  // 光手写一个 cookie 名进来是过不了校验的。
  const store = await cookies();
  store.set(ADMIN_SESSION_COOKIE, createSessionTicket(expected), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_SECONDS, // 8 小时
    path: '/',
  });
}

export default async function AdminPage() {
  const hash = process.env.ADMIN_PASSWORD_HASH;
  const store = await cookies();
  // 两条路都能进：V1 口令票据（cx_admin，8h）或 V3.0 的 ADMIN 登录票（cx_token，role 快照）。
  // middleware 已拦掉非 ADMIN，这里再验一次是纵深防御——页面自己不信 middleware。
  const tokenTicket = await verifyUserToken(store.get(TOKEN_COOKIE)?.value);
  const authed =
    verifySessionTicket(store.get(ADMIN_SESSION_COOKIE)?.value, hash) ||
    tokenTicket?.role === 'ADMIN';

  // 未设置口令：给出配置方法，不让任何人进得来
  if (!hash) {
    return <Notice>还没设置 ADMIN_PASSWORD_HASH，后台未启用。</Notice>;
  }

  if (!authed) {
    return (
      <Shell>
        <h1 className="mb-1 text-xl font-extrabold text-slate-800">脆香后台</h1>
        <p className="mb-5 text-xs text-slate-400">输入管理口令进入</p>
        <form action={login} className="space-y-3">
          <input
            type="password"
            name="password"
            placeholder="管理口令"
            className="w-full rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-800 outline-none focus:border-slate-400 focus:ring-2 focus:ring-slate-100"
          />
          <button className="w-full rounded-xl bg-cx-300 py-2.5 text-sm font-bold text-white transition hover:bg-cx-400">
            进入
          </button>
        </form>
        <p className="mt-4 text-[11px] leading-relaxed text-slate-400">
          口令用 <code className="rounded bg-slate-100 px-1">ADMIN_PASSWORD_HASH</code>{' '}
          配置，取明文口令的 sha256。改完记得重启 dev。
        </p>
      </Shell>
    );
  }

  // authed：V3.0 数据看板（V1 的"配没配"状态页职责被看板取代，配置排查走 env）
  return <DashboardClient />;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-6 shadow-card">
        {children}
      </div>
    </main>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <p className="text-sm text-slate-700">{children}</p>
      <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
        生成方式：
        <code className="mt-1 block rounded bg-white px-2 py-1.5 text-[11px]">
          node -e
          &quot;console.log(require(&apos;crypto&apos;).createHash(&apos;sha256&apos;).update(&apos;你的口令&apos;).digest(&apos;hex&apos;))&quot;
        </code>
      </p>
    </Shell>
  );
}
