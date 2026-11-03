// scripts/ts-alias-loader.mjs
// 给 Node 的 ESM 解析器补两件事，让 smoke 能直接跑 lib 下的 .ts：
//   1. `@/xxx` 别名 → 项目根（tsconfig paths 里的那一条）
//   2. 无扩展名的 import（"@/lib/data/snacks"）→ 补 .ts / .tsx / index.ts
//
// 为什么需要：smoke.mjs 是 node 脚本，不是 Next 编译产物，
// 它 import 一个 .ts 时没人帮它解析 `@/`。以前只能 import 那些**恰好没有别名**的模块
// （如 lib/llm/time-context.ts），兜底链路所在的 orchestrator.ts 用别名，测不到。

import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function firstFile(base) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mts`,
    path.join(base, 'index.ts'),
    path.join(base, 'index.tsx'),
  ];
  for (const c of candidates) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  // `@/xxx` → 项目根
  if (specifier.startsWith('@/')) {
    const hit = firstFile(path.join(root, specifier.slice(2)));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
    return nextResolve(specifier, context);
  }

  // 相对路径同样要补扩展名：源码里写的是 "./snacks"，
  // ESM 却要求完整文件名（Next 编译时能解析，裸 node 不行）
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const parent = context.parentURL ? path.dirname(fileURLToPath(context.parentURL)) : root;
    const hit = firstFile(path.resolve(parent, specifier));
    if (hit) return { url: pathToFileURL(hit).href, shortCircuit: true };
  }

  return nextResolve(specifier, context);
}
