// lib/memory/store.ts
// 长期记忆：本地版「长期记忆检索（173639）+ 记忆召回（103270）+ 长期记忆写入（66 类节点）」。
// 照 Coze 工作流的记忆分层设计，但去掉了对 coze 长期记忆组件的依赖：
//
//   三层：core_profile（核心画像，稳定偏好）/ summary_memory（概要，含场景化偏好）/ fragment_memory（碎片，含待确认与失效声明）
//   状态：active（可用）/ pending（待确认，不能当稳定偏好）/ resolved（冲突已澄清）/ superseded（已失效）/ deleted（软删除）
//
// 关键约束（来自工作流提示词）：
//   - 只有 active 的核心画像和概要记忆能作为稳定偏好；碎片记忆只能参考，不能推翻核心画像
//   - 删除是软删除，必须保留旧内容便于追溯，不能物理抹除

import fs from 'node:fs/promises';
import path from 'node:path';

export type MemoryLayer = 'core_profile' | 'summary_memory' | 'fragment_memory';
export type MemoryStatus = 'active' | 'pending' | 'resolved' | 'superseded' | 'deleted';
export type Polarity = '喜欢' | '不喜欢' | '拒绝' | '接受' | '中立' | '不确定';

export interface MemoryRecord {
  id: string;
  layer: MemoryLayer;
  /** 关键词，如「不吃辣」「花生过敏」「场景偏好_加班_清淡」 */
  keyword: string;
  content: string;
  /** 适用场景，没有则空 */
  context?: string;
  category?: string;
  polarity?: Polarity;
  status: MemoryStatus;
  source?: string;
  created_at: string;
  updated_at: string;
}

/** 召回结果：对应工作流里 103270 节点的四个输出 */
export interface RecalledMemory {
  core_profile: string[];
  summary_memory: string[];
  active_fragments: string[];
  pending_fragments: string[];
}

export interface MemoryFact {
  category: string;
  key: string;
  value: string;
  polarity: Polarity;
  context?: string;
  confidence?: number;
}

export type MemoryDecision =
  | 'no_action'
  | 'new_memory'
  | 'consistent_update'
  | 'confirmation_required'
  | 'delete_required'
  | 'query_memory';

export interface MemoryDecisionResult {
  decision: MemoryDecision;
  matched_memory: { keyword: string; content: string; layer: MemoryLayer | 'none' };
  conflicts: {
    old_keyword: string;
    old_content: string;
    new_content: string;
    conflict_type: string;
  }[];
  write_layer: 'none' | MemoryLayer;
  confirmationquestion: string;
}

/**
 * 进程内的串行锁（Promise 链队列）。
 *
 * 为什么需要：`readStore` 读、`writeStore` 写是分开的两步，
 * 所以「读-改-写」整体并不原子——两个请求同时读到旧数据，
 * 后写的那份会把先写的整份覆盖掉（lost update）。
 * 原子写（临时文件 + 改名）只保证文件不被写坏，挡不住这种覆盖：
 * 多用户并发、或同一用户连着发几条消息时，记忆会静默丢失。
 *
 * 单进程部署下，一把进程内的队列锁就够把所有读写串起来，
 * 不引入外部依赖；真要多实例部署，再换 better-sqlite3 之类的存储。
 */
class MemoryMutex {
  private queue: Promise<unknown> = Promise.resolve();

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // 排队：把这一轮挂到当前队尾之后，先等前面全部跑完
    const prev = this.queue;
    this.queue = prev.then(() => gate);

    return prev.then(async () => {
      try {
        return await task();
      } finally {
        // 成功失败都要放行，否则后面排队的请求会永久挂住
        release();
      }
    });
  }
}

/** 全局唯一的文件锁实例：所有对 memory.json 的读写都走它 */
const fileLock = new MemoryMutex();
const DATA_DIR = path.join(process.cwd(), 'data');
const MEMORY_FILE = path.join(DATA_DIR, 'memory.json');

type Store = Record<string, MemoryRecord[]>;
/**
 * 取某个用户的记录。
 *
 * 为什么不能直接用 `store[userId]`：原型链上有 constructor / toString / valueOf 这些同名属性，
 * 字符白名单又拦不住纯字母的 key，直接取会拿到函数而不是数组，后面一 `.slice` 就炸了。
 * 这里先认 own property，再确认它确实是数组，脏数据一律当空处理。
 */
function listOf(store: Store, userId: string): MemoryRecord[] {
  const raw = Object.prototype.hasOwnProperty.call(store, userId) ? store[userId] : [];
  return Array.isArray(raw) ? raw : [];
}

async function readStore(): Promise<Store> {
  try {
    const raw = await fs.readFile(MEMORY_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object'
      ? (Object.assign(Object.create(null), parsed) as Store)
      : {};
  } catch {
    return {};
  }
}

async function writeStore(store: Store): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });

  // 写前备份：把当前这一版先复制成 memory.json.bak，再覆盖。
  // 原子写只挡「文件被写成半截」，挡不住「整份被一份错数据覆盖」——
  // 并发写丢记忆、或上游传进来空 store 时，至少还有上一版可以捞回来。
  // 首次运行（或手动清空过 data/）还没有 memory.json，复制失败属正常，忽略。
  try {
    await fs.copyFile(MEMORY_FILE, `${MEMORY_FILE}.bak`);
  } catch {
    /* 没有旧文件就没什么可备份的 */
  }

  // 原子写：先写临时文件再改名，避免半截文件
  const tmp = `${MEMORY_FILE}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8');
  await fs.rename(tmp, MEMORY_FILE);
}

/**
 * 记忆召回。`_query` 现在用不上（Coze 里它做语义检索，本地是按状态分层取的），
 * 这里按状态分层返回：能当稳定偏好的和不能当的严格分开，避免后面的节点误用。
 * 留着这个形参是为了和 Coze 节点的入参顺序一致，调用方不必跟着改。
 */
export async function recallMemory(
  userId: string,
  _query: string = '零食偏好',
  limit: number = 20,
): Promise<RecalledMemory> {
  return fileLock.runExclusive(async () => {
    const store = await readStore();
    const list = listOf(store, userId).slice(-limit);

    const fmt = (r: MemoryRecord) =>
      r.context ? `${r.keyword}：${r.content}（${r.context}）` : `${r.keyword}：${r.content}`;

    // 按最近更新时间排：后面注入提示词时按这个顺序截断，留新不留旧。
    // updated_at 是 ISO 串，直接比字符串大小就是比时间先后。
    const recent = (rs: MemoryRecord[]) =>
      [...rs].sort((a, b) => b.updated_at.localeCompare(a.updated_at));

    return {
      core_profile: recent(
        list.filter((r) => r.layer === 'core_profile' && r.status === 'active'),
      ).map(fmt),
      summary_memory: recent(
        list.filter((r) => r.layer === 'summary_memory' && r.status === 'active'),
      ).map(fmt),
      active_fragments: recent(
        list.filter((r) => r.layer === 'fragment_memory' && r.status === 'active'),
      ).map(fmt),
      pending_fragments: list.filter((r) => r.status === 'pending').map(fmt),
    };
  });
}

/** 原始记录，删除/失效时要按 keyword 找到目标 */
export async function listMemory(userId: string): Promise<MemoryRecord[]> {
  return fileLock.runExclusive(async () => {
    const store = await readStore();
    return listOf(store, userId);
  });
}

export interface WriteEntry {
  layer: MemoryLayer;
  keyword: string;
  content: string;
  context?: string;
  category?: string;
  polarity?: Polarity;
  status?: MemoryStatus;
  source?: string;
}

/**
 * 写入记忆。同 layer+keyword 的 active 记录做更新而不是堆一条新的，
 * 否则"不吃辣"会被写几十遍，检索出来的全是重复项。
 */
export async function writeMemory(userId: string, entries: WriteEntry[]): Promise<void> {
  return fileLock.runExclusive(async () => {
    if (!entries.length) return;
    const store = await readStore();
    const list = listOf(store, userId);
    const now = new Date().toISOString();

    for (const e of entries) {
      const keyword = e.keyword.trim();
      const content = e.content.trim();
      if (!keyword || !content) continue;

      const status = e.status || 'active';
      const existing = list.find(
        (r) => r.layer === e.layer && r.keyword === keyword && r.status === status,
      );
      if (existing) {
        existing.content = content;
        existing.context = e.context ?? existing.context;
        existing.updated_at = now;
        continue;
      }
      list.push({
        id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        layer: e.layer,
        keyword,
        content,
        context: e.context,
        category: e.category,
        polarity: e.polarity,
        status,
        source: e.source || '对话提取',
        created_at: now,
        updated_at: now,
      });
    }

    store[userId] = list.slice(-200); // 兜个上限，别让文件无限涨
    await writeStore(store);
  });
}

/** 软删除：标记 deleted，保留原文便于追溯 */
export async function deleteMemory(userId: string, keyword: string): Promise<boolean> {
  return fileLock.runExclusive(async () => {
    const store = await readStore();
    const list = listOf(store, userId);
    const now = new Date().toISOString();
    let hit = false;

    for (const r of list) {
      if (r.status === 'deleted' || r.status === 'superseded') continue;
      if (r.keyword.includes(keyword) || r.content.includes(keyword)) {
        r.status = 'deleted';
        r.updated_at = now;
        hit = true;
      }
    }
    if (hit) {
      store[userId] = list;
      await writeStore(store);
    }
    return hit;
  });
}

/**
 * 待确认记忆的闭环：用户对上一轮那句「你之前说过 X，现在改口了？」给了答复。
 *
 * confirm=true  → pending 转正成 active 的长期偏好，被它顶掉的旧偏好标记为 superseded
 * confirm=false → pending 作废，旧偏好原样保留，等于用户说了句玩笑话
 *
 * 以前这条链路是断的：pending 写进去之后没人问、也没人收，用户永远收不到确认提问，
 * 改口也就永远无法生效。现在由 route.ts 在下一句话里拦截答复，走到这里办结。
 *
 * @returns 办结的那条内容便于 route 拼回复；没有待确认的记忆则返回 null
 */
export async function resolvePending(
  userId: string,
  confirm: boolean,
): Promise<{ keyword: string; content: string } | null> {
  return fileLock.runExclusive(async () => {
    const store = await readStore();
    const list = listOf(store, userId);
    const now = new Date().toISOString();

    // 一次只办结最近的那条：同时挂好几个待确认的话，用户一句"对"说不清Yes的是哪个
    const pending = [...list].reverse().find((r) => r.status === 'pending');
    if (!pending) return null;

    const baseKeyword = pending.keyword.replace(/^待确认_/, '');

    if (!confirm) {
      pending.status = 'resolved';
      pending.updated_at = now;
      store[userId] = list;
      await writeStore(store);
      return { keyword: baseKeyword, content: pending.content };
    }

    // 转正前先把旧偏好作废：同一个 keyword 的 active 记录不能再继续当稳定偏好用，
    // 否则推荐会同时吃到"不吃辣"和"喜欢辣"两条相反的约束。
    for (const r of list) {
      if (r.id === pending.id || r.status !== 'active') continue;
      if (
        r.keyword === baseKeyword ||
        baseKeyword.includes(r.keyword) ||
        r.keyword.includes(baseKeyword)
      ) {
        r.status = 'superseded';
        r.updated_at = now;
      }
    }

    list.push({
      id: `m_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      layer: 'core_profile',
      keyword: baseKeyword,
      content: pending.content,
      context: pending.context,
      category: pending.category,
      polarity: pending.polarity,
      status: 'active',
      source: '冲突确认',
      created_at: now,
      updated_at: now,
    });
    pending.status = 'resolved';
    pending.updated_at = now;

    store[userId] = list.slice(-200);
    await writeStore(store);
    return { keyword: baseKeyword, content: pending.content };
  });
}

/** 一次性全清：同样只做软删除，历史留着可追溯 */
export async function clearMemory(userId: string): Promise<number> {
  return fileLock.runExclusive(async () => {
    const store = await readStore();
    const list = listOf(store, userId);
    const now = new Date().toISOString();
    let n = 0;

    for (const r of list) {
      if (r.status === 'deleted') continue;
      r.status = 'deleted';
      r.updated_at = now;
      n++;
    }
    if (n) {
      store[userId] = list;
      await writeStore(store);
    }
    return n;
  });
}

/** 失效声明：旧记忆不再作为当前偏好，但不抹掉历史 */
export async function supersedeMemory(
  userId: string,
  keyword: string,
  // 第三参是给 Coze 节点留的"为什么失效"，本地记在 updated_at 里就够，暂不落字段
  _reason?: string,
): Promise<void> {
  return fileLock.runExclusive(async () => {
    const store = await readStore();
    const list = listOf(store, userId);
    const now = new Date().toISOString();

    for (const r of list) {
      if (r.status !== 'active') continue;
      if (r.keyword.includes(keyword) || r.content.includes(keyword)) {
        r.status = 'superseded';
        r.updated_at = now;
      }
    }
    store[userId] = list;
    await writeStore(store);
  });
}

/**
 * 记忆比较与冲突识别：本地版 148919 节点。
 * 规则顺序沿用工作流提示词，最要紧的两条：
 *   1. 过敏 / 明确忌口是高优先级，遇到就直接写，不走确认
 *   2. 与稳定偏好相反时才要求确认，不同场景的偏好不算冲突
 */
export function decideMemoryAction(
  facts: MemoryFact[],
  memory: RecalledMemory,
  intent: '表达偏好' | '修改偏好' | '删除记忆' | '查询记忆' | '普通闲聊' | '其他' = '表达偏好',
): MemoryDecisionResult {
  const empty: MemoryDecisionResult = {
    decision: 'no_action',
    matched_memory: { keyword: '', content: '', layer: 'none' },
    conflicts: [],
    write_layer: 'none',
    confirmationquestion: '',
  };

  if (intent === '查询记忆') return { ...empty, decision: 'query_memory' };
  if (!facts.length) return empty;

  // 删除：目标必须能匹配到已有记忆，匹配不到就不能猜（工作流规则 4）
  if (intent === '删除记忆') {
    const target = matchExisting(facts, memory);
    if (!target) return empty;
    return {
      ...empty,
      decision: 'delete_required',
      matched_memory: target,
      write_layer: 'fragment_memory',
    };
  }

  const hard = facts.find((f) => f.category === '过敏忌口' && f.polarity === '拒绝');
  if (hard) {
    return {
      ...empty,
      decision: 'new_memory',
      matched_memory: { keyword: hard.key, content: hard.value, layer: 'core_profile' },
      write_layer: 'core_profile',
    };
  }

  const fact = facts[0];
  const existing = matchExisting([fact], memory);

  // 已有同关键词的 active 记忆
  if (existing) {
    const sameValue = existing.content.includes(fact.value);
    if (sameValue) {
      return {
        ...empty,
        decision: 'consistent_update',
        matched_memory: existing,
        write_layer: existing.layer,
      };
    }
    // 场景不同 → 属于场景差异，不是冲突，直接按场景另存一条概要
    if (fact.context && !existing.content.includes(fact.context)) {
      return {
        ...empty,
        decision: 'new_memory',
        matched_memory: existing,
        write_layer: 'summary_memory',
      };
    }
    return {
      decision: 'confirmation_required',
      matched_memory: existing,
      conflicts: [
        {
          old_keyword: existing.keyword,
          old_content: existing.content,
          new_content: `${fact.key}=${fact.value}`,
          conflict_type: '偏好变化',
        },
      ],
      write_layer: 'fragment_memory',
      confirmationquestion: `你之前说过${existing.content}，现在改口成${fact.value}了？我按新的记？`,
    };
  }

  return {
    ...empty,
    decision: 'new_memory',
    matched_memory: {
      keyword: fact.key,
      content: `${fact.key}=${fact.value}`,
      layer: 'core_profile',
    },
    write_layer: 'core_profile',
  };
}

/** 在召回结果里找本轮事实能对应的那条记忆 */
function matchExisting(
  facts: MemoryFact[],
  memory: RecalledMemory,
): { keyword: string; content: string; layer: MemoryLayer } | null {
  const pool: { text: string; layer: MemoryLayer }[] = [
    ...memory.core_profile.map((t) => ({ text: t, layer: 'core_profile' as const })),
    ...memory.summary_memory.map((t) => ({ text: t, layer: 'summary_memory' as const })),
    ...memory.active_fragments.map((t) => ({ text: t, layer: 'fragment_memory' as const })),
  ];

  for (const f of facts) {
    const hit = pool.find((p) => p.text.includes(f.key) || p.text.includes(f.value));
    if (hit) {
      const [keyword, ...rest] = hit.text.split('：');
      return { keyword: keyword || f.key, content: rest.join('：') || hit.text, layer: hit.layer };
    }
  }
  return null;
}

/**
 * 注入量上限。聊了几个月的用户记忆会很稀疏也很长，全塞进 system 会拖慢首字响应，
 * 而且几十条里真正影响当前推荐的往往就那几条。
 * 核心画像是稳定偏好，条数本来极少，全放；概要和碎片按最近更新截断（顺序在 recallMemory 里已排好）。
 */
const MAX_SUMMARY_INJECT = 5;
const MAX_FRAGMENT_INJECT = 3;

/** 把记忆压成给大脑看的几行字（只带 active，pending 不进提示词） */
export function renderMemoryForPrompt(memory: RecalledMemory): string {
  const lines: string[] = [];
  if (memory.core_profile.length) {
    lines.push(`长期偏好（一直有效）：${memory.core_profile.join('；')}`);
  }
  if (memory.summary_memory.length) {
    const picked = memory.summary_memory.slice(0, MAX_SUMMARY_INJECT);
    const rest = memory.summary_memory.length - picked.length;
    lines.push(`场景偏好：${picked.join('；')}${rest ? `（还有 ${rest} 条更早的）` : ''}`);
  }
  if (memory.active_fragments.length) {
    const picked = memory.active_fragments.slice(0, MAX_FRAGMENT_INJECT);
    const rest = memory.active_fragments.length - picked.length;
    lines.push(`零散记录：${picked.join('；')}${rest ? `（还有 ${rest} 条更早的）` : ''}`);
  }
  return lines.join('\n');
}
