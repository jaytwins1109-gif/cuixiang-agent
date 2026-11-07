// lib/chat/handlers.ts
// 入口层共用的处理片段：用户标识、记忆意图、待确认闭环、推荐分支。
//
// 为什么单独放这里：/api/ai（普通一次性响应）与 /api/ai/stream（SSE 流式）
// 走的是同一套判断。各写一份必然分叉——改了一边忘了另一边，正是这个项目最怕的事。
//
// 注意 Next.js 的限制：route.ts 只允许导出 HTTP 方法与少数配置项，
// 所以这些函数不能挂在两个 route 文件里共用，只能抽成独立模块。
//
// 这里只放「怎么判断、怎么组织响应」，正则字面量一律在 lib/rules/patterns.ts。

import {
  MEMORY_QUERY_PATTERN,
  MEMORY_CLEAR_PATTERN,
  MEMORY_DELETE_PATTERN,
  MEMORY_KEYWORD_PATTERN,
  MEMORY_LIKE_PATTERN,
  PENDING_YES_PATTERN,
  PENDING_NO_PATTERN,
  QUALIFIED_ANSWER_PATTERN,
  URGE_PATTERN,
  INSIST_PATTERN,
  INTRODUCE_PATTERN,
  NIGHT_PATTERN,
  PICK_REFERENCE_PATTERN,
  SCENE_COMPLAINT_PATTERN,
  SPICY_DENIAL_PATTERN,
  ALLERGEN_LABEL_PATTERN,
  LIST_EMOJI_LINE_PATTERN,
} from '@/lib/rules/patterns';
import type { ChatMessage, Filters } from '@/lib/llm';
import {
  allowRecommend,
  extractPrefsFromText,
  mergedPrefs,
  recentUserText,
  pickCompanionReply,
  logDegraded,
} from '@/lib/llm';
import { composeRecommendReply } from '@/lib/llm/reply-composer';
import { timeContext } from '@/lib/llm/time-context';
import { traceLocal, tracePrefix } from '@/lib/chat/trace';
import {
  triggerWorkflow,
  triggerDify,
  pollWorkflow,
  matchLocalFallback,
  findLocalSnack,
  findLocalProduct,
  blockedProductNames,
} from '@/lib/llm/orchestrator';
import {
  runLocalWorkflow,
  violateHardConstraint,
  memoryAvoidTags,
  budgetFromText,
  type LocalWorkflowResult,
} from '@/lib/llm/local-workflow';
import {
  recallMemory,
  writeMemory,
  deleteMemory,
  clearMemory,
  decideMemoryAction,
  resolvePending,
  supersedeTasteConflicts,
  type MemoryFact,
  type RecalledMemory,
} from '@/lib/memory/store';

/**
 * 长期 profile 里**可信**的字段。只有这四类跨轮成立：
 * 说过一次「不吃辣」就是不吃辣，「甜味」「10元内」「脆的」同理，攒下来是对的。
 *
 * 场景和情绪不在此列——它们是**当轮语境**：「办公室」「看海」「烦」每轮都在变，
 * 一旦写进长期 profile 就是脏数据，而且会跨会话复活：
 *   ① 前端侧栏「一直记着」里挂着用户三天前随口提的一句，摘不掉；
 *   ② 选品时它会被当成用户这轮提的约束，几轮前聊过「上班」，
 *      这轮一句「想吃点啥」就被当成"信息够了"直接甩卡片。
 * 场景只认当轮从用户原话 / 模型里抽出来的那份（`prefs.scene`），**不认攒下来的**。
 */
const TRUSTED_PROFILE_KEYS = ['flavor', 'budget', 'avoid', 'texture'] as const;

/**
 * 白名单清洗：从一份 profile 里只挑可信字段，其余一律丢掉。
 *
 * 白名单而不是黑名单：黑名单只能挡住今天想到的 `scene` / `emotion`，
 * 明天模型往 preferences 里多吐一个什么字段，脏数据就又混进来了。
 *
 * 这一份是**本轮选品**用的口径：模型当轮抽的偏好在这里照样算数
 * （`prefs` 已经过了纠偏，本轮按它过滤是对的）。
 * 能不能"长期记住"是另一条更严的口径，见 `pickTrustedProfile`。
 *
 * 预算额外卡一道：只存**选品引擎认得的档位**（`BUDGET_MAP` 里的 10元内 / 10-30元）。
 * 「不限」和「5块」这类值换算出来 min/max 都是 null，选品用不上，
 * 却会作为「预算·不限」挂在侧栏——用户从没说过这话，看着像系统替他做的决定。
 */
export function sanitizeProfile(p?: Record<string, any>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of TRUSTED_PROFILE_KEYS) {
    const v = (p || {})[k];
    if (typeof v !== 'string' || !v.trim() || v === 'null') continue;
    if (k === 'budget') {
      const b = budgetFromText(v.trim());
      if (b.min == null && b.max == null) continue;
    }
    out[k] = v.trim();
  }
  return out;
}

/**
 * **回给前端、允许长期记住的偏好**——必须先过本地确定性抽取这一关。
 *
 * 这是 2026-11-02 的事故修出来的：模型在「有什么好吃的」这种空请求上
 * 会自己填 `avoid=花生过敏`、`flavor=辣味`、`budget=10元内`，
 * 前端照单全收写进 localStorage，侧栏「一直记着」里就挂着用户从没说过的忌口——
 * 而且忌口会**真的执行**，用户从此吃不到花生，可他根本不过敏。
 *
 * 口径：**模型当轮的 preferences 只服务本轮选品，不许沉淀。**
 * 长期化唯一的依据是本地 `extractPrefsFromText(message)` 从**用户原话**里抽出来的那份，
 * 有出处才记，模型猜的一律不记。值也以本地抽到的为准（同一个意思可能有几种写法）。
 *
 * @param message 本轮用户原话（长期化的唯一依据）
 * @param prefs   模型当轮输出的 preferences（本轮选品照常用，只是不在这里沉淀）
 */
export function pickTrustedProfile(
  message: string,
  prefs?: Record<string, any>,
): Record<string, string> {
  const local = extractPrefsFromText(message || '') as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of TRUSTED_PROFILE_KEYS) {
    const v = (prefs || {})[k];
    const fromModel = typeof v === 'string' ? v.trim() : '';

    // 出处①：本地确定性抽取认出来的（"不吃辣""花生过敏""便宜点"……）
    const localHit = typeof local[k] === 'string' ? String(local[k]).trim() : '';
    // 出处②：模型填的这个词**原样出现在用户原话里**（"来点10元内的"——
    //   本地那套"嫌贵"的说法没命中，但用户确实是这么说的）。
    //   只认字面命中："有什么好吃的"对不上任何偏好词，模型脑补的那个值必然落空。
    const literalHit =
      fromModel && fromModel !== 'null' && (message || '').includes(fromModel) ? fromModel : '';

    // 本地抽到的更可靠（同一个意思可能有几种写法），它优先
    const value = localHit || literalHit;
    if (!value) continue;
    if (k === 'budget') {
      const b = budgetFromText(value);
      if (b.min == null && b.max == null) continue;
    }
    out[k] = value;
  }
  // 同维度互斥（2026-11-03）：avoid 与 flavor 撞上同一个口味轴 → 忌口赢。
  // 平时 extractPrefsFromText 已保证单句内不冲突，但模型回声（mergedPrefs 里
  // 模型那份覆盖本地）可能把旧口味带回来——回给前端的标签不能自相矛盾。
  // 过敏原不含轴字，不受影响。
  const avoidAxis = avoidAxisOf(out.avoid || '');
  if (avoidAxis && avoidAxisOf(out.flavor || '') === avoidAxis) delete out.flavor;
  return out;
}

/**
 * 回给前端的偏好：只回**有出处**的那四类（见 `pickTrustedProfile`）。
 *
 * 前端会把这份 profile 攒进 localStorage 并在下一轮带回来，
 * 所以这里漏一个字段出去，就等于允许它变成"用户一直记着的偏好"。
 */
export function cleanProfile(message: string, p?: Record<string, any>): Record<string, string> {
  return pickTrustedProfile(message, p);
}

/** 记忆快照：给前端展示"我记住了什么"，pending 的不能算数，所以只回 active 的三层 */
export function snapshot(m: RecalledMemory) {
  return {
    core_profile: m.core_profile,
    summary_memory: m.summary_memory,
    active_fragments: m.active_fragments,
  };
}

/**
 * 记忆三件套：查「你记得我什么」/ 删一条 / 全清。
 * 这三件事本地就能办结，不必惊动大脑——省一次往返，话术也更可控。
 */
export async function handleMemoryIntent(
  userId: string,
  message: string,
  memory: RecalledMemory,
  traceId?: string,
): Promise<Record<string, unknown> | null> {
  const intent = detectMemoryIntent(message);

  if (intent === 'query') {
    traceLocal(traceId, '记忆意图:查询', '本地办结，不进大脑');
    return {
      route: 'direct',
      reply: renderMemoryReply(memory),
      memory: snapshot(memory),
    };
  }

  if (intent === 'clear') {
    const n = await clearMemory(userId);
    traceLocal(traceId, '记忆意图:全清', `本地办结，清掉 ${n} 条`);
    return {
      route: 'direct',
      reply: n ? `行，记着的 ${n} 条都清了，咱从头开始` : '本来也没记着啥，正好从头开始',
      // 清完要回最新快照，不然前端侧栏还挂着已经删掉的偏好
      memory: snapshot(await recallMemory(userId)),
      // 告诉前端"这次是真清了"，前端才好把本地缓存一起抹掉，避免界面和后端对不上
      memory_action: 'cleared',
    };
  }

  if (intent === 'delete') {
    const kw = extractMemoryKeyword(message);
    const ok = kw ? await deleteMemory(userId, kw) : false;
    traceLocal(
      traceId,
      '记忆意图:单条删除',
      ok ? `软删「${kw}」` : '抠不出关键词，不猜（回「你要我忘掉哪条」）',
    );
    return {
      route: 'direct',
      reply: ok ? `行，${kw}这条我删了，以后不按它来` : '你要我忘掉哪条？说具体点，我不猜',
      memory: snapshot(await recallMemory(userId)),
      memory_action: ok ? 'deleted' : null,
      memory_keyword: ok ? kw : undefined,
    };
  }

  return null;
}

/**
 * 出卡片前的最后一道闸：点名的货撞上忌口 / 过敏 → 一律不给。
 *
 * 为什么必须有这一道：「我就要麻辣魔芋爽」以前是**直接出卡片的**。
 * 点名要货走 introduce，而 introduce 从 `findLocalSnack` 拿到商品就直接返回，
 * **完全不过硬过滤**——主工作流记得住忌口，这条支路却记不住，
 * 同一个用户在两个入口得到两种结果。忌口是死命令，不能看入口。
 */
export function cardBlocked(card: any, memory: RecalledMemory, traceId?: string): string | null {
  const name = card?.name;
  if (!name) return null;

  // 必须拿完整商品来判：卡片对象只有展示用的四个字段，
  // 缺了 spicy / allergens，硬约束判定会读空字段直接抛错
  const full = findLocalProduct(name);
  if (!full) return null;

  const reason = violateHardConstraint(full, {
    avoid_tags: memoryAvoidTags(memory),
    budget_min: null,
    budget_max: null,
  });
  if (reason) {
    traceLocal(traceId, '点名的货撞忌口/过敏', `卡片不给：${name}（${reason}）`);
  }
  return reason;
}

/**
 * 模型自己编了一份商品清单（"1. XX｜X元"）——那是**本地合成专用**的格式。
 *
 * 文档里明写着商品明细不用它写、也不许它写：价、活动、库存都以数据为准，
 * 让它复述必错。陪聊轮根本没有卡片，它却报出带价的菜名，等于凭空报价。
 *
 * 截断只留清单前面的安抚语；整段都是清单（没有安抚语）就返回空，
 * 由调用方拿人设内的兜底话术顶上，绝不留空气泡。
 */
export function stripFakeList(reply: string, traceId?: string): string {
  const lines = (reply || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  // 清单行口径：编号带价（"1. XX｜29.9元"）之外，还有模型爱抄的两种不带价的伪卡片行——
  // 过敏原标注（"⚠️ 儿童海苔小片：含海产品"）和 emoji 商品串（见 patterns.ts 的注释）
  const isListLine = (l: string): boolean =>
    /^\d+[.、]\s*.+[｜|]\s*\d/.test(l) ||
    ALLERGEN_LABEL_PATTERN.test(l) ||
    LIST_EMOJI_LINE_PATTERN.test(l);
  const idx = lines.findIndex(isListLine);
  if (idx < 0) return reply || '';
  traceLocal(
    traceId,
    '陪聊轮自己编了商品清单',
    idx > 0 ? '截掉清单，只留前面的安抚语' : '整段是清单，作废落兜底话术',
  );
  // 清单行之前还有话 → 那才是安抚语，留下
  if (idx > 0) return lines.slice(0, idx).join('\n');
  // 一上来就是清单 → 没有安抚语可留，整个作废
  return '';
}

/**
 * 出口前的最后一道：话里提到了忌口货就整个换掉。
 *
 * 卡片能拦住，模型嘴上提拦不住——那一轮卡片是干净的牛肉干/猪肉脯，
 * 它却在过渡语里写了「麻辣魔芋爽，辣完就爽，后果自负」。
 * 用户看到的就是"一边说不给你推辣的，一边报着辣鸡翅的菜名"。
 */
export function guardReply(
  reply: string | undefined,
  memory: RecalledMemory,
  traceId?: string,
): string {
  const clean = (reply || '').trim();
  if (!clean) return clean;

  const hit = blockedProductNames(memoryAvoidTags(memory)).find((n) => clean.includes(n));
  if (!hit) return clean;

  // 这里不往下传 traceId：cardBlocked 会再打一条"卡片不给"，
  // 同一件事打两行只会让日志变吵
  const reason = cardBlocked({ name: hit }, memory);
  traceLocal(traceId, '话里提到了忌口货', `整句换成劝阻：${hit}`);
  // 不带问号：推荐轮这段话后面还要接本地合成的清单，写成问句会自相矛盾
  return `嗯，${hit}这个我得拦住——${(reason || '它跟你的忌口对不上').replace(/^用户/, '你')}。`;
}

/**
 * 硬要忌口货：用强制性句式点名要一样自己明令忌口的东西。
 *
 * 本地直接回绝，**不进 LLM、也不出卡片**。交给模型的话，它在这种句式上会让步——
 * 实测说过「你既然铁了心要麻辣魔芋爽，那就点呗——8块」，
 * 那是把死命令当成了可以商量的偏好。所以这轮根本不该让它看见这句话。
 *
 * 只拦「点名了具体商品」的情况；光是「我非要吃辣」没有具体货，交给模型正常接话。
 */
export async function handleInsistAvoid(
  userId: string,
  message: string,
  memory: RecalledMemory,
  traceId?: string,
): Promise<Record<string, unknown> | null> {
  if (!INSIST_PATTERN.test(message)) return null;

  const avoid = memoryAvoidTags(memory);
  if (!avoid.length) return null;

  const hit = findLocalSnack(message);
  if (!hit) return null;

  const reason = cardBlocked(hit, memory);
  if (!reason) return null;

  traceLocal(
    traceId,
    '硬要忌口货（强制性句式）',
    `本地回绝，不进 LLM、不出卡片：${hit.name}（${reason}）`,
  );

  return {
    route: 'direct',
    // reason 是内部视角（"用户不吃辣"），换成"你"才像人话
    reply: `知道你铁了心，但${reason.replace(/^用户/, '你')}，我哪敢给你推${hit.name}。换个别的解解馋？`,
    profile: {},
    memory: snapshot(memory),
  };
}

/**
 * 待确认记忆的入口拦截。
 * 上轮问过「你之前说过 X，现在改口了？」且这轮用户给了表态，就本地办结，
 * 不等大脑——这件事的答案是确定的，本地判更快、话术也更可控。
 * @returns 组装好的响应体；返回 null 表示这轮不是对确认的答复
 */
export async function handlePendingConfirm(
  userId: string,
  message: string,
  memory: RecalledMemory,
  traceId?: string,
): Promise<Record<string, unknown> | null> {
  if (!memory.pending_fragments.length) return null;

  const reply = await handlePendingConfirmation(userId, message);
  if (!reply) return null;

  traceLocal(traceId, '待确认记忆收到表态', '本地办结，pending 转正或作废');
  return {
    route: 'direct',
    reply,
    memory: snapshot(await recallMemory(userId)),
    // 告诉前端这次把一条待确认的记忆办结了，侧栏可以据此刷新
    memory_action: 'resolved',
  };
}

/**
 * 推荐分支：跑完「需求 → 检索 → 硬过滤 → 排序 → 合规」整条链路。
 *
 * 编排抛错、或者一件都没选出来，就退到内置库兜底并标 `degraded`。
 * 但**约束不足的追问不兜底**——追问本身就是本轮的产出，
 * 兜底会用一堆卡片把刚问出去的问题盖掉，用户永远看不到提问。
 */
/**
 * 「有出处的口味」：用户原话里抠出来的、长期 profile 里记着的、左侧栏亲手点的。
 *
 * 追问闸（167988）在模糊请求下只认这一份。模型当轮填的 flavor/texture 是推测，
 * 它看见上一句自己写的"配点能嚼着的"就会填 texture=嚼感——那是我们自己的推销稿，
 * 不能当成用户提的要求。没有出处 = 不算约束，该追问还是追问。
 */
function statedTasteOf(input: {
  message: string;
  recentText?: string;
  prefs: Record<string, any>;
  userProfile?: Record<string, any>;
  filters?: Filters;
}): string[] {
  const out = new Set<string>();
  const localThisTurn = extractPrefsFromText(input.message || '');
  const localRecent = extractPrefsFromText(input.recentText || '');
  const candidates = [
    input.filters?.flavor,
    input.userProfile?.flavor,
    input.userProfile?.texture,
    localThisTurn.flavor,
    localThisTurn.texture,
    localRecent.flavor,
    localRecent.texture,
  ];
  for (const v of candidates) {
    if (typeof v === 'string' && v && v !== 'null') out.add(v);
  }
  return [...out];
}

export async function runRecommendation(input: {
  message: string;
  /** 最近几轮用户原话：口味出处比只看当轮一句更全（"我爱吃甜的"可能在前一轮） */
  recentText?: string;
  prefs: Record<string, any>;
  userProfile?: Record<string, any>;
  filters?: Filters;
  inRecommendContext?: boolean;
  exclude: string[];
  userId: string;
  memory: RecalledMemory;
  /** 链路日志 TraceID：只用于打点，不参与任何判定 */
  traceId?: string;
}): Promise<{
  recommendations: any[];
  degraded: boolean;
  workflow?: LocalWorkflowResult;
}> {
  // 长期 profile 只信那四类：场景/情绪这类当轮语境不参与合并（见 sanitizeProfile）
  const trustedProfile = sanitizeProfile(input.userProfile);
  const workflowInput = {
    keyword: [input.prefs.flavor, input.prefs.scene].filter(Boolean).join(' '),
    user_id: input.userId,
    user_profile: { ...trustedProfile, ...input.prefs },
    exclude: input.exclude,
    /**
     * 兜底专用的忌口标签（来自长期记忆）。
     *
     * 主链路 `buildNeed` 里就有 `memoryAvoidTags(memory)`，兜底却只吃 `user_profile.avoid`
     * ——那条是**用户这轮说出口**的忌口，用户这轮没提，兜底就什么都不知道。
     * 结果就是"编排一报错，记着花生过敏的人照样收到花生"。
     * 兜底是最后一道，忌口必须带全。
     */
    avoidTags: memoryAvoidTags(input.memory),
  };

  const provider = (process.env.ORCHESTRATOR || 'local').trim();
  let recommendations: any[] | undefined;
  let degraded = false;
  let workflow: LocalWorkflowResult | undefined;

  try {
    if (provider === 'dify') {
      // Dify：异步，先拿执行 ID 再轮询
      const execId = await triggerDify(workflowInput);
      recommendations = await pollWorkflow(execId, 15000);
    } else if (provider === 'coze') {
      // Coze：同步拿结果
      recommendations = await triggerWorkflow(workflowInput);
    } else {
      // local：本地工作流（需求抽取 → 检索 → 硬过滤 → 排序 → 优惠 → 合规）
      // prefs 是模型**当轮**输出的偏好，userProfile 是前端攒的长期偏好。
      // 只传当轮的话长期偏好就断了——profile 里明晃晃记着"甜味"，
      // 本地工作流看不见，照样问"爱吃甜的还是咸的"。
      // 合并顺序：当轮说了以当轮为准（模型判断优先），空值不许覆盖长期值。
      // 长期那份只取可信字段：场景/情绪不进来（见 pickTrustedProfile）
      const mergedPrefsBoth: Record<string, any> = { ...trustedProfile };
      for (const [k, v] of Object.entries(input.prefs || {})) {
        if (v !== null && v !== undefined && v !== '' && v !== 'null') mergedPrefsBoth[k] = v;
      }
      workflow = runLocalWorkflow({
        message: input.message,
        prefs: mergedPrefsBoth,
        filters: input.filters,
        inRecommendContext: input.inRecommendContext,
        memory: input.memory,
        userId: input.userId,
        exclude: input.exclude,
        statedTaste: statedTasteOf(input),
      });
      recommendations = workflow.recommendations;
    }
  } catch (wfErr: any) {
    // 编排挂了不能让用户空手而归，降级到内置零食库
    console.error(`${tracePrefix()}[Workflow Fallback]`, provider, wfErr?.message);
    traceLocal(
      input.traceId,
      `选品编排抛错（${provider}）`,
      `兜内置库，原因：${wfErr?.message || '未知'}`,
    );
    recommendations = matchLocalFallback(workflowInput);
    degraded = true;
  }

  // 本地工作流一件都没选出来：再兜一次内置库，实在没有才走追问。
  // follow_up 的返回不能兜，理由见上面注释——
  // **除非用户在催货**：都问到"哪几样呢"这份上了，再追问一轮就是把人晾着，
  // "给个不那么贴合的货"比"继续安抚"体面得多。
  if (!recommendations || recommendations.length === 0) {
    const urge = URGE_PATTERN.test(input.message);
    if (workflow?.follow_up && !urge) {
      traceLocal(input.traceId, '约束不足（167988 追问闸）', '本轮不出卡片，先追问偏好');
      return { recommendations: [], degraded: false, workflow };
    }
    if (urge) {
      traceLocal(input.traceId, '用户在催货', '跳过追问，直接给兜底卡片');
    }
    traceLocal(input.traceId, '本地工作流一件都没选出来', '兜内置库并标 degraded');
    recommendations = matchLocalFallback(workflowInput);
    degraded = true;

    // 兜底还是空的：多半是"别重复上轮"把池子掏空了，把 exclude 也放掉再兜一次。
    // 忌口 / 过敏在 user_profile.avoid 里，硬约束始终不动——宁可少给，不能给错。
    if (!recommendations.length) {
      traceLocal(input.traceId, '兜底仍为空', '放掉 exclude 再兜一次（忌口/过敏不松）');
      recommendations = matchLocalFallback({ ...workflowInput, exclude: [] });
      degraded = true;
    }
  }

  return { recommendations, degraded, workflow };
}

/**
 * 无大脑降级：大脑整体不可用（Key 欠费 / 没配 / 两个 provider 都挂）时的整轮兜底。
 *
 * 以前 `callBrain` 抛错 → 入口直接 500，整站打烊。可这条链路里真正不可省的东西
 * 其实都在本地：
 *
 * | 环节 | 谁来做 |
 * |---|---|
 * | 要不要给货 | `allowRecommend`（同一套正则） |
 * | 偏好 / 忌口 | `extractPrefsFromText`（最近 4 轮原文） |
 * | 选哪 3 款 | `runLocalWorkflow` → `runRecommendation` |
 * | 硬过滤 | `violateHardConstraint`（兜底也是同一份口径） |
 * | 商品明细话术 | `composeRecommendReply`（本来就不是模型写的） |
 * | 陪聊接住人 | `pickCompanionReply`（本地话术池） |
 *
 * 模型真正不可替代的只有"把话说得像人"这一件，本地池子差一点，但比 500 强得多。
 *
 * **红线**：忌口 / 过敏一条都不松——`runRecommendation` 内部走的还是 `violateHardConstraint`，
 * 出卡片前另有 `cardBlocked`，出口再过一遍 `guardReply`。降级不等于"过滤松一点"。
 * 用户没开口要东西时照样不给卡片（能出货的口径由 `allowRecommend` 把关，见汇总文档 §3.4）。
 */
export async function runLocalBrain(input: {
  messages: ChatMessage[];
  message: string;
  userProfile?: Record<string, any>;
  filters?: Filters;
  inRecommendContext?: boolean;
  exclude: string[];
  userId: string;
  memory: RecalledMemory;
  /** 链路日志 TraceID：只用于打点，不参与任何判定 */
  traceId?: string;
}): Promise<Record<string, unknown>> {
  logDegraded('大脑不可用 → 本地链路兜底', {
    userId: input.userId,
    msg: input.message,
  });
  traceLocal(
    input.traceId,
    '大脑不可用（Key 欠费/没配/provider 全挂）',
    '转本地链路：意图/选品/硬过滤/话术合成全在本地',
  );

  // 偏好：本地从最近 4 轮原文抠（忌口 / 场景 / 口味），长期 profile 打底，当轮说法优先。
  // 模型不在的这一轮，这就是唯一的偏好来源，抠漏了等于什么都不按用户说的来。
  const localPrefs = mergedPrefs(recentUserText(input.messages));
  // 长期那份只取可信字段：场景/情绪是当轮语境，不该从前端攒的 profile 里复活
  const prefs: Record<string, any> = { ...sanitizeProfile(input.userProfile) };
  for (const [k, v] of Object.entries(localPrefs)) {
    if (v !== null && v !== undefined && v !== '' && v !== 'null') prefs[k] = v;
  }
  // 左侧栏选了口味/预算 = 用户亲手点的约束。模型在的时候会把它们填进 preferences
  // （提示词 §2.3 就是这么要求的），本地链路得自己补上，否则响应的 filters 回显是空的
  if (input.filters?.flavor) prefs.flavor = input.filters.flavor;
  if (input.filters?.budget) prefs.budget = input.filters.budget;

  // 记忆照常同步：用户这时候说"我不吃辣"仍然要记下来，不能因为大脑断了就失忆
  const mem = await syncMemory(input.userId, input.message, prefs, input.memory, input.traceId);
  const freshMemory = await recallMemory(input.userId);
  const base = {
    // 大脑不在的这一轮，prefs 完全来自本地抽取 + 长期 profile，
    // 照样只把"用户原话里有出处"的那部分回给前端（同 pickTrustedProfile 口径）
    profile: cleanProfile(input.message, prefs),
    degraded: true,
    memory: snapshot(freshMemory),
  };

  // 1) 打听具体商品 → 卡片 + 数据里的卖点。文案是数据原句，不会编出不存在的活动或价格。
  // 顺序必须与 callBrain 一致（介绍优先于推荐）："麻辣魔芋爽啥样"这种，
  // mentionsGoods 会把它当成"在要货"，先判推荐就会甩三张卡当回答，答非所问。
  if (INTRODUCE_PATTERN.test(input.message)) {
    const card = findLocalSnack(input.message);
    if (card) {
      const blocked = cardBlocked(card, freshMemory);
      traceLocal(
        input.traceId,
        '本地链路:打听具体商品',
        blocked ? '点名的货撞忌口 → 不给卡，话也换成劝阻' : '给卡片 + 数据里的卖点',
      );
      return {
        route: 'direct',
        reply: blocked
          ? `这个我得拦一下——${blocked.replace(/^用户/, '你')}，${card.name}就不给你推了。换个别的？`
          : guardReply(
              `${card.name}：${card.reason}。${card.price}元一份，要不要来一份？`,
              freshMemory,
            ),
        ...(blocked ? {} : { recommendations: [card] }),
        ...base,
      };
    }
  }

  // 2) 开口要了 → 选品链路本来就不依赖大脑，卡片照出
  if (allowRecommend(input.message, { inRecommendContext: input.inRecommendContext })) {
    const { recommendations, workflow } = await runRecommendation({
      message: input.message,
      recentText: recentUserText(input.messages),
      prefs,
      userProfile: input.userProfile,
      filters: input.filters,
      inRecommendContext: input.inRecommendContext,
      exclude: input.exclude,
      userId: input.userId,
      memory: freshMemory,
      traceId: input.traceId,
    });

    traceLocal(
      input.traceId,
      '本地链路:开口要货',
      `选品 ${recommendations.length} 款${workflow?.follow_up ? '（条件不足，转追问）' : ''}`,
    );

    if (!recommendations.length) {
      return {
        route: 'direct',
        reply: workflow?.follow_up || 'emmm 这个条件有点刁钻，换宽松点我再给你找？',
        awaiting_prefs: !!workflow?.follow_up,
        ...base,
      };
    }

    // 模型那句开头没有了，过渡语改由 pickTransition 按场景/口味现挑（composeRecommendReply 本来就要它）
    const transition = guardReply(pickTransition(prefs, input.filters), freshMemory);
    const reply = workflow
      ? composeRecommendReply({
          transition,
          recommendations: workflow.recommendations,
          message: input.message,
        })
      : transition;

    return {
      route: 'workflow',
      reply: withPendingQuestion(reply, mem.question),
      recommendations,
      filters: { flavor: prefs.flavor, budget: prefs.budget },
      ...base,
    };
  }

  // 3) 其余一律陪聊：用户没点头，降级也不是"自动推荐"的理由
  traceLocal(input.traceId, '本地链路:陪聊', '没开口要 → 本地话术池接住，不出卡片');
  const reply = withPendingQuestion(
    pickCompanionReply(input.userId, prefs, input.message),
    mem.question,
  );
  return {
    route: 'direct',
    reply,
    ...(/[?？]/.test(reply) ? { lead_in: true } : {}),
    ...base,
  };
}

/**
 * 待确认记忆的答复处理。
 * 只有干脆的表态（是 / 不是）才拦；说了别的一律放行，让大脑正常接话。
 * @returns 给用户的回复；返回 null 表示这轮不是对确认的答复
 */
/**
 * 用户标识的清洗 + 兜底。
 *
 * 两件事：
 *
 * 1. **防污染**：userId 会直接当成 `memory.json` 的对象 key，
 *    `__proto__` / `constructor` 这类能污染原型，斜杠和点则可能被拼进路径。
 *    统一收敛到安全字符集。
 * 2. **防串号**：以前所有没带 ID 的请求都落在 `anonymous` 这同一个桶里，
 *    张三说的「花生过敏」会被下一个陌生人继承。现在没带 ID 就发一个一次性 guest id，
 *    各用各的桶——宁可刷新后记忆不延续，也不能让陌生人共享偏好。
 *
 * 正常路径下前端 `ensureUserId()` 会生成并持久化 UUID，走不到 guest 这个分支；
 * 它只兜住隐私模式等写不了 localStorage 的情况。
 */
/**
 * 标识清洗的实现搬到了 `lib/auth/user-id.ts`（V2.0 起鉴权层也要用，而 handlers
 * 会把整条 LLM 链路拖进 auth 路由）。这里只做 re-export，调用方不用改。
 */
export { normalizeUserId } from '@/lib/auth/user-id';

// ─── 长期记忆 ────────────────────────────────────
// 记忆意图的规则表达式见 lib/rules/patterns.ts。

export function detectMemoryIntent(text: string): 'query' | 'clear' | 'delete' | null {
  if (MEMORY_QUERY_PATTERN.test(text)) return 'query';
  // 全清必须先于单条删除判断，否则"全都忘掉"会被当成删某一条
  if (MEMORY_CLEAR_PATTERN.test(text)) return 'clear';
  if (MEMORY_DELETE_PATTERN.test(text)) return 'delete';
  return null;
}

/**
 * 从"忘了我说过不吃辣"里抠出要删的关键词。
 *
 * 侧栏 ✕ 走的是同一条路：那里发来的是「忘掉辣味」「忘掉10元内」这类短语，
 * 所以 `MEMORY_KEYWORD_PATTERN` 里除了忌口，还得认口味 / 预算 / 口感，
 * 抠不出来后端就没法删——界面标签没了、服务端还记着，下一轮又带回来。
 */
export function extractMemoryKeyword(text: string): string {
  // 先认白名单里的偏好对象（忌口 / 口味 / 口感 / 预算档）。
  // 「忘掉我喜欢辣味」在这里就能落到「辣味」，不会把动词「喜欢」一起带出去。
  const hit = text.match(MEMORY_KEYWORD_PATTERN);
  if (hit) return hit[0];

  // 白名单没认出来（"忘掉我喜欢薯片"）才走动词兜底，且只取动词后面的宾语。
  // 正则捕获从动词后开始，"我喜欢的薯片"会捕到"的薯片"——开头的"的"必须洗掉，
  // 否则 deleteMemory 拿"的薯片"去 includes 匹配"薯片"永远落空，
  // 用户明明说了要忘、系统却回"你要我忘掉哪条"
  const like = text.match(MEMORY_LIKE_PATTERN);
  return like?.[1]?.trim().replace(/^的/, '') || '';
}

/**
 * 把待确认的提问挂在回复后面。
 * 问句本来是接在对话里的，塞进 reply 末尾而不是另起一条消息，
 * 是因为它就是这轮回复的一部分——前端也只有一条 bubbles。
 */
export function withPendingQuestion(reply: string, question?: string | null): string {
  if (!question) return reply;
  return `${reply}\n${question}`;
}

/** 对待确认记忆的肯定答复。只在有 pending 时才会走到这里的判断，不会误伤日常闲聊 */
// 待确认答复：见 lib/rules/patterns.ts 的 PENDING_YES_PATTERN / PENDING_NO_PATTERN

/**
 * 这句答复是不是"带条件的长答案"。
 *
 * 待确认的提问是个是非题（"你之前说过 X，现在改口了？"），所以只有干脆的是/不是才本地办结。
 * 像「不是不吃辣，是微辣可以接受」这种，开头就命中"不是"，按否定拦下来，
 * 就把"微辣可以"这条新信息整个丢掉了。带转折或限定词的、以及明显是长句的，
 * 一律放行给大脑——它接得住，还能顺手把新偏好写回记忆。
 */
export function looksQualifiedAnswer(text: string): boolean {
  return text.length > 5 || QUALIFIED_ANSWER_PATTERN.test(text);
}

/**
 * 接住用户对「你要改口吗」的答复。
 * 只有明确表态（是 / 不是）才拦；说了别的一律放行，让大脑正常接话。
 *
 * **否定开头的长句必须本地办结**（2026-11-05 外审 P0）：以前只有
 * "否认+撤回"（"不是，我开玩笑的"）这类短例外拦得住，其余见长句就放行大脑——
 * 「不是，我是说微辣可以接受。」被放行后大脑够不着 pending 状态，
 * 确认永远挂着，后续每轮都被追问，等于死循环。
 * 按"否"办结是保守解：不改口（旧偏好保留），用户真想改成"微辣"
 * 会自己再说一遍，大脑下一轮接得住；宁可少办，不能瞎猜着改忌口。
 * @returns 给用户的回复；返回 null 表示这轮不是对确认的答复
 */
export async function handlePendingConfirmation(
  userId: string,
  message: string,
): Promise<string | null> {
  const text = message.trim();
  // PENDING_NO_PATTERN 是 ^(锚定) 的：只有**以否定开头**才算否认——
  // 「其实我觉得还好吧」这种"不是"不在句首的不会被误拦
  const noHit = PENDING_NO_PATTERN.test(text);
  // 带条件的长答案不自己判，交给大脑（见 looksQualifiedAnswer）；
  // 否定开头的例外见上：办结挂着的确认，比把用户晾在追问里重要
  if (looksQualifiedAnswer(text) && !noHit) return null;

  const yes = PENDING_YES_PATTERN.test(text);
  const no = !yes && noHit;
  if (!yes && !no) return null;

  const r = await resolvePending(userId, yes);
  if (!r) return null;

  // pending 的 content 形如"不吃辣=不吃辣"、"辣=喜欢辣"，取等号后面那段才是人话
  const shown = r.content.includes('=') ? r.content.split('=').pop() || r.content : r.content;

  return yes
    ? `行，那以后按新的来——${shown}。旧的那条我就不提了`
    : `好嘞，刚才当我没问，${shown} 不往你身上记，还按原来的来`;
}

export function renderMemoryReply(memory: RecalledMemory): string {
  const lines = [
    ...memory.core_profile.map((t) => `· ${t}`),
    ...memory.summary_memory.map((t) => `· ${t}`),
    ...memory.active_fragments.map((t) => `· ${t}`),
  ];
  if (!lines.length) {
    return '还没记下啥。你说过我就记着——像"我不吃辣"这种，我以后都自动避开';
  }
  return `记着这些：\n${lines.join('\n')}\n还有要我记的吗？`;
}

/**
 * 本轮能写成长期记忆的事实。
 * 只记明确、长期的表达：忌口过敏一定记；"我平时都喜欢吃辣"这种带长期副词的才记口味，
 * 一次性的"来点辣的"不能污染长期偏好（工作流规则：不要把一次性需求推断成偏好）。
 */
/** 口味 → 在记忆里认冲突用的那个字（"不吃辣" 里的"辣"） */
const TASTE_AXIS: Record<string, string> = {
  辣味: '辣',
  甜味: '甜',
  咸味: '咸',
  酸味: '酸',
  清淡: '清淡',
};

/**
 * 从忌口原话里抠出口味轴（"不吃辣" → "辣"）。
 *
 * 同维度互斥的钥匙：忌口落到轴 X 上，X 轴上的旧口味偏好就该作废
 * （「不想吃辣了」之后，"口味·辣味"不能继续挂着）。
 * 过敏原（花生/坚果/海鲜/乳制品）不含任何轴字 → 返回空串，
 * 调用方据此跳过，真实过敏记录永远不会被互斥逻辑碰到。
 */
export function avoidAxisOf(avoidText: string): string {
  const t = avoidText || '';
  for (const axis of Object.values(TASTE_AXIS)) {
    if (t.includes(axis)) return axis;
  }
  return '';
}

/**
 * 本轮能写成长期记忆的事实。
 * 只记明确、长期的表达：忌口过敏一定记；"我平时都喜欢吃辣"这种带长期副词的才记口味，
 * 一次性的"来点辣的"不能污染长期偏好（工作流规则：不要把一次性需求推断成偏好）。
 *
 * 唯一的例外是**撞上忌口记忆**：记着"不吃辣"的人这轮开口要辣，
 * 这是一次性需求还是改口，本地判不了——必须挂待确认问本人（工作流规则 7）。
 * 以前这里只认"喜欢/爱吃"且不认 prefs.flavor，结果"今天想辣的发泄"一句事实都抽不出来，
 * 冲突感知整个是瞎的：pending 不生成、提问不问、用户改口永远没法生效。
 *
 * 2026-11-02 又修一次门槛：忌口事实只认本轮原话（prefs.avoid 可能是最近几轮的回声）；
 * 冲突分支也不再看 `!out.length` 了——它把"我平时都喜欢吃辣的"这种真正的改口挡在门外，
 * 详见函数内注释。
 */
export function factsFromMessage(
  message: string,
  prefs: Record<string, any>,
  memory?: RecalledMemory,
): MemoryFact[] {
  const out: MemoryFact[] = [];

  // 忌口必须是**本轮原话**说的，才算一条新事实。
  // prefs.avoid 常常只是回声：mergedPrefs 抽的是最近 4 轮用户发言（recentUserText），
  // 两轮前的"我不吃辣"会被重新抽出来。拿回声当新事实有两个坏处：
  //   ① 它命中 decideMemoryAction 里那条"过敏忌口"早退分支（直接 return new_memory），
  //      冲突判定压根没机会跑；
  //   ② 等于每轮都在重写一条用户这轮没提过的忌口。
  // 「这轮原话抽得出忌口吗」交给 extractPrefsFromText 答——不另立一份拒绝词表。
  const statedAvoid = extractPrefsFromText(message).avoid;
  const avoid = (prefs.avoid || '').trim();
  /**
   * 对上一轮推荐的质疑（"这些也不辣"）不是忌口声明。
   *
   * 实测事故：用户嫌推的不够辣，说了句"这些也不辣"，被抽成 `avoid='不吃辣'`
   * 记进长期记忆；下一轮再要辣，`buildNeed` 把"辣味"同时塞进 `taste_preference`
   * 和 `avoid_tags`，硬过滤把辣款全踢光，回一句"这个条件有点刁钻"。
   * 越抱怨越吃不到，闭环彻底反了。
   */
  const complainingAboutPicks =
    PICK_REFERENCE_PATTERN.test(message) && SPICY_DENIAL_PATTERN.test(message);
  // "都"必须跟"吃/喝/喜欢"才算长期语气："这些都不辣"里的"都"是范围副词，
  // 把它当长期偏好信号，抱怨句就又能混进记忆
  const longTerm = /一直|平时|一般|通常|以后|从来|总是|都(?:喜欢|爱|吃|喝)/.test(message);

  // 纯评价句（"这些也不辣"）整轮都不写记忆：它评价的是上一轮的货，不是用户的长期偏好。
  // 只排掉忌口是不够的——prefs 里带着上一轮的 flavor 回声，会顺势判成"改口要辣"，
  // 然后弹出"你之前说过不吃辣，现在改口？"这种驴唇不对马嘴的确认。
  // 带长期副词的（"这些也不辣，我平时都吃重辣"）例外，那是真在说偏好。
  if (complainingAboutPicks && !longTerm) return out;

  if (avoid && avoid !== 'null' && statedAvoid && !complainingAboutPicks) {
    out.push({
      category: '过敏忌口',
      key: avoid,
      value: avoid,
      polarity: '拒绝',
      confidence: 0.9,
    });
  }

  const like = message.match(/(?:喜欢|爱吃|爱|偏好|钟爱)([^，。！？\s]{1,6})/);
  if (longTerm && like && like[1]) {
    out.push({
      category: '口味',
      key: like[1].trim(),
      value: `喜欢${like[1].trim()}`,
      polarity: '喜欢',
      confidence: 0.6,
    });
  }

  // 本轮开口要的口味撞上长期记住的忌口 → 冲突事实，交 decideMemoryAction 挂待确认。
  // **过敏不在内**：过敏是死命令，没有"改口"这个选项，绝不能拿来问用户要不要作废
  const want = (prefs.flavor || '').trim();
  const axis = want ? TASTE_AXIS[want] : '';
  // 门槛不能是 `!out.length`：out 里那条口味事实（"我平时都喜欢…"抽出来的）
  // 跟"这轮是不是改口"毫无关系——拿它当门槛，改口永远问不出口（实测事故：
  // 记着"不吃辣"的人说"我平时都喜欢吃辣的"，既没挂 pending，
  // 又把"喜欢吃辣的"当新记忆写进去，跟忌口并存）。
  // 真正该拦的是**用户这轮亲口重申了同一个忌口**：说"我不吃辣"不能被读成想改口要辣。
  const restatedAvoid = !!statedAvoid && statedAvoid.includes(axis);
  if (axis && memory && !restatedAvoid) {
    const pool = [
      ...(memory.core_profile || []),
      ...(memory.summary_memory || []),
      ...(memory.active_fragments || []),
    ];
    const clash = pool.find((t) => t.includes(axis) && /不吃|不要|忌|戒|不碰|不想吃|不嗜/.test(t));
    if (clash) {
      // 冲突是本轮**最重要**的一条事实：decideMemoryAction 只看 facts[0]
      // （拿它去记忆里对、也拿它写 pending），所以必须排到最前面去。
      // 排后面的话，决策看的是"喜欢吃辣的"那条——它在记忆里对不上"不吃辣"，
      // 会被当成新记忆直接写进去：问都不问就把忌口改了。
      out.unshift({
        category: '口味',
        // key 用轴上的那个字：matchExisting 靠它去记忆里对上"不吃辣"这条
        key: axis,
        value: `想吃${axis}`,
        polarity: '喜欢',
        confidence: 0.5,
      });
    }
  }

  return out;
}

/**
 * 回复末尾是一个往零食上带的问题 = 在铺垫（"要不要我给你配点能嚼着的？""你平时会备点吃的吗"）。
 * 大脑自己在陪聊里抛出这种钩子时（不是走降级路径）也得接住，否则钩子落到地上没人捡。
 */
// 铺垫钩子：见 lib/rules/patterns.ts 的 LEAD_IN_REPLY_PATTERN

/**
 * 记忆同步：写新偏好 / 更新一致项 / 待确认的挂 pending / 要求删除的软删除。
 * 冲突没确认前绝不覆盖旧偏好——工作流规则 7 明确要求。
 */
export async function syncMemory(
  userId: string,
  message: string,
  prefs: Record<string, any>,
  memory: RecalledMemory,
  traceId?: string,
): Promise<{ question: string | null }> {
  // memory 一并传进去：撞忌口的冲突事实要靠它才认得出来（见 factsFromMessage）
  const facts = factsFromMessage(message, prefs, memory);
  if (!facts.length) return { question: null };

  const d = decideMemoryAction(
    facts,
    memory,
    MEMORY_DELETE_PATTERN.test(message) ? '删除记忆' : '表达偏好',
  );
  // 只有"本地替用户做了个判断"才值得打点：改口要挂待确认、或者本轮要求删除。
  // 常规写入（new_memory / consistent_update）每轮都在发生，打进去就等于没有信号——
  // [Local] 的定义是"拦截/兜底"，不是"这轮动了记忆"。
  if (d.decision === 'confirmation_required' || d.decision === 'delete_required') {
    traceLocal(
      traceId,
      `记忆冲突:${facts.map((f) => f.category).join('/')}`,
      d.decision === 'delete_required'
        ? '本轮要求删除，软删旧偏好'
        : '改口撞上旧偏好 → 挂 pending 并向本人追问',
    );
  }

  if (d.decision === 'delete_required') {
    await deleteMemory(userId, d.matched_memory.keyword);
    return { question: null };
  }

  if (d.decision === 'new_memory' || d.decision === 'consistent_update') {
    const fact = facts[0];
    await writeMemory(userId, [
      {
        layer: d.write_layer === 'none' ? 'core_profile' : d.write_layer,
        keyword: d.matched_memory.keyword || fact.key,
        content: d.matched_memory.content || `${fact.key}=${fact.value}`,
        category: fact.category,
        polarity: fact.polarity,
        status: 'active',
      },
    ]);
    // 同维度互斥（2026-11-03）：忌口落库的同一瞬间，把这个口味轴上的旧偏好作废。
    // 以前只写不管——「不想吃辣了，想吃甜的」之后口味·辣味还挂着，
    // 侧栏两条对立标签并排，下一轮推荐同时吃到两个相反的约束。
    // 注意方向：忌口 → 口味是用户本轮明说的作废（直接办）；
    // 口味 → 忌口绝不能走这里（过敏是死命令，改口必须走 pending 确认）。
    if (fact.polarity === '拒绝') {
      const axis = avoidAxisOf(`${fact.key}${fact.value}`);
      const n = await supersedeTasteConflicts(userId, axis);
      if (n > 0) traceLocal(traceId, `同维度互斥:${axis}`, `忌口写入 → 作废 ${n} 条旧口味偏好`);
    }
    return { question: null };
  }

  if (d.decision === 'confirmation_required') {
    const fact = facts[0];
    await writeMemory(userId, [
      {
        layer: 'fragment_memory',
        keyword: `待确认_${fact.key}`,
        content: `${fact.key}=${fact.value}`,
        category: fact.category,
        polarity: fact.polarity,
        status: 'pending',
      },
    ]);
    // 挂上待确认还不够——这句提问必须由我们问出去，用户才有机会答，
    // 否则 pending 永远没人认领，"改口"这条路径等于废的。由 handlePendingConfirmation 收尾。
    return { question: d.confirmationquestion || null };
  }

  return { question: null };
}

/**
 * 场景抱怨的找补（2026-11-03）：用户说「场景呢？刚说了」，说明我们漏接了。
 * 模型在陪聊支路通常会自己找补，但它也可能只机械地重新提问。
 * 这里在回给用户前垫一句认错——前提是模型自己没认（已经说了"忘了/抱歉"就不重复垫）。
 * 两个 AI 入口都要接（口径分叉的亏吃过不止一次）。
 */
export function apologizeForMissedScene(message: string, reply: string): string {
  if (!SCENE_COMPLAINT_PATTERN.test(message || '')) return reply;
  if (!reply) return reply;
  if (/我的锅|抱歉|对不起|忘了问|是我没(接住|问)/.test(reply)) return reply;
  return `我的锅，忘了问你在哪儿吃——${reply}`;
}

/**
 * 推荐前的过渡语：按场景 / 情绪挑文案池，随机抽一条。
 * 每次都"来了——"会像自动售货机；场景贴合的过渡语（"吹着海风配点脆的——"）才像朋友。
 */
export function pickTransition(prefs: Record<string, any>, filters?: Filters): string {
  // 左侧栏明确选了口味，以它为先
  if (filters?.flavor) return `好，按你选的${filters.flavor}来——`;

  const pools: Record<string, string[]> = {
    海边: ['吹着海风配点脆的，绝了——', '海边就得带点轻盈的——', '看海标配，清爽不腻口——'],
    户外: ['出去玩就得带点扛饿的——', '背上包，这几样管饱——', '野餐清单，照着带就行——'],
    看剧: ['追剧标配，直接抄作业——', '剧还没开，先把粮备上——', '看剧没这个等于白看——'],
    加班: ['熬着也得垫点——', '打工人的续航口粮——', '深夜续命，安排——'],
    办公室: ['办公室抽屉常备款——', '摸鱼零嘴，安排——'],
    烦: ['行，那歇会儿。来个能泄愤的——', '憋屈就该辣一顿——'],
    生气: ['行，那歇会儿。来个能泄愤的——', '憋屈就该辣一顿——'],
    难过: ['抱抱你。整点甜的缓一缓——', '甜的东西最治这一套——'],
    丧: ['抱抱你。整点甜的缓一缓——', '甜的东西最治这一套——'],
    无聊: ['那给你找点新鲜的——'],
    开心: ['开心就整点好的——', '值得庆祝一下，挑吧——'],
  };

  const pool = (prefs.scene && pools[prefs.scene]) ||
    (prefs.emotion && pools[prefs.emotion]) || ['来了——', '安排——', '这几个挑挑——'];

  // 白天不许提"深夜/熬夜/通宵"：提示词第十节对人设是这么要求的（见汇总文档 §7.1），
  // 本地话术池也得照做——上午甩一句"深夜续命，安排——"，读着像对面坐了个没睡醒的人。
  const usable = timeContext().isNight ? pool : pool.filter((t: string) => !NIGHT_PATTERN.test(t));

  return (
    usable[Math.floor(Math.random() * usable.length)] ??
    pool[Math.floor(Math.random() * pool.length)]
  );
}
