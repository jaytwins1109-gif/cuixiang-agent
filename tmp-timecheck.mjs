// 一次性校验：确认计划写进 smoke 的时间边界断言都能过（跑完就删）
import path from "node:path";
import { pathToFileURL } from "node:url";

process.on("warning", (w) => {
  if (w.code !== "MODULE_TYPELESS_PACKAGE_JSON") console.warn(w);
});

// 不能直接写 "../lib/... "：项目目录名含中文，ESM 解析器在 `../` 归一化时会吞掉
// 一层路径（实测解析成 /D:/codebuddy/lib/...），所以先用 path 拼绝对路径再转 file URL
const url = pathToFileURL(
  path.join(import.meta.dirname, "lib", "llm", "time-context.ts"),
).href;
const { timeContext, timeSection } = await import(url);

const at = (hhmm) => new Date(`2026-11-01T${hhmm}:00`);
const cases = [
  ["20:59", "晚上", false],
  ["21:13", "晚上", false],
  ["22:59", "晚上", false],
  ["23:00", "深夜", true],
  ["04:59", "凌晨", true],
  ["05:00", "早上", false],
];
for (const [hhmm, period, night] of cases) {
  const c = timeContext(at(hhmm));
  const ok = c.period === period && c.isNight === night;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${hhmm} → ${period} isNight=${night}（实际 ${c.period} isNight=${c.isNight}）`,
  );
}

const evening = timeSection(at("21:13"));
console.log(
  `${/怎么还没睡/.test(evening) && !/这个点还没睡/.test(evening) ? "PASS" : "FAIL"} 21:13 提示词口径`,
);
console.log("  21:13: " + evening.replace(/\s+/g, " ").trim().slice(0, 130));
const night = timeSection(at("23:30"));
console.log(`${/这个点还没睡/.test(night) ? "PASS" : "FAIL"} 23:30 提示词口径`);
console.log("  23:30: " + night.replace(/\s+/g, " ").trim().slice(0, 130));
