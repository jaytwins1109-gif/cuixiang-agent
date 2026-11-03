import type { Metadata, Viewport } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '脆香零食 · 你的零食推荐好友',
  description: '懂零食、会聊天的 AI 陪伴客服「脆脆」',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  themeColor: '#FFB84D',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <head>
        {/*
          在样式生效前就把皮肤落上去，不然深色皮肤会先闪一帧浅色再变暗。
          要跟 page.tsx 里的 THEME_KEY / THEMES 保持一致。
        */}
        <script
          dangerouslySetInnerHTML={{
            __html: `try{var t=localStorage.getItem('cx_theme_v1');if(t)document.documentElement.dataset.theme=t;}catch(e){}`,
          }}
        />
      </head>
      <body className="bg-cx-50 text-cx-700 antialiased">{children}</body>
    </html>
  )
}
