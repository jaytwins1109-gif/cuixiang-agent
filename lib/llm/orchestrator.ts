// lib/llm/orchestrator.ts
// 工作流编排：Coze（主，同步）/ Dify（备，触发 + 轮询）/ local（内置零食库，用于无 Key 时跑通链路）

import { PRODUCTS, type Product } from '@/lib/data/snacks';
// 兜底走的硬约束判定与主链路同源，避免两条路推出不一样的货
import { avoidTagsFromText, budgetFromText, violateHardConstraint } from '@/lib/llm/local-workflow';

export interface WorkflowInput {
  keyword: string;
  user_id: string;
  user_profile: Record<string, any>;
  /** 上一轮已经推过的商品名，用户说"换一个"时要避开，别把同样三款再甩一遍 */
  exclude?: string[];
}

export interface Recommendation {
  name: string;
  reason: string;
  price: number;
  image?: string;
  emoji?: string;
}

export function currentProvider(): string {
  return process.env.ORCHESTRATOR || 'local';
}

/**
 * 同步取回推荐列表。
 * Coze：直接同步调用。
 * local：查内置零食库（无需任何 Key，用于开发/演示）。
 * Dify：异步模型，请改用 triggerDify() + pollWorkflow()。
 */
export async function triggerWorkflow(input: WorkflowInput): Promise<Recommendation[]> {
  const provider = currentProvider();

  if (provider === 'coze') return callCoze(input);
  if (provider === 'local') return matchLocalFallback(input);
  if (provider === 'dify') {
    throw new Error(
      'Dify 是异步模式，请改用 triggerDify() + pollWorkflow()，或把 ORCHESTRATOR 设为 coze / local',
    );
  }
  throw new Error(`未知编排引擎：${provider}（可选：coze / dify / local）`);
}

// ─── Coze ────────────────────────────────────────────
async function callCoze(input: WorkflowInput): Promise<Recommendation[]> {
  const apiKey = process.env.COZE_API_KEY;
  const workflowId = process.env.COZE_WORKFLOW_ID;

  if (!apiKey || !workflowId) {
    throw new Error(
      'COZE_API_KEY 或 COZE_WORKFLOW_ID 未配置（想不配就跑通，可设 ORCHESTRATOR=local）',
    );
  }

  const res = await fetch('https://api.coze.cn/v3/workflow/run', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      workflow_id: workflowId,
      parameters: {
        keyword: input.keyword,
        user_id: input.user_id,
        ...input.user_profile,
      },
    }),
  });

  if (!res.ok) {
    throw new Error(`Coze 工作流请求失败：${res.status} ${await res.text()}`);
  }

  // Coze 挂了 / 网关插了一脚时返回体是 HTML 错误页，直接 res.json() 会抛 SyntaxError，
  // 那一串 "Unexpected token '<'" 看不出是编排那边出的事
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error('Coze 返回了非法格式（不是 JSON）');
  }

  if (data.code !== 0) {
    throw new Error(`Coze 工作流调用失败：${data.msg || '未知错误'}`);
  }

  // Coze 返回的 data 有时是字符串，有时已是对象，两种都要吃下
  const parsed = typeof data.data === 'string' ? safeParse(data.data) : data.data;

  return normalizeList(parsed?.recommendations);
}

// ─── Dify：触发 ──────────────────────────────────────
/** 触发 Dify 工作流，返回执行 ID（不是推荐结果） */
export async function triggerDify(input: WorkflowInput): Promise<string> {
  const apiKey = process.env.DIFY_API_KEY;
  const baseUrl = process.env.DIFY_BASE_URL || 'http://localhost:3000/v1';

  if (!apiKey) {
    throw new Error('DIFY_API_KEY 未配置');
  }

  const res = await fetch(`${baseUrl}/workflows/run`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      inputs: {
        keyword: input.keyword,
        user_id: input.user_id,
        ...input.user_profile,
      },
      user: input.user_id,
      response_mode: 'blocking',
    }),
  });

  if (!res.ok) {
    throw new Error(`Dify 工作流请求失败：${res.status} ${await res.text()}`);
  }

  // 同上：Dify 那边的返回体也可能不是 JSON
  let data: any;
  try {
    data = await res.json();
  } catch {
    throw new Error('Dify 返回了非法格式（不是 JSON）');
  }
  const execId = data?.data?.id || data?.id;
  if (!execId) throw new Error('Dify 未返回执行 ID');
  return execId;
}

// ─── Dify：轮询 ──────────────────────────────────────
export async function pollWorkflow(
  executeId: string,
  timeoutMs: number = 15000,
): Promise<Recommendation[]> {
  const apiKey = process.env.DIFY_API_KEY;
  const baseUrl = process.env.DIFY_BASE_URL || 'http://localhost:3000/v1';
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${baseUrl}/workflows/run/${executeId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    // 轮询期间网关随时可能吐一帧非 JSON，那是**这一轮**没拿到，
    // 不是整个编排失败——跳过等下一次，别把一次抖动当成工作流挂了
    let data: any;
    try {
      data = await res.json();
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
      continue;
    }

    if (data?.data?.status === 'succeeded') {
      return normalizeList(data.data.outputs?.recommendations);
    }
    if (data?.data?.status === 'failed') {
      throw new Error('Dify 工作流执行失败');
    }

    await new Promise((r) => setTimeout(r, 1000));
  }

  throw new Error('Dify 工作流超时');
}

// ─── local：内置零食库（无 Key 也能跑通全链路）────────────
/**
 * 内置零食库就是商品表本身，不再另立一套字段更少的接口：
 * 兜底和主链路要读的是同一份数据（尤其是 allergens / spicy 这两个硬约束字段）。
 */
const SNACKS: Product[] = PRODUCTS;

/**
 * 按关键词 / 偏好从内置库里挑 3 款。
 * 公开导出：编排器挂了或没配 Key 时，用它兜底，保证用户不会空手而归。
 */
/**
 * 按关键词 / 偏好从内置库里挑 3 款。
 * 公开导出：编排器挂了或没配 Key 时，用它兜底，保证用户不会空手而归。
 *
 * 硬约束不在这里另判一遍，直接复用主链路的 `violateHardConstraint`。
 * 以前兜底自己过滤，口径比主链路松一截：忌辣时容忍微辣（主链路是微辣也出局）、
 * 过敏只看标签不看 allergens 字段、连「已售罄」都不查。
 * 结果就是主流程一报错，卖不动的和不能吃的被一起端上来——最高级别的事故面。
 *
 * @param input.avoidTags **额外**的忌口标签（已经是标签口径，如「花生」「海产品」）。
 *   `user_profile.avoid` 是**用户说法**（"花生过敏"），要经 `avoidTagsFromText` 翻译；
 *   而长期记忆那一份拿到的已经是标签，再翻译一遍反而认不出来。
 *   这两路合起来，兜底才同时认得"这轮说的忌口"和"记忆里记着的忌口"——
 *   主链路 `buildNeed` 就是这么做的（`avoidTagsFromText` + `memoryAvoidTags`），两边必须同口径。
 */
export function matchLocalFallback(
  input: WorkflowInput & { avoidTags?: string[] },
): Recommendation[] {
  const kw = (input.keyword || '').trim();
  const p = input.user_profile || {};
  const prefs = [p.flavor, p.texture, p.emotion, p.scene, kw].filter(Boolean) as string[];

  const budget = budgetFromText(p.budget);
  const constraints = {
    avoid_tags: Array.from(new Set([...avoidTagsFromText(p.avoid), ...(input.avoidTags || [])])),
    budget_min: budget.min,
    budget_max: budget.max,
    scene: (p.scene || '').trim(),
    exclude: (input.exclude || []).filter(Boolean),
  };

  const pool = SNACKS.filter((s) => !violateHardConstraint(s, constraints));

  const scored = pool.map((s) => ({
    snack: s,
    score:
      prefs.reduce((n, pref) => n + (s.tags.includes(pref) ? 1 : 0), 0) +
      // 忌辣时完全不辣的排前面，跟主链路 rank() 的倾向保持一致
      (constraints.avoid_tags.includes('辣味') && s.spicy === 0 ? 2 : 0),
  }));

  // 一个都没命中就退回池子里前 3 款，但**不绕过硬约束**——宁可少给，不能给错
  const hit = scored.filter((x) => x.score > 0);
  const picked = (hit.length ? hit : scored)
    .sort((a, b) => b.score - a.score || b.snack.quality - a.snack.quality)
    .slice(0, 3)
    .map((x) => x.snack);

  return picked.map((s) => ({
    name: s.name,
    reason: s.reason,
    price: s.price,
    emoji: s.emoji,
  }));
}
export function findLocalSnack(name?: string | null): Recommendation | null {
  const kw = (name || '').trim();
  if (!kw) return null;

  const hit =
    SNACKS.find((s) => s.name === kw) ||
    SNACKS.find((s) => s.name.includes(kw) || kw.includes(s.name));

  if (!hit) return null;
  return {
    name: hit.name,
    reason: hit.reason,
    price: hit.price,
    emoji: hit.emoji,
  };
}

/**
 * 按名字取**完整**的商品数据（含 `spicy` / `allergens` / `stock`）。
 *
 * 跟 `findLocalSnack` 的区别：那个只回展示用的四个字段，**做不了硬约束判定**——
 * 拿它去跑 `violateHardConstraint` 会因为读 `allergens` 直接抛错。
 * 出卡片前查忌口必须走这个。
 */
/**
 * 被当前忌口踢掉的商品名。
 *
 * 卡片那道闸拦得住货，拦不住模型**嘴上提**——实测它说过
 * 「变态辣鸡翅，辣完就爽」，而那一轮的卡片明明是干净的。
 * 输出侧拿这份名单去扫一遍 reply。
 */
export function blockedProductNames(avoidTags: string[]): string[] {
  if (!avoidTags.length) return [];
  return SNACKS.filter(
    (s) =>
      violateHardConstraint(s, {
        avoid_tags: avoidTags,
        budget_min: null,
        budget_max: null,
      }) !== null,
  ).map((s) => s.name);
}

export function findLocalProduct(name?: string | null): Product | null {
  const kw = (name || '').trim();
  if (!kw) return null;
  return (
    SNACKS.find((s) => s.name === kw) ||
    SNACKS.find((s) => s.name.includes(kw) || kw.includes(s.name)) ||
    null
  );
}

// ─── 通用工具 ────────────────────────────────────────
function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** 把上游返回的各种脏数据洗成干净的推荐列表 */
function normalizeList(raw: any): Recommendation[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((it) => it && typeof it.name === 'string')
    .slice(0, 3)
    .map((it) => ({
      name: String(it.name),
      reason: typeof it.reason === 'string' ? it.reason : '',
      price: Number(it.price) || 0,
      image: typeof it.image === 'string' ? it.image : undefined,
      emoji: typeof it.emoji === 'string' ? it.emoji : undefined,
    }));
}
