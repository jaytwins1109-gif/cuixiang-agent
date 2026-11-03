/**
 * Vitest 配置。
 *
 * 只做两件事：
 *   1. 把 `@/xxx` 还原成项目根（跟 tsconfig 的 paths、scripts/ts-alias-loader.mjs 同一口径），
 *      否则 tests 里 import `@/lib/...` 会解析失败；
 *   2. 只跑 `tests/**\/*.test.ts`——scripts 下那些守卫脚本是 CLI，不是用例文件。
 *
 * 注意 vitest 自己会转译 TS（esbuild），不需要 ts-node / tsx。
 */
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// 去掉末尾分隔符：Windows 上是 `D:\codebuddy\脆香cuixiang\`，直接拼别名会成 `...\` + `/lib/x`
const root = fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]+$/, '');

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // 守卫里都是纯函数（无 IO / 无网络），默认超时足够；留个明确的兜底值便于以后加用例
    testTimeout: 10000,
  },
  resolve: {
    alias: {
      '@': root,
    },
  },
});
