// lib/llm/index.ts
// 大脑层：意图判断 + 偏好抽取（含 introduce），输出结构化 JSON。

import {
  REFUSE_PATTERN,
  BUY_PATTERN,
  ADJUST_PATTERN,
  CONSENT_PATTERN,
  INTRODUCE_PATTERN,
  URGE_PATTERN,
  RECOMMEND_PITCH_PATTERN,
  SPICY_WANT_PATTERN,
  PRICE_PATTERN,
  KNOWN_SHORT,
  MEMORY_QUERY_PATTERN,
  MEMORY_CLEAR_PATTERN,
  MEMORY_DELETE_PATTERN,
  MEMORY_KEYWORD_PATTERN,
  PENDING_YES_PATTERN,
  PENDING_NO_PATTERN,
  QUALIFIED_ANSWER_PATTERN,
  LEAD_IN_REPLY_PATTERN,
  VAGUE_EAT_PATTERN,
  GIFT_NEED_PATTERN,
  NIGHT_PATTERN,
  ZERO_WIDTH_PATTERN,
  HONORIFIC_PATTERN,
  PROFANITY_PATTERN,
  INTERNAL_LEAK_PATTERN,
  NO_SPICY_PATTERN,
  NO_SWEET_PATTERN,
  NO_SOUR_PATTERN,
  PEANUT_ALLERGY_PATTERN,
  NUT_ALLERGY_PATTERN,
  SEAFOOD_ALLERGY_PATTERN,
  DAIRY_ALLERGY_PATTERN,
  CHEAP_PATTERN,
} from "@/lib/rules/patterns";
import { buildSystemPrompt, buildChatPrompt } from "@/lib/prompts/system-prompt";
import { findLocalSnack } from "@/lib/llm/orchestrator";
import { mentionsGoods } from "@/lib/llm/category-words";
// 这一层的报错行统一带 TraceID 前缀，重启后翻 dev.err.log 能顺藤摸瓜回到那一轮对话。
// TraceID 由请求入口用 AsyncLocalStorage 包好（见 lib/chat/trace.ts），
// 这里只读不传——把 traceId 当参数一层层传进来会污染这一整层的函数签名
import { tracePrefix } from "@/lib/chat/trace";

const DEEPSEEK_API_URL = "https://api.deepseek.com/v1/chat/completions";
const GLM_API_URL = "https://open.bigmodel.cn/api/paas/v4/chat/completions";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface Preferences {
  flavor?: string;
  budget?: string;
  texture?: string;
  emotion?: string;
  /** 长期忌口：不吃辣 / 不吃甜 / 花生过敏，后续推荐要一直避开 */
  avoid?: string;
  /** 使用场景：海边 / 户外 / 看剧 / 加班 / 办公室，推荐要贴合场景 */
  scene?: string;
  /**
   * 品类：用户点名要的那一类（坚果炒货 / 饼干膨化 / 肉类零食 …，见 local-workflow 的 CATEGORY_WORDS）。
   * 有它检索才能先把这类货捞上来，否则"我想吃坚果"会被场景/情绪命中顶掉。
   */
  category?: string;
  product_name?: string | null;
}

export interface BrainResponse {
  intent: "chat" | "recommend" | "introduce";
  reply?: string;
  preferences?: Preferences;
  /**
   * 这一句是在"抛铺垫钩子"（场景/情绪陪聊里轻轻往零食带一笔，见 §3.6）。
   * 真源在这，上层据此给前端发 lead_in——用户点头的下一轮才允许真出卡片。
   */
  leadIn?: boolean;
  /**
   * 这一句是**纯陪聊链路**（`callChatOnly`）产出的：纯文本自由输出、无 json_object 约束、
   * 提示词里没有商品库。上层据此放宽拦截——只守红线，不再拿话术池盖模型原话。
   */
  chatOnly?: boolean;
  /**
   * 大脑整体不可用：Key 欠费 / 没配 / 两个 provider 都超时或报错。
   *
   * 以前这里是**抛错**，入口直接 500——可意图判断、选品、硬过滤、话术合成
   * 本来就在本地（lib/chat/handlers.ts + local-workflow），一个 Key 断供就让整店
   * 打烊说不过去。改成带标记返回，让上层走本地降级链路，用户仍然拿得到卡片。
   * 只有"传进来的 messages 是空的"这种调用方自己的 bug 才继续抛。
   */
  unavailable?: boolean;
}

export interface Filters {
  flavor?: string;
  budget?: string;
}

/**
 * 从模型输出里抠出 JSON（保留原逻辑，很好用）。
 */
function extractJson(raw: string): BrainResponse | null {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [fence ? fence[1].trim() : "", text];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate) as BrainResponse;
    } catch {
      // 继续
    }
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1)) as BrainResponse;
      } catch {
        /* 落空 */
      }
    }
  }
  return null;
}

/**
 * 洗掉零宽字符和首尾空白。
 * 模型偶尔会吐一串不可见字符当 reply，直接进 history 会把后面的对话全带偏。
 */
export function cleanReply(raw?: string): string | undefined {
  if (typeof raw !== "string") return undefined;
  const t = raw.replace(/[\u200b-\u200f\u202a-\u202e\ufeff]/g, "").trim();
  return t || undefined;
}

/**
 * 输出侧兜底：模型吐出来的话，过一遍人设里那些**零误伤**的措辞红线。
 *
 * 人设（第二节禁止清单、第八节全局规则）里有一批纯措辞要求，模型不是每次都能守住。
 * 这里只兜三类真正会出事故或明显出戏的：
 *
 *   1. **敬语"您"** → 换成"你"。人设两处禁用，且替换不改变句意，代价为零
 *   2. **内部信息**（模型名 / 供应商 / 内部架构）→ 命中即整句作废，交给上层换兜底话术。
 *      正常中文对话不会提到这些词，不担心误伤
 *   3. **脏话 / 粗俗字眼** → 命中即整句作废，同上
 *
 * **刻意不拦**总结式结尾（"希望对你有帮助"）、关怀语收尾（"早点休息哦"）、
 * emoji 频率、口癖——这些是风格不是事实，正则判不准：
 * "早点休息"在朋友真心关心时完全合理，硬拦只会让回复更机械，
 * 而人设自己就写着「禁止把反应变成口癖」，机械恰恰是要避免的结果。
 *
 * @returns 洗过的话；返回 `undefined` 表示整句都不能用，调用方应换兜底话术
 */
function sanitizeModelReply(raw?: string): string | undefined {
  const clean = cleanReply(raw);
  if (!clean) return undefined;

  // 内部信息与脏话改词救不回来，整句作废让上层换一句干净的
  if (INTERNAL_LEAK_PATTERN.test(clean) || PROFANITY_PATTERN.test(clean)) {
    return undefined;
  }

  return clean.replace(HONORIFIC_PATTERN, "你");
}

/**
 * 【改动3】兜底：加介绍类关键词，避免"介绍一下"被当闲聊。
 */
function guessIntent(raw: string): BrainResponse {
  const recommendHit =
    /推荐|来个|想吃|买点|买个|有啥好吃|有什么好吃|来点|整点|换一批|换一个/.test(
      raw,
    );
  const introduceHit = /介绍|啥样|是什么|讲讲|说说|这个.*怎么样|怎么吃/.test(
    raw,
  );

  if (recommendHit) return { intent: "recommend" };
  // 这里**故意不带商品名**：抠名字必须交给上层用**用户原话**做。
  // 拿模型输出去匹配的话，它随口提一句"海苔脆片原味装"就会被当成在介绍它。
  // 上层抠不出商品的 introduce 会降回陪聊（两条路的 introduce 分支）。
  if (introduceHit)
    return { intent: "introduce", preferences: { product_name: null } };
  // raw 可能是模型吐的一串空白，必须先洗再兜底，否则空气泡会直接飘到用户面前
  return { intent: "chat", reply: sanitizeModelReply(raw) || UNCLEAR_REPLY };
}

// ── 意图防呆 ──────────────────────────────────────
// 规则表达式统一收在 lib/rules/patterns.ts，调口径去那里改。

export interface BrainContext {
  /** 上一轮是不是刚推过卡片（在改条件也算要推荐） */
  inRecommendContext?: boolean;
  /**
   * 服务端长期记忆的人话版（renderMemoryForPrompt 的输出）。
   * 拼进 system 末尾，让大脑真的看得见"这人不吃辣"这类跨会话约定，
   * 而不是只靠前端传来的当轮 userProfile。没有就不填。
   */
  memoryText?: string;
}

/** 这道闸只做「放行 / 拦下」，不负责把 chat 升成 recommend */
export function allowRecommend(text: string, ctx?: BrainContext): boolean {
  // 拒绝优先："不想吃东西了"含"不想吃"，会撞上改条件规则，但它其实是撤单
  if (REFUSE_PATTERN.test(text)) return false;
  if (BUY_PATTERN.test(text)) return true;
  // 催货：「你说说」「哪几样呢」——人已经点头要了，再陪聊一轮就是把人晾着。
  // 必须在降级判断里放行，否则上一轮的饼还没兑现，这轮又被拦回陪聊
  if (URGE_PATTERN.test(text)) return true;
  // 点名了某一类货就算在要（"有没有巧克力"）——这条补的是"没说'来点/推荐'但说清了要什么"，
  // 历史上它会被降级成陪聊，用户说了半天要的东西反而被晾着
  if (mentionsGoods(text)) return true;
  if (ctx?.inRecommendContext && ADJUST_PATTERN.test(text)) return true;
  // 追问偏好之后用户的回答（"不吃辣""要甜的"）是在报偏好，不是闲聊
  if (ctx?.inRecommendContext && Object.keys(extractPrefsFromText(text)).length)
    return true;
  // 答"随便/都行"或直接点头 = 让我们直接推
  if (ctx?.inRecommendContext && CONSENT_PATTERN.test(text)) return true;
  return false;
}

/**
 * 意图路由：本地先定，再决定这一轮走哪条模型链路。
 *
 * 陪聊（旅游大巴）与推荐/介绍（危险品运输车）的待遇本来就不该一样：
 * 陪聊要的是"像人说话"，所以给精简提示词 + 纯文本自由输出；
 * 推荐/介绍要的是可解析的结构化结果，所以给完整业务提示词 + json_object。
 *
 * 判定顺序与结构化链路里那三道纠偏（`callBrain` 内部）**同源**，
 * 那边判完的结果跟这里必然一致，所以陪聊这一支不用再让模型判一次意图——
 * 省一次往返，也免得模型把"烦死"判成 recommend 又纠回来。
 *
 *   1. 打听具体商品优先：它长得像"开口要"（"火鸡面啥样"里就有商品名），
 *      先判要货就会甩三张卡当回答，答非所问
 *   2. `allowRecommend` 放行 → 货是一定要出的，走结构化链路
 *   3. 其余 → 陪聊
 */
export function routeIntent(
  text: string,
  ctx?: BrainContext,
): BrainResponse["intent"] {
  if (INTRODUCE_PATTERN.test(text) && findLocalSnack(text)) return "introduce";
  if (allowRecommend(text, ctx)) return "recommend";
  return "chat";
}

/**
 * 催货升级：上一轮画了饼，这轮用户追着要货 → chat 升 recommend。
 *
 * `allowRecommend` 只管"放行 / 拦下"，**不负责把 chat 升成 recommend**，
 * 所以催货信号必须在意图纠偏阶段单独升一次，否则人问到第三轮还见不到货。
 *
 * 普通接口与 SSE 两条路共用这一个入口——历史上两条路各写一份，
 * SSE 那份漏过防线，导致"画饼不出货"只在流式下复现，这种分叉靠比对查不完。
 */
export function upgradeForUrge(
  intent: BrainResponse["intent"],
  text: string,
): BrainResponse["intent"] {
  if (intent === "chat" && URGE_PATTERN.test(text)) return "recommend";
  return intent;
}

/**
 * 从用户原话里抠出硬性约束，给模型兜底。
 *
 * 必要的原因：聊天被判成陪聊再升级成推荐时，模型常把 preferences 留空，
 * 结果"我不吃辣"照样推火鸡面——忌口是硬约束，丢一次就是事故，不能只指望模型自觉。
 */
// 想要辣的说法：见 lib/rules/patterns.ts 的 SPICY_WANT_PATTERN

export function extractPrefsFromText(text: string): Preferences {
  const prefs: Preferences = {};
  const t = text || "";

  // 忌口先行，优先级最高："不想吃辣"这类否定式必须拦在口味抽取之前，
  // 否则下面的 /吃辣/ 会把它抽成"想吃辣"——忌口直接反转成喜好，比丢失更糟。
  //
  // ⚠️ 这份抽取现在是**长期偏好唯一的写入依据**（见 pickTrustedProfile）：
  // 模型当轮填的 preferences 只用于本轮选品，能不能进"一直记着"全看这里抽不抽得到。
  // 所以过敏原必须覆盖全：漏一个就等于用户说了白说，后面每一轮都按没听见处理。
  const noSpicy = NO_SPICY_PATTERN.test(t);
  if (noSpicy) prefs.avoid = "不吃辣";
  else if (NO_SWEET_PATTERN.test(t)) prefs.avoid = "不吃甜";
  else if (NO_SOUR_PATTERN.test(t)) prefs.avoid = "不吃酸";
  else if (PEANUT_ALLERGY_PATTERN.test(t)) prefs.avoid = "花生过敏";
  else if (NUT_ALLERGY_PATTERN.test(t)) prefs.avoid = "坚果过敏";
  else if (SEAFOOD_ALLERGY_PATTERN.test(t)) prefs.avoid = "海鲜过敏";
  else if (DAIRY_ALLERGY_PATTERN.test(t)) prefs.avoid = "乳制品过敏";

  if (CHEAP_PATTERN.test(t)) prefs.budget = "30元内";

  // 场景：聊到"看海/爬山/追剧"时想吃的，推荐要贴合场景，不能永远火鸡面辣条
  if (/看海|海边|沙滩|吹海风|赶海/.test(t)) prefs.scene = "海边";
  else if (/爬山|徒步|登山|郊游|野餐|踏青|出去玩|露营/.test(t))
    prefs.scene = "户外";
  else if (/追剧|看剧|看电影|刷剧|电影|剧集/.test(t)) prefs.scene = "看剧";
  else if (/加班|熬夜|上班|深夜|打工|通宵/.test(t)) prefs.scene = "加班";
  else if (/办公室|摸鱼|工位/.test(t)) prefs.scene = "办公室";

  // 忌口命中后跳过对应口味分支，"不吃辣，来点甜的"要能同时拿到 avoid + flavor
  if (!noSpicy && SPICY_WANT_PATTERN.test(t)) prefs.flavor = "辣味";
  else if (!NO_SWEET_PATTERN.test(t) && /想吃甜|甜的|甜口|甜味/.test(t))
    prefs.flavor = "甜味";
  else if (/咸的|咸味/.test(t)) prefs.flavor = "咸味";
  else if (/酸的|酸味/.test(t)) prefs.flavor = "酸味";
  else if (/清淡|不油腻|清爽/.test(t)) prefs.flavor = "清淡";

  // 口感：以前本地完全不抽，全交给模型。后果是 texture 只有"模型当轮推测"这一个来源，
  // 追问闸（167988）根本分不清「用户说了要脆的」和「我们从"烦"脑补出嚼感」——
  // 于是"推荐个零食吧"这种裸要，模型顺手填个嚼感就把闸门绕过去了。
  // 用户明说的一律本地认下来，模型那份只当作补充。
  if (/脆|酥|嘎嘣|咔嚓|咔滋/.test(t)) prefs.texture = "脆";
  else if (/嚼劲|耐嚼|有嚼[头劲]|筋道|磨牙|嚼着/.test(t)) prefs.texture = "嚼感";
  else if (/软的|绵软|入口即化|软糯/.test(t)) prefs.texture = "软";

  return prefs;
}

/** 丢掉 null / 空串，只留真正有用的字段 */
function compactPrefs(prefs?: Preferences): Preferences {
  const out: Preferences = {};
  if (!prefs) return out;
  for (const [k, v] of Object.entries(prefs)) {
    if (typeof v === "string" && v.trim() && v !== "null") {
      out[k as keyof Preferences] = v.trim() as any;
    }
  }
  return out;
}

/**
 * 本地抠的兜底在前，模型填的在后覆盖——硬约束不丢，模型的判断优先。
 * userText 传的是最近几轮用户发言拼起来的原文：场景信息常常散落在好几轮里
 * （"想出去玩"→"看海吧"→"带点什么吃的"），只看最后一句会整个漏掉。
 */
export function mergedPrefs(userText: string, modelPrefs?: Preferences): Preferences {
  return { ...extractPrefsFromText(userText), ...compactPrefs(modelPrefs) };
}

/** 把最近几轮用户发言拼成一段，交给偏好抽取找场景 / 忌口 */
export function recentUserText(messages: ChatMessage[], maxTurns = 4): string {
  return messages
    .filter((m) => m.role === "user")
    .slice(-maxTurns)
    .map((m) => m.content)
    .join(" ");
}

/** 最后一条用户发言：兜底话术要拿它判断"是不是在说饿/馋" */
function lastUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content || "";
  }
  return "";
}

/**
 * 降级可观测：每一处"本轮没按正常流程走"都要在这里留一行。
 *
 * 以前只能靠读对话内容反推"刚才是不是降级了"——复读机出了事，
 * 得拿用户截图一句句猜。降级本身不丢人，出了事查不到才丢人。
 */
export function logDegraded(
  reason: string,
  extra?: Record<string, unknown>,
): void {
  console.warn(`${tracePrefix()}[Degrade]`, reason, extra ? JSON.stringify(extra) : "");
}

// 价格识别、短打招呼放行：见 lib/rules/patterns.ts 的 PRICE_PATTERN / KNOWN_SHORT

/**
 * 判断是不是随手乱敲的输入（"dnu""asd，我图断予"这类）。
 * 只拦没汉字的：有汉字就当正经输入交给模型，别误伤。
 */
function isGibberish(text: string): boolean {
  const t = (text || "").trim();
  if (!t) return true;

  // 有汉字（或中文标点/全角字符）→ 当正经中文输入
  if (/[\u4e00-\u9fff\u3000-\u303f\uff01-\uff5e]/.test(t)) return false;

  const compact = t.replace(/[\s!.,?~…、，。！？]+/g, "");
  if (!compact) return false; // 纯标点/空白，模型接得住（"。。。"→"咋了"）
  if (KNOWN_SHORT.test(compact)) return false;

  // 没有英文字母：纯数字/符号串，短的都是表情包式发言（666、？？？），放行
  if (!/[a-z]/i.test(compact)) return compact.length > 12;

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length >= 2) return false; // 带空格的多词，像正经英文

  // 单个字母串：短的双字符叠字（ww、aa）放行；3 位以上还全是辅音，基本是乱敲
  const c = compact.toLowerCase();
  if (c.length <= 2) return false;
  return !/[aeiou]/.test(c);
}

/**
 * 没听清时的兜底：说"我没懂"，不说"嗯？"。
 *
 * 反问句在中文里很容易读成质问——用户随手敲了个「说说」「嗯？」，
 * 回一句"嗯？"像在挑衅，等于把我们自己的解析失败怪到用户头上。
 */
export const UNCLEAR_REPLY = "我没太听懂你的意思呢，可不可以再说一遍呀？";

/** 乱码输入的人设内兜底，随机挑一句，避免每次都一样 */
function pickGibberishReply(): string {
  const pool = [
    UNCLEAR_REPLY,
    "手滑了吧，这几个字我看着有点懵",
    "没看懂这几个字，再打一遍？",
    "这打的是啥字，我知识库查无此词",
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 模型把推荐清单写进 reply 时，只留开头那句不带价格的过渡语。
 * 清单会被卡片顶掉，留着就是重复；但"行，不说了。来点解气的——"这种值得留。
 */
function keepTransitionOnly(reply?: string): string | undefined {
  const text = cleanReply(reply);
  if (!text) return undefined;
  if (!PRICE_PATTERN.test(text)) return text;

  const first = text
    .split("\n")
    .map((s) => s.trim())
    .find((s) => s && !PRICE_PATTERN.test(s));

  return first && first.length <= 40 ? first : undefined;
}

// ── 纯陪聊链路（callChatOnly）────────────────────────────────
// 与结构化链路并列的一条独立通道：
//   · 不套 response_format: json_object（约束一上，语气就死）
//   · 提示词用 buildChatPrompt：人设 + 长期记忆 + 时间，不注商品库、不讲业务规则
//   · 温度 0.75（结构化那档是 0.3）
// 出口的拦截口径也跟着放宽，见 settleChatReply。

/** 陪聊档温度：0.7–0.8 之间，取中 */
export const CHAT_TEMPERATURE = 0.75;

/**
 * 陪聊重写的补充约束：只在"模型嘴瓢承诺了货"这一条路上临时拼。
 * 陪聊轮没有卡片，说"我给你挑好了"就是空头许诺——但改写仍然让模型自己说话，
 * 不落话术池（池子里的句子是通用的，会把这一轮的上下文盖掉）。
 */
const CHAT_NO_PITCH_HINT = `

# 本次补充约束（优先级高于上面的常规规则）

重新说一句接住他的话。这一句里：
- 不许出现任何商品名、价格、清单
- 不许说"我给你挑好了""下面这几样""清单如下"这类已经在给货的话（这一轮没有货）
- 仍然 80 字以内的口语`;

/**
 * 纯陪聊链路：一次纯文本调用，只拿回"脆脆该说的那句话"。
 *
 * 失败（没配大脑 / provider 全挂 / 吐了空白）一律返回 undefined，
 * 由 settleChatReply 落本地话术池——不让空气泡飘到用户面前。
 *
 * @param hint 临时拼在提示词末尾的补充约束（目前只有"不许承诺给货"这一条在用）
 */
export async function callChatOnly(
  messages: ChatMessage[],
  ctx?: BrainContext,
  hint?: string,
): Promise<string | undefined> {
  if (!messages.length) {
    throw new Error("messages 为空");
  }

  const lastMsg = messages[messages.length - 1];
  const full: ChatMessage[] = [
    { role: "system", content: buildChatPrompt(ctx?.memoryText) + (hint || "") },
    ...messages.slice(0, -1),
    { role: "user", content: lastMsg.content },
  ];

  for (const rt of resolveRuntimes()) {
    try {
      const content = await requestOnce(rt, full, { chatOnly: true });
      const reply = cleanReply(content);
      if (reply) return reply;
      console.warn(
        `${tracePrefix()}[Brain:chat] ${rt.provider} 没吐出正文`,
        JSON.stringify(content).slice(0, 120),
      );
    } catch (err: any) {
      console.error(
        `${tracePrefix()}[Brain:chat:${rt.provider}]`,
        err?.message || err,
      );
    }
  }
  return undefined;
}

/**
 * 把纯文本链路拿回来的原话组装成陪聊响应。
 *
 * preferences 不再向模型要：陪聊链路是自由输出，模型填不了结构。
 * 硬约束（忌口 / 口味 / 场景）本来就以本地 `extractPrefsFromText` 为准，
 * 少一份模型推测，反而不会出现"脑补的口味盖过用户原话"。
 */
export function chatResponseFromText(
  raw: string,
  messages: ChatMessage[],
): BrainResponse {
  return {
    intent: "chat",
    reply: cleanReply(raw),
    preferences: mergedPrefs(recentUserText(messages)),
    chatOnly: true,
  };
}

/**
 * 按标点切句。空头许诺常常是**半句**——"行，我给你挑了三样："后面那截是好的，
 * 整句作废太浪费，所以按句裁。
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?\n；;])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 剪掉在"承诺已经给了货"的那几句，其余**原样保留**。
 * 整句都在许诺（剪完什么也不剩）才返回空，由调用方落兜底。
 */
function stripPitchSentences(text: string): string {
  const parts = splitSentences(text);
  if (parts.length < 2) return RECOMMEND_PITCH_PATTERN.test(text) ? "" : text;
  return parts.filter((s) => !RECOMMEND_PITCH_PATTERN.test(s)).join("");
}

/**
 * 陪聊出口：**放行是默认，拦截是例外**。
 *
 * 推荐链路那边有 keepTransitionOnly / 空头许诺重写 / 话术池三级兜底，
 * 那套口径放在陪聊上就是"把人味儿洗掉"——模型明明说了句好话，被换成本地池子的通用句。
 *
 * 所以陪聊只守**红线**，其余一律放行模型原话：
 *
 * | 情况 | 处理 |
 * |---|---|
 * | 正常说话 | 原样出去（只把"您"改成"你"） |
 * | 半句在夸海口（"行，我给你挑了三样：…"） | 只剪掉许诺那几句，留着接住人的部分 |
 * | 整句都在夸海口 | 让模型按 `CHAT_NO_PITCH_HINT` 重写一次；重写失败才落池 |
 * | 提到内部信息 / 脏话 | 改词救不回来 → 落本地话术池（这是底线，不商量） |
 * | 压根没拿到正文 | 落本地话术池（不能让空气泡出去） |
 *
 * 注意"防线绝对不能拆"：剪许诺和红线拦截都还在，
 * 只是**不再拿话术池去盖正常的话**。
 */
export async function settleChatReply(
  raw: string | undefined,
  opts: {
    userId: string;
    messages: ChatMessage[];
    /** 兜底话术挑池子用的偏好；不传就用本地从最近几轮原话抠的那份 */
    prefs?: Preferences;
    /** 需要重写时的第二个来源（纯陪聊链路传 callChatOnly；不传就跳到话术池） */
    rewrite?: () => Promise<string | undefined>;
  },
): Promise<string> {
  const take = (text?: string): string | undefined => {
    const clean = cleanReply(text);
    if (!clean) return undefined;
    // 红线：内部信息 / 脏话。只有这两种配得上"整句作废"
    if (INTERNAL_LEAK_PATTERN.test(clean) || PROFANITY_PATTERN.test(clean)) {
      return undefined;
    }
    const trimmed = stripPitchSentences(clean);
    return trimmed ? trimmed.replace(HONORIFIC_PATTERN, "你") : undefined;
  };

  const direct = take(raw);
  if (direct) return direct;

  if (opts.rewrite) {
    const rewritten = take(await opts.rewrite());
    if (rewritten) return rewritten;
  }

  logDegraded("陪聊正文不可用，落本地话术池", {
    userId: opts.userId,
    raw: (raw || "").slice(0, 60),
  });
  // 兜底话术必须接得住上下文：prefs 用「最近几轮原文抠出来的」那份
  return pickCompanionReply(
    opts.userId,
    opts.prefs || mergedPrefs(recentUserText(opts.messages)),
    lastUserText(opts.messages),
  );
}

/**
 * 陪聊这一轮的整条链路：纯文本调用 → 放行/裁剪 → 兜底。
 * 推荐 / 介绍不经过这里。
 */
async function runChatChain(
  messages: ChatMessage[],
  ctx: BrainContext | undefined,
  userId: string,
): Promise<BrainResponse> {
  const raw = await callChatOnly(messages, ctx);
  const reply = await settleChatReply(raw, {
    userId,
    messages,
    // 模型有说话、只是说了不该说的 → 让它自己重说一次；
    // 压根没说话（provider 挂了）就别再等一轮超时，直接落池
    rewrite: raw
      ? () => callChatOnly(messages, ctx, CHAT_NO_PITCH_HINT)
      : undefined,
  });

  const res = chatResponseFromText(reply, messages);
  res.reply = reply;
  // 抛出**往零食方向**的问句才算在铺垫（LEAD_IN_REPLY_PATTERN，与 route.ts 同一条口径）。
  // 不能图省事写成 /[?？]/.test(reply)：陪聊本来就爱追问细节（"因为啥吵的？"），
  // 把追问当钩子会让下一轮的"嗯""好"被 CONSENT_PATTERN 当成点头，凭空甩出卡片
  res.leadIn = LEAD_IN_REPLY_PATTERN.test(reply);
  return res;
}

/** 本地陪聊兜底池：按场景 / 情绪分组，收尾带一句软钩子，用户点头下一轮才出卡片 */
const COMPANION_POOL: Record<string, string[]> = {
  // "嘴馋""饿了"抽不进 scene/emotion，单开一档——这时候用户离下单最近
  嘴馋: [
    "馋了还是饿了？不管哪个，先说个方向呗——你是想辣得出汗，还是就想嘴里有点味儿？",
    "嘴馋这事儿我熟。先挑个大方向：辣的、甜的，还是脆的？",
  ],
  加班: [
    "上班呢？坐着熬是真磨人。要我给你配点嘴里能嚼着的，慢慢磨着时间会好过些？",
    "还没下班啊，这班上的。要不要我来点提神的，撑过这一段？",
  ],
  办公室: [
    "摸鱼被我逮着了。要不要我给你配点没声儿、不用舔手的，坐着慢慢嚼？",
    "工位上干坐着最容易走神。来点能嚼的给你解解闷，要不要我挑挑？",
  ],
  看剧: [
    "看剧呢？没点粮配着总觉得少点啥。要不要我给你配点耐吃的？",
    "这剧追到哪了。追剧不备点零食总觉得对不起剧情，要我给你挑两样不？",
  ],
  海边: [
    "看海呢，吹着风边走边嚼才对。要不要我给你挑点清爽不腻的？",
    "海边的节奏就得慢，手里有点东西晃着才舒服。要我配点不？",
  ],
  户外: [
    "出去玩啊，路上带点吃的才踏实。要不要我给你配点方便带的？",
    "出门在外，包里塞点扛饿的准没错。要不要我挑几样方便揣着的？",
  ],
  烦: [
    "听着就上火。先别想那些了——要不要我给你配点能泄愤的，辣一顿出出汗？",
    "这谁受得了。要不要我给你配点嚼起来带劲的，把这口气顺出去？",
  ],
  生气: [
    "听着就上火。先别想那些了——要不要我给你配点能泄愤的，嚼着出出气？",
    "确实欠收拾。要不要我给你挑点带劲的，辣完一身汗爽一下？",
  ],
  难过: [
    "嗯，怎么了？要不要我给你配点软乎的甜的，嘴里有点东西会好受点。",
    "那就先缓缓。甜的治这一套，要不要我给你挑两样？",
  ],
  丧: [
    "嗯，那就先歇会儿。要不要我给你配点甜的，慢慢来。",
    "打不起精神的时候，来点软乎的最解压。要不要我挑两样？",
  ],
  无聊: [
    "闲得发慌是吧，那你跟我聊聊也行。要不我给你挑点没吃过的新口味，换个新鲜感？",
    "坐着干瞅是真难受，手边有能嚼的会好过点。要不要我给你配点？",
  ],
  开心: [
    "哟，心情不错啊。有好事值得配点好的，要不要我给你挑挑？",
    "这得庆祝一下。要不要我配点平时不舍得买的？",
  ],
};

/** 认不出场景/情绪时的通用兜底：同样先接住，再轻轻带一笔 */
const COMPANION_DEFAULT_POOL = [
  "嗯，我在。接着说呗——对了，这种时候嘴里有点东西嚼着会好过点，要不要我给你配点？",
  "你说，我听着呢。要不要我顺便给挑点零食，边聊边吃？",
  "哈哈，然后呢？聊归聊，要不要我给你配点能嚼的？",
];

/**
 * chat 升 recommend 时，模型那句陪聊文案的去留。
 *
 * **默认留着**：模型按陪聊写的这句常常就是最好的过渡语——
 * "我记得你说不想吃辣，这几个都绕开了辣"既有记忆感又贴题，
 * 换成池子里的"安排——"等于把人味儿洗掉（实测被吐槽过）。
 *
 * 只砍两种留不得的：
 *
 *   1. **带清单**（"1. 海苔脆片原味装｜29.9元"）→ `keepTransitionOnly` 剔掉，
 *      清单永远由本地按数据重新合成，不让它报一遍价
 *   2. **抛出钩子的问句**（"…要不要我给你配点能嚼的？"）→ 卡片已经在下面了，
 *      上面还问"要不要"是答非所问，落 `pickTransition` 现挑一句
 *
 * 普通接口与 SSE 两条路共用这一个入口，别再各写一份口径。
 */
export function replyForUpgrade(reply: string | undefined): string | undefined {
  // 模型那句里带清单（"1. 海苔脆片原味装｜29.9元"）的部分剔掉，清单由本地重新合成
  const kept = keepTransitionOnly(reply);
  if (!kept) return undefined;

  // 抛出钩子的问句不算过渡语：卡片已经在下面了，上面还问"要不要我给你配点？"
  // 是答非所问——那种留给 pickTransition 现挑一句
  if (LEAD_IN_REPLY_PATTERN.test(kept)) return undefined;

  return kept;
}

/**
 * 上一轮发给这个用户的兜底话术。进程内缓存、只记最近若干人——
 * 丢了顶多偶尔重复一句，不值得为它上存储。
 */
const lastCompanion = new Map<string, string>();
const LAST_COMPANION_MAX = 500;

/**
 * 兜底话术：先按上下文挑池子（场景 / 情绪 / 嘴馋），再随机一句。
 *
 * 两件事在这里一起做，顺序不能反：
 *   1. **先认上下文**——用户说了"海边"就该进海边池。
 *      只做防重不认上下文，两轮是不同句了，可照样答非所问。
 *   2. **再防复读**——同一个用户连着两轮撞同一句，读起来像卡带了。
 *      池子只有一句时没法换，硬换只会把自己绕进去，那种情况原样返回。
 */
export function pickCompanionReply(
  userId: string,
  prefs: Preferences,
  text = "",
): string {
  const pool =
    (/馋|饿了|肚子空/.test(text) ? COMPANION_POOL["嘴馋"] : undefined) ||
    (prefs.scene && COMPANION_POOL[prefs.scene]) ||
    (prefs.emotion && COMPANION_POOL[prefs.emotion]) ||
    COMPANION_DEFAULT_POOL;

  let picked = pool[Math.floor(Math.random() * pool.length)];
  const last = lastCompanion.get(userId);
  if (pool.length > 1 && picked === last) {
    const rest = pool.filter((x) => x !== last);
    picked = rest[Math.floor(Math.random() * rest.length)];
  }

  // 兜得太满就整个清掉，不值得为它写 LRU
  if (lastCompanion.size > LAST_COMPANION_MAX) lastCompanion.clear();
  lastCompanion.set(userId, picked);
  return picked;
}

/**
 * 判断一句过渡语是不是在"承诺已经给出货了"（"我给你挑了三样""下面这几样"）。
 * 降级路径这一轮是没有卡片的——带着这种句子出去就是空头许诺，比不说话还糟。
 */
function looksLikeRecommendPitch(text?: string): boolean {
  return RECOMMEND_PITCH_PATTERN.test(text || "");
}

/**
 * 陪聊轮的空头许诺防线：模型嘴瓢说「我给你挑好了」，可陪聊轮根本不出卡片——
 * 话先出去了、货却没到，比什么都不说更糟。
 *
 * **普通接口与 SSE 两条路都必须走。** SSE 曾经漏了这道（自由输出下模型爱这么说），
 * 结果用户追着问「那几样呢」要多等一轮才见到货。抽成单一入口就是为了不再分叉。
 *
 * 口径统一交给 `settleChatReply`：**默认放行模型原话**，只有红线才换人，
 * 半句在夸海口就只剪那一句，不再整句盖成本地池子的通用句。
 */
export async function fixEmptyPromise(
  userId: string,
  messages: ChatMessage[],
  reply: string | undefined,
  prefs: Preferences | undefined,
  ctx?: BrainContext,
): Promise<string> {
  const settled = await settleChatReply(reply, {
    userId,
    messages,
    prefs: mergedPrefs(recentUserText(messages), prefs),
    // 模型有说话、只是说了不该说的 → 走纯陪聊链路让它自己重说一次
    rewrite: reply
      ? () => callChatOnly(messages, ctx, CHAT_NO_PITCH_HINT)
      : undefined,
  });
  return settled || UNCLEAR_REPLY;
}

export interface BrainRuntime {
  provider: "deepseek" | "glm";
  url: string;
  apiKey: string;
  model: string;
  supportsJson: boolean;
}

export function resolveRuntimes(): BrainRuntime[] {
  const preferred = (process.env.LLM_PROVIDER || "").trim();
  const order: ("deepseek" | "glm")[] = [];

  if (preferred === "deepseek" || preferred === "glm") order.push(preferred);
  (["deepseek", "glm"] as const).forEach((n) => {
    if (!order.includes(n)) order.push(n);
  });

  const runtimes: BrainRuntime[] = [];
  for (const provider of order) {
    if (provider === "deepseek") {
      const apiKey = process.env.DEEPSEEK_API_KEY;
      if (apiKey) {
        runtimes.push({
          provider,
          url: DEEPSEEK_API_URL,
          apiKey,
          model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
          supportsJson: true,
        });
      }
    } else {
      const apiKey = process.env.GLM_API_KEY;
      if (apiKey) {
        runtimes.push({
          provider,
          url: GLM_API_URL,
          apiKey,
          model: process.env.GLM_MODEL || "glm-4.7-flash",
          supportsJson: false,
        });
      }
    }
  }
  return runtimes;
}

/**
 * 把模型吐的原始文本解析成结构化响应。
 *
 * 抽成独立函数是为了让**流式路径**也能复用同一套解析口径：
 * 流式那边不走 json_object（那个约束会把模型卡住吐空白），模型可能吐纯文本，
 * 所以这里必须带 guessIntent 兜底。两条路用同一份解析，才不会一边认得出、一边认不出。
 */
export function parseBrainResponse(raw: string): BrainResponse {
  const parsed = extractJson(raw);
  if (!parsed) return guessIntent(raw);

  // 保留 introduce 意图，不强制转 recommend
  const intent =
    parsed.intent === "recommend" || parsed.intent === "introduce"
      ? parsed.intent
      : "chat";

  const reply = sanitizeModelReply(parsed.reply);

  return {
    intent,
    // chat 必须有话说，否则宁可给一句人设内的兜底，也不让空气泡飘出去
    reply: reply || (intent === "chat" ? UNCLEAR_REPLY : undefined),
    // 意图可能被上层改写（chat 升 recommend），偏好一律带上，省得改完就没得用了
    preferences: parsed.preferences,
  };
}

async function callProvider(
  rt: BrainRuntime,
  messages: ChatMessage[],
): Promise<BrainResponse> {
  const content = await requestOnce(rt, messages);
  return parseBrainResponse(content);
}

/**
 * 单次请求的等待上限。
 *
 * 以前这里没有超时：模型一旦挂起（对端不返回、也不报错），Promise 永远 pending，
 * 前端就那么一直转圈，用户既等不到回复也没法重发。宁可早点认输，让上层走兜底。
 */
const REQUEST_TIMEOUT_MS = 8_000;

/**
 * 容忍连续空白的次数。
 *
 * 空白是偶发还是这家模型的老毛病，看连着几次就知道：连着两次都在 json_object 下吐空，
 * 就别再拿第一次去赌了，后面直接走自由输出，省掉一次几乎必然白等的请求和一份 token。
 * 只要有一次正常返回就清零，格式约束自动恢复。
 */
const BLANK_STREAK_LIMIT = 2;

/** provider → 当前连续空白次数 */
const blankStreak = new Map<string, number>();

/** 请求参数：`chatOnly` 表示走纯陪聊链路（不套 json_object，温度走陪聊档） */
interface RequestOptions {
  chatOnly?: boolean;
}

/**
 * 发一次请求，拿回模型原始文本。
 *
 * 【空白重试】DeepSeek 在 json_object 模式下会吐一串纯空白：finish_reason 是 stop，
 * completion_tokens 也有几十，但内容全是空格换行。同参数重试无效——是 json_object
 * 这个约束本身把模型卡住了。所以重试时**摘掉 response_format**，让它自由输出，
 * 靠 extractJson / guessIntent 兜住格式，成功率明显更高。
 */
async function requestOnce(
  rt: BrainRuntime,
  messages: ChatMessage[],
  opts: RequestOptions = {},
): Promise<string> {
  let lastContent = "";

  for (let attempt = 0; attempt < 2; attempt++) {
    const streak = blankStreak.get(rt.provider) || 0;
    // 第一次走 json_object 保证格式；一旦空白，重试就解除这个约束。
    // 连着空白达到上限，说明这家的 json_object 不靠谱，第一次也不再拿它赌。
    // 陪聊链路从头到尾都不套这个约束——它要的就是自由文本
    const useJson =
      !opts.chatOnly &&
      rt.supportsJson &&
      attempt === 0 &&
      streak < BLANK_STREAK_LIMIT;
    // 温度：JSON 模式降 0.3 稳格式；解除约束后升温 0.9，让语气重新活起来。
    // 陪聊链路走 0.75——比结构化那档活，又不至于飘到跑题
    const temperature = opts.chatOnly
      ? CHAT_TEMPERATURE
      : rt.supportsJson
        ? attempt === 0
          ? 0.3
          : 0.9
        : 0.8;

    // 超时覆盖到「响应体读完」为止，不只是等响应头
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(rt.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${rt.apiKey}`,
        },
        body: JSON.stringify({
          model: rt.model,
          messages,
          temperature,
          ...(useJson ? { response_format: { type: "json_object" } } : {}),
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const err = await res.text();
        // HTTP 报错重试没意义（额度、鉴权这类不会自己好），直接抛
        throw new Error(`${rt.provider} 调用失败：${res.status} ${err}`);
      }

      // 上游返回的未必是 JSON：网关的 HTML 错误页、被代理截断的半截响应、
      // 甚至是一个字都没有的空体。直接 await res.json() 会抛 SyntaxError，
      // 那一串 "Unexpected token '<'" 既看不出是谁家、也看不出该不该重试。
      // 这里统一翻成人话往上抛，让降级链路接得住（上层会转 runLocalBrain）
      let data: any;
      try {
        data = await res.json();
      } catch {
        throw new Error(`${rt.provider} 返回了非法格式（不是 JSON）`);
      }
      const choice = data?.choices?.[0];
      const content: string = choice?.message?.content || "";
      lastContent = content;

      if (content.trim()) {
        blankStreak.set(rt.provider, 0);
        return content;
      }
      // 陪聊链路本来就是自由输出，吐空白跟 json_object 没关系，
      // 不该拿它去判定"这家的 JSON 模式不靠谱"（那会把结构化链路的约束一起误伤）
      if (!opts.chatOnly) blankStreak.set(rt.provider, streak + 1);

      // 把现场打全，方便定位（finish_reason=length 说明被截断，stop 说明模型自己吐了空）
      console.warn(
        `${tracePrefix()}[Brain:${rt.provider}] 空内容 第${attempt + 1}次 finish_reason=${choice?.finish_reason}`,
        JSON.stringify(choice),
        JSON.stringify(data?.usage),
      );
    } catch (err: any) {
      const timedOut = err?.name === "AbortError";
      if (!timedOut) throw err;
      // 卡住的这一轮作废，换一套参数（解除 json 约束 + 升温）再试一次
      console.warn(
        `${tracePrefix()}[Brain:${rt.provider}] 第${attempt + 1}次请求超时（${REQUEST_TIMEOUT_MS}ms），重试`,
      );
      if (attempt === 1) {
        // 别把 AbortError 原文漏到前端，翻成人话交给上层兜底
        throw new Error(`${rt.provider} 响应超时`);
      }
    } finally {
      clearTimeout(timer);
    }
  }

  return lastContent;
}

export async function callBrain(
  messages: ChatMessage[],
  filters?: Filters,
  ctx?: BrainContext,
  /** 兜底话术防重复用：没有就传空串，退化为不防重 */
  userId = "",
): Promise<BrainResponse> {
  if (!messages.length) {
    throw new Error("messages 为空");
  }

  const lastMsg = messages[messages.length - 1];

  // 乱码拦截：像随手乱敲的输入直接本地兜底——不浪费模型调用，
  // 也断了模型"顺着编"的路（它会接出"行了，能还没说完了"这种鬼话）
  if (isGibberish(lastMsg.content)) {
    console.warn(
      `${tracePrefix()}[Brain] 乱码输入，本地兜底：`,
      JSON.stringify(lastMsg.content),
    );
    return { intent: "chat", reply: pickGibberishReply() };
  }

  const runtimes = resolveRuntimes();
  if (!runtimes.length) {
    logDegraded("没有配置任何大脑，走本地链路兜底", { userId });
    return {
      intent: "chat",
      unavailable: true,
      preferences: mergedPrefs(recentUserText(messages)),
    };
  }

  // ── 按意图分流：陪聊与推荐不再是同一条管道 ──────────────
  // 用户没开口要东西（本地 routeIntent 判 chat）→ 走纯陪聊链路：
  // 不套 json_object、提示词不注商品库、温度 0.75，出口只守红线。
  // 判成 recommend / introduce 才走下面这条结构化链路（完整业务提示词 + json_object）。
  //
  // 旅游大巴宽松放行，危险品运输车严格检查——防线一道没拆，只是不再一刀切。
  if (routeIntent(lastMsg.content, ctx) === "chat") {
    return await runChatChain(messages, ctx, userId);
  }

  // 【改动2】不再拼接 JSON_INSTRUCTION 到 user，格式已在 system 里
  const fullMessages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(filters, ctx?.memoryText) },
    ...messages.slice(0, -1),
    { role: "user", content: lastMsg.content },
  ];

  let lastErr: unknown;
  for (const rt of runtimes) {
    try {
      const brainRes = await callProvider(rt, fullMessages);

      // 「打听某个具体商品」优先于其它路由判断。
      // 放最前面是因为：模型看到"火鸡面啥样"偶尔会判成 recommend，
      // 若先走下面的 recommend 降级，就会 return 掉 chat 回复，这张卡片永远挂不上去。
      if (
        brainRes.intent !== "introduce" &&
        INTRODUCE_PATTERN.test(lastMsg.content)
      ) {
        const hit = findLocalSnack(lastMsg.content);
        if (hit) {
          console.warn(`${tracePrefix()}[Brain] 用户在问商品，升级介绍：`, lastMsg.content);
          return {
            intent: "introduce",
            reply: brainRes.reply,
            preferences: {
              ...mergedPrefs(recentUserText(messages), brainRes.preferences),
              product_name: hit.name,
            },
          };
        }
      }

      // 催货升级：上一轮画了饼，这轮追着要货（"你说说""哪几样呢"）→ 升 recommend。
      // 必须放在下面的 recommend 降级**之前**，否则刚升上去就被判回陪聊。
      //（allowRecommend 已为 URGE 开了放行，不会误降）
      const urged = upgradeForUrge(brainRes.intent, lastMsg.content);
      if (urged !== brainRes.intent) {
        console.warn(`${tracePrefix()}[Brain] 用户在催货，升级推荐：`, lastMsg.content);
        brainRes.intent = urged;
        // 模型原本是按"陪聊"写的（"说啥？你这话没头没尾的"），跟卡片对不上。
        // 留着就会出现"嘴上说接不住、下面甩三张卡"的割裂感。
        // 清空让它落 pickTransition——那边会按场景/口味现写一句接得住的过渡语。
        brainRes.reply = undefined;
      }

      // 防呆：模型看到"烦死/好累/上班好无聊"就想推零食泄愤，但用户根本没开口要
      if (
        brainRes.intent === "recommend" &&
        !allowRecommend(lastMsg.content, ctx)
      ) {
        const prefs = mergedPrefs(
          recentUserText(messages),
          brainRes.preferences,
        );
        // 降级不等于甩一句反问打发人。recommend 意图下模型通常不写 reply，
        // 直接兜底会让它听起来像在问"你是谁、你要干嘛"——先接住人，再慢慢引出零食。
        // 这一轮没有卡片，所以任何"我给你挑了三样"的空头许诺都得拦掉。
        //
        // **降级为陪聊也要走纯陪聊链路**：补写用 callChatOnly（精简提示词 + 自由输出），
        // 出口口径交给 settleChatReply，与正常陪聊轮完全一致——
        // 否则同一个"没开口要"的用户，在两条支路里听到两种口气。
        const reply = await settleChatReply(
          keepTransitionOnly(brainRes.reply),
          {
            userId,
            messages,
            prefs,
            rewrite: () => callChatOnly(messages, ctx, CHAT_NO_PITCH_HINT),
          },
        );

        logDegraded("判 recommend 但用户没开口要，降级陪伴", {
          userId,
          msg: lastMsg.content,
          reply,
        });
        // 这一轮绝不出卡片：用户没点头，货一律压着。
        // 抛出问句 = 在铺垫，上层据此给前端 lead_in，用户下一轮点头才接得上推荐。
        return {
          intent: "chat",
          reply,
          preferences: prefs,
          chatOnly: true,
          leadIn: LEAD_IN_REPLY_PATTERN.test(reply),
        };
      }

      // 反向防呆：用户明明开口要了（或在推荐里改条件），模型却判成陪聊。
      // 文案去留一律交给 replyForUpgrade（默认留着，只砍带清单的和还在抛钩子的问句），
      // 别在这里另立口径——注释和实现对不上比没有注释更坑。
      if (brainRes.intent === "chat" && allowRecommend(lastMsg.content, ctx)) {
        const reply = replyForUpgrade(brainRes.reply);
        console.warn(
          `${tracePrefix()}[Brain] 判 chat 但用户在要东西，升级推荐（${reply ? "留过渡语" : "清空落本地过渡语"}）：`,
          lastMsg.content,
        );
        return {
          intent: "recommend",
          reply,
          preferences: mergedPrefs(
            recentUserText(messages),
            brainRes.preferences,
          ),
        };
      }

      // 推荐意图：模型漏填的硬约束（尤其忌口）用本地抠出来的补上，它填过的以它为准
      if (brainRes.intent === "recommend") {
        return {
          ...brainRes,
          preferences: mergedPrefs(
            recentUserText(messages),
            brainRes.preferences,
          ),
        };
      }

      // 陪聊里嘴瓢：模型自己承诺了"我按XX给你挑了三样"，可陪聊轮是不出卡片的——
      // 话先出去了、货却没到，比什么都不说更糟。改写逻辑见 fixEmptyPromise，
      // SSE 那条路也调同一个函数，别在这里另写一份。
      if (
        brainRes.intent === "chat" &&
        looksLikeRecommendPitch(brainRes.reply)
      ) {
        // prefs 只传模型填的那份：本地兜底合并由 fixEmptyPromise 统一做，
        // 这里再拼一次，两条入口迟早又拼出两种口径
        const fixed = await fixEmptyPromise(
          userId,
          messages,
          brainRes.reply,
          brainRes.preferences,
          ctx,
        );
        return { ...brainRes, reply: fixed, leadIn: /[?？]/.test(fixed) };
      }

      return brainRes;
    } catch (err: any) {
      lastErr = err;
      console.error(`${tracePrefix()}[Brain:${rt.provider}]`, err?.message || err);
    }
  }

  logDegraded("大脑调用失败，走本地链路兜底", {
    userId,
    tried: runtimes.map((r) => r.provider).join(" → "),
    error: (lastErr as Error)?.message || "未知错误",
  });

  return {
    intent: "chat",
    unavailable: true,
    preferences: mergedPrefs(recentUserText(messages)),
  };
}
