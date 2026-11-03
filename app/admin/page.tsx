import { cookies } from 'next/headers'
import { createHash } from 'crypto'
import {
  createSessionTicket,
  verifySessionTicket,
  safeEqualHex,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/admin/session'

const COOKIE = 'cx_admin'

function sha256(text: string) {
  return createHash('sha256').update(text).digest('hex')
}

async function login(formData: FormData) {
  'use server'
  const pw = String(formData.get('password') || '')
  const expected = process.env.ADMIN_PASSWORD_HASH

  if (!expected) return
  if (!safeEqualHex(sha256(pw), expected)) return

  // 票据由服务端用 ADMIN_PASSWORD_HASH 派生密钥签名，
  // 光手写一个 cookie 名进来是过不了校验的。
  const store = await cookies()
  store.set(COOKIE, createSessionTicket(expected), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_MAX_AGE_SECONDS, // 8 小时
    path: '/',
  })
}

async function logout() {
  'use server'
  const store = await cookies()
  store.delete(COOKIE)
}

export default async function AdminPage() {
  const hash = process.env.ADMIN_PASSWORD_HASH
  const store = await cookies()
  const authed = verifySessionTicket(store.get(COOKIE)?.value, hash)

  // 未设置口令：给出配置方法，不让任何人进得来
  if (!hash) {
    return <Notice>还没设置 ADMIN_PASSWORD_HASH，后台未启用。</Notice>
  }

  if (!authed) {
    return (
      <Shell>
        <h1 className="mb-1 text-xl font-extrabold text-cx-600">脆香后台</h1>
        <p className="mb-5 text-xs text-cx-400">输入管理口令进入</p>
        <form action={login} className="space-y-3">
          <input
            type="password"
            name="password"
            placeholder="管理口令"
            className="w-full rounded-xl border border-cx-200 px-4 py-2.5 text-sm outline-none focus:border-cx-300 focus:ring-2 focus:ring-cx-100"
          />
          <button className="w-full rounded-xl bg-cx-300 py-2.5 text-sm font-bold text-white transition hover:bg-cx-400">
            进入
          </button>
        </form>
        <p className="mt-4 text-[11px] leading-relaxed text-cx-400">
          口令用 <code className="rounded bg-cx-50 px-1">ADMIN_PASSWORD_HASH</code>{' '}
          配置，取明文口令的 sha256。改完记得重启 dev。
        </p>
      </Shell>
    )
  }

  const rows = [
    ['大脑', 'DeepSeek', !!process.env.DEEPSEEK_API_KEY, process.env.DEEPSEEK_MODEL || 'deepseek-chat'],
    ['编排引擎', 'Coze / Dify / local', true, process.env.ORCHESTRATOR || 'coze'],
    ['Coze', '工作流', !!process.env.COZE_API_KEY, process.env.COZE_WORKFLOW_ID ? '已配 workflow' : '未配 workflow'],
    ['Dify', '备用异步', !!process.env.DIFY_API_KEY, process.env.DIFY_BASE_URL || 'http://localhost:3000/v1'],
  ] as const

  return (
    <Shell>
      <div className="mb-5 flex items-center justify-between">
        <h1 className="text-xl font-extrabold text-cx-600">脆香后台</h1>
        <form action={logout}>
          <button className="rounded-full border border-cx-200 px-3 py-1.5 text-xs text-cx-500 hover:bg-cx-50">
            退出
          </button>
        </form>
      </div>

      <div className="space-y-2">
        {rows.map(([name, desc, ok, detail]) => (
          <div
            key={name}
            className="flex items-center gap-3 rounded-xl border border-cx-100 bg-white px-4 py-3"
          >
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${ok ? 'bg-emerald-400' : 'bg-cx-200'}`} />
            <div className="min-w-0 flex-1">
              <div className="text-sm font-semibold text-cx-700">{name}</div>
              <div className="truncate text-xs text-cx-400">{detail}</div>
            </div>
            <span className="shrink-0 text-xs text-cx-400">{desc}</span>
          </div>
        ))}
      </div>

      <p className="mt-5 text-[11px] leading-relaxed text-cx-400">
        这里只显示「配没配」，不显示 Key 本身。要改 Key 去服务器上的{' '}
        <code className="rounded bg-cx-50 px-1">.env.local</code>。
      </p>
    </Shell>
  )
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-cx-50 p-6">
      <div className="w-full max-w-md rounded-3xl border border-cx-100 bg-cx-50/60 p-6 shadow-card">
        {children}
      </div>
    </main>
  )
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <Shell>
      <p className="text-sm text-cx-600">{children}</p>
      <p className="mt-3 text-[11px] leading-relaxed text-cx-400">
        生成方式：
        <code className="mt-1 block rounded bg-white px-2 py-1.5 text-[11px]">
          node -e &quot;console.log(require(&apos;crypto&apos;).createHash(&apos;sha256&apos;).update(&apos;你的口令&apos;).digest(&apos;hex&apos;))&quot;
        </code>
      </p>
    </Shell>
  )
}
