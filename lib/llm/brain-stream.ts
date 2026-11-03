// lib/llm/brain-stream.ts
// 大脑的流式通道：模型逐块吐 JSON，这里增量解析，尽早把 reply 交给前端。
//
// 与 callBrain 的关系：callBrain 是「等完整结果再返回」，这里是「边收边吐」。
// 两条路的错误处理与兜底策略不同，混在一起会让两边都难改，所以分开。
// 但两者共用 lib/rules/patterns.ts 里的同一份正则，口径不会分叉。

import { ZERO_WIDTH_PATTERN } from '@/lib/rules/patterns';
import { buildSystemPrompt, buildChatPrompt } from '@/lib/prompts/system-prompt';
import type { BrainContext, ChatMessage, Filters } from './index';
import { resolveRuntimes, CHAT_TEMPERATURE } from './index';
// 与 lib/llm/index.ts 同一套口径：报错行带 TraceID 前缀，TraceID 从请求上下文取
import { tracePrefix } from '@/lib/chat/trace';

/** 等首字的耐心：模型开口前最多等这么久 */
const FIRST_TOKEN_TIMEOUT_MS = 8_000;

/** 整条流的上限：开口之后还能吐多久，防止挂死 */
const TOTAL_STREAM_TIMEOUT_MS = 30_000;

/** 流式通道里吐出来的东西 */
export type BrainStreamEvent =
  /** reply 新增了一段，可以立刻上屏 */
  | { type: 'delta'; text: string }
  /** 整段原始文本，流结束时给一次，交给上层做完整解析和兜底 */
  | { type: 'raw'; content: string };

/** 把 SSE 响应按 data 行逐条吐出来 */
async function* readSSE(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('响应体不可读');

  const decoder = new TextDecoder();
  let buf = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    // 最后一段可能是不完整的一行，留在 buffer 里等下一块，别急着解析
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const data = t.slice(5).trim();
      if (data === '[DONE]') return;
      if (data) yield data;
    }
  }
}

/**
 * 从累积的（可能还没拼完的）JSON 里抠出 reply 字段已确定的部分。
 *
 * 这是流式路径上唯一跑的正则相关逻辑，而且它判的是**结构**（reply 值闭合了没），
 * 不是语义——语义类的防呆一律等流结束。
 *
 * @param buffer   累积到现在的完整文本
 * @param consumed 上一次已吐出的字符数（按**解码后**的文本计）
 */
export function deltaReply(
  buffer: string,
  consumed: number,
): { text: string; consumed: number; closed: boolean } {
  const key = /"reply"\s*:\s*"/.exec(buffer);

  if (!key) {
    // 没有 reply 键，有两种可能，必须分清楚：
    //
    //   1. 模型还在拼 JSON，reply 字段排在后头 → 以 `{` 开头，继续等
    //   2. 模型压根没按 JSON 输出（流式路径没开 json_object，这在预期之内）
    //      → 整段就是人话，直接当 reply 逐字吐出去
    //
    // 不分的话，第 2 种情况会一个 delta 都不吐，流式等于白做。
    const trimmed = buffer.trimStart();
    if (!trimmed || trimmed.startsWith('{')) {
      return { text: '', consumed, closed: false };
    }
    return {
      text: buffer.slice(consumed),
      consumed: buffer.length,
      closed: false,
    };
  }

  let i = key.index + key[0].length;
  let decoded = '';

  while (i < buffer.length) {
    const ch = buffer[i];

    if (ch === '\\') {
      // 转义符落在块尾、或 \u 后面没收够 4 位 → 等下一块，别吐半个字
      if (i + 1 >= buffer.length) break;
      const esc = decodeEscape(buffer, i);
      if (esc.len === 0) break;
      decoded += esc.text;
      i += esc.len;
      continue;
    }
    if (ch === '"') {
      // reply 值闭合：剩下没吐的一起吐完，并标记结束
      return {
        text: decoded.slice(consumed),
        consumed: decoded.length,
        closed: true,
      };
    }

    decoded += ch;
    i += 1;
  }

  return {
    text: decoded.slice(consumed),
    consumed: decoded.length,
    closed: false,
  };
}

/** 解析一处 JSON 转义；收不全返回 len=0，让调用方等下一块 */
function decodeEscape(s: string, i: number): { text: string; len: number } {
  const c = s[i + 1];
  const simple: Record<string, string> = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
  };
  if (c in simple) return { text: simple[c], len: 2 };
  if (c === 'u') {
    const hex = s.slice(i + 2, i + 6);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      return { text: String.fromCharCode(parseInt(hex, 16)), len: 6 };
    }
    return { text: '', len: 0 }; // \u00 只到了一半
  }
  return { text: s[i], len: 1 };
}

/**
 * 流式调大脑：模型吐一个字，这里就往外递一个字。
 *
 * ## 正则防呆层怎么异步、分块处理
 *
 * 这是整个流式化里唯一真正棘手的地方。本地防呆正则分两类，处理方式完全不同：
 *
 * ### A. 输入侧正则 —— 流开始前同步跑完
 *
 * `detectMemoryIntent` / `handlePendingConfirmation` / `extractPrefsFromText` / `allowRecommend`
 * 判的都是**用户说了什么**。用户输入是完整的，压根不存在"分块"问题。
 * 这类在调用方（route.ts）里处理，流式路径不碰。
 *
 * ### B. 输出侧正则 —— 流结束后一次性跑
 *
 * `cleanReply` / 敬语 / 内部信息 / 脏话 / `looksLikeRecommendPitch` / `keepTransitionOnly`
 * 判的是**语义**。pattern 会跨 chunk 出现——"我给你挑了三样"完全可能被切成
 * "我给你挑" + "了三样"。在分块状态下跑必然漏判，所以一律等流结束再跑一遍完整的。
 *
 * ### C. 唯一例外：零宽字符
 *
 * 它字符级、无上下文依赖，所以在流式路径上逐块洗掉。
 * 这样即使后面出错中断，已经上屏的字也是干净的。
 *
 * ## 代价（刻意的取舍）
 *
 * **已上屏的 reply 可能被 final 事件改写**——模型前面说得好好的，
 * 最后突然蹦出一句"清单如下"，整句就得兜掉、替换成人话。
 * 先快，再准，总比让用户干等一个"准确"要好。
 */
export async function* streamBrain(
  messages: ChatMessage[],
  filters?: Filters,
  ctx?: BrainContext,
  /**
   * 走纯陪聊链路：提示词换成 `buildChatPrompt`（不注商品库、不讲业务规则），
   * 温度走陪聊档。与 `callBrain` 的 `routeIntent` 分流同源——
   * 两条入口的陪聊必须是同一副口气，否则用户换个入口就像换了一个人。
   */
  chatOnly = false,
): AsyncGenerator<BrainStreamEvent> {
  const lastMsg = messages[messages.length - 1];
  const fullMessages: ChatMessage[] = [
    {
      role: 'system',
      content: chatOnly
        ? buildChatPrompt(ctx?.memoryText)
        : buildSystemPrompt(filters, ctx?.memoryText),
    },
    ...messages.slice(0, -1),
    { role: 'user', content: lastMsg.content },
  ];

  for (const rt of resolveRuntimes()) {
    const ctrl = new AbortController();
    const timers: ReturnType<typeof setTimeout>[] = [];

    try {
      // 第一段耐心：等模型开口
      timers.push(setTimeout(() => ctrl.abort(), FIRST_TOKEN_TIMEOUT_MS));

      const res = await fetch(rt.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${rt.apiKey}`,
        },
        body: JSON.stringify({
          model: rt.model,
          messages: fullMessages,
          temperature: chatOnly ? CHAT_TEMPERATURE : 0.8,
          // 流式不走 json_object：那个约束本身就会把模型卡住吐空白（见 3.2），
          // 而流式路径本来就要靠本地解析兜格式，多一层约束反而是负担
          stream: true,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        console.warn(`${tracePrefix()}[Brain:stream] ${rt.provider} 返回 ${res.status}`);
        continue;
      }

      // 开口了，换成整条流的上限
      timers.push(setTimeout(() => ctrl.abort(), TOTAL_STREAM_TIMEOUT_MS));

      let buffer = '';
      let consumed = 0;

      for await (const data of readSSE(res)) {
        let chunk = '';
        try {
          const j = JSON.parse(data);
          chunk = j?.choices?.[0]?.delta?.content || '';
        } catch {
          continue; // 心跳行、不合法行，跳过
        }
        if (!chunk) continue;

        // C 类：字符级的清洗可以在流式路径上逐块做
        buffer += chunk.replace(ZERO_WIDTH_PATTERN, '');

        // 增量抠 reply：JSON 没拼完也能先把确定的字吐出去
        const d = deltaReply(buffer, consumed);
        if (d.text) {
          consumed = d.consumed;
          yield { type: 'delta', text: d.text };
        }
      }

      // 流结束：整段原文交上去，由上层跑 B 类（语义）防呆与完整解析
      yield { type: 'raw', content: buffer };
      return;
    } catch (err: any) {
      console.warn(`${tracePrefix()}[Brain:stream] ${rt.provider} 失败：`, err?.message);
    } finally {
      timers.forEach(clearTimeout);
    }
  }

  throw new Error('大脑流式响应失败');
}
