// app/api/ai/stream/route.ts
// 流式版入口：模型吐一个字就上屏一个字，不用等整段 JSON 拼完。
//
// 与 /api/ai 的差别只有一处：那边等完整结果一次性返回，这边边收边吐。
// 判断逻辑完全共用 lib/chat/handlers.ts，不另写一套。
//
// ── 事件协议 ────────────────────────────────────────────────
//   event: stage   {"stage":"memory"|"thinking"|"finalizing"}   阶段提示
//   event: delta   {"text":"行，"}                               reply 逐块
//   event: cards   {"recommendations":[...]}                     推荐结果
//   event: final   {完整响应体，结构同 /api/ai}                    最终结果
//   event: error   {"message":"..."}                             出错
//
// ── 为什么要有 stage ──────────────────────────────────────
// 记忆查询 / 待确认这类请求会在几百毫秒内本地办结（压根不调模型）。
// 前端看到 stage=memory 就知道"这次很快"，不用先摆一个打字动画。
//
// 链路日志见 lib/chat/trace.ts：与 /api/ai 同一套 TraceID 打点，
// 流式只是多了一条 [Local]「明确要货不上屏 delta」。

import { NextRequest, NextResponse } from 'next/server';
import { streamBrain } from '@/lib/llm/brain-stream';
import {
  allowRecommend,
  callBrain,
  mergedPrefs,
  recentUserText,
  parseBrainResponse,
  chatResponseFromText,
  routeIntent,
  upgradeForUrge,
  fixEmptyPromise,
  replyForUpgrade,
  UNCLEAR_REPLY,
  logDegraded,
  type ChatMessage,
  type Filters,
} from '@/lib/llm';
import { INTRODUCE_PATTERN, LEAD_IN_REPLY_PATTERN } from '@/lib/rules/patterns';
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
  snapshot,
  pickTransition,
  withPendingQuestion,
} from '@/lib/chat/handlers';

export const runtime = 'nodejs';

interface StreamBody {
  message: string;
  history?: ChatMessage[];
  filters?: Filters;
  inRecommendContext?: boolean;
  lastPicks?: string[];
  userProfile?: Record<string, any>;
  // 没有 userId：身份只认 cookie 与 x-guest-id 头（V2.1 删掉了自报身份的兼容通道）
}

export async function POST(req: NextRequest) {
  // TraceID 在入口就生成：流式这一轮的 delta / cards / final 都靠它串起来
  const traceId = newTraceId();
  // 整条流包进 trace 上下文：lib/llm 深处的报错（provider 挂了、超时重试）
  // 不用把 traceId 当参数一层层传下去，直接问上下文要
  return runWithTrace(traceId, () => buildStreamResponse(req, traceId));
}

async function buildStreamResponse(req: NextRequest, traceId: string) {
  const encoder = new TextEncoder();

  // 请求体与身份必须在建流之前解析完：
  // 响应头（含 Set-Cookie 的游客票据）只能在这个函数返回 Response 时一次性给全，
  // 等进了 start() 再算就晚了——头已经发出去了。
  const body = (await req.json().catch(() => null)) as StreamBody | null;
  if (!body?.message || typeof body.message !== 'string' || !body.message.trim()) {
    // 与 /api/ai 对齐：前端本来就判断 400 并提示「说点什么呀」
    return NextResponse.json({ error: '说点什么呀' }, { status: 400 });
  }

  // **不认 body.userId**（V2.1 已删）：只认 cx_token cookie 与 x-guest-id 头
  const identity = await resolveIdentity(req);
  const userId = identity.userId;

  const limited = checkRateLimit(userId);
  if (!limited.ok) {
    return NextResponse.json(
      { error: '慢点，一口气说太多了，缓一下再聊', retry_after: limited.retryAfter },
      { status: 429 },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      const finish = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      /**
       * final 的统一出口：[Response] 只在这里打一次。
       * 这条路上有 7 个分支会发 final，分散着打点迟早漏一条。
       */
      const sendFinal = (payload: Record<string, unknown>) => {
        traceResponse(
          traceId,
          payload.reply,
          Array.isArray(payload.recommendations) ? payload.recommendations.length : 0,
          {
            degraded: !!payload.degraded,
            route: typeof payload.route === 'string' ? payload.route : '-',
            awaiting: !!payload.awaiting_prefs,
          },
        );
        send('final', { ...payload, trace_id: traceId });
        finish();
      };

      try {
        traceRequest(traceId, {
          message: body.message,
          entry: '/api/ai/stream',
          userId,
          identity: identity.source,
        });
        const memory = await recallMemory(userId);
        const messages: ChatMessage[] = [
          ...(body.history || []).slice(-10),
          { role: 'user' as const, content: body.message },
        ];
        const ctx = {
          inRecommendContext: body.inRecommendContext,
          memoryText: renderMemoryForPrompt(memory),
        };

        // ── 阶段 1：输入侧正则（同步，零延迟）────────────────────
        // 判的是「用户说了什么」。输入是完整的，不存在分块问题，
        // 所以这些判断压根不参与流式——能本地办结的就直接办结，比流式还快。
        send('stage', { stage: 'memory' });

        const memRes = await handleMemoryIntent(userId, body.message, memory, traceId);
        if (memRes) {
          sendFinal(memRes);
          return;
        }

        const pendingRes = await handlePendingConfirm(userId, body.message, memory, traceId);
        if (pendingRes) {
          sendFinal(pendingRes);
          return;
        }

        // 硬要忌口货：本地回绝，不让模型看见这句话——它会让步，
        // 实测说过"你既然铁了心要变态辣鸡翅，那就点呗——8块"
        const insistRes = await handleInsistAvoid(userId, body.message, memory, traceId);
        if (insistRes) {
          sendFinal(insistRes);
          return;
        }

        // ── 阶段 2：流式调大脑（只吐 reply，不吐商品清单）──────────
        send('stage', { stage: 'thinking' });

        // 明确要货的句子（命中 BUY / URGE / 点名商品）：无论模型这轮说成什么，
        // 出口必定是推荐 / 介绍，它按陪聊写的那些字一句都不会上屏。
        // 这种字照常喂给前端，等 final 再整段换掉——就是"先出一段、啪地变另一段"的闪烁。
        // 所以这里干脆不下发 delta：攒住模型原文（raw 还是要的，意图和偏好都从这来），
        // 让过渡语和卡片一起到
        // 按意图分流：与 callBrain 同源的 routeIntent，两条入口不许分叉。
        // 陪聊走纯陪聊链路（精简提示词 + 自由输出），推荐 / 介绍走结构化链路。
        const chatOnly = routeIntent(body.message, ctx) === 'chat';
        const definiteGoods = allowRecommend(body.message, ctx);
        if (definiteGoods) {
          traceLocal(traceId, '明确要货（definiteGoods）', '模型逐字不上屏，过渡语和卡片一起到');
        }

        let raw = '';
        try {
          for await (const ev of streamBrain(messages, body.filters, ctx, chatOnly)) {
            if (ev.type === 'delta' && ev.text) {
              if (!definiteGoods) send('delta', { text: ev.text });
            } else if (ev.type === 'raw') {
              raw = ev.content;
            }
          }
        } catch (e: any) {
          // 流断了不代表这轮没救：raw 可能已经收到一部分，交给下面统一处理
          console.warn(`[${traceId}] [Stream] 流式中断：`, e?.message);
        }

        // ── 阶段 3：输出侧正则 + 选品（语义类必须整句判）───────────
        send('stage', { stage: 'finalizing' });

        // 流式一点没拿到（超时 / 网络断）→ 退回一次性调用，别让用户空手
        const brainRes = raw
          ? // 陪聊链路拿回来的是纯人话，**不能**送去 parseBrainResponse：
            // 那边 JSON 解析失败会走 guessIntent 拿关键词猜意图，
            // "行啊，想吃就吃呗"里有个"想吃"就会被猜成 recommend，凭空甩出卡片
            chatOnly
            ? chatResponseFromText(raw, messages)
            : parseBrainResponse(raw)
          : await callBrain(messages, body.filters, ctx, userId);
        traceBrain(
          traceId,
          brainRes.unavailable ? 'unavailable（大脑不可用）' : brainRes.intent,
          brainRes.preferences,
        );

        // 大脑整体不可用 → 本地链路兜底（与 /api/ai 同一个 handler，别分叉）。
        // 流式这条路上，此时可能已经吐了半句话上屏，final 到达时前端会整体替换
        if (brainRes.unavailable) {
          const fallback = await runLocalBrain({
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
          // 没有模型逐字吐字的来源了：把本地文案整块当一个 delta 发出去，
          // 占位气泡马上有字，final 到达时再按最终版本整体替换一次
          if (typeof fallback.reply === 'string' && fallback.reply) {
            send('delta', { text: fallback.reply });
          }
          sendFinal(fallback);
          return;
        }

        // 意图纠偏：与 callBrain 里那三道判断同源。
        // 不做的话，流式路径会退化成"模型说啥就是啥"，人设里的防呆形同虚设。
        let intent = brainRes.intent;
        if (intent !== 'introduce' && INTRODUCE_PATTERN.test(body.message)) {
          const hit = findLocalSnack(body.message);
          if (hit) {
            traceLocal(traceId, '意图纠偏:打听商品', `${intent} → introduce`);
            intent = 'introduce';
          }
        }
        // 催货升级（"你说说""哪几样呢"）：与 callBrain 同源，必须放在降级之前
        const urged = upgradeForUrge(intent, body.message);
        if (urged !== intent) {
          traceLocal(traceId, '意图纠偏:用户在催货', `${intent} → ${urged}`);
          intent = urged;
          // 同 callBrain：模型这句是按陪聊写的（"说啥？没头没尾"），
          // 留着会变成"嘴上说接不住、下面甩三张卡"，清空让它落本地过渡语
          brainRes.reply = undefined;
        }
        if (intent === 'recommend' && !allowRecommend(body.message, ctx)) {
          traceLocal(traceId, '意图纠偏:用户没开口要', 'recommend → chat，本轮不出卡片');
          intent = 'chat';
        }

        // 判了 introduce 却从用户原话里抠不出商品名 → 降回陪聊。
        // 否则出口只能吐"emmm 这个我还不太了解"——那是把我们的解析失败甩给用户
        if (intent === 'introduce') {
          const hit =
            findLocalSnack(brainRes.preferences?.product_name) || findLocalSnack(body.message);
          if (!hit) {
            logDegraded('introduce 但抠不出商品名，降陪聊', {
              userId,
              msg: body.message,
            });
            traceLocal(traceId, 'introduce 抠不出商品名', '降回陪聊');
            intent = 'chat';
          }
        }

        // 反向防呆（与 callBrain 同源；这条 SSE 历史上漏了）：
        // 用户明明开口要了（"最近心痒痒，想吃零食"），模型却判成陪聊 → 升 recommend。
        // 漏了它，"想吃零食"会落进本地陪聊池回一句"哈哈，然后呢？聊归聊"，
        // 货不见踪影。文案去留口径见 replyForUpgrade
        if (intent === 'chat' && allowRecommend(body.message, ctx)) {
          traceLocal(traceId, '意图纠偏:用户在要东西', 'chat → recommend');
          intent = 'recommend';
          brainRes.reply = replyForUpgrade(brainRes.reply);
          logDegraded('判 chat 但用户在要东西，升级推荐（SSE）', {
            userId,
            msg: body.message,
          });
        }

        // 陪聊：本轮不出卡片
        if (intent === 'chat') {
          // 偏好要本地抠 + 模型填合过才写记忆：模型在陪聊轮常把 preferences 留空，
          // 只用它那份，"今天想辣的发泄"就抽不出 flavor，撞忌口的冲突认不出来
          const mem = await syncMemory(
            userId,
            body.message,
            mergedPrefs(recentUserText(messages), brainRes.preferences),
            memory,
            traceId,
          );
          // 空头许诺防线：SSE 是自由输出，模型爱说"我给你挑好了"，
          // 可陪聊轮根本没有卡片——话先出去货却没到，用户会追着再问一轮。
          // 放行 / 裁剪 / 兜底的口径统一在 settleChatReply（fixEmptyPromise 委托它）。
          const fixed = await fixEmptyPromise(
            userId,
            messages,
            brainRes.reply,
            brainRes.preferences,
            ctx,
          );
          const reply = guardReply(
            withPendingQuestion(stripFakeList(fixed, traceId) || UNCLEAR_REPLY, mem.question),
            memory,
            traceId,
          );
          sendFinal({
            route: 'direct',
            reply,
            profile: cleanProfile(body.message, brainRes.preferences),
            // 钩子判定与 /api/ai 同一条口径：只有往零食方向抛的问句才算铺垫。
            // 以前这里图省事判 /[?？]/，陪聊追问细节（"因为啥吵的？"）也被标成钩子，
            // 下一轮用户回个"嗯"就被 CONSENT_PATTERN 当点头，凭空甩出卡片
            ...(brainRes.leadIn || LEAD_IN_REPLY_PATTERN.test(reply) ? { lead_in: true } : {}),
            memory: snapshot(await recallMemory(userId)),
          });
          return;
        }

        // 同上：推荐 / 介绍两条支路也用合并后的偏好，别分叉
        const prefs = mergedPrefs(recentUserText(messages), brainRes.preferences);
        const mem = await syncMemory(userId, body.message, prefs, memory, traceId);
        const freshMemory = await recallMemory(userId);

        // 介绍单品
        if (intent === 'introduce') {
          const card = findLocalSnack(prefs.product_name) || findLocalSnack(body.message);
          // 点名的货撞上忌口 / 过敏 → 卡片不给，话也换成劝阻的
          const blocked = cardBlocked(card, freshMemory, traceId);
          sendFinal({
            route: 'direct',
            reply: blocked
              ? `这个我得拦一下——${blocked.replace(/^用户/, '你')}，${card?.name}就不给你推了。换个别的？`
              : guardReply(brainRes.reply?.trim() || 'emmm 这个我还不太了解', freshMemory, traceId),
            profile: cleanProfile(body.message, prefs),
            ...(card && !blocked ? { recommendations: [card] } : {}),
            memory: snapshot(freshMemory),
          });
          return;
        }

        // 推荐
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
          sendFinal({
            route: 'direct',
            reply: workflow?.follow_up || 'emmm 这个条件有点刁钻，换宽松点我再给你找？',
            awaiting_prefs: !!workflow?.follow_up,
            profile: cleanProfile(body.message, prefs),
            memory: snapshot(freshMemory),
          });
          return;
        }

        // 模型的开头也可能嘴上提忌口货（卡片是干净的），出口前再扫一遍；
        // 自己写的"1. XX｜X元"清单和"你先说句随便"这类漏内部逻辑的句子先切掉
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

        // 卡片先发：前端可以先把骨架渲染出来，再等 final 的完整文案
        send('cards', { recommendations });

        sendFinal({
          route: 'workflow',
          reply: withPendingQuestion(reply, mem.question),
          recommendations,
          profile: cleanProfile(body.message, prefs),
          filters: { flavor: prefs.flavor, budget: prefs.budget },
          degraded,
          memory: snapshot(freshMemory),
        });
      } catch (err: any) {
        traceError('Stream Error', err, traceId);
        send('error', { message: '服务出了点问题，再说一次？', trace_id: traceId });
        finish();
      }
    },
  });

  const headers: Record<string, string> = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    // 关掉 Nginx 一类反代的缓冲，否则 SSE 会被攒成一大块再吐，流式就白做了
    'X-Accel-Buffering': 'no',
  };
  // 游客票据：必须在响应头一次性带出去，等流开始就改不了头了
  if (identity.guestTicket) {
    headers['Set-Cookie'] = cookieString(GUEST_COOKIE, identity.guestTicket, GUEST_MAX_AGE);
  }

  return new Response(stream, { headers });
}
