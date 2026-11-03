'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import { AuthDialog, type AuthMode } from './_components/auth-dialog';
import { Bubble, MsgTime } from './_components/bubble';
import { FilterPanel } from './_components/filter-panel';
import { finalPrice } from './_components/format';
import { NavBtn } from './_components/nav-btn';
import { SnackCard } from './_components/snack-card';
import { mergeProfileExclusive, stripVolatileProfile } from './_components/storage';
import { applyTheme, readTheme } from './_components/theme';
import { useAuth } from './_components/use-auth';
import { ThemeSwitch } from './_components/theme-switch';
import { useDebouncedWrite } from './_components/use-debounced-write';
import {
  PROFILE_KEY,
  PROFILE_LABEL,
  PROFILE_RESET_KEY,
  QUICK,
  SCENES,
  STORE_KEY,
  WANT_KEY,
  WELCOME,
  type ThemeKey,
} from './_components/constants';
import type { Filters, MemorySnapshot, Msg, Rec } from './_components/types';

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
  const [messages, setMessages] = useState<Msg[]>([{ role: 'assistant', content: WELCOME }]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [drawer, setDrawer] = useState(false);
  /** 右侧「我的」抽屉：想要清单 + 长期偏好 */
  const [myOpen, setMyOpen] = useState(false);
  /** 点过「想要」的零食，攒成清单 */
  const [wantList, setWantList] = useState<Rec[]>([]);
  /** 当前皮肤：真身是 <html data-theme>，state 只用来画按钮 */
  const [theme, setTheme] = useState<ThemeKey>('warm');
  /**
   * 读档完成了吗？没完成之前**不许写盘**。
   *
   * 首帧的 messages 只有欢迎语，读档是 effect 里做的。放行太早的话，
   * 落盘逻辑会先把"只有欢迎语"这一版写回去，把历史覆盖掉。
   */
  const [hydrated, setHydrated] = useState(false);

  /**
   * 账号态：真源在服务端 cookie，这里只是它的投影。
   * `userId` 未登录时是本地那个 u_xxx——升级不换 id，所以记忆天然继承。
   */
  const auth = useAuth();
  /** 登录/注册弹窗；null = 关着 */
  const [authMode, setAuthMode] = useState<AuthMode | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [authBusy, setAuthBusy] = useState(false);

  /**
   * 统一请求头：游客身份走 `x-guest-id`（服务端以它为准），
   * 登录态则认 HttpOnly cookie（`credentials: same-origin` 带上）。
   * 两条并存：已登录时 cookie 优先，头里的 id 会被忽略——这是服务端定的优先级。
   */
  function requestHeaders(): Record<string, string> {
    return { 'Content-Type': 'application/json', 'x-guest-id': auth.userId };
  }

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
          localStorage.setItem(PROFILE_RESET_KEY, '1');
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
      setMessages((prev) => prev.map((m) => (m.ts ? m : { ...m, ts: Date.now() })));
    }

    // 到这里内存里的状态才是"用户上次看到的那一版"，现在才允许落盘
    setHydrated(true);
  }, []);

  // 落盘：debounce 写，别让流式每吐一个字就同步 setItem 一次。
  // 引用要靠 useMemo 稳住，否则输入框敲一个字也会把定时器重置掉。
  const storeSnapshot = useMemo(() => ({ messages, filters }), [messages, filters]);
  useDebouncedWrite(STORE_KEY, storeSnapshot, hydrated, 400);
  // 注册成功后要**立刻**把这份缓存作废，所以要拿到 save()：
  // 只 setProfile({}) 的话，上一个定时器还握着旧值，300ms 后照样写回去
  const { save: saveProfile } = useDebouncedWrite(PROFILE_KEY, profile, hydrated);
  useDebouncedWrite(WANT_KEY, wantList, hydrated);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages, loading]);

  // 输入框随内容长高，最多到 160px 后自己滚
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [input]);

  /** 记下想要的零食，同时给一句回话 */
  function addWant(rec: Rec) {
    setWantList((prev) => (prev.some((w) => w.name === rec.name) ? prev : [...prev, rec]));
    setMessages((prev) => [
      ...prev,
      {
        role: 'assistant',
        content: `好嘞，${rec.name}记下了 👌\n想要清单里有 ${wantList.length + 1} 样了，随时在「我的」里看`,
        ts: Date.now(),
      },
    ]);
  }

  /** 服务端快照写进 state：字段缺失一律当空数组，别让 undefined 漏进渲染 */
  function applyMemorySnapshot(snapshot: Partial<MemorySnapshot> | null | undefined) {
    const m = snapshot ?? {};
    setMemory({
      core_profile: Array.isArray(m.core_profile) ? m.core_profile : [],
      summary_memory: Array.isArray(m.summary_memory) ? m.summary_memory : [],
      active_fragments: Array.isArray(m.active_fragments) ? m.active_fragments : [],
    });
  }

  /**
   * 把后端返回的记忆结果落到前端。
   * 关键在 memory_action：用户本轮说"忘掉XX"/"全都忘掉"时后端已经删了，
   * 前端缓存必须跟着删，否则侧栏还挂着那条、下一轮又当偏好带上去，等于没删。
   */
  function applyMemoryPayload(data: any) {
    if (!data || typeof data !== 'object') return;

    if (data.memory_action === 'cleared') {
      setProfile({});
      setMemory({ core_profile: [], summary_memory: [], active_fragments: [] });
    } else if (data.memory_action === 'deleted' && data.memory_keyword) {
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

    if (data.memory && typeof data.memory === 'object') {
      applyMemorySnapshot(data.memory as MemorySnapshot);
    }
  }

  /**
   * 注册 / 登录提交。
   *
   * 收尾这一步最容易漏：升级不换 userId，所以本地这份 profile 里还是
   * "游客时期攒的临时值"。不清掉的话，刷新一次旧缓存又回来了，
   * 而真源已经在库里——两边打架，用户会看到自己没说过的东西。
   */
  async function handleAuthSubmit(email: string, password: string) {
    const mode = authMode;
    if (!mode || authBusy) return;
    setAuthBusy(true);
    setAuthError(null);
    try {
      const r =
        mode === 'upgrade'
          ? await auth.upgrade(email, password)
          : await auth.login(email, password);
      if (!r.ok) {
        setAuthError(r.error || '没成功，稍后再试');
        return;
      }
      setAuthMode(null);
      if (mode === 'upgrade') {
        // 立刻盖掉，别等 debounce 那 300ms
        setProfile({});
        saveProfile({});
      }
      // 服务端快照为准：换了设备登录时，记忆就是从这里补回来的
      applyMemorySnapshot(await auth.refresh());
    } finally {
      setAuthBusy(false);
    }
  }

  /**
   * 退出登录：只清登录态。
   *
   * 不清 profile / memory——升级不换 id，退出后还是同一个人的游客态，
   * 记忆本来就在他身上。清了反而像是"一退出就失忆"。
   */
  async function handleLogout() {
    await auth.logout();
  }

  function openAuth(mode: AuthMode) {
    setAuthError(null);
    setAuthMode(mode);
  }

  /**
   * 侧栏/抽屉里点「忘掉」：光清本地没用，得让后端一起删，
   * 否则下次请求又把这条偏好带回去，用户会觉得我根本没忘。
   */
  async function forgetOnServer(text: string) {
    try {
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: requestHeaders(),
        credentials: 'same-origin',
        body: JSON.stringify({ message: text }),
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
    const keywordish = /不吃辣|不想吃辣|不能吃辣|忌辣|不吃甜|不想吃甜|不吃酸|忌酸|过敏|不耐/.test(
      value,
    );
    void forgetOnServer(keywordish ? `忘掉${value}` : `忘掉我喜欢${value}`);
  }

  /** 全都忘掉：本地清空 + 后端一起清 */
  function forgetAll() {
    setProfile({});
    void forgetOnServer('全都忘掉');
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
    const replyText = typeof data.reply === 'string' ? data.reply.trim() : '';

    const build = (): Msg | null => {
      if (cards)
        return {
          role: 'assistant',
          content: replyText,
          cards,
          ts: Date.now(),
          refreshed,
        };
      if (replyText)
        return {
          role: 'assistant',
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
    if (data.profile && typeof data.profile === 'object') {
      const incoming = stripVolatileProfile(data.profile);
      if (Object.keys(incoming).length) {
        // 同维度互斥（2026-11-03）：本轮说了忌口，同轴的旧口味标签要当场让位，
        // 裸 spread 会把「口味·辣味」和「忌口·不吃辣」并排挂在侧栏
        setProfile((prev) => mergeProfileExclusive(prev, incoming));
      }
    }

    applyMemoryPayload(data);
  }

  /**
   * 新建会话：只重置「这一轮对话」，长期记忆一个字都不动。
   *
   * 这里必须把两件事彻底分开：
   *   - **清空聊天记录** → 纯前端 UI 状态，本地就能做
   *   - **清空长期记忆**（后端数据库）→ 只能在对话里说「全都忘掉」触发
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

    setMessages([{ role: 'assistant', content: WELCOME, ts: Date.now() }]);
    setInput('');
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
  async function streamChat(payload: Record<string, unknown>, session: number): Promise<boolean> {
    // 每条流配一个 controller：新对话要能把它掐断，不给旧流继续往下读的机会
    const ctrl = new AbortController();
    streamAbort.current = ctrl;

    const res = await fetch('/api/ai/stream', {
      method: 'POST',
      headers: requestHeaders(),
      credentials: 'same-origin',
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });

    // 400 是"没写内容"这类可预期的拒绝，给句提示就行，不用降级重发
    if (res.status === 400) {
      setMessages((prev) => [
        ...prev,
        { role: 'assistant', content: '说点什么呀', ts: Date.now() },
      ]);
      return true;
    }
    // 限流同理：服务端已经说明了"慢点"，照原话给用户，
    // 别走下面的降级重发——那会再打一次接口，正好把限流撞得更死
    if (res.status === 429) {
      let hint = '慢点，一口气说太多了，缓一下再聊';
      try {
        const data = await res.json();
        if (typeof data?.error === 'string' && data.error) hint = data.error;
      } catch {
        /* 响应体不是 JSON 就用默认话术 */
      }
      setMessages((prev) => [...prev, { role: 'assistant', content: hint, ts: Date.now() }]);
      return true;
    }
    if (!res.ok || !res.body) return false;

    // 占位气泡：先插进去，后面靠 id 定位反复改写它
    const bubbleId = 's_' + Date.now();
    setMessages((prev) => [
      ...prev,
      { id: bubbleId, role: 'assistant', content: '', ts: Date.now() },
    ]);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let acc = '';
    let finalized = false;

    // 渲染前先确认还是同一个会话：掐断之后队列里可能还排着几个 delta
    const patch = (fn: (m: Msg) => Msg) =>
      setMessages((prev) =>
        sessionId.current === session ? prev.map((m) => (m.id === bubbleId ? fn(m) : m)) : prev,
      );

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // 会话已经被重置：后面的字全部丢弃，别再往新列表里写
      if (sessionId.current !== session) return true;

      buf += decoder.decode(value, { stream: true });

      // SSE 以空行分帧；最后一段可能不完整，留在 buffer 里等下一块
      const frames = buf.split('\n\n');
      buf = frames.pop() || '';

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

        if (ev === 'delta' && data.text) {
          // 逐块追加：这一步是纯渲染，不碰任何业务判断
          acc += data.text;
          patch((m) => ({ ...m, content: acc }));
        } else if (ev === 'error') {
          patch((m) => ({
            ...m,
            content: data.message || '啊？刚卡了一下，再说一次？',
          }));
          return true;
        } else if (ev === 'final') {
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
      patch((m) => (m.content ? m : { ...m, content: '啊？网断了？再说一次？' }));
    }
    return true;
  }

  // ── 发送 ──────────────────────────────────────
  async function send(raw?: string) {
    const text = (raw ?? input).trim();
    if (!text || loading) return;

    // 记下发起时的会话代号：异步回来后比对一下，中途被"新对话"重置就整个丢弃
    const mySession = sessionId.current;

    setInput('');
    setMessages((prev) => [...prev, { role: 'user', content: text, ts: Date.now() }]);
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
      // 身份只走 cookie 与 x-guest-id 头（见 requestHeaders）：V2.1 起服务端不再读 body.userId
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
      const res = await fetch('/api/ai', {
        method: 'POST',
        headers: requestHeaders(),
        credentials: 'same-origin',
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
            data.trace_id ? `trace_id=${data.trace_id}` : '（服务端没给 trace_id）',
          );
        recommendCtx.current = false;
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: '啊？刚卡了一下，再说一次？',
            ts: Date.now(),
          },
        ]);
        return;
      }

      applyPayload(data);
    } catch (e: any) {
      // 用户主动"新对话"掐断的，不是真的出错，别弹"网断了"吓人
      if (e?.name === 'AbortError') return;
      // 同理，这轮已经被重置了就什么都不做
      if (sessionId.current !== mySession) return;

      console.error('[Chat] 发送失败：', e);
      recommendCtx.current = false;
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content: '啊？网断了？再说一次？',
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
  const addOnTip = wantList.map((w) => w.promo?.add_on).find((a) => a && a.gap > 0);

  /**
   * 服务端长期记忆压成一条条展示项。
   * 服务端那份是持久化的真源，本地 profile 只是本轮带过去的缓存，
   * 两边会有重叠，所以本地这里只补"服务端没记下的"，避免同一条显示两遍。
   */
  const serverMemory = [
    ...memory.core_profile.map((text) => ({ text, tag: '一直有效' })),
    ...memory.summary_memory.map((text) => ({ text, tag: '场景' })),
    ...memory.active_fragments.map((text) => ({ text, tag: '零散' })),
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
    const keyword = text.split('：')[0] || text;
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
          <span className="text-lg font-extrabold tracking-wide text-cx-600">脆香零食</span>
          <span className="hidden text-xs text-cx-400 sm:inline">你的零食推荐好友</span>
        </div>

        {/*
          顶栏只留三个入口。
          「+ 新对话」是最高频的逃生出口，文字常驻；
          「推荐」「我的」在窄屏压成图标——375px 的手机上四个带文字的按钮
          会把输入框挤得只剩一半，而这两个入口靠图标 + title 完全认得出来。
        */}
        <nav className="ml-auto flex items-center gap-0.5 text-sm sm:gap-1">
          <NavBtn onClick={newChat}>+ 新对话</NavBtn>
          <NavBtn onClick={() => send('推荐个零食')} label="推荐零食">
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
            <div className="absolute inset-0 bg-black/30" onClick={() => setDrawer(false)} />
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
          <div ref={listRef} className="scroll-slim flex-1 space-y-4 overflow-y-auto p-4">
            {messages.map((m, i) =>
              m.cards ? (
                <div key={i}>
                  {/* 推荐话术先出气泡，再接卡片：只有三张卡的推荐太像自动售货机 */}
                  {m.content.trim() && <Bubble msg={{ ...m, cards: undefined }} />}
                  <div
                    className={`grid gap-2 sm:grid-cols-2 xl:grid-cols-3 ${
                      m.content.trim() ? 'mt-3' : ''
                    }`}
                  >
                    {m.cards.map((c, j) => (
                      <SnackCard
                        key={j}
                        rec={c}
                        wanted={wantList.some((w) => w.name === c.name)}
                        onWant={() => addWant(c)}
                        onSwap={() => send('换一批')}
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
                    <div className="mt-0.5 text-xs leading-relaxed text-cx-400">{s.sub}</div>
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
                    if (e.key === 'Enter' && !e.shiftKey) {
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
            <div className="absolute inset-0 bg-black/30" onClick={() => setMyOpen(false)} />
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

              {/*
                账号区放在最上面：游客态是"记忆只跟着这台浏览器走"，
                这句话不显眼就不会有人去注册，而清一次缓存他的忌口就没了。
              */}
              <section className="mb-6 rounded-2xl border border-cx-200 bg-cx-50 p-3">
                <h3 className="mb-2 text-xs font-bold tracking-wider text-cx-400">账号</h3>
                {auth.loading ? (
                  <p className="text-xs text-cx-400">正在读取账号…</p>
                ) : auth.email ? (
                  <div className="flex items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold text-cx-700">{auth.email}</div>
                      <div className="mt-0.5 text-[11px] text-cx-400">换设备登录也不会丢记忆</div>
                    </div>
                    <button
                      onClick={() => void handleLogout()}
                      className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-full border border-cx-200 bg-white px-3 py-1 text-[11px] font-semibold text-cx-600 hover:bg-cx-100"
                    >
                      退出
                    </button>
                  </div>
                ) : (
                  <>
                    <p className="text-[11px] leading-relaxed text-cx-400">
                      你现在是游客，记住的东西只跟着这台浏览器走，清缓存就没了。
                    </p>
                    <div className="mt-2 flex gap-2">
                      <button
                        onClick={() => openAuth('upgrade')}
                        className="inline-flex min-h-[40px] flex-1 items-center justify-center rounded-full bg-cx-300 px-3 py-1 text-[11px] font-bold text-white hover:bg-cx-400"
                      >
                        注册（保留现在的记忆）
                      </button>
                      <button
                        onClick={() => openAuth('login')}
                        className="inline-flex min-h-[40px] shrink-0 items-center justify-center rounded-full border border-cx-200 bg-white px-3 py-1 text-[11px] font-semibold text-cx-600 hover:bg-cx-100"
                      >
                        登录
                      </button>
                    </div>
                  </>
                )}
              </section>

              <section className="mb-6">
                <h3 className="mb-2 text-xs font-bold tracking-wider text-cx-400">想要清单</h3>
                {wantList.length ? (
                  <>
                    <ul className="space-y-2">
                      {wantList.map((w) => (
                        <li
                          key={w.name}
                          className="flex items-center gap-2 rounded-xl border border-cx-100 bg-cx-50 px-3 py-2"
                        >
                          <span className="text-lg">{w.emoji || '🍪'}</span>
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
                              setWantList((prev) => prev.filter((x) => x.name !== w.name))
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
                        合计 ¥{wantList.reduce((n, w) => n + finalPrice(w), 0).toFixed(1)}
                        {wantList.some((w) => (w.promo?.saved || 0) > 0) && (
                          <span className="ml-1 text-cx-400">
                            （已省 ¥
                            {wantList.reduce((n, w) => n + (w.promo?.saved || 0), 0).toFixed(1)}）
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
                                      reason: '凑单加购',
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
                  <p className="text-xs text-cx-400">还没挑中什么。卡片上点「想要」就存这儿了。</p>
                )}
              </section>

              <section>
                <h3 className="mb-2 text-xs font-bold tracking-wider text-cx-400">记住你的偏好</h3>
                {hasMemory ? (
                  <>
                    <div className="flex flex-wrap gap-1.5">
                      {serverMemory.map(({ text, tag }) => (
                        <span
                          key={text}
                          className="inline-flex items-center gap-1 rounded-full bg-cx-300 px-2.5 py-1 text-xs font-semibold text-white"
                        >
                          {tag}·{text.split('：').slice(1).join('：') || text}
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
                  <p className="text-xs text-cx-400">聊着聊着就记住了，比如你说过"不吃辣"。</p>
                )}
              </section>
            </div>
          </div>
        )}
      </div>

      {authMode && (
        <AuthDialog
          mode={authMode}
          busy={authBusy}
          error={authError}
          onClose={() => setAuthMode(null)}
          onSubmit={(email, password) => void handleAuthSubmit(email, password)}
          onSwitch={(next) => {
            setAuthError(null);
            setAuthMode(next);
          }}
        />
      )}
    </div>
  );
}
