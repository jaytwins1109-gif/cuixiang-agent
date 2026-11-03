// scripts/reco-guard.ts — 检索/推荐链路守卫：强约束 + 诚实理由 + 气泡文案
//
// 背景：曾经"辣的吧，去海边吃"——系统把重辣款按"海边场景不适合重辣"砍掉，
// 反而推了不辣的雪饼，还在理由里写"冲着你要的辣味挑的"（指鹿为马）。
// 这条守卫守住四件事：
//   1. 口味是强约束：用户要辣，不辣的绝不许进候选池（除非 0 候选才追问）
//   2. 场景是软约束：只当 rank 加分，不参与硬过滤，更不许反客为主压掉口味
//   3. 理由必须落到商品自身：只有真辣的卡才说"冲着你要的辣味挑的"
//   4. 气泡文案不许列商品明细、不许把内部引导语（"你先说句随便"）漏给用户
//
// 三种跑法：
//   1. `npm run guard` / node --import ./scripts/ts-alias-register.mjs scripts/reco-guard.ts → CLI
//   2. `npm run test` → tests/reco-guard.test.ts（按 section 分组）
//   3. smoke 不拉这个（它拉的是 profile-guard / fallback-guard）
// 所以断言逻辑在 `runRecoGuard()` 里，`process.argv[1]` 判断了才走 CLI。

import { runLocalWorkflow, needFollowUp } from '@/lib/llm/local-workflow';
import { PRODUCTS } from '@/lib/data/snacks';
import { composeRecommendReply } from '@/lib/llm/reply-composer';
import type { Preferences, Filters } from '@/lib/llm/index';
import type { GuardResult } from './guard-types';

const emptyMemory = {
  core_profile: [],
  summary_memory: [],
  active_fragments: [],
  pending_fragments: [],
};

function run(
  message: string,
  opts: { flavor?: string; scene?: string; budget?: string; avoid?: string } = {},
) {
  const prefs = {
    ...(opts.flavor ? { flavor: opts.flavor } : {}),
    ...(opts.scene ? { scene: opts.scene } : {}),
    ...(opts.avoid ? { avoid: opts.avoid } : {}),
  } as Preferences;
  const filters = {
    ...(opts.flavor ? { flavor: opts.flavor } : {}),
    ...(opts.budget ? { budget: opts.budget } : {}),
  } as Filters;
  return runLocalWorkflow({
    message,
    prefs,
    filters,
    memory: emptyMemory,
    userId: 'probe_reco',
    inRecommendContext: false,
    statedTaste: opts.flavor ? [opts.flavor] : [],
  });
}

const PRODUCT_BY_NAME = new Map(PRODUCTS.map((p) => [p.name, p]));
function isSpicy(name: string): boolean {
  const p = PRODUCT_BY_NAME.get(name);
  return !!p && (p.spicy > 0 || p.taste_tags.includes('辣味'));
}

export function runRecoGuard(): GuardResult[] {
  const results: GuardResult[] = [];
  let section = '';
  const setSection = (s: string) => {
    section = s;
  };
  const report = (cond: boolean, label: string, actual = '') => {
    results.push({ name: label, pass: !!cond, actual, section });
  };

  // ── 1. 口味是强约束：要辣，不辣的别进来 ──────────────────────────
  setSection('【检索】口味强约束');
  {
    const r = run('辣的吧，去海边吃', { flavor: '辣味', scene: '海边' });
    report(r.recommendations.length >= 1, '要辣至少推得出 1 张', String(r.recommendations.length));
    const nonSpicy = r.recommendations.filter((c) => !isSpicy(c.name));
    report(
      nonSpicy.length === 0,
      '推出来的全是辣的（不辣的被硬约束挡掉）',
      nonSpicy.map((c) => c.name).join(',') || '无',
    );
    // 反向证据：全库不辣款都不该出现在推荐里（硬约束整体生效，不依赖是否进候选池）
    const leaked = r.recommendations.filter((c) =>
      PRODUCTS.some((p) => p.name === c.name && p.spicy === 0),
    );
    report(leaked.length === 0, '不辣款整体被硬约束排除', leaked.join(',') || '无');
  }

  // ── 2. 场景不能反客为主：海边+要辣，重辣款不再被误杀 ──────────────
  setSection('【检索】场景不压口味强诉求');
  {
    const r = run('辣的吧，去海边吃', { flavor: '辣味', scene: '海边' });
    const names = r.recommendations.map((c) => c.name);
    // 火鸡面 / 辣味花生 旧逻辑会被"海边场景不适合重辣"砍掉，新逻辑必须出现
    report(
      names.length >= 1 && names.every((n) => isSpicy(n)),
      '海边场景没把辣款压掉（推出来的都是真辣的）',
      names.join(','),
    );
  }

  // ── 3. 没点口味时，场景默认不强制辣（口味硬过滤不误伤纯场景诉求）───
  setSection('【检索】纯场景诉求不被口味过滤误伤');
  {
    const r = run('来点海边吃的', { scene: '海边' });
    report(r.recommendations.length >= 1, '纯场景也能推得出货', String(r.recommendations.length));
    const hasNonSpicy = r.recommendations.some((c) => !isSpicy(c.name));
    report(
      hasNonSpicy,
      '纯场景诉求下允许推不辣款（证明没默认强制辣）',
      r.recommendations.map((c) => c.name).join(','),
    );
  }

  // ── 4. 要甜：甜款才进，咸/辣款出局 ──────────────────────────────
  setSection('【检索】其他口味强约束（甜）');
  {
    const r = run('来点甜的', { flavor: '甜味' });
    const bad = r.recommendations.filter((c) => {
      const p = PRODUCT_BY_NAME.get(c.name);
      return !!p && !p.taste_tags.includes('甜味');
    });
    report(bad.length === 0, '要甜只推甜款', bad.map((c) => c.name).join(',') || '无');
  }

  // ── 5. 理由必须落到商品自身：只有真辣卡才吹"冲着你要的辣味" ───────
  setSection('【理由】诚实校验，杜绝指鹿为马');
  {
    const r = run('辣的吧，去海边吃', { flavor: '辣味', scene: '海边' });
    const liars = r.recommendations.filter(
      (c) => c.user_visible_reasons.some((s) => s.includes('冲着你要的辣味')) && !isSpicy(c.name),
    );
    report(
      liars.length === 0,
      '写「冲着你要的辣味」的卡一定真辣',
      liars.map((c) => c.name).join(',') || '无',
    );

    // 不带场景标签的凑数卡，必须诚实说"不一定是专属"
    const sceneHonest = r.recommendations.filter(
      (c) =>
        !PRODUCT_BY_NAME.get(c.name)!.scenes.includes('海边') &&
        c.user_visible_reasons.some((s) => s.includes('虽然不一定是海边')),
    );
    report(
      sceneHonest.length >= 1,
      '不带海边标签的卡诚实写「虽然不是海边专属，但在海边吃也很爽」',
      sceneHonest.map((c) => c.name).join(',') || '无',
    );
  }

  // ── 6. 兜底追问口径：有货就出卡，0 货才追问 ───────────────────────
  setSection('【兜底】needFollowUp 口径');
  {
    report(needFollowUp(0) !== undefined, '0 款 → 追问');
    report(needFollowUp(1) === undefined, '1 款 → 出卡不追问');
    report(needFollowUp(3) === undefined, '3 款 → 出卡不追问');
  }

  // ── 7. 气泡文案：不列商品明细、不漏内部引导语 ─────────────────────
  // 事故原型（2026-11-03）：追问两轮后用户说「换一批」，气泡里出现
  //   "要不你先说句「随便」，我就直接给你排上 1. 麻辣魔芋爽｜29.9元…"
  // 那是模型把自己的清单 + 我们内部的 CONSENT 判定一起讲给了用户听。
  setSection('【文案】气泡不列明细、不漏内部引导');
  {
    const recs = run('辣的吧，去海边吃', { flavor: '辣味', scene: '海边' }).recommendations;
    report(recs.length >= 1, '有卡片可用来合成话术', String(recs.length));

    // 把事故现场那句话原样喂进去
    const dirty = '要不你先说句「随便」，我就直接给你排上 1. 麻辣魔芋爽｜29.9元';
    const reply = composeRecommendReply({
      transition: dirty,
      recommendations: recs,
      message: '换一批',
    });
    report(!/说句|我就直接|给你排上/.test(reply), '引导指令整句切掉', reply);
    report(!/\d+(\.\d+)?\s*元|¥\s*\d/.test(reply), '气泡里不出现任何价格', reply);
    report(!/^\s*\d+\s*[.、]/m.test(reply), '气泡里不出现「1. 」编号明细', reply);
    report(reply.trim().length > 0, '切光后不留空气泡', reply);
    report(/换个方向/.test(reply), '换方向的请求落「行，换个方向给你挑——」', reply);

    // 正常气泡也不许把明细再列一遍（明细只在卡片的 recommendations 里）
    const plain = composeRecommendReply({
      transition: '行，这几个给你挑好了——',
      recommendations: recs,
      message: '来点辣的',
    });
    report(!/\d+(\.\d+)?\s*元/.test(plain), '本地合成的气泡里也没有价格', plain);
    report(!/^\s*\d+\s*[.、]/m.test(plain), '本地合成的气泡里也没有编号明细', plain);

    // 干净的过渡语要原样留着——别把正常接话一起洗掉
    const good = composeRecommendReply({
      transition: '行，那给你挑几个不齁的。',
      recommendations: recs,
      message: '来点不辣的',
    });
    report(good.startsWith('行，那给你挑几个不齁的。'), '正常过渡语原样保留', good);
  }

  // ── 8. 改口不挡路 + 微辣不冒充 ──────────────────────────────────
  // 事故原型（2026-11-03）：用户以前说过"不吃辣"，这次说"我想吃辣的"，
  // need 里 taste=['辣味']、avoid=['辣味'] 自相矛盾 → 硬过滤全踢 → 0 候选 →
  // 回"这个条件有点刁钻"。同时要辣却把微辣的黑胡椒薯角推上来，
  // 理由还写"冲着你要的辣味挑的"，用户咬一口就发现不辣。
  setSection('【记忆】改口不挡路 / 微辣不冒充');
  {
    const memAvoid = { ...emptyMemory, core_profile: ['忌口：不吃辣'] };
    const clash = runLocalWorkflow({
      message: '我想吃辣的',
      prefs: { flavor: '辣味' } as Preferences,
      filters: {} as Filters,
      memory: memAvoid,
      userId: 'probe_reco',
      inRecommendContext: true,
      statedTaste: ['辣味'],
    });

    report(
      !clash.need.avoid_tags.includes('辣味'),
      '改口期不拿旧忌口挡本轮明确要的辣',
      clash.need.avoid_tags.join(',') || '（空）',
    );
    report(
      clash.recommendations.length > 0,
      '旧忌口 + 本轮要辣 → 仍然出得了货',
      String(clash.recommendations.length),
    );

    const top = PRODUCT_BY_NAME.get(clash.recommendations[0]?.name || '');
    report(
      (top?.spicy ?? 0) >= 2,
      '要辣时第一名是中辣以上（不让微辣占坑）',
      `${clash.recommendations[0]?.name}(spicy=${top?.spicy})`,
    );

    const weak = clash.recommendations.filter(
      (c) => (PRODUCT_BY_NAME.get(c.name)?.spicy ?? 0) === 1,
    );
    const liar = weak.filter((c) =>
      (c.user_visible_reasons || []).some((r) => r.includes('冲着你要的辣味')),
    );
    report(
      liar.length === 0,
      '微辣商品不写「冲着你要的辣味挑的」',
      liar.map((c) => c.name).join(',') || '无',
    );
    const weakReason = weak[0]?.user_visible_reasons?.join(' / ') || '';
    report(
      !weak.length || weakReason.includes('微辣'),
      '微辣商品改说「微辣，只能提个味」',
      weakReason || '（没有微辣款）',
    );

    report(
      !(needFollowUp(0) || '').includes('刁钻'),
      '0 款时不甩锅「条件有点刁钻」',
      needFollowUp(0) || '（空）',
    );
  }

  return results;
}

/** 只有被 node 直接执行时才打印 + 退出；被 vitest import 时什么都不做 */
const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/reco-guard.ts');
if (isCli) {
  const results = runRecoGuard();
  let lastSection = '';
  for (const r of results) {
    if (r.section && r.section !== lastSection) {
      console.log(r.section);
      lastSection = r.section;
    }
    console.log(
      r.pass ? `  ✓ ${r.name}` : `  ✗ ${r.name}${r.actual ? ` — 实际: ${r.actual}` : ''}`,
    );
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\nreco-guard: ${results.length - failed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
