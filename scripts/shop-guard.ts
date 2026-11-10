// scripts/shop-guard.ts — `/shop`「0 Token 货架」的静态红线守卫
//
// 为什么需要：/shop 的产品定位是「明确购买意图不用等 AI」——Server Component 直查
// Prisma，筛选 / 加购 / 结算全是本地 state，页面内一次 LLM 都不许调。
// 这类"不能碰某个模块"的约束靠 code review 守不住：只要有人顺手 import 了
// `callBrain` 或 `fetch('/api/ai')`，页面照样能跑、构建照样过，只有成本悄悄涨上去。
// 所以从 `app/shop/page.tsx` 出发把整条本地 import 链爬一遍，逐文件查禁区。
//
// 三种跑法（与 profile-guard / reco-guard 同一套）：
//   1. `npm run guard` → CLI，打印 PASS / FAIL 行 + `GUARD_FAILED=n`
//   2. `npm run verify` → tests/shop-guard.test.ts 把每条断言变成 vitest 用例
//   3. `npm run smoke` 第 39 节 → 同样拉起 CLI 计入用例
// 所以断言逻辑收在 `runShopGuard()` 里，只有被 node 直接执行时才打印并设退出码。
//
// ⚠️ 检查前必须剥注释：这几个文件的注释里**特意写了**禁区名当说明
// （shop-shelf.tsx 第 12 行「不许出现 fetch('/api/ai')」、cart-context.tsx 第 18 行
// 「不得 import 任何 lib/llm…」），不剥注释会把自己的注释判成违规。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GuardResult } from './guard-types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = path.join(ROOT, 'app', 'shop', 'page.tsx');

/**
 * 剥掉行注释与块注释，只留代码。
 *
 * 顺序不能反：必须先剥行注释。page.tsx 的注释里写着「app/shop 加两个星号」，
 * 那个斜杠加星号会被当成块注释开头，一路吃到下一处「星号加斜杠」（第 18 行 ISR 注释结尾），
 * 把中间 12-15 行真正的 import 全吞掉——扫描链就只剩入口一个文件，守卫等于空转。
 * 这几个文件里没有含双斜杠的 URL / 字符串字面量，行优先的剥法够用。
 */
function stripComments(src: string): string {
  return src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** 抓 import / export ... from 'x' 与 import('x') 的说明符 */
function importSpecs(src: string): string[] {
  const out: string[] = [];
  const re = /(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

/** 只解析本地文件（@/ 别名与相对路径）；第三方包交给 bundler，不进扫描链 */
function resolveSpec(spec: string, fromFile: string): string | null {
  let base: string;
  if (spec.startsWith('@/')) base = path.join(ROOT, spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  for (const suffix of ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.tsx']) {
    const hit = base + suffix;
    if (fs.existsSync(hit) && fs.statSync(hit).isFile()) return hit;
  }
  return null;
}

/** 从 /shop/page.tsx 出发 BFS 出整条本地 import 链 */
export function shopImportChain(): string[] {
  const seen = new Set<string>();
  const queue = [ENTRY];
  while (queue.length) {
    const file = queue.shift()!;
    if (seen.has(file) || !fs.existsSync(file)) continue;
    seen.add(file);
    // 先剥注释：page.tsx 的注释里写了「不能 import PRODUCTS」当反面教材，
    // 不剥的话会把注释里的示例当成真的依赖拉进链里
    const src = stripComments(fs.readFileSync(file, 'utf8'));
    for (const spec of importSpecs(src)) {
      const hit = resolveSpec(spec, file);
      if (hit && !seen.has(hit)) queue.push(hit);
    }
  }
  return [...seen];
}

/** 整条链都不许碰的：LLM / 对话编排 / 提示词模块，以及它们的入口函数名 */
const LLM_FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: "import '@/lib/llm'", re: /from\s*['"][^'"]*\/lib\/llm(?:['"/]|\/)/ },
  { label: "import '@/lib/chat'", re: /from\s*['"][^'"]*\/lib\/chat(?:['"/]|\/)/ },
  { label: "import '@/lib/prompts'", re: /from\s*['"][^'"]*\/lib\/prompts(?:['"/]|\/)/ },
  { label: 'callBrain()', re: /\bcallBrain\s*\(/ },
  { label: 'streamBrain()', re: /\bstreamBrain\s*\(/ },
  { label: 'runLocalWorkflow()', re: /\brunLocalWorkflow\s*\(/ },
  { label: 'buildSystemPrompt()', re: /\bbuildSystemPrompt\s*\(/ },
  { label: 'buildChatPrompt()', re: /\bbuildChatPrompt\s*\(/ },
];

/**
 * 只查 /shop 自己的文件与购物车 context：
 * 库层（lib/db、product-cache）即便有 fetch 也是服务端取数，不该被页面红线误伤。
 */
const UI_FORBIDDEN: { label: string; re: RegExp }[] = [
  { label: "fetch('/api/ai')", re: /fetch\s*\([^)]*\/api\/ai/ },
  { label: '任意 fetch()', re: /\bfetch\s*\(/ },
  {
    label: 'snacks.ts 的静态 PRODUCTS',
    re: /import\s*\{[^}]*\bPRODUCTS\b[^}]*\}\s*from\s*['"][^'"]*snacks/,
  },
];

/** 给一段源码判违规，返回命中的规则名（供正向断言与「守卫有牙」反向对照共用） */
export function detectViolations(
  code: string,
  rules: { label: string; re: RegExp }[] = LLM_FORBIDDEN,
): string[] {
  const clean = stripComments(code);
  return rules.filter((r) => r.re.test(clean)).map((r) => r.label);
}

function read(file: string): string {
  return fs.existsSync(file) ? stripComments(fs.readFileSync(file, 'utf8')) : '';
}

export function runShopGuard(): GuardResult[] {
  const results: GuardResult[] = [];
  const report = (ok: boolean, name: string, actual: string, section = '【0 Token 红线】') => {
    results.push({ name, pass: !!ok, actual, section });
  };

  const chain = shopImportChain();
  const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/');

  report(
    chain.length >= 3,
    '扫描链没跑空（入口 + 货架组件 + 库层都被爬到）',
    `${chain.length} 个文件：${chain.map(rel).join(', ')}`,
  );

  // 整条链：不许把 LLM / 编排 / 提示词拖进 /shop
  for (const file of chain) {
    const hits = detectViolations(read(file));
    report(
      hits.length === 0,
      `${rel(file)} → import 链不碰 LLM`,
      hits.length ? `命中 ${hits.join(' / ')}` : '干净',
    );
  }

  // 页面层：任何 fetch 都不许有（加购 / 筛选 / 结算全本地）
  const uiFiles = [
    'app/shop/page.tsx',
    'app/shop/_components/shop-shelf.tsx',
    'app/_components/cart-context.tsx',
  ];
  for (const f of uiFiles) {
    const hits = detectViolations(read(path.join(ROOT, f)), UI_FORBIDDEN);
    report(
      hits.length === 0,
      `${f} → 页面内 0 网络请求 / 0 静态兜底`,
      hits.length ? `命中 ${hits.join(' / ')}` : '干净',
    );
  }

  // 库为源：Admin 改价 / 下架必须立刻反映到货架，不能拿内存 RAW 兜底
  const pageSrc = read(path.join(ROOT, 'app/shop/page.tsx'));
  report(
    /prisma\.product\.findMany\s*\(/.test(pageSrc),
    '【库为源】货架直查 Prisma Product 表',
    pageSrc.match(/prisma\.product\.findMany\s*\(/)?.[0] ?? '没找到',
    '【库为源】',
  );
  report(
    /active:\s*true/.test(pageSrc) && /stock:\s*['"]in_stock['"]/.test(pageSrc),
    '【库为源】只取在架且有货的商品',
    pageSrc.match(/where:\s*\{[^}]*\}/s)?.[0]?.replace(/\s+/g, ' ') ?? '没找到 where',
    '【库为源】',
  );
  report(
    !/^\s*['"]use client['"]/m.test(pageSrc),
    '【库为源】page.tsx 保持 Server Component',
    pageSrc.slice(0, 40).replace(/\n/g, ' '),
    '【库为源】',
  );

  // 闭环：首页要有入口，且「问问脆脆」带回来的 ?ask= 得有人消费
  const homeSrc = read(path.join(ROOT, 'app/page.tsx'));
  report(
    /href\s*=\s*['"]\/shop['"]/.test(homeSrc),
    '【闭环】首页有 /shop 入口',
    homeSrc.match(/href\s*=\s*['"]\/shop['"]/)?.[0] ?? '没找到',
    '【闭环】',
  );
  report(
    /URLSearchParams/.test(homeSrc) && /\bget\s*\(\s*['"]ask['"]\s*\)/.test(homeSrc),
    '【闭环】首页消费 ?ask=（货架「问问脆脆」不是死链）',
    homeSrc.match(/get\s*\(\s*['"]ask['"][^)]*\)/)?.[0] ?? '没找到',
    '【闭环】',
  );

  // 「守卫有牙」反向对照：正则写错时上面全绿也没意义，必须证明它抓得住真违规
  const dirty = `import { callBrain } from '@/lib/llm';\nimport { buildChatPrompt } from '@/lib/prompts';\nvoid callBrain();`;
  const dirtyHits = detectViolations(dirty);
  report(
    dirtyHits.length >= 3,
    '反向对照：注入 LLM 调用能被检出',
    `命中 ${dirtyHits.join(' / ') || '（一条都没抓到）'}`,
    '【守卫自身】',
  );
  const dirtyUi = `const r = await fetch('/api/ai', { method: 'POST' });`;
  report(
    detectViolations(dirtyUi, UI_FORBIDDEN).length >= 2,
    '反向对照：注入 fetch(/api/ai) 能被检出',
    `命中 ${detectViolations(dirtyUi, UI_FORBIDDEN).join(' / ') || '（没抓到）'}`,
    '【守卫自身】',
  );
  report(
    detectViolations(`// 注释里写 fetch('/api/ai') 只是说明\nconst x = 1;`, UI_FORBIDDEN).length ===
      0,
    '反向对照：注释里的禁区字样不误报',
    '注释已剥',
    '【守卫自身】',
  );

  return results;
}

/** 只有被 node 直接执行时才打印 + 退出；被 vitest import 时什么都不做 */
const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/shop-guard.ts');
if (isCli) {
  const results = runShopGuard();
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name} — ${r.actual}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`GUARD_FAILED=${failed}`);
  process.exit(failed ? 1 : 0);
}
