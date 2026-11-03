// lib/chat/trace.ts
// 链路日志：一次请求一个短 TraceID，四个固定打点（Request / Brain / Local / Response）。
//
// 为什么单独抽一个文件：/api/ai 与 /api/ai/stream 两条入口、以及 lib/chat/handlers.ts
// 都要打点。各写一份格式必然分叉——scripts/capture-log.mjs 是靠固定前缀从日志里捞行的，
// 格式一变脚本就捞不到，而"改了一边忘了另一边"正是这个项目最怕的事。
//
// ── 行格式（capture-log.mjs 按它解析，改格式必须连脚本一起改）──────────
//   [a7f3k2] [Request]  收到请求，用户输入: 想吃零食 | 入口=/api/ai userId=u123
//   [a7f3k2] [Brain]    模型判定意图: recommend, 抽取偏好: flavor=辣味;avoid=不吃辣
//   [a7f3k2] [Local]    触发拦截规则: 硬要忌口货, 兜底处理: 本地回绝，不进 LLM
//   [a7f3k2] [Response] 最终返回文案: 行，来了——…, 推荐卡片数: 3 | degraded=false
//
// 两条硬要求：
// 1. **一行就是一条**：日志按行捞，reply 里原本带的换行一律压平（见 oneLine），
//    否则一条推荐回复（含逐款清单）会把日志切成七八行，后半截全成噪声。
// 2. **只在真的触发时打**：[Local] 是"拦截/兜底"信号，每轮都打等于没有信号。

import { AsyncLocalStorage } from 'node:async_hooks';

const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** 单条打点进日志前的最大字符数：太长会把同一轮的其它信息挤出可视区 */
const MAX_LEN = 200;

/** 每请求一个短 ID（6 位，如 a7f3k2）：交错日志里靠它串起同一次对话 */
export function newTraceId(): string {
  let out = '';
  for (let i = 0; i < 6; i++) {
    out += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return out;
}

// ── Trace 上下文（AsyncLocalStorage）──────────────────────
// 为什么需要它：最该被追溯的报错发生在**最深处**——lib/llm/index.ts 里的
// provider 报错、超时重试、降级判定，这些函数都不接 traceId 参数。
// 要让它们带上 TraceID 有两个办法：
//   a. 把 traceId 当参数一层层往下传（签名污染一大片，而且迟早漏传一两个）
//   b. 用 ALS 把整轮请求包起来，深处直接问"现在这个请求的 TraceID 是多少"
// 这里选 b。**不能**用模块级全局变量存当前 ID——请求是并发的，会串号。

const traceStore = new AsyncLocalStorage<{ traceId: string }>();

/** 在整轮请求的上下文里执行 fn：fn 内部（含深层 await）都能取到这个 TraceID */
export function runWithTrace<T>(traceId: string, fn: () => T): T {
  return traceStore.run({ traceId }, fn);
}

/** 当前请求的 TraceID；不在请求上下文里（脚本直调）时是 undefined */
export function currentTraceId(): string | undefined {
  return traceStore.getStore()?.traceId;
}

/**
 * 日志前缀 `[a7f3k2] `，给深处那些不接 traceId 参数的函数用
 * （lib/llm/index.ts 的报错行全靠它）。
 * 没有上下文时返回空串——宁可不带，也不能在日志里打出 `[undefined]`。
 */
export function tracePrefix(): string {
  const id = currentTraceId();
  return id ? `[${id}] ` : '';
}

/**
 * 报错统一走这里：**stderr 也要带 TraceID**。
 * 电脑重启后翻 dev.err.log，看一眼 TraceID 就能顺藤摸瓜回到那一轮对话。
 */
export function traceError(stage: string, err: unknown, traceId?: string): void {
  const id = traceId || currentTraceId();
  console.error(`[${id || '-'}] [${stage}]`, err);
}

/**
 * 压成单行人话 + 截断。日志是按行解析的，换行必须压平；
 * 截断是为了让 capture-log 捞出来的表格能一眼看完。
 */
export function oneLine(text: unknown, max: number = MAX_LEN): string {
  const s = String(text ?? '')
    .replace(/\r?\n/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** 偏好压缩成 `k=v;k=v`：一轮一个字段一行太占地方，空值不写 */
export function formatPrefs(prefs?: Record<string, any>): string {
  if (!prefs) return '（无）';
  const parts: string[] = [];
  for (const [k, v] of Object.entries(prefs)) {
    if (v === null || v === undefined || v === '' || v === 'null') continue;
    parts.push(`${k}=${oneLine(v, 24)}`);
  }
  return parts.length ? parts.join(';') : '（无）';
}

function emit(traceId: string, stage: string, detail: string): void {
  console.log(`[${traceId}] [${stage}] ${detail}`);
}

/** ① 收到用户请求：整轮日志的起点，TraceID 在这里第一次出现 */
export function traceRequest(
  traceId: string,
  input: {
    message: string;
    entry: string;
    userId?: string;
    /** 这轮身份从哪来（token / guest-header / new-guest），排查串号必备 */
    identity?: string;
  },
): void {
  emit(
    traceId,
    'Request',
    `收到请求，用户输入: ${oneLine(input.message, 120)} | 入口=${input.entry} userId=${input.userId || '-'}` +
      (input.identity ? ` 身份=${input.identity}` : ''),
  );
}

/** ② 大脑返回意图：模型判成了什么、抽到了哪些偏好 */
export function traceBrain(traceId: string, intent: string, prefs?: Record<string, any>): void {
  emit(traceId, 'Brain', `模型判定意图: ${intent || '（空）'}, 抽取偏好: ${formatPrefs(prefs)}`);
}

/**
 * ③ 本地拦截 / 兜底：**只在真触发时打**。
 * 这是排查时最有用的一行——它说明这一轮不是模型说了算，是本地规则接管了。
 */
export function traceLocal(traceId: string | undefined, rule: string, handling: string): void {
  // 没传就取当前请求的上下文（包在 runWithTrace 里的调用都会自动带上）；
  // 传了以传的为准——降级链路里显式传的那份更可信
  const id = traceId || currentTraceId();
  if (!id) return;
  emit(id, 'Local', `触发拦截规则: ${rule}, 兜底处理: ${oneLine(handling, 120)}`);
}

/** ④ 返回响应：最终文案 + 卡片数，附带降级/路由，够判断这一轮有没有出货 */
export function traceResponse(
  traceId: string,
  reply: unknown,
  cardCount: number,
  extra?: { degraded?: boolean; route?: string; awaiting?: boolean },
): void {
  const tail = [
    `degraded=${extra?.degraded ? 'true' : 'false'}`,
    `route=${extra?.route || '-'}`,
    extra?.awaiting ? 'awaiting_prefs=true' : '',
  ]
    .filter(Boolean)
    .join(' ');
  emit(
    traceId,
    'Response',
    `最终返回文案: ${oneLine(reply, 160)}, 推荐卡片数: ${cardCount} | ${tail}`,
  );
}
