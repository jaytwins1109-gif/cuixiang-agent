"use client";

import { useEffect, useRef, useState } from "react";

// ────────────────────────────────────────────────
//  类型
// ────────────────────────────────────────────────
interface Rec {
  name: string;
  reason: string;
  price: number;
  image?: string;
  emoji?: string;
  /** 本地工作流算出来的优惠：到手价 / 省了多少 / 凑单建议（兜底卡片没有这些） */
  promo?: {
    activity?: string;
    coupon?: string;
    final_price: number;
    saved: number;
    estimated?: boolean;
    add_on?: { name: string; gap: number; extra_saved: number };
  };
  /** 面向用户的推荐理由，比库里的 reason 更贴合本轮需求 */
  user_visible_reasons?: string[];
  risk_notes?: string[];
}

interface Msg {
  role: "user" | "assistant";
  content: string;
  cards?: Rec[];
  /** 时间戳，用来插日期分隔线；旧记录没有就当没有分隔 */
  ts?: number;
  /** 流式占位气泡的临时标识：同一条消息要被反复改写，靠它定位 */
  id?: string;
  /**
   * 流式吐出来的字被 final 整段改写了（本地防呆 / 意图纠偏）。
   * 挂上淡入动画，让替换有个视觉过渡，而不是"先出一段、啪地变成另一段"
   */
  refreshed?: boolean;
}

interface Filters {
  flavor?: string;
  budget?: string;
}

/** 后端长期记忆快照：三层，前端只负责展示，真源在服务端 */
interface MemorySnapshot {
  core_profile: string[];
  summary_memory: string[];
  active_fragments: string[];
}

// ────────────────────────────────────────────────
//  常量
// ────────────────────────────────────────────────
const FLAVORS = [
  { label: "辣味", icon: "🌶️" },
  { label: "甜味", icon: "🍬" },
  { label: "咸味", icon: "🧂" },
  { label: "酸味", icon: "🍋" },
  { label: "清淡", icon: "🥯" },
  { label: "坚果", icon: "🥜" },
  { label: "嚼感解压", icon: "🦾" },
];

const BUDGETS = [
  { label: "30元内", icon: "💰" },
  { label: "30-60元", icon: "💎" },
  { label: "60元以上", icon: "👑" },
];

/** 聊起来后的快捷开口：给场景，不给"来点甜的"这种跟卡片按钮重复的话 */
const QUICK = [
  { label: "追剧来点", icon: "🎬", text: "追剧的时候来点吃的" },
  { label: "去海边带点", icon: "🌊", text: "明天去看海，带点吃的" },
  { label: "加班垫垫", icon: "💻", text: "加班熬夜，来点垫肚子的" },
  { label: "换一批", icon: "🔄", text: "换一批" },
];

/** 空会话时的场景入口：给个具体的开口方式，别让人对着空白框发呆 */
const SCENES = [
  {
    icon: "🎬",
    title: "追剧解馋",
    sub: "看点剧，嘴别闲着",
    text: "追剧的时候来点吃的",
  },
  {
    icon: "🌊",
    title: "出去玩带点",
    sub: "海边爬山能扛饿的",
    text: "明天去看海，带点吃的",
  },
  {
    icon: "😮‍💨",
    title: "烦了想发泄",
    sub: "不想说话也行",
    text: "今天被领导当众骂了，烦死",
  },
];

const WELCOME =
  "嘿，我是脆脆 🥜\n馋了直接说，想找人说话也行。\n对了——今天咋样？";

/** 聊天记录 + 左侧偏好存本地，刷新页面不丢 */
const STORE_KEY = "cx_chat_v1";
/** 从对话里攒出来的偏好（忌口/口味/场景），跨会话记住"不吃辣"这类长期约定 */
const PROFILE_KEY = "cx_profile_v1";
/** 历史脏数据作废标记：置上之后就不再清空 PROFILE_KEY（见初始化时的迁移） */
const PROFILE_RESET_KEY = "cx_profile_reset_20261102";
/** 点过「想要」的零食清单 */
const WANT_KEY = "cx_want_v1";
/** 长期记忆的用户标识：第一次进站生成一个固定住，后端据此存/取记忆，不然所有人的记忆会串在一个桶里 */
const USER_KEY = "cx_user_v1";
/** 皮肤偏好：跟 layout.tsx 里防闪烁的内联脚本用同一个 key，改一处必须改两处 */
const THEME_KEY = "cx_theme_v1";

/**
 * 皮肤清单。真正决定配色的是 globals.css 里同名的 [data-theme] 变量块，
 * 这里只管按钮上的名字和一个示意色点。
 */
const THEMES = [
  { key: "warm", label: "暖阳棕", dot: "#FFB84D" },
  { key: "obsidian", label: "曜石黑", dot: "#3A332E" },
  { key: "glacier", label: "冰川蓝", dot: "#5AA9E6" },
] as const;

type ThemeKey = (typeof THEMES)[number]["key"];

/** 落皮肤：变量挂在 <html> 上，body 和各面板才跟着变 */
function applyTheme(key: ThemeKey) {
  try {
    document.documentElement.dataset.theme = key;
    localStorage.setItem(THEME_KEY, key);
  } catch {
    document.documentElement.dataset.theme = key;
  }
}

/** 读上次的皮肤，存坏了或存了不认识的就退回暖阳棕 */
function readTheme(): ThemeKey {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved && THEMES.some((t) => t.key === saved)) return saved as ThemeKey;
  } catch {
    /* 隐私模式读不了，走默认值 */
  }
  return "warm";
}

/**
 * 取（或首次生成）本浏览器的用户标识。
 * 放在函数里而不是 state：send 可能在 state 生效前就被触发，直接读 localStorage 最稳。
 */
function ensureUserId(): string {
  try {
    let uid = localStorage.getItem(USER_KEY);
    if (!uid) {
      uid = `u_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem(USER_KEY, uid);
    }
    return uid;
  } catch {
    // 隐私模式写不了 localStorage，退回匿名桶，至少不报错
    return "anonymous";
  }
}

/**
 * 长期偏好里**可信**的 key：口味 / 预算 / 忌口 / 口感。
 *
 * 场景和情绪不在这份里——它们是**当轮语境**（"办公室""看海""烦"），
 * 只在说话那一轮成立。攒进 profile 就是脏数据：跨会话复活，
 * 侧栏一直挂着用户三天前随口提的一句，选品时还会冒充"用户这轮提的约束"。
 * 后端的 `TRUSTED_PROFILE_KEYS`（lib/chat/handlers.ts）是同一份口径。
 */
const PROFILE_TRUSTED_KEYS = ["flavor", "budget", "avoid", "texture"] as const;

/**
 * 预算只认侧栏那两档（与 `BUDGETS` 同源）。
 *
 * 「不限」不是偏好，是**没提**：模型早年的 schema 里允许填它，
 * 于是用户一句「有什么好吃的」就被记成「预算·不限」挂在侧栏——
 * 用户从没说过这话，怎么点都摘不掉（2026-11-02 的真事）。
 * 「5块」这类自造档同理：选品引擎认不出来，挂上去就是"说了不算"。
 */
const BUDGET_LABELS = BUDGETS.map((b) => b.label);

/**
 * 只留可信字段，其余一律丢掉。
 *
 * 白名单而不是黑名单：黑名单只能挡住今天想到的 scene / emotion，
 * 后端哪天多吐一个字段，脏数据就又混进来了。
 */
function stripVolatileProfile(raw: any): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const k of PROFILE_TRUSTED_KEYS) {
    const v = (raw as Record<string, unknown>)[k];
    if (typeof v !== "string" || !v.trim()) continue;
    if (k === "budget" && !BUDGET_LABELS.includes(v.trim())) continue;
    out[k] = v.trim();
  }
  return out;
}

/** 偏好 key → 人话标签，给「当前偏好」区显示用（只有可信字段会走到这里） */
const PROFILE_LABEL: Record<string, string> = {
  avoid: "忌口",
  flavor: "口味",
  texture: "口感",
  budget: "预算",
};

/** 实付价：算过优惠就按到手价走，没算过就是原价 */
const finalPrice = (r: Rec) =>
  r.promo && r.promo.saved > 0 ? r.promo.final_price : r.price;

/**
 * 气泡上的时间：今天只给「 HH:mm 」，隔天的才带日期前缀。
 * 每条都顶一串完整日期会把聊天区挤满，反而没人看。
 */
function formatMsgTime(ts?: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(d, now)) return hm;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;

  // 今年的省掉年份，跨年才补全
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// ────────────────────────────────────────────────
//  主壳子
// ────────────────────────────────────────────────
export default function Page() {
  const [filters, setFilters] = useState<Filters>({});
  /** 对话里攒出来的长期偏好，随请求带给后端，刷新不忘"不吃辣" */
  const [profile, setProfile] = useState<Record<string, string>>({});
  /** 后端长期记忆快照：服务端是持久化的真源，本地 profile 只是本轮带过去的缓存 */
  const [memory, setMemory] = useState<MemorySnapshot>({
    core_profile: [],
    summary_memory: [],
    active_fragments: [],
  });
  const [messages, setMessages] = useState<Msg[]>([
    { role: "assistant", content: WELCOME },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState(false);
  /** 右侧「我的」抽屉：想要清单 + 长期偏好 */
  const [myOpen, setMyOpen] = useState(false);
  /** 点过「想要」的零食，攒成清单 */
  const [wantList, setWantList] = useState<Rec[]>([]);
  /** 当前皮肤：真身是 <html data-theme>，state 只用来画按钮 */
  const [theme, setTheme] = useState<ThemeKey>("warm");

  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  /** 上一轮是不是刚推过卡片（决定「太贵了」「换一个」这类算还要推荐） */
  const recommendCtx = useRef(false);
  /**
   * 会话代号：每开一次新对话就 +1。
   *
   * 流式响应是异步回来的，掐断之后队列里可能还躺着几个 delta 或 final。
   * 渲染前比对一下代号，不是当前会话就整个丢掉——
   * 否则用户看到的就是「开了新对话，上一句又迟到了一下」。
   */
  const sessionId = useRef(0);
  /** 正在进行的流式请求；开新对话时用它掐断，别让旧流继续往下读 */
  const streamAbort = useRef<AbortController | null>(null);

  // 进来先把皮肤贴上：layout 的内联脚本只负责首屏不闪，
  // React 这边的 state 还得自己同步一次，按钮上的选中态才对。
  useEffect(() => {
    const saved = readTheme();
    setTheme(saved);
    document.documentElement.dataset.theme = saved;
  }, []);

  // 进来先捞上次的记录
  useEffect(() => {
    let restored = false;
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const saved = JSON.parse(raw);
        if (Array.isArray(saved?.messages) && saved.messages.length) {
          setMessages(saved.messages);
          restored = true;
        }
        if (saved?.filters) setFilters(saved.filters);
      }
      // 2026-11-02 的历史脏数据**一次性作废**：以前前端无条件把模型当轮填的
      // preferences 存进这里，于是「忌口·花生」「预算·不限」这类用户没说过的标签
      // 挂满了侧栏。存量数据里分不清哪条是真说过的、哪条是模型脑补的，
      // 与其猜，不如全部推倒重来——之后的写入只认本地有出处的（见 pickTrustedProfile）。
      // 用标记位保证只清一次：清完照样能正常攒（不然每次刷新都清空，永远记不住东西）。
      if (!localStorage.getItem(PROFILE_RESET_KEY)) {
        localStorage.removeItem(PROFILE_KEY);
        try {
          localStorage.setItem(PROFILE_RESET_KEY, "1");
        } catch {
          /* 隐私模式写不了，顶多下次再清一次，不影响功能 */
        }
      }
      const rawProfile = localStorage.getItem(PROFILE_KEY);
      if (rawProfile) {
        const clean = stripVolatileProfile(JSON.parse(rawProfile));
        setProfile(clean);
        try {
          localStorage.setItem(PROFILE_KEY, JSON.stringify(clean));
        } catch {
          /* 隐私模式写不了，内存里已经清干净了 */
        }
      }
      const rawWant = localStorage.getItem(WANT_KEY);
      if (rawWant) setWantList(JSON.parse(rawWant));
    } catch {
      /* 存坏了就当没存过 */
    }

    // 没有历史可捞时，欢迎语是唯一一条没时间戳的消息，挂载后给它补上。
    // 捞到历史就不补：那批消息带着发送当时的时间，不能被改写成"现在"。
    if (!restored) {
      setMessages((prev) =>
        prev.map((m) => (m.ts ? m : { ...m, ts: Date.now() })),
      );
    }
  }, []);

  // 每次有变化就落盘
  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ messages, filters }));
    } catch {
      /* 隐私模式写不了，忽略 */
    }
  }, [messages, filters]);

  useEffect(() => {
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch {
      /* 同上，写不了就算了 */
    }
  }, [profile]);

  useEffect(() => {
    try {
      localStorage.setItem(WANT_KEY, JSON.stringify(wantList));
    } catch {
      /* 同上 */
    }
  }, [wantList]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, loading]);

  // 输入框随内容长高，最多到 160px 后自己滚
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  /** 记下想要的零食，同时给一句回话 */
  function addWant(rec: Rec) {
    setWantList((prev) =>
      prev.some((w) => w.name === rec.name) ? prev : [...prev, rec],
    );
    setMessages((prev) => [
      ...prev,
      {
        role: "assistant",
        content: `好嘞，${rec.name}记下了 👌\n想要清单里有 ${wantList.length + 1} 样了，随时在「我的」里看`,
        ts: Date.now(),
      },
    ]);
  }

  /**
   * 把后端返回的记忆结果落到前端。
   * 关键在 memory_action：用户本轮说"忘掉XX"/"全都忘掉"时后端已经删了，
   * 前端缓存必须跟着删，否则侧栏还挂着那条、下一轮又当偏好带上去，等于没删。
   */
  function applyMemoryPayload(data: any) {
    if (!data || typeof data !== "object") return;

    if (data.memory_action === "cleared") {
      setProfile({});
      setMemory({ core_profile: [], summary_memory: [], active_fragments: [] });
    } else if (data.memory_action === "deleted" && data.memory_keyword) {
      const kw = String(data.memory_keyword);
      setProfile((prev) => {
        const next: Record<string, string> = {};
        for (const [k, v] of Object.entries(prev)) {
          // 「不吃辣」和「忘掉我不吃辣」抠出来的关键词能对上就一起删
          if (v.includes(kw) || kw.includes(v)) continue;
          next[k] = v;
        }
        return next;
      });
    }

    if (data.memory && typeof data.memory === "object") {
      setMemory({
        core_profile: Array.isArray(data.memory.core_profile)
          ? data.memory.core_profile
          : [],
        summary_memory: Array.isArray(data.memory.summary_memory)
          ? data.memory.summary_memory
          : [],
        active_fragments: Array.isArray(data.memory.active_fragments)
          ? data.memory.active_fragments
          : [],
      });
    }
  }

  /**
   * 侧栏/抽屉里点「忘掉」：光清本地没用，得让后端一起删，
   * 否则下次请求又把这条偏好带回去，用户会觉得我根本没忘。
   */
  async function forgetOnServer(text: string) {
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, userId: ensureUserId() }),
      });
      applyMemoryPayload(await res.json());
    } catch {
      /* 同步失败就算了，本地已经清掉了 */
    }
  }

  /** 忘掉某条长期偏好 */
  function forgetProfile(key: string) {
    const value = profile[key];
    setProfile((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    // 后端是从这句话里**抠关键词**去删的（`extractMemoryKeyword`），
    // 所以发送的文本必须让那条正则对得上：
    //   「花生过敏」这类忌口词组本身就能抠出来；
    //   「辣味」「10元内」这类口味 / 预算要说成「忘掉我喜欢辣味」才抠得到——
    //   直接发「忘掉辣味」时老版本抠不出关键词，服务端那条删不掉，
    //   界面上标签没了、下一轮又把偏好带回来，用户会觉得"我明明删了"。
    if (!value) return;
    const keywordish =
      /不吃辣|不想吃辣|不能吃辣|忌辣|不吃甜|不想吃甜|不吃酸|忌酸|过敏|不耐/.test(
        value,
      );
    void forgetOnServer(keywordish ? `忘掉${value}` : `忘掉我喜欢${value}`);
  }

  /** 全都忘掉：本地清空 + 后端一起清 */
  function forgetAll() {
    setProfile({});
    void forgetOnServer("全都忘掉");
  }

  /**
   * 把后端返回落到界面上。一次性接口与流式 final 共用这一份——
   * 两条路各写一遍，渲染逻辑迟早长歪（比如一条挂了卡片、另一条忘了）。
   *
   * @param replaceId 流式占位气泡的 id；传了就替换它，没传就追加新消息
   * @param refreshed 最终文案和流式已吐的字不一致（被本地改写过）：挂淡入动画
   */
  function applyPayload(data: any, replaceId?: string, refreshed?: boolean) {
    // 有文字就出气泡，有卡片就接在后面（陪伴 / 介绍 / 推荐三种都一样）
    const cards: Rec[] | null =
      Array.isArray(data.recommendations) && data.recommendations.length
        ? data.recommendations
        : null;

    // 洗一遍再入列：空白文本会渲染成空气泡，还会作为 assistant 历史喂回模型，把后续对话带偏
    const replyText = typeof data.reply === "string" ? data.reply.trim() : "";

    const build = (): Msg | null => {
      if (cards)
        return {
          role: "assistant",
          content: replyText,
          cards,
          ts: Date.now(),
          refreshed,
        };
      if (replyText)
        return {
          role: "assistant",
          content: replyText,
          ts: Date.now(),
          refreshed,
        };
      return null;
    };

    const msg = build();

    if (replaceId) {
      setMessages((prev) => {
        const rest = prev.filter((m) => m.id !== replaceId);
        return msg ? [...rest, msg] : rest;
      });
    } else if (msg) {
      setMessages((prev) => [...prev, msg]);
    }

    // 卡片、追问偏好、以及陪聊里抛的零食钩子（lead_in）都算推荐进行中：
    // 用户答完偏好或点一下头，下一轮直接接上推荐
    recommendCtx.current = !!cards || !!data.awaiting_prefs || !!data.lead_in;

    // 后端本轮回的偏好：只可能是"用户这轮原话里有出处"的那几条
    // （后端 `pickTrustedProfile` 已拿本地抽取核过一遍，这里再按白名单兜一道）。
    // **不再无条件合并**——以前模型当轮填什么就存什么，
    // 于是「有什么好吃的」一句就能让侧栏挂出「忌口·花生」，那标签还会真的执行。
    if (data.profile && typeof data.profile === "object") {
      const incoming = stripVolatileProfile(data.profile);
      if (Object.keys(incoming).length) {
        setProfile((prev) => ({ ...prev, ...incoming }));
      }
    }

    applyMemoryPayload(data);
  }

  /**
   * 新建会话：只重置「这一轮对话」，长期记忆一个字都不动。
   *
   * 这里必须把两件事彻底分开：
   *   - **清空聊天记录** → 纯前端 UI 状态，本地就能做
   *   - **清空长期记忆**（后端 `data/memory.json`）→ 只能在对话里说「全都忘掉」触发
   *
   * 所以这里绝不碰 `forgetAll()` 或任何清记忆的接口。开完新对话，
   * 后端照样按 userId 自动召回「不吃辣」这类长期偏好——这才是想要的效果：
   * 换个话题重来，但朋友还记得你的忌口。
   *
   * 环境类的东西也不动：左侧栏选的口味、皮肤、想要清单都是用户主动设的，
   * 不属于"这一轮对话"。要连筛选一起放掉，点旁边的「首页」。
   */
  function newChat() {
    // 先掐断正在进行的流。不掐的话，旧流读完会把 final 补上来，
    // 用户看到的就是"开了新对话，上一句又迟到了一下"
    streamAbort.current?.abort();
    streamAbort.current = null;

    // 代号 +1：掐断之后回调队列里可能还躺着几个 delta / final，
    // 靠代号在渲染前挡掉，避免气泡闪一下或留下没闭合的空泡
    sessionId.current += 1;

    setMessages([{ role: "assistant", content: WELCOME, ts: Date.now() }]);
    setInput("");
    setLoading(false);

    // 「上一轮推过卡片」「还在追问偏好」这些上下文都随会话走，必须一起清。
    // 不清的话，新会话第一句说"换一个"会被当成还在上一轮推荐里接话
    recommendCtx.current = false;

    inputRef.current?.focus();
  }

  /**
   * 流式发送：模型吐一个字就往气泡里填一个字。
   *
   * 为什么要留一条降级路：流式的好处是"立刻有反应"，代价是链路更长——
   * 代理缓冲、超时、断网都可能让它半路失败，而且那时用户已经看到半句话了。
   * 所以这里的原则是：**流式只负责抢先显示，最终内容一律以 final 事件为准**。
   * final 没到就退回一次性接口，用户最多是"没看到打字效果"，而不是"发不出去"。
   *
   * @returns true 表示这轮已处理完（成功或已给提示）；false 表示需要调用方走一次性接口
   */
  async function streamChat(
    payload: Record<string, unknown>,
    session: number,
  ): Promise<boolean> {
    // 每条流配一个 controller：新对话要能把它掐断，不给旧流继续往下读的机会
    const ctrl = new AbortController();
    streamAbort.current = ctrl;

    const res = await fetch("/api/ai/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    // 400 是"没写内容"这类可预期的拒绝，给句提示就行，不用降级重发
    if (res.status === 400) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: "说点什么呀", ts: Date.now() },
      ]);
      return true;
    }
    if (!res.ok || !res.body) return false;

    // 占位气泡：先插进去，后面靠 id 定位反复改写它
    const bubbleId = "s_" + Date.now();
    setMessages((prev) => [
      ...prev,
      { id: bubbleId, role: "assistant", content: "", ts: Date.now() },
    ]);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let acc = "";
    let finalized = false;

    // 渲染前先确认还是同一个会话：掐断之后队列里可能还排着几个 delta
    const patch = (fn: (m: Msg) => Msg) =>
      setMessages((prev) =>
        sessionId.current === session
          ? prev.map((m) => (m.id === bubbleId ? fn(m) : m))
          : prev,
      );

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 会话已经被重置：后面的字全部丢弃，别再往新列表里写
      if (sessionId.current !== session) return true;

      buf += decoder.decode(value, { stream: true });

      // SSE 以空行分帧；最后一段可能不完整，留在 buffer 里等下一块
      const frames = buf.split("\n\n");
      buf = frames.pop() || "";

      for (const frame of frames) {
        const ev = /^event:\s*(\w+)$/m.exec(frame)?.[1];
        const rawData = /^data:\s*(.+)$/m.exec(frame)?.[1];
        if (!ev || !rawData) continue;

        let data: any;
        try {
          data = JSON.parse(rawData);
        } catch {
          continue;
        }

        if (ev === "delta" && data.text) {
          // 逐块追加：这一步是纯渲染，不碰任何业务判断
          acc += data.text;
          patch((m) => ({ ...m, content: acc }));
        } else if (ev === "error") {
          patch((m) => ({
            ...m,
            content: data.message || "啊？刚卡了一下，再说一次？",
          }));
          return true;
        } else if (ev === "final") {
          finalized = true;
          // 会话已经被"新对话"重置：这条结果整个作废。
          // 少了这道判断，用户就会看到"新会话里凭空冒出上一轮的回答"
          if (sessionId.current !== session) return true;
          // 最终文案可能被本地防呆改写（比如把"清单如下"兜掉），所以整体替换
          applyPayload(data, bubbleId);
        }
      }
    }

    if (!finalized) {
      // 流结束却没收到 final：已经吐出来的留着（用户已经看了），一个字的才给提示
      patch((m) =>
        m.content ? m : { ...m, content: "啊？网断了？再说一次？" },
      );
    }
    return true;
  }

  // ── 发送 ──────────────────────────────────────
  async function send(raw?: string) {
    const text = (raw ?? input).trim();
    if (!text || loading) return;

    // 记下发起时的会话代号：异步回来后比对一下，中途被"新对话"重置就整个丢弃
    const mySession = sessionId.current;

    setInput("");
    setMessages((prev) => [
      ...prev,
      { role: "user", content: text, ts: Date.now() },
    ]);
    setLoading(true);

    const payload = {
      message: text,
      history: messages
        // 卡片组现在也带过渡语，按"有没有文字"过滤，别再把整条丢掉
        // 开场白也要排掉：新会话的 history 必须是空数组，
        // 否则模型会以为自己刚才已经说过那句欢迎语，跟着它往下接
        .filter((m) => m.content && m.content.trim() && m.content !== WELCOME)
        .slice(-10)
        .map((m) => ({ role: m.role, content: m.content })),
      filters,
      // 长期记忆挂在固定用户上，刷新/重开浏览器都还是同一个人
      userId: ensureUserId(),
      inRecommendContext: recommendCtx.current,
      // 长期偏好（忌口/口味/场景）随请求带上，后端据此过滤推荐
      userProfile: profile,
      // 上一轮推过的款，用户说"换一个"时后端要避开
      lastPicks:
        [...messages]
          .reverse()
          .find((m) => m.cards)
          ?.cards?.map((c) => c.name) ?? [],
    };

    try {
      // 优先走流式：先让用户看到字在动，最终内容以 final 为准
      if (await streamChat(payload, mySession)) return;

      // 流式链路不通（代理不支持、老浏览器）→ 退回一次性接口
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      // 这轮已经被"新对话"重置了，结果别往新会话里塞
      if (sessionId.current !== mySession) return;

      if (!res.ok) {
        // 原始 error（可能是 Key 未配置、500 之类）只留在控制台，界面上不吓人
        // trace_id 是服务端这一轮的 TraceID：浏览器控制台报错时带上它，
        // 就能直接翻服务端日志把那轮对话捞出来（不用靠时间猜）
        if (data?.error)
          console.error(
            `[Chat] 请求失败：${data.error}`,
            data.trace_id ? `trace_id=${data.trace_id}` : "（服务端没给 trace_id）",
          );
        recommendCtx.current = false;
        setMessages((prev) => [
          ...prev,
          {
            role: "assistant",
            content: "啊？刚卡了一下，再说一次？",
            ts: Date.now(),
          },
        ]);
        return;
      }

      applyPayload(data);
    } catch (e: any) {
      // 用户主动"新对话"掐断的，不是真的出错，别弹"网断了"吓人
      if (e?.name === "AbortError") return;
      // 同理，这轮已经被重置了就什么都不做
      if (sessionId.current !== mySession) return;

      console.error("[Chat] 发送失败：", e);
      recommendCtx.current = false;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: "啊？网断了？再说一次？",
          ts: Date.now(),
        },
      ]);
    } finally {
      // 会话已经换人了就别动，免得把新会话的状态覆盖回去
      if (sessionId.current === mySession) {
        streamAbort.current = null;
        setLoading(false);
      }
    }
  }

  // ── 左侧栏交互 ────────────────────────────────
  function toggle(key: keyof Filters, value: string) {
    setFilters((prev) => ({
      ...prev,
      [key]: prev[key] === value ? undefined : value,
    }));
  }

  function clearFilters() {
    setFilters({});
    // 预算的"手选"和"一直记着"在用户眼里是同一件事：
    // 点了清空手选，侧栏那个「预算·不限」还挂着，他只会觉得系统没听他的。
    // 所以清空手选时把长期偏好里的预算一起放下（口味/忌口不动，那些是真说过的）
    setProfile((prev) => {
      if (!prev.budget) return prev;
      const next = { ...prev };
      delete next.budget;
      return next;
    });
  }

  const active = [filters.flavor, filters.budget].filter(Boolean) as string[];

  /** 想要清单里第一款能凑单的商品：给「我的」抽屉用 */
  const addOnTip = wantList
    .map((w) => w.promo?.add_on)
    .find((a) => a && a.gap > 0);

  /**
   * 服务端长期记忆压成一条条展示项。
   * 服务端那份是持久化的真源，本地 profile 只是本轮带过去的缓存，
   * 两边会有重叠，所以本地这里只补"服务端没记下的"，避免同一条显示两遍。
   */
  const serverMemory = [
    ...memory.core_profile.map((text) => ({ text, tag: "一直有效" })),
    ...memory.summary_memory.map((text) => ({ text, tag: "场景" })),
    ...memory.active_fragments.map((text) => ({ text, tag: "零散" })),
  ];
  // profile 里只有可信字段（场景/情绪在读档和收包时都被剔掉了），不用再过滤一遍
  const localOnly = Object.entries(profile).filter(
    ([, v]) => !serverMemory.some((m) => m.text.includes(v)),
  );
  const hasMemory = serverMemory.length > 0 || localOnly.length > 0;

  /** 换皮肤：同步 <html data-theme>、本地缓存和按钮选中态 */
  function changeTheme(next: ThemeKey) {
    setTheme(next);
    applyTheme(next);
  }

  /** 删一条服务端记忆：本地先摘掉，再让后端软删除 */
  function forgetMemoryEntry(text: string) {
    const keyword = text.split("：")[0] || text;
    setMemory((prev) => ({
      core_profile: prev.core_profile.filter((t) => t !== text),
      summary_memory: prev.summary_memory.filter((t) => t !== text),
      active_fragments: prev.active_fragments.filter((t) => t !== text),
    }));
    void forgetOnServer(`忘掉${keyword}`);
  }

  return (
    <div className="flex h-screen flex-col bg-cx-50">
      {/* ── 顶栏 ─────────────────────────────── */}
      <header className="z-20 flex shrink-0 items-center gap-3 border-b border-cx-100 bg-white/90 px-4 py-3 backdrop-blur">
        <button
          onClick={() => setDrawer(true)}
          className="rounded-xl p-2 text-cx-500 hover:bg-cx-50 lg:hidden"
          aria-label="打开口味栏"
        >
          <span className="text-lg">☰</span>
        </button>

        <div className="flex items-center gap-2">
          <span className="text-2xl">🥜</span>
          <span className="text-lg font-extrabold tracking-wide text-cx-600">
            脆香零食
          </span>
          <span className="hidden text-xs text-cx-400 sm:inline">
            你的零食推荐好友
          </span>
        </div>

        {/*
          顶栏只留三个入口。
          「+ 新对话」是最高频的逃生出口，文字常驻；
          「推荐」「我的」在窄屏压成图标——375px 的手机上四个带文字的按钮
          会把输入框挤得只剩一半，而这两个入口靠图标 + title 完全认得出来。
        */}
        <nav className="ml-auto flex items-center gap-0.5 text-sm sm:gap-1">
          <NavBtn onClick={newChat}>+ 新对话</NavBtn>
          <NavBtn onClick={() => send("推荐个零食")} label="推荐零食">
            <span className="sm:hidden">🍿</span>
            <span className="hidden sm:inline">推荐</span>
          </NavBtn>
          <NavBtn onClick={() => setMyOpen(true)} label="我的清单与长期偏好">
            <span>👤</span>
            {wantList.length > 0 && (
              <span className="ml-0.5 rounded-full bg-cx-300 px-1.5 py-0.5 text-[10px] font-bold text-white">
                {wantList.length}
              </span>
            )}
          </NavBtn>
          {/* 换皮肤：就一个小色点，不占地方，想换的时候才点开 */}
          <ThemeSwitch theme={theme} onChange={changeTheme} />
        </nav>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ── 左侧口味栏（桌面常驻）──────────────── */}
        <aside className="hidden w-64 shrink-0 border-r border-cx-100 bg-white/70 p-4 lg:block">
          <FilterPanel
            filters={filters}
            onToggle={toggle}
            onClear={clearFilters}
            active={active}
            profile={profile}
            onForget={forgetProfile}
          />
        </aside>

        {/* ── 移动端抽屉 ───────────────────────── */}
        {drawer && (
          <div className="fixed inset-0 z-40 lg:hidden">
            <div
              className="absolute inset-0 bg-black/30"
              onClick={() => setDrawer(false)}
            />
            <div className="absolute left-0 top-0 h-full w-72 animate-fade-in bg-white p-4 shadow-xl">
              <div className="mb-3 flex items-center justify-between">
                <span className="font-bold text-cx-600">挑个口味</span>
                <button
                  onClick={() => setDrawer(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg p-1 text-cx-400 hover:bg-cx-50"
                  aria-label="关闭"
                >
                  ✕
                </button>
              </div>
              <FilterPanel
                filters={filters}
                onToggle={toggle}
                onClear={clearFilters}
                active={active}
                profile={profile}
                onForget={forgetProfile}
              />
            </div>
          </div>
        )}

        {/* ── 右侧聊天区 ──────────────────────── */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div
            ref={listRef}
            className="scroll-slim flex-1 space-y-4 overflow-y-auto p-4"
          >
            {messages.map((m, i) =>
              m.cards ? (
                <div key={i}>
                  {/* 推荐话术先出气泡，再接卡片：只有三张卡的推荐太像自动售货机 */}
                  {m.content.trim() && (
                    <Bubble msg={{ ...m, cards: undefined }} />
                  )}
                  <div
                    className={`grid gap-2 sm:grid-cols-2 xl:grid-cols-3 ${
                      m.content.trim() ? "mt-3" : ""
                    }`}
                  >
                    {m.cards.map((c, j) => (
                      <SnackCard
                        key={j}
                        rec={c}
                        wanted={wantList.some((w) => w.name === c.name)}
                        onWant={() => addWant(c)}
                        onSwap={() => send("换一批")}
                      />
                    ))}
                  </div>
                  {/* 卡片组也有发送时间，跟气泡对齐在同一种样式里 */}
                  <MsgTime ts={m.ts} />
                </div>
              ) : (
                <Bubble key={i} msg={m} />
              ),
            )}

            {/* 空会话给几个开口方式，别让人对着空白框发呆 */}
            {messages.length <= 1 && !loading && (
              <div className="grid gap-3 pt-2 sm:grid-cols-3">
                {SCENES.map((s) => (
                  <button
                    key={s.title}
                    onClick={() => send(s.text)}
                    className="group animate-fade-in rounded-2xl border border-cx-200 bg-white p-4 text-left shadow-sm transition hover:-translate-y-0.5 hover:border-cx-300 hover:shadow-card"
                  >
                    <div className="mb-2 text-2xl">{s.icon}</div>
                    <div className="font-bold text-cx-700">{s.title}</div>
                    <div className="mt-0.5 text-xs leading-relaxed text-cx-400">
                      {s.sub}
                    </div>
                  </button>
                ))}
              </div>
            )}

            {loading && (
              <div className="flex items-center gap-2 text-sm text-cx-400">
                <span>🧸</span>
                脆脆正在想
                <span className="dot-typing flex gap-1">
                  <span>·</span>
                  <span>·</span>
                  <span>·</span>
                </span>
              </div>
            )}
          </div>

          {/* ── 输入区 ─────────────────────────── */}
          <div className="shrink-0 border-t border-cx-100 bg-white/80 p-3 backdrop-blur">
            <div className="mx-auto max-w-3xl">
              {/* 空会话已经有场景卡了，快捷短语只在聊起来后露出来 */}
              {messages.length > 1 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {QUICK.map((q) => (
                    <button
                      key={q.text}
                      onClick={() => send(q.text)}
                      disabled={loading}
                      className="inline-flex min-h-[40px] items-center rounded-full border border-cx-200 bg-cx-50 px-3.5 py-2 text-xs text-cx-600 transition hover:bg-cx-100 disabled:opacity-40"
                    >
                      <span className="mr-1">{q.icon}</span>
                      {q.label}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-end gap-2">
                <textarea
                  ref={inputRef}
                  rows={1}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      send();
                    }
                  }}
                  placeholder="说点什么...（Enter 发送，Shift+Enter 换行）"
                  className="scroll-slim min-w-0 flex-1 resize-none rounded-bubble border border-cx-200 bg-white px-5 py-3 text-base leading-relaxed outline-none transition placeholder:text-cx-300 focus:border-cx-300 focus:ring-2 focus:ring-cx-100"
                />
                <button
                  onClick={() => send()}
                  disabled={loading || !input.trim()}
                  className="shrink-0 rounded-full bg-cx-300 px-6 py-3.5 text-base font-bold text-white shadow transition hover:bg-cx-400 disabled:opacity-40"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        </main>

        {/* ── 「我的」抽屉：想要清单 + 长期偏好 ──── */}
        {myOpen && (
          <div className="fixed inset-0 z-50">
            <div
              className="absolute inset-0 bg-black/30"
              onClick={() => setMyOpen(false)}
            />
            <div className="absolute right-0 top-0 h-full w-80 animate-fade-in overflow-y-auto bg-white p-4 shadow-xl">
              <div className="mb-4 flex items-center justify-between">
                <span className="font-bold text-cx-600">我的</span>
                <button
                  onClick={() => setMyOpen(false)}
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg p-1 text-cx-400 hover:bg-cx-50"
                  aria-label="关闭"
                >
                  ✕
                </button>
              </div>

              <section className="mb-6">
                <h3 className="mb-2 text-xs font-bold tracking-wider text-cx-400">
                  想要清单
                </h3>
                {wantList.length ? (
                  <>
                    <ul className="space-y-2">
                      {wantList.map((w) => (
                        <li
                          key={w.name}
                          className="flex items-center gap-2 rounded-xl border border-cx-100 bg-cx-50 px-3 py-2"
                        >
                          <span className="text-lg">{w.emoji || "🍪"}</span>
                          <span className="min-w-0 flex-1 truncate text-sm text-cx-700">
                            {w.name}
                          </span>
                          <span className="shrink-0 text-xs font-bold text-cx-500">
                            ¥{finalPrice(w)}
                            {w.promo && w.promo.saved > 0 && (
                              <span className="ml-1 font-normal text-cx-400 line-through">
                                ¥{w.price}
                              </span>
                            )}
                          </span>
                          <button
                            onClick={() =>
                              setWantList((prev) =>
                                prev.filter((x) => x.name !== w.name),
                              )
                            }
                          className="inline-flex h-10 w-10 shrink-0 items-center justify-center text-xs text-cx-400 hover:text-cx-600"
                            aria-label="删掉"
                          >
                            ✕
                          </button>
                        </li>
                      ))}
                    </ul>
                    <div className="mt-3 flex items-center justify-between text-xs">
                      <span className="text-cx-500">
                        合计 ¥
                        {wantList
                          .reduce((n, w) => n + finalPrice(w), 0)
                          .toFixed(1)}
                        {wantList.some((w) => (w.promo?.saved || 0) > 0) && (
                          <span className="ml-1 text-cx-400">
                            （已省 ¥
                            {wantList
                              .reduce((n, w) => n + (w.promo?.saved || 0), 0)
                              .toFixed(1)}
                            ）
                          </span>
                        )}
                      </span>
                      <button
                        onClick={() => setWantList([])}
                        className="text-cx-400 underline-offset-2 hover:underline"
                      >
                        清空
                      </button>
                    </div>

                    {/* 凑单建议：清单里任意一款能凑出更高档优惠时给个一键加购 */}
                    {addOnTip && (
                      <div className="mt-2 flex items-center gap-2 rounded-xl bg-cx-50 px-3 py-2">
                        <span className="min-w-0 flex-1 text-[11px] leading-relaxed text-cx-600">
                          再加份{addOnTip.name}（¥{addOnTip.gap}），这单能多省 ¥
                          {addOnTip.extra_saved}
                        </span>
                        <button
                          onClick={() =>
                            setWantList((prev) =>
                              prev.some((x) => x.name === addOnTip.name)
                                ? prev
                                : [
                                    ...prev,
                                    {
                                      name: addOnTip.name,
                                      price: addOnTip.gap,
                                      reason: "凑单加购",
                                    },
                                  ],
                            )
                          }
                          className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-full bg-cx-300 px-3 py-1 text-[11px] font-semibold text-white hover:bg-cx-400"
                        >
                          加一份
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-cx-400">
                    还没挑中什么。卡片上点「想要」就存这儿了。
                  </p>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-bold tracking-wider text-cx-400">
                  记住你的偏好
                </h3>
                {hasMemory ? (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {serverMemory.map(({ text, tag }) => (
                        <span
                          key={text}
                          className="inline-flex items-center gap-1 rounded-full bg-cx-300 px-2.5 py-1 text-xs font-semibold text-white"
                        >
                          {tag}·{text.split("：").slice(1).join("：") || text}
                          <button
                            onClick={() => forgetMemoryEntry(text)}
                            className="opacity-70 hover:opacity-100"
                            aria-label="忘掉这条"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                      {localOnly.map(([k, v]) => (
                        <span
                          key={k}
                          className="inline-flex items-center gap-1 rounded-full border border-cx-300 bg-white px-2.5 py-1 text-xs font-semibold text-cx-600"
                        >
                          {PROFILE_LABEL[k] || k}·{v}
                          <button
                            onClick={() => forgetProfile(k)}
                            className="opacity-70 hover:opacity-100"
                            aria-label="忘掉这条"
                          >
                            ✕
                          </button>
                        </span>
                      ))}
                    </div>
                    <button
                      onClick={() => forgetAll()}
                      className="mt-3 text-xs text-cx-400 underline-offset-2 hover:underline"
                    >
                      全都忘掉
                    </button>
                  </>
                ) : (
                  <p className="text-xs text-cx-400">
                    聊着聊着就记住了，比如你说过"不吃辣"。
                  </p>
                )}
              </section>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────
//  子组件
// ────────────────────────────────────────────────
function NavBtn({
  children,
  onClick,
  label,
}: {
  children: React.ReactNode;
  onClick: () => void;
  /**
   * 按钮里没有可见文字时（窄屏图标模式）**必填**。
   * 没有它的话，读屏软件只能念出一个 emoji，键盘用户也完全没有提示。
   */
  label?: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      // whitespace-nowrap：360px 窄屏下顶栏会挤压 nav，不锁住的话
      // 「+ 新对话」会被压成竖排三个字（实测 92px 高），比触摸目标太小更难看
      className="inline-flex min-h-[40px] items-center justify-center whitespace-nowrap rounded-full px-2.5 py-1.5 text-cx-600 transition hover:bg-cx-50 sm:px-3"
    >
      {children}
    </button>
  );
}

/**
 * 换皮肤入口：平时就是一个小色点，点了才弹出三个选项。
 * 做成这么克制是因为它属于"顺手改一次就不用管"的设置，不该跟推荐入口抢位置。
 */
function ThemeSwitch({
  theme,
  onChange,
}: {
  theme: ThemeKey;
  onChange: (key: ThemeKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = THEMES.find((t) => t.key === theme) ?? THEMES[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full p-2 opacity-55 transition hover:bg-cx-50 hover:opacity-100"
        title="换个颜色"
        aria-label="切换皮肤"
        aria-expanded={open}
      >
        <span
          className="block h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
          style={{ backgroundColor: current.dot }}
        />
      </button>

      {open && (
        <>
          {/* 点别处收起：铺一层透明底比给 window 挂监听省心 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-32 animate-fade-in rounded-xl border border-cx-200 bg-white p-1.5 shadow-card">
            {THEMES.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  onChange(t.key);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-cx-50 ${
                  t.key === theme ? "font-bold text-cx-700" : "text-cx-600"
                }`}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10"
                  style={{ backgroundColor: t.dot }}
                />
                <span className="flex-1">{t.label}</span>
                {t.key === theme && (
                  <span className="text-[10px] text-cx-400">✓</span>
                )}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function FilterPanel({
  filters,
  onToggle,
  onClear,
  active,
  profile,
  onForget,
}: {
  filters: Filters;
  onToggle: (key: keyof Filters, value: string) => void;
  onClear: () => void;
  active: string[];
  /** 对话里攒下来的长期偏好，显示出来才知道脆脆记住了什么 */
  profile: Record<string, string>;
  onForget: (key: string) => void;
}) {
  /** 记太多会把侧栏撑满，默认只露 3 条，其余折叠 */
  const [showAllProfile, setShowAllProfile] = useState(false);
  const remembered = Object.entries(profile);
  const shownRemembered = showAllProfile ? remembered : remembered.slice(0, 3);
  const hiddenCount = remembered.length - shownRemembered.length;

  return (
    <div className="space-y-5">
      <FilterGroup
        title="口味"
        items={FLAVORS}
        value={filters.flavor}
        onPick={(v) => onToggle("flavor", v)}
      />
      <FilterGroup
        title="价格"
        items={BUDGETS}
        value={filters.budget}
        onPick={(v) => onToggle("budget", v)}
      />

      <div className="rounded-2xl border border-cx-200 bg-cx-50 p-3">
        <div className="mb-2 text-xs font-bold text-cx-500">当前偏好</div>

        {/* 手选的：这次说了要什么 */}
        {active.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {active.map((a) => (
              <span
                key={a}
                className="rounded-full bg-cx-300 px-2.5 py-1 text-xs font-semibold text-white"
              >
                {a}
              </span>
            ))}
          </div>
        )}

        {/* 长期记住的：聊出来过，跨会话一直生效 */}
        {remembered.length > 0 && (
          <div className={active.length ? "mt-2" : ""}>
            <div className="mb-1 text-[11px] text-cx-400">一直记着</div>
            <div className="flex flex-wrap gap-1.5">
              {shownRemembered.map(([k, v]) => (
                <span
                  key={k}
                  className="inline-flex items-center gap-1 rounded-full border border-cx-300 bg-white px-2.5 py-1 text-xs font-semibold text-cx-600"
                >
                  {PROFILE_LABEL[k] || k}·{v}
                  <button
                    onClick={() => onForget(k)}
                    className="text-cx-300 hover:text-cx-600"
                    aria-label="忘掉这条"
                  >
                    ✕
                  </button>
                </span>
              ))}
              {hiddenCount > 0 && (
                <button
                  onClick={() => setShowAllProfile(true)}
                  className="inline-flex min-h-[40px] items-center rounded-full border border-dashed border-cx-300 px-3 py-1 text-xs font-semibold text-cx-500 hover:bg-cx-50"
                >
                  +{hiddenCount}
                </button>
              )}
              {showAllProfile && remembered.length > 3 && (
                <button
                  onClick={() => setShowAllProfile(false)}
                  className="inline-flex min-h-[40px] items-center rounded-full px-3 py-1 text-xs text-cx-400 hover:text-cx-600"
                >
                  收起
                </button>
              )}
            </div>
          </div>
        )}

        {!active.length && !remembered.length && (
          <p className="text-xs text-cx-400">
            还没选，脆脆会按你聊天里的意思来
          </p>
        )}

        {active.length > 0 && (
          <button
            onClick={onClear}
            className="mt-2 text-xs text-cx-500 underline-offset-2 hover:underline"
          >
            清空手选
          </button>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-cx-400">
        选了之后直接说「来点吃的」就行，不用再重复口味。「一直记着」是从聊天里攒下来的，长期生效。
      </p>
    </div>
  );
}

function FilterGroup({
  title,
  items,
  value,
  onPick,
}: {
  title: string;
  items: { label: string; icon: string }[];
  value?: string;
  onPick: (v: string) => void;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-bold tracking-wider text-cx-400">
        {title}
      </h3>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => {
          const on = value === it.label;
          return (
            <button
              key={it.label}
              onClick={() => onPick(it.label)}
              className={`inline-flex min-h-[40px] items-center rounded-full border px-3 py-1.5 text-xs transition ${
                on
                  ? "border-cx-500 bg-cx-500 font-semibold text-white shadow"
                  : "border-cx-200 bg-white text-cx-600 hover:bg-cx-50"
              }`}
            >
              <span className="mr-1">{it.icon}</span>
              {it.label}
              {/* 选中态除了底色再加个勾，扫一眼就知道选了什么 */}
              {on && <span className="ml-1 text-[10px]">✓</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/**
 * 气泡下方的时间。极淡、极小，知道这条是几点发的就够，不该跟话术抢注意力。
 * 没有 ts 的时间一律不显示（旧记录 / 服务端直出的欢迎语），宁缺勿假。
 */
function MsgTime({ ts, mine }: { ts?: number; mine?: boolean }) {
  const text = formatMsgTime(ts);
  if (!text) return null;
  return (
    <div className={`mt-1 flex ${mine ? "justify-end" : "justify-start"}`}>
      <span className="msg-time px-1 text-[10px] leading-none text-cx-400/70">
        {text}
      </span>
    </div>
  );
}

function Bubble({ msg }: { msg: Msg }) {
  const mine = msg.role === "user";
  return (
    <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
      <div className={`flex items-end gap-2 ${mine ? "justify-end" : ""}`}>
        {!mine && <span className="mb-1 text-xl">🧸</span>}
        <div
          className={`max-w-[78%] whitespace-pre-wrap rounded-bubble px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
            mine
              ? "rounded-br-md bg-cx-300 text-white"
              : "rounded-bl-md border border-cx-100 bg-white text-cx-700"
          } ${msg.refreshed ? "bubble-swap" : ""}`}
        >
          {msg.content}
        </div>
        {mine && <span className="mb-1 text-xl">👤</span>}
      </div>
      <MsgTime ts={msg.ts} mine={mine} />
    </div>
  );
}

function SnackCard({
  rec,
  onWant,
  onSwap,
  wanted,
  best,
}: {
  rec: Rec;
  onWant: () => void;
  onSwap: () => void;
  /** 已经在想要清单里了，按钮给个已存的反馈 */
  wanted?: boolean;
  /** 排在第一位：给个"最搭"的记号，三张卡不至于一模一样 */
  best?: boolean;
}) {
  const saved = rec.promo?.saved || 0;
  const addOn = rec.promo?.add_on;
  const reasons = rec.user_visible_reasons?.length
    ? rec.user_visible_reasons
    : rec.reason
      ? [rec.reason]
      : [];

  return (
    <div
      className={`animate-fade-in flex h-full flex-col overflow-hidden rounded-2xl border bg-white shadow-card ${
        best ? "border-cx-300 ring-1 ring-cx-200" : "border-cx-100"
      }`}
    >
      {/* 图区：真实图优先，没有就给 emoji 一个白色圆托底，别让橙色底抢戏 */}
      <div className="relative flex h-20 shrink-0 items-center justify-center bg-gradient-to-br from-cx-100 to-cx-200">
        {rec.image ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={rec.image}
            alt={rec.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/85 text-4xl shadow-sm">
            {rec.emoji || "🍪"}
          </span>
        )}
        {best && (
          <span className="absolute left-2 top-2 rounded-full bg-cx-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
            最搭
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate font-bold text-cx-700">{rec.name}</h3>
          <span className="shrink-0 font-extrabold text-cx-500">
            ¥{finalPrice(rec)}
            {saved > 0 && (
              <span className="ml-1 text-[11px] font-normal text-cx-400 line-through">
                ¥{rec.price}
              </span>
            )}
          </span>
        </div>

        {/* 省多少紧跟价格，视线不用跳到图区右上角 */}
        {saved > 0 && (
          <div className="mt-1">
            <span className="rounded-full bg-cx-500/10 px-2 py-0.5 text-[11px] font-bold text-cx-600">
              省 ¥{saved}
            </span>
          </div>
        )}

        {reasons.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {reasons.slice(0, 2).map((r, i) => (
              <li
                key={i}
                className="line-clamp-2 text-xs leading-relaxed text-cx-500"
              >
                · {r}
              </li>
            ))}
          </ul>
        )}

        {(rec.promo?.activity || rec.promo?.coupon) && (
          <div className="mt-2 flex flex-wrap gap-1">
            {rec.promo?.activity && (
              <span className="rounded-full bg-cx-50 px-2 py-0.5 text-[11px] font-semibold text-cx-600">
                {rec.promo.activity}
              </span>
            )}
            {rec.promo?.coupon && (
              <span className="rounded-full bg-cx-50 px-2 py-0.5 text-[11px] font-semibold text-cx-600">
                {rec.promo.coupon}
              </span>
            )}
          </div>
        )}

        {addOn && addOn.gap > 0 && (
          <p className="mt-2 rounded-lg bg-cx-50 px-2 py-1.5 text-[11px] leading-relaxed text-cx-500">
            再加份{addOn.name}（¥{addOn.gap}），这单能多省 ¥{addOn.extra_saved}
          </p>
        )}

        {/* mt-auto：理由长短不一时，按钮统一贴着卡片底部，三张卡才齐 */}
        <div className="mt-auto flex gap-2 pt-3">
          <CardBtn primary onClick={onWant}>
            {wanted ? "✓ 已记下" : "想要"}
          </CardBtn>
          <CardBtn onClick={onSwap}>换一个</CardBtn>
        </div>
      </div>
    </div>
  );
}

function CardBtn({
  children,
  onClick,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  /**
   * 触摸目标：手机上这些按钮以前只有 30px 高，手指不好点。
   * 统一抬到 40px（min-h），桌面端因为本来就够大，视觉上几乎没变化。
   */
  return (
    <button
      onClick={onClick}
      className={`inline-flex min-h-[40px] flex-1 items-center justify-center rounded-full px-3 py-2 text-xs font-semibold transition ${
        primary
          ? "bg-cx-300 text-white hover:bg-cx-400"
          : "border border-cx-200 text-cx-500 hover:bg-cx-50"
      }`}
    >
      {children}
    </button>
  );
}
