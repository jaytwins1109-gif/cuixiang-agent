// app/api/ai/route.ts
// 前端入口（普通一次性响应）：所有 API Key 都只在服务端。
//
// 这个文件只做四件事：解析 → 调大脑 → 分流 → 返回。
// 记忆意图、待确认闭环、推荐选品都在 lib/chat/handlers.ts。
// 需要逐字上屏的流式版本见 app/api/ai/stream/route.ts，两条路共用同一套 handler。
//
// 链路日志见 lib/chat/trace.ts：一次请求一个 TraceID，
// [Request] / [Brain] / [Local] / [Response] 四个打点，scripts/capture-log.mjs 靠它们归档。

import { NextRequest, NextResponse } from 'next/server';
import { LEAD_IN_REPLY_PATTERN } from '@/lib/rules/patterns';
import {
  callBrain,
  mergedPrefs,
  recentUserText,
  UNCLEAR_REPLY,
  allowRecommend,
  upgradeForUrge,
  replyForUpgrade,
  logDegraded,
  type ChatMessage,
  type Filters,
} from '@/lib/llm';
import { findLocalSnack } from '@/lib/llm/orchestrator';
import { composeRecommendReply, sanitizeTransition } from '@/lib/llm/reply-composer';
import { recallMemory, renderMemoryForPrompt } from '@/lib/memory/store';
import { GUEST_COOKIE, GUEST_MAX_AGE, cookieString } from '@/lib/auth/jwt';
import { resolveIdentity } from '@/lib/auth/identity';
import { checkRateLimit } from '@/lib/auth/rate-limit';
import {
  newTraceId,
  traceRequest,
  traceBrain,
  traceLocal,
  traceResponse,
  traceError,
  runWithTrace,
} from '@/lib/chat/trace';
import {
  handleMemoryIntent,
  handlePendingConfirm,
  handleInsistAvoid,
  cardBlocked,
  guardReply,
  stripFakeList,
  runRecommendation,
  runLocalBrain,
  syncMemory,
  cleanProfile,
  apologizeForMissedScene,
  snapshot,
  pickTransition,
  withPendingQuestion,
} from '@/lib/chat/handlers';

export const runtime = 'nodejs';

interface AiRequestBody {
  message: string;
  history?: ChatMessage[];
  /** 左侧口味栏当前选中的约束（硬性过滤） */
  filters?: Filters;
  /** 上一轮是不是刚推过卡片（决定「太贵了」「换一个」这类算不算还要推荐） */
  inRecommendContext?: boolean;
  /** 上一轮推过的商品名，用来在「换一个」时避开，避免甩同样三款 */
  lastPicks?: string[];
  userProfile?: Record<string, any>;
  // 没有 userId：身份只认 cx_token cookie 与 x-guest-id 头。
  // 旧客户端若还在 body 里塞，会被原样忽略（读它等于允许自报身份、读别人的记忆）。
}

export async function POST(req: NextRequest) {
  // TraceID 在入口就生成：这一轮所有打点（含 handler 内部的 [Local]）都靠它串起来
  const traceId = newTraceId();
  try {
    const body = (await req.json()) as AiRequestBody;
    if (!body?.message || typeof body.message !== 'string' || !body.message.trim()) {
      return NextResponse.json({ error: '说点什么呀' }, { status: 400 });
    }

    // 身份：登录态 cookie 优先，其次 x-guest-id 头。**不认 body.userId**（V2.1 已删）。
    // 顺序与判定逻辑只在 lib/auth/identity.ts 一处，流式入口共用同一份。
    const identity = await resolveIdentity(req);
    const userId = identity.userId;

    // 限流：按 userId 计（不按 IP，宿舍/公司共用一个出口，按 IP 会误伤旁人）
    const limited = checkRateLimit(userId);
    if (!limited.ok) {
      const res = NextResponse.json(
        { error: '慢点，一口气说太多了，缓一下再聊', retry_after: limited.retryAfter },
        { status: 429 },
      );
      if (identity.guestTicket) {
        res.headers.append(
          'Set-Cookie',
          cookieString(GUEST_COOKIE, identity.guestTicket, GUEST_MAX_AGE),
        );
      }
      return res;
    }

    traceRequest(traceId, {
      message: body.message,
      entry: '/api/ai',
      userId,
      identity: identity.source,
    });

    // 整轮包进 trace 上下文：lib/llm 深处的报错（provider 挂了、超时重试、降级）
    // 不用把 traceId 当参数一层层传下去，直接问上下文要就行
    const payload = await runWithTrace(traceId, () => handleTurn({ traceId, body, userId }));

    // [Response] 只有一个出口：所有分支的响应体都从这里出去，不会漏打
    traceResponse(traceId, payload.reply, cardCountOf(payload), {
      degraded: !!payload.degraded,
      route: typeof payload.route === 'string' ? payload.route : '-',
      awaiting: !!payload.awaiting_prefs,
    });
    // trace_id 回给调用方：界面上看到的那一句，能直接对上日志里那几行
    const res = NextResponse.json({ ...payload, trace_id: traceId });
    // 游客第一次来（或换了 id）时补发签名票据：/api/auth/upgrade 要靠它证明"这个 id 是我"
    if (identity.guestTicket) {
      res.headers.append(
        'Set-Cookie',
        cookieString(GUEST_COOKIE, identity.guestTicket, GUEST_MAX_AGE),
      );
    }
    return res;
  } catch (err: any) {
    // 走 traceError：stderr 里也要有 TraceID，重启后翻 dev.err.log 才对得上人
    traceError('AI Route Error', err, traceId);
    return NextResponse.json(
      { error: err?.message || '服务出了点问题', trace_id: traceId },
      { status: 500 },
    );
  }
}

/** 响应体里出了几张卡：[Response] 打点只关心这个数字 */
function cardCountOf(payload: Record<string, unknown>): number {
  return Array.isArray(payload.recommendations) ? payload.recommendations.length : 0;
}

/**
 * 一轮对话的处理主体：解析 → 本地拦截 → 大脑 → 分流 → 组装响应体。
 *
 * 为什么从 POST 里抽出来，而不是各分支直接 return NextResponse：
 * 早退分支（记忆问答 / 待确认 / 硬要忌口货 / 无大脑降级）也得打 [Response]。
 * 分散着 return，迟早漏打一条——日志缺一段，排查就断在这儿。
 */
async function handleTurn({
  traceId,
  body,
  userId,
}: {
  traceId: string;
  body: AiRequestBody;
  userId: string;
}): Promise<Record<string, unknown>> {
  // 1. 长期记忆（每轮都召回，后面的推荐要按它做硬过滤）
  const memory = await recallMemory(userId);
  const messages: ChatMessage[] = [
    ...(body.history || []).slice(-10),
    { role: 'user' as const, content: body.message },
  ];

  // 2. 记忆的查询 / 删除 / 清空：本地就能办结，不必惊动大脑（省一次往返）
  const memRes = await handleMemoryIntent(userId, body.message, memory, traceId);
  if (memRes) return memRes;

  // 2.5 待确认闭环：上轮抛过「你之前说过 X，现在改口了？」，这轮给答复就本地办结
  const pendingRes = await handlePendingConfirm(userId, body.message, memory, traceId);
  if (pendingRes) return pendingRes;

  // 2.6 硬要忌口货：本地直接回绝。
  // 交给模型的话它会让步（实测说过"那就点呗——8块"），这轮不该让它看见这句话
  const insistRes = await handleInsistAvoid(userId, body.message, memory, traceId);
  if (insistRes) return insistRes;

  // 3. 大脑：判断意图 + 抽偏好 + 说人话
  const brainCtx = {
    inRecommendContext: body.inRecommendContext,
    memoryText: renderMemoryForPrompt(memory),
  };
  const brainRes = await callBrain(
    messages,
    body.filters,
    brainCtx,
    // 兜底话术防重要用，也方便日志里按人追
    userId,
  );
  traceBrain(
    traceId,
    brainRes.unavailable ? 'unavailable（大脑不可用）' : brainRes.intent,
    brainRes.preferences,
  );

  // 大脑整体不可用（Key 欠费 / 没配 / 两个 provider 都挂）→ 本地链路兜底。
  // 意图、选品、硬过滤、话术合成本来就都在本地，不该因为 Key 断供就整店打烊
  if (brainRes.unavailable) {
    return await runLocalBrain({
      messages,
      message: body.message,
      userProfile: body.userProfile,
      filters: body.filters,
      inRecommendContext: body.inRecommendContext,
      exclude: Array.isArray(body.lastPicks) ? body.lastPicks : [],
      userId,
      memory,
      traceId,
    });
  }

  // 判了 introduce 却从用户原话里抠不出商品名 → 先看用户是不是在要货。
  // 否则出口只能吐"emmm 这个我还不太了解"——那是把我们的解析失败甩给用户。
  // 实测（2026-11-03）：模型偶发返回空内容后重试判成 introduce，
  // 「我不想吃辣，来点吃的」就被降成陪聊，回一句"我没太听懂"。
  if (brainRes.intent === 'introduce') {
    const hit = findLocalSnack(brainRes.preferences?.product_name) || findLocalSnack(body.message);
    if (!hit) {
      if (allowRecommend(body.message, brainCtx)) {
        traceLocal(traceId, 'introduce 抠不出商品名', '用户在要货 → 转推荐，不降陪聊');
        brainRes.intent = 'recommend';
      } else {
        logDegraded('introduce 但抠不出商品名，降陪聊', {
          userId,
          msg: body.message,
        });
        traceLocal(traceId, 'introduce 抠不出商品名', '降回陪聊，不吐自曝失败的话术');
        brainRes.intent = 'chat';
      }
    }
  }

  // 与 SSE 同源的两条意图纠偏。普通接口历史上一直缺这两段，
  // 于是模型偶尔把"来点吃的""再来一轮，不要辣的"判成聊天，这轮就一张卡都没有，
  // 用户明明在要东西。两条路的纠偏口径必须一致，别再各写一份。
  const urged = upgradeForUrge(brainRes.intent, body.message);
  if (urged !== brainRes.intent) {
    traceLocal(traceId, '意图纠偏:用户在催货', `${brainRes.intent} → ${urged}`);
    brainRes.intent = urged;
    // 模型那句是按陪聊写的（"说啥？没头没尾"），留着会变成"嘴上接不住、下面甩三张卡"
    brainRes.reply = undefined;
  }
  if (brainRes.intent === 'chat' && allowRecommend(body.message, brainCtx)) {
    traceLocal(traceId, '意图纠偏:用户在要东西', 'chat → recommend');
    brainRes.intent = 'recommend';
    brainRes.reply = replyForUpgrade(brainRes.reply);
    logDegraded('判 chat 但用户在要东西，升级推荐', {
      userId,
      msg: body.message,
    });
  }

  // 3. 分流：陪聊 / 介绍 / 推荐
  //
  // 陪聊这一支（`brainRes.chatOnly`）走的是**纯陪聊链路**：
  // callBrain 里由 routeIntent 判定后走的 callChatOnly——不套 json_object、
  // 提示词只有人设 + 长期记忆 + 时间、温度 0.75，出口只守红线（内部信息 / 脏话 / 空头许诺）。
  // 推荐 / 介绍仍旧是完整业务提示词 + json_object 的严格结构化链路。
  // 下面这一段两条链路共用：卡片和忌口相关的硬闸一条都不能少。
  if (brainRes.intent === 'chat') {
    // 偏好必须本地抠 + 模型填合过再写记忆：模型在陪聊轮常把 preferences 留空，
    // 只用它填的那份，"今天想辣的发泄"这种就抽不出 flavor，
    // 撞忌口的冲突根本认不出来，改口确认这条链路一直是断的
    const mem = await syncMemory(
      userId,
      body.message,
      mergedPrefs(recentUserText(messages), brainRes.preferences),
      memory,
      traceId,
    );
    // 陪聊轮没有卡片，模型却自己编了"1. XX｜X元"的清单 → 截掉，只留安抚语
    const stripped = stripFakeList(brainRes.reply?.trim() || '', traceId);
    const chatReply = guardReply(
      apologizeForMissedScene(
        body.message,
        withPendingQuestion(stripped || UNCLEAR_REPLY, mem.question),
      ),
      memory,
      traceId,
    );
    // 在往零食方向抛钩子 = 铺垫中。前端把它算进推荐上下文，用户下一轮点头就直接接上推荐，
    // 否则"铺垫出去、用户答应了、我们继续陪聊"会把人晾在那儿。
    const leadIn = brainRes.leadIn || LEAD_IN_REPLY_PATTERN.test(chatReply);
    return {
      route: 'direct',
      reply: chatReply,
      profile: cleanProfile(body.message, brainRes.preferences),
      ...(leadIn ? { lead_in: true } : {}),
      memory: snapshot(await recallMemory(userId)),
    };
  }

  // 同上：推荐 / 介绍这两条支路也得拿合并后的偏好去写记忆，口径不能分叉
  const prefs = mergedPrefs(recentUserText(messages), brainRes.preferences);
  const mem = await syncMemory(userId, body.message, prefs, memory, traceId);
  // 本轮可能刚写入/更新了记忆，重新召回一次，后面推荐和回给前端的都按最新的来
  const freshMemory = await recallMemory(userId);

  // 介绍：文案 + 能配上就挂一张卡片。
  // product_name 偶尔会被模型漏填，这时拿用户原话再找一次（"火鸡面啥样"里就有名字）
  if (brainRes.intent === 'introduce') {
    const card = findLocalSnack(prefs.product_name) || findLocalSnack(body.message);
    // 点名的货撞上忌口 / 过敏 → 卡片不给。
    // 模型这时候多半在顺着用户说，所以话也一起换成劝阻的
    const blocked = cardBlocked(card, freshMemory, traceId);
    return {
      route: 'direct',
      reply: blocked
        ? `这个我得拦一下——${blocked.replace(/^用户/, '你')}，${card?.name}就不给你推了。换个别的？`
        : guardReply(brainRes.reply?.trim() || 'emmm 这个我还不太了解', freshMemory, traceId),
      profile: cleanProfile(body.message, prefs),
      ...(card && !blocked ? { recommendations: [card] } : {}),
      memory: snapshot(freshMemory),
    };
  }

  // 推荐：跑工作流，出问题就兜内置库
  const { recommendations, degraded, workflow } = await runRecommendation({
    message: body.message,
    recentText: recentUserText(messages),
    prefs,
    userProfile: body.userProfile,
    filters: body.filters,
    inRecommendContext: body.inRecommendContext,
    exclude: Array.isArray(body.lastPicks) ? body.lastPicks : [],
    userId,
    memory: freshMemory,
    traceId,
  });

  if (!recommendations.length) {
    return {
      route: 'direct',
      reply: workflow?.follow_up || 'emmm 这个条件有点刁钻，换宽松点我再给你找？',
      // 追问偏好也算推荐进行中：下一轮用户报偏好要按"回答推荐追问"处理
      awaiting_prefs: !!workflow?.follow_up,
      profile: cleanProfile(body.message, prefs),
      memory: snapshot(freshMemory),
    };
  }

  // 逐款明细（名字/为什么/活动/到手价/注意事项）由本地按真实选品结果合成，
  // 大脑只负责开头那句接住人的话——让它复述商品必错：价、活动、库存都以数据为准。
  // 模型的开头也可能嘴上提忌口货（卡片是干净的），出口前再扫一遍
  // 模型那句开头先过清洗：自己写的"1. XX｜X元"清单、以及"你先说句随便"这类
  // 把内部逻辑漏出来的句子一律切掉；切光了才落本地过渡语池
  const transition = guardReply(
    sanitizeTransition(brainRes.reply) || pickTransition(prefs, body.filters),
    freshMemory,
    traceId,
  );
  const reply = workflow
    ? composeRecommendReply({
        transition,
        recommendations: workflow.recommendations,
        message: body.message,
        hint: workflow.shortfall_note,
      })
    : transition;

  return {
    route: 'workflow',
    reply: withPendingQuestion(reply, mem.question),
    recommendations,
    profile: cleanProfile(body.message, prefs),
    filters: { flavor: prefs.flavor, budget: prefs.budget },
    degraded,
    memory: snapshot(freshMemory),
  };
}
