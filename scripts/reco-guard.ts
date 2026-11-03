// scripts/reco-guard.ts — 检索/推荐链路守卫：强约束 + 诚实理由
//
// 背景：曾经"辣的吧，去海边吃"——系统把重辣款按"海边场景不适合重辣"砍掉，
// 反而推了不辣的雪饼，还在理由里写"冲着你要的辣味挑的"（指鹿为马）。
// 这条守卫守住三件事：
//   1. 口味是强约束：用户要辣，不辣的绝不许进候选池（除非 0 候选才追问）
//   2. 场景是软约束：只当 rank 加分，不参与硬过滤，更不许反客为主压掉口味
//   3. 理由必须落到商品自身：只有真辣的卡才说"冲着你要的辣味挑的"
import { runLocalWorkflow, needFollowUp } from "@/lib/llm/local-workflow";
import { PRODUCTS } from "@/lib/data/snacks";
import type { Preferences, Filters } from "@/lib/llm/index";

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
    userId: "probe_reco",
    inRecommendContext: false,
    statedTaste: opts.flavor ? [opts.flavor] : [],
  });
}

const PRODUCT_BY_NAME = new Map(PRODUCTS.map((p) => [p.name, p]));
function isSpicy(name: string): boolean {
  const p = PRODUCT_BY_NAME.get(name);
  return !!p && (p.spicy > 0 || p.taste_tags.includes("辣味"));
}

let pass = 0;
let fail = 0;
function report(cond: boolean, label: string, actual?: string) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${actual ? ` — 实际: ${actual}` : ""}`);
  }
}

// ── 1. 口味是强约束：要辣，不辣的别进来 ──────────────────────────
console.log("【检索】口味强约束");
{
  const r = run("辣的吧，去海边吃", { flavor: "辣味", scene: "海边" });
  report(r.recommendations.length >= 1, "要辣至少推得出 1 张", String(r.recommendations.length));
  const nonSpicy = r.recommendations.filter((c) => !isSpicy(c.name));
  report(
    nonSpicy.length === 0,
    "推出来的全是辣的（不辣的被硬约束挡掉）",
    nonSpicy.map((c) => c.name).join(",") || "无",
  );
  // 反向证据：全库不辣款都不该出现在推荐里（硬约束整体生效，不依赖是否进候选池）
  const leaked = r.recommendations.filter((c) =>
    PRODUCTS.some((p) => p.name === c.name && p.spicy === 0),
  );
  report(leaked.length === 0, "不辣款整体被硬约束排除", leaked.join(",") || "无");
}

// ── 2. 场景不能反客为主：海边+要辣，重辣款不再被误杀 ──────────────
console.log("【检索】场景不压口味强诉求");
{
  const r = run("辣的吧，去海边吃", { flavor: "辣味", scene: "海边" });
  const names = r.recommendations.map((c) => c.name);
  // 火鸡面 / 辣味花生 旧逻辑会被"海边场景不适合重辣"砍掉，新逻辑必须出现
  report(
    names.length >= 1 && names.every((n) => isSpicy(n)),
    "海边场景没把辣款压掉（推出来的都是真辣的）",
    names.join(","),
  );
}

// ── 3. 没点口味时，场景默认不强制辣（口味硬过滤不误伤纯场景诉求）───
console.log("【检索】纯场景诉求不被口味过滤误伤");
{
  const r = run("来点海边吃的", { scene: "海边" });
  report(r.recommendations.length >= 1, "纯场景也能推得出货", String(r.recommendations.length));
  const hasNonSpicy = r.recommendations.some((c) => !isSpicy(c.name));
  report(hasNonSpicy, "纯场景诉求下允许推不辣款（证明没默认强制辣）", r.recommendations.map((c) => c.name).join(","));
}

// ── 4. 要甜：甜款才进，咸/辣款出局 ──────────────────────────────
console.log("【检索】其他口味强约束（甜）");
{
  const r = run("来点甜的", { flavor: "甜味" });
  const bad = r.recommendations.filter((c) => {
    const p = PRODUCT_BY_NAME.get(c.name);
    return !!p && !p.taste_tags.includes("甜味");
  });
  report(bad.length === 0, "要甜只推甜款", bad.map((c) => c.name).join(",") || "无");
}

// ── 5. 理由必须落到商品自身：只有真辣卡才吹"冲着你要的辣味" ───────
console.log("【理由】诚实校验，杜绝指鹿为马");
{
  const r = run("辣的吧，去海边吃", { flavor: "辣味", scene: "海边" });
  const liars = r.recommendations.filter(
    (c) => c.user_visible_reasons.some((s) => s.includes("冲着你要的辣味")) && !isSpicy(c.name),
  );
  report(liars.length === 0, "写「冲着你要的辣味」的卡一定真辣", liars.map((c) => c.name).join(",") || "无");

  // 不带场景标签的凑数卡，必须诚实说"不一定是专属"
  const sceneHonest = r.recommendations.filter(
    (c) => !PRODUCT_BY_NAME.get(c.name)!.scenes.includes("海边") &&
      c.user_visible_reasons.some((s) => s.includes("虽然不一定是海边")),
  );
  report(
    sceneHonest.length >= 1,
    "不带海边标签的卡诚实写「虽然不是海边专属，但在海边吃也很爽」",
    sceneHonest.map((c) => c.name).join(",") || "无",
  );
}

// ── 6. 兜底追问口径：有货就出卡，0 货才追问 ───────────────────────
console.log("【兜底】needFollowUp 口径");
{
  report(needFollowUp(0) !== undefined, "0 款 → 追问");
  report(needFollowUp(1) === undefined, "1 款 → 出卡不追问");
  report(needFollowUp(3) === undefined, "3 款 → 出卡不追问");
}

console.log(`\nreco-guard: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
