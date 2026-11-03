// scripts/fallback-guard.ts
// 兜底链路的忌口守卫。
//
// 为什么单开一个脚本：兜底（`matchLocalFallback`）是**主链路报错 / 一件都选不出来**时才走的路，
// 从 HTTP 那边没法稳定地"强制主链路报错"——编排是进程级配置，测试改不了。
// 所以这里直接在进程内复现兜底那一步的入参，断言它挑出来的货是安全的。
//
// 由 scripts/smoke.mjs 拉起（`node --import ./scripts/ts-alias-register.mjs scripts/fallback-guard.ts <uid>`），
// 输出 `PASS / FAIL` 行，smoke 解析后计入用例。单独跑也行：
//   node --import ./scripts/ts-alias-register.mjs scripts/fallback-guard.ts

import { PRODUCTS } from "@/lib/data/snacks";
import { matchLocalFallback } from "@/lib/llm/orchestrator";
import { memoryAvoidTags } from "@/lib/llm/local-workflow";
import { recallMemory, writeMemory } from "@/lib/memory/store";

const uid = process.argv[2] || `smoke_fallback_${Date.now()}`;

let failed = 0;
const report = (ok: boolean, name: string, actual: string) => {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${actual}`);
};

/** 过敏原里带海产品的款：海产品过敏的人一口都不能碰（契合新库：海苔类多标海产品） */
const SEAFOOD = PRODUCTS.filter((p) => p.allergens.includes("海产品"));
const seaNames = SEAFOOD.map((p) => p.name);

async function main() {
  // 1) 长期记忆里记一条「花生过敏」——这轮的 userProfile 是空的（用户没提），
  //    忌口唯一的来源就是记忆。这正是"兜底击穿"事故的形状
  await writeMemory(uid, [
    {
      layer: "core_profile",
      keyword: "海产品过敏",
      content: "海产品过敏=海产品过敏",
      category: "过敏忌口",
      polarity: "拒绝",
      status: "active",
    },
  ]);
  const memory = await recallMemory(uid);
  const tags = memoryAvoidTags(memory);

  report(
    tags.includes("海产品"),
    "长期记忆的「海产品过敏」能读成忌口标签",
    tags.join("/") || "（空）",
  );

  // 2) 兜底：userProfile 为空（主链路这个用户什么都没说），只带长期忌口
  const safe = matchLocalFallback({
    keyword: "",
    user_id: uid,
    user_profile: {},
    exclude: [],
    avoidTags: tags,
  });
  const bad = safe.filter((r) => seaNames.includes(r.name));

  report(
    bad.length === 0,
    "兜底卡片里没有含海产品的款",
    bad.length ? bad.map((r) => r.name).join("/") : safe.map((r) => r.name).join("/"),
  );

  // 3) 反向对照：不带忌口时，同一条兜底**确实会**推出坚果款。
  //    少了这一条，上面的断言可能只是"池子里本来就没有雷"，用例等于没长牙
  const raw = matchLocalFallback({
    keyword: "",
    user_id: uid,
    user_profile: {},
    exclude: [],
  });
  const hit = raw.filter((r) => seaNames.includes(r.name));

  report(
    hit.length > 0,
    "反向对照：不并忌口时兜底确实会推出海产品款（用例有效）",
    hit.length ? hit.map((r) => r.name).join("/") : "一款都没有，断言是空的",
  );

  console.log(`GUARD_FAILED=${failed}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.log(`FAIL  守卫脚本自身跑挂了 — ${e?.message || e}`);
  console.log("GUARD_FAILED=1");
  process.exit(1);
});
