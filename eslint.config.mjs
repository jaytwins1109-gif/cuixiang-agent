/**
 * ESLint 9 flat config。
 *
 * 立场：**宽松优先**。这个仓库的类型安全靠 `tsc --noEmit` 兜（`npm run verify` 的第一段），
 * lint 只负责抓"编译器不认为是错、但人一眼看出有问题"的那类东西（空 catch、重复 key、
 * 误用表达式……）。所以：
 *   - 不开 type-checked 规则（慢，且会在 `any` 满天飞的老代码里刷出几百条）；
 *   - `no-explicit-any` 关掉，`no-unused-vars` 降成 warn；
 *   - 风格类规则全部交给 Prettier（`eslint-config-prettier` 关掉冲突项）。
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      '.next/**',
      'data/**', // 运行期记忆数据，不是源码
      '*.log',
      'smoke-*.txt',
      'next-env.d.ts', // Next 生成
      '.playwright-cli/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,

  {
    languageOptions: {
      // 既跑浏览器（app/）、也跑 node（scripts/、route handlers），混着给最省事
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      // ── 以下几项是刻意关掉的，不是漏配 ──
      '@typescript-eslint/no-explicit-any': 'off', // 存量 20+ 处，改类型不在本轮范围
      'no-unused-vars': 'off', // 交给下面 TS 版本（能忽略 _ 前缀）
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      // 空 catch 里经常只有一句注释（"没有旧文件就没什么可备份的"），这是有意为之
      'no-empty': ['warn', { allowEmptyCatch: true }],
      '@typescript-eslint/no-empty-object-type': 'off',
      '@typescript-eslint/no-require-imports': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-constant-condition': ['warn', { checkLoops: false }],
    },
  },

  {
    // 脚本是一次性工具，允许 console / process.exit 这类写法
    files: ['scripts/**/*.{ts,mjs}', '*.config.{ts,mjs}'],
    rules: {
      'no-console': 'off',
    },
  },
);
