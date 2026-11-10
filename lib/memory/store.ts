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
//
// ── V2.0：从 data/memory.json 迁到 SQLite（Prisma） ─────────────────────
//
// 这一层只换存储，**语义一行没改**：分层的判定、软删除、待确认闭环、注入上限都原样保留。
// 变化的是三件事：
//   1. 不再有进程内 MemoryMutex。原来那把锁是为了解决"整份 JSON 读-改-写"的 lost update；
//      现在每次操作都是带条件的单行/多行写入，SQLite 自身只允许一个写者，
//      事务边界由 prisma.$transaction 划，锁不再需要（多实例部署要换 Postgres，见 §4 文档）。
//   2. 不再有"写前备份 memory.json.bak"——备份改由 scripts/backup-db.mjs 单独跑，
//      不再挂在每次写入的热路径上。
//   3. 单用户 200 条上限仍在，但改成"写完后按 updatedAt 删掉超出的旧行"：
//      原来的 `list.slice(-200)` 是数组截断，换到库里就是这句。

import type { User } from '@prisma/client';
import { prisma } from '@/lib/db';

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

/** 库里存的是 String（SQLite 不支持 enum），读出来统一转回联合类型 */
function castLayer(raw: string): MemoryLayer {
  return raw === 'summary_memory' || raw === 'fragment_memory' ? raw : 'core_profile';
}

function castStatus(raw: string): MemoryStatus {
  switch (raw) {
    case 'pending':
    case 'resolved':
    case 'superseded':
    case 'deleted':
      return raw;
    default:
      return 'active';
  }
}

function castPolarity(raw: string | null): Polarity | undefined {
  switch (raw) {
    case '喜欢':
    case '不喜欢':
    case '拒绝':
    case '接受':
    case '中立':
    case '不确定':
      return raw;
    default:
      return undefined;
  }
}

/** 库行 → 对外形状。字段名保持 created_at / updated_at（调用方按这个口径写的） */
function toRecord(row: {
  id: string;
  layer: string;
  keyword: string;
  content: string;
  context: string | null;
  category: string | null;
  polarity: string | null;
  status: string;
  source: string | null;
  createdAt: Date;
  updatedAt: Date;
}): MemoryRecord {
  return {
    id: row.id,
    layer: castLayer(row.layer),
    keyword: row.keyword,
    content: row.content,
    context: row.context ?? undefined,
    category: row.category ?? undefined,
    polarity: castPolarity(row.polarity),
    status: castStatus(row.status),
    source: row.source ?? undefined,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

/** 召回格式：有场景就带上场景，没有就只给「关键词：内容」 */
function fmt(r: MemoryRecord): string {
  return r.context ? `${r.keyword}：${r.content}（${r.context}）` : `${r.keyword}：${r.content}`;
}

/**
 * 保证 User 行存在。
 *
 * 记忆表有外键，写记忆前必须先有用户行。游客是"第一次说话就存在"的，
 * 前端只带了个 u_xxx 过来，服务端并不知道这个 id——所以这里 upsert 一次，
 * 已存在的（含已注册用户）一个字都不改。
 */
async function ensureUser(tx: Pick<typeof prisma, 'user'>, userId: string): Promise<User> {
  return tx.user.upsert({
    where: { id: userId },
    create: { id: userId, isGuest: true },
    update: {},
  });
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
  // 只取这个用户最近 limit 条**有效**记忆：聊了几个月的用户记录会很长，
  // 真正影响当前推荐的往往只有最近那几条，注入上限在 renderMemoryForPrompt 里再收一次。
  //
  // ⚠️ deleted / superseded 必须在查询里排除（2026-11-05 外审 P0）：以前是
  // `take: limit` 后再在内存里过滤状态——用户一旦攒了 20+ 条废弃记忆
  // （改口味连环、删偏好都会产生），这 20 个名额全被废弃数据占满，
  // 「不吃辣」这类长期偏好被挤出结果集，AI 当场"失忆"。
  // 把状态过滤下推到查询，limit 只作用于有效数据。
  const rows = await prisma.memory.findMany({
    where: { userId, status: { notIn: ['deleted', 'superseded'] } },
    orderBy: { updatedAt: 'desc' },
    take: Math.max(1, limit),
  });

  const list = rows.map(toRecord);
  const byLayer = (layer: MemoryLayer, status: MemoryStatus) =>
    list.filter((r) => r.layer === layer && r.status === status).map(fmt);

  return {
    core_profile: byLayer('core_profile', 'active'),
    summary_memory: byLayer('summary_memory', 'active'),
    active_fragments: byLayer('fragment_memory', 'active'),
    pending_fragments: list.filter((r) => r.status === 'pending').map(fmt),
  };
}

/** 原始记录，删除/失效时要按 keyword 找到目标 */
export async function listMemory(userId: string): Promise<MemoryRecord[]> {
  const rows = await prisma.memory.findMany({
    where: { userId },
    orderBy: { updatedAt: 'asc' },
  });
  return rows.map(toRecord);
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

/** 单用户记忆条数上限：原来的 `list.slice(-200)`，超过就丢最旧的 */
const MAX_PER_USER = 200;

// ─── 口味轴（2026-11-09：口味一律长期化，冲突才确认）─────────────────────
//
// 这一层不能 import `lib/chat/handlers.ts`（handlers 反过来依赖 store，会循环），
// 所以轴表在这里再写一份，口径与 `TASTE_AXIS` 一致：辣/甜/咸/酸/清淡。
// 长的排前面，免得「清淡」被别的轴先截走。

const TASTE_AXES = ['清淡', '辣', '甜', '咸', '酸'];
const AVOID_MARK = /不吃|不想吃|不要|不碰|忌|戒|过敏|不耐|不能/;

/** 一串文本里出现的第一个口味轴，不管它是不是忌口句 */
function axisIn(text: string): string {
  return TASTE_AXES.find((a) => text.includes(a)) || '';
}

/** 口味偏好句里的轴：带忌口标记的句子是"不吃X"，不是"爱吃X"，必须返回空 */
function tasteAxisOfText(text: string): string {
  return AVOID_MARK.test(text) ? '' : axisIn(text);
}

/** 把 `keyword：content` 形状的召回文本拆开 */
function parseMemoryLine(text: string): { keyword: string; content: string } {
  const [keyword, ...rest] = text.split('：');
  return { keyword: keyword || '', content: rest.join('：') || text };
}

/** 召回文本池（active 三层 + pending 之外的），冲突判定只看这里 */
function memoryPool(memory: RecalledMemory): { text: string; layer: MemoryLayer }[] {
  return [
    ...memory.core_profile.map((t) => ({ text: t, layer: 'core_profile' as const })),
    ...memory.summary_memory.map((t) => ({ text: t, layer: 'summary_memory' as const })),
    ...memory.active_fragments.map((t) => ({ text: t, layer: 'fragment_memory' as const })),
  ];
}

/**
 * 写入记忆。同 layer+keyword+status 的已有记录做更新而不是堆一条新的，
 * 否则"不吃辣"会被写几十遍，检索出来的全是重复项。
 *
 * 为什么整段包在事务里：这里是"先查有没有、再决定更新还是插入"，
 * 两步分开做，两个并发请求会各插一条（原来靠 MemoryMutex 串行化，现在靠事务）。
 */
export async function writeMemory(userId: string, entries: WriteEntry[]): Promise<void> {
  if (!entries.length) return;

  await prisma.$transaction(async (tx) => {
    await ensureUser(tx, userId);

    for (const e of entries) {
      const keyword = e.keyword.trim();
      const content = e.content.trim();
      if (!keyword || !content) continue;

      const layer = e.layer;
      const status = e.status || 'active';

      const existing = await tx.memory.findFirst({
        where: { userId, layer, keyword, status },
        orderBy: { updatedAt: 'desc' },
      });

      if (existing) {
        await tx.memory.update({
          where: { id: existing.id },
          data: {
            content,
            context: e.context ?? existing.context,
            // category / polarity / source 只在这次真带了的时候覆盖，避免把已有标注冲成 null
            category: e.category ?? existing.category,
            polarity: e.polarity ?? existing.polarity,
            source: e.source ?? existing.source,
          },
        });
        continue;
      }

      await tx.memory.create({
        data: {
          userId,
          layer,
          keyword,
          content,
          context: e.context ?? null,
          category: e.category ?? null,
          polarity: e.polarity ?? null,
          status,
          source: e.source || '对话提取',
        },
      });
    }

    // 超出上限的旧记录删掉。按 updatedAt 倒序跳过前 200 条，剩下的一次 deleteMany。
    const overflow = await tx.memory.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      skip: MAX_PER_USER,
      select: { id: true },
    });
    if (overflow.length) {
      await tx.memory.deleteMany({ where: { id: { in: overflow.map((r) => r.id) } } });
    }
  });
}

/** 软删除：标记 deleted，保留原文便于追溯 */
export async function deleteMemory(userId: string, keyword: string): Promise<boolean> {
  // 已经 deleted / superseded 的不再重复处理（保留第一次的状态，追溯才有意义）
  const hit = await prisma.memory.updateMany({
    where: {
      userId,
      status: { notIn: ['deleted', 'superseded'] },
      OR: [{ keyword: { contains: keyword } }, { content: { contains: keyword } }],
    },
    data: { status: 'deleted' },
  });
  return hit.count > 0;
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
  return prisma.$transaction(async (tx) => {
    // 一次只办结最近的那条：同时挂好几个待确认的话，用户一句"对"说不清 Yes 的是哪个
    const pending = await tx.memory.findFirst({
      where: { userId, status: 'pending' },
      orderBy: { updatedAt: 'desc' },
    });
    if (!pending) return null;

    const baseKeyword = pending.keyword.replace(/^待确认_/, '');

    if (!confirm) {
      await tx.memory.update({ where: { id: pending.id }, data: { status: 'resolved' } });
      return { keyword: baseKeyword, content: pending.content };
    }

    // 转正前先把旧偏好作废：同一个 keyword 的 active 记录不能再继续当稳定偏好用，
    // 否则推荐会同时吃到"不吃辣"和"喜欢辣"两条相反的约束。
    //
    // 这里刻意把 active 行捞到内存里比，而不是让数据库做：
    // 判定条件是「相等 / 互相包含」三条，SQLite 里表达不了"被包含于"，
    // 一个用户的 active 记录也就几条，捞出来比更简单也不慢。
    const active = await tx.memory.findMany({
      where: { userId, status: 'active', id: { not: pending.id } },
      select: { id: true, keyword: true, content: true },
    });
    const doomed = active
      .filter(
        (r) =>
          r.keyword === baseKeyword ||
          baseKeyword.includes(r.keyword) ||
          r.keyword.includes(baseKeyword),
      )
      .map((r) => r.id);
    if (doomed.length) {
      await tx.memory.updateMany({
        where: { id: { in: doomed } },
        data: { status: 'superseded' },
      });
    }

    /**
     * 用户确认「是真的改口味」之后，别的口味轴上的旧偏好也要作废（2026-11-09）。
     *
     * 上面的 `doomed` 只按 pending 的关键词做包含匹配：从「辣」改成「甜」时
     * baseKeyword 是"甜"，够不着 keyword="辣" 的那条，结果新旧两条口味并排 active。
     * 这里补一刀：只动 `polarity='喜欢'` 且**轴不同**的口味行；
     * 忌口 / 过敏行带否定词（`tasteAxisOfText` 直接返回空），一条都不会被误伤。
     */
    if (pending.category === '口味' && pending.polarity === '喜欢') {
      const newAxis = axisIn(`${baseKeyword}${pending.content}`);
      const staleTastes = active
        .filter((r) => {
          const old = tasteAxisOfText(`${r.keyword}${r.content}`);
          return !!old && !!newAxis && old !== newAxis;
        })
        .map((r) => r.id);
      if (staleTastes.length) {
        await tx.memory.updateMany({
          where: { id: { in: staleTastes } },
          data: { status: 'superseded' },
        });
      }
    }

    await tx.memory.create({
      data: {
        userId,
        layer: 'core_profile',
        keyword: baseKeyword,
        content: pending.content,
        context: pending.context,
        category: pending.category,
        polarity: pending.polarity,
        status: 'active',
        source: '冲突确认',
      },
    });

    await tx.memory.update({ where: { id: pending.id }, data: { status: 'resolved' } });
    return { keyword: baseKeyword, content: pending.content };
  });
}

/** 一次性全清：同样只做软删除，历史留着可追溯 */
export async function clearMemory(userId: string): Promise<number> {
  const hit = await prisma.memory.updateMany({
    where: { userId, status: { not: 'deleted' } },
    data: { status: 'deleted' },
  });
  return hit.count;
}

/** 失效声明：旧记忆不再作为当前偏好，但不抹掉历史 */
export async function supersedeMemory(
  userId: string,
  keyword: string,
  // 第三参是给 Coze 节点留的"为什么失效"，本地记在 updated_at 里就够，暂不落字段
  _reason?: string,
): Promise<void> {
  await prisma.memory.updateMany({
    where: {
      userId,
      status: 'active',
      OR: [{ keyword: { contains: keyword } }, { content: { contains: keyword } }],
    },
    data: { status: 'superseded' },
  });
}

/**
 * 同维度互斥：忌口落到某个口味轴上时，把这个轴上的旧口味偏好全部作废。
 *
 * 事故原型（2026-11-03）：用户说「不想吃辣了，想吃甜的」，忌口照写，
 * 但旧的「口味·辣味」没有任何人去动——侧栏两条对立标签并排挂着，
 * 下一轮 `buildNeed` 同时吃到 avoid=辣 和 taste=辣，推荐精神分裂。
 *
 * 为什么不用 `supersedeMemory(userId, axis)`：它按 keyword/content **包含**匹配，
 * 「不吃辣」本身就含"辣"，会把刚写进去的忌口自己也标失效。
 * 所以这里限定 `polarity='喜欢'`——只动口味偏好，忌口 / 过敏原一条不碰。
 *
 * 轴从忌口原话里抠（"不吃辣"→辣）；过敏原（花生/坚果/海鲜/乳制品）不含口味轴字，
 * 天然返回空串不触发——真实过敏记录永远不会被这个函数碰到。
 */
export async function supersedeTasteConflicts(userId: string, axis: string): Promise<number> {
  if (!axis) return 0;
  const rows = await prisma.memory.findMany({
    where: { userId, status: 'active', polarity: '喜欢' },
    select: { id: true, keyword: true, content: true },
  });
  const doomed = rows
    .filter((r) => r.keyword.includes(axis) || r.content.includes(axis))
    .map((r) => r.id);
  if (!doomed.length) return 0;
  await prisma.memory.updateMany({
    where: { id: { in: doomed } },
    data: { status: 'superseded' },
  });
  return doomed.length;
}

/**
 * 记忆比较与冲突识别：本地版 148919 节点。
 * 规则顺序沿用工作流提示词，最要紧的两条：
 *   1. 过敏 / 明确忌口是高优先级，遇到就直接写，不走确认
 *   2. 与稳定偏好相反时才要求确认，不同场景的偏好不算冲突
 *
 * 注意：这一段是**纯函数**，与存储无关，迁库时刻意一行没动——
 * 它同时是提示词规则的落点，动了要连带改《系统prompt汇总》§5。
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

  /**
   * 只看 facts[0]：冲突事实会被 `factsFromMessage` 特意 unshift 到最前面，
   * 它代表的"改口"必须优先于同轮顺带提到的忌口。
   *
   * 以前这里是 `facts.find(...)` —— 只要本轮任何一条事实是忌口就直接写，
   * 哪怕用户正说着"我想吃辣的"。结果"改口"被静默吞掉：忌口照写、pending 不挂、
   * 确认话术不问，用户下次要辣又被自己的旧忌口挡住。
   */
  const first = facts[0];
  const hard = first.category === '过敏忌口' && first.polarity === '拒绝' ? first : null;
  if (hard) {
    return {
      ...empty,
      decision: 'new_memory',
      matched_memory: { keyword: hard.key, content: hard.value, layer: 'core_profile' },
      write_layer: 'core_profile',
    };
  }

  const fact = facts[0];
  const factAxis =
    fact.category === '口味' && fact.polarity === '喜欢'
      ? tasteAxisOfText(fact.value) || axisIn(fact.key)
      : '';

  /**
   * 口味冲突（2026-11-09 用户拍板）：口味一律长期记，但**和已有记忆打架时先问本人**。
   *
   * 以前 `matchExisting` 只按字面包含找旧记录，「辣=喜欢辣」和新的「甜=喜欢甜味」
   * 互相找不到 → 两条口味并排写进 core_profile，侧栏挂两个对立标签、
   * 推荐同时吃到两个相反口味。现在两类冲突都挂 pending，提问明确区分
   * 「临时尝鲜」和「真的改口味」——用户答临时就不更新，答真改才顶掉旧的。
   */
  if (factAxis) {
    const pool = memoryPool(memory);
    // 同轮已经明说的忌口会立刻作废旧口味（安全死命令），别拿那条旧口味来制造假冲突
    const declaredAvoid = new Set(
      facts
        .filter((f) => f.category === '过敏忌口' && f.polarity === '拒绝')
        .map((f) => axisIn(`${f.key}${f.value}`))
        .filter(Boolean),
    );

    // ① 同轴忌口（记着"不吃辣"，这回又想吃辣）→ 确认后才敢撤忌口
    const avoidHit = pool.find((p) => AVOID_MARK.test(p.text) && axisIn(p.text) === factAxis);
    if (avoidHit) {
      const parsed = parseMemoryLine(avoidHit.text);
      return {
        ...empty,
        decision: 'confirmation_required',
        matched_memory: { ...parsed, layer: avoidHit.layer },
        conflicts: [
          {
            old_keyword: parsed.keyword,
            old_content: parsed.content,
            new_content: `${fact.key}=${fact.value}`,
            conflict_type: '改口撞忌口',
          },
        ],
        write_layer: 'fragment_memory',
        confirmationquestion: `你之前说过${parsed.content}，这回又想吃${factAxis}的——是就这一回尝个鲜，还是以后都能吃了？说「临时」我就不动忌口，确认了才敢撤`,
      };
    }

    // ② 异轴旧口味（记着爱吃辣，这回说甜）→ 确认是真改口味才作废旧的那条
    const oldTaste = pool.find((p) => {
      const old = tasteAxisOfText(p.text);
      return !!old && old !== factAxis && !declaredAvoid.has(old) && /喜欢|爱吃|偏好/.test(p.text);
    });
    if (oldTaste) {
      const parsed = parseMemoryLine(oldTaste.text);
      const oldAxis = tasteAxisOfText(oldTaste.text);
      return {
        ...empty,
        decision: 'confirmation_required',
        matched_memory: { ...parsed, layer: oldTaste.layer },
        conflicts: [
          {
            old_keyword: parsed.keyword,
            old_content: parsed.content,
            new_content: `${fact.key}=${fact.value}`,
            conflict_type: '口味变化',
          },
        ],
        write_layer: 'fragment_memory',
        confirmationquestion: `你之前一直爱吃${oldAxis}的，这回换成${factAxis}的——是临时尝个鲜，还是以后就改口味了？说「临时」我就不动记着的，真改了我才更新`,
      };
    }
  }

  const existing = matchExisting([fact], memory);

  // 已有同关键词的 active 记忆
  if (existing) {
    const sameValue = existing.content.includes(fact.value);
    // 同一个口味轴、只是措辞不同（"喜欢辣味" / "喜欢辣的"）→ 原地更新，
    // 不能因此挂一次"改口了吗"的确认，也不能再堆一条重复的口味记录
    const sameAxis =
      !!factAxis &&
      !AVOID_MARK.test(`${existing.keyword}${existing.content}`) &&
      (tasteAxisOfText(existing.content) === factAxis || axisIn(existing.keyword) === factAxis);
    if (sameValue || sameAxis) {
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
