import type { Config } from 'tailwindcss';

export default {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}', // V3.0 Admin UI（components/admin + components/ui）
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      /**
       * 色板走 CSS 变量，换皮肤只改变量值，不用动任何 className。
       * 变量存的是 RGB 通道（"255 248 240"）而不是完整颜色——
       * 这样 bg-cx-700/30 这类带透明度的写法才能继续生效。
       */
      colors: {
        cx: {
          50: 'rgb(var(--cx-50) / <alpha-value>)', // 页面底色
          100: 'rgb(var(--cx-100) / <alpha-value>)', // 分隔线 / 浅填充
          200: 'rgb(var(--cx-200) / <alpha-value>)', // 边框
          300: 'rgb(var(--cx-300) / <alpha-value>)', // 主色
          400: 'rgb(var(--cx-400) / <alpha-value>)', // 主色 hover
          500: 'rgb(var(--cx-500) / <alpha-value>)', // 强调 / 价格
          600: 'rgb(var(--cx-600) / <alpha-value>)', // 标题
          700: 'rgb(var(--cx-700) / <alpha-value>)', // 正文
        },
      },
      borderRadius: {
        bubble: '1.25rem',
      },
      boxShadow: {
        card: '0 8px 24px -8px rgb(var(--cx-shadow) / <alpha-value>)',
      },
      keyframes: {
        'fade-in': {
          '0%': { opacity: '0', transform: 'translateY(6px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in .28s ease-out',
      },
    },
  },
  plugins: [],
} satisfies Config;
