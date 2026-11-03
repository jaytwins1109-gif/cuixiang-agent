// scripts/capture-log.mjs
// 把服务端链路日志（lib/chat/trace.ts 打的四类点）自动归档成 docs/TEST_LOG.md 的表格行。
//
// 用法：
//   npm run capture-log                       跟 dev-server.log，只收脚本启动后的新日志
//   npm run capture-log -- --file X.log       换个日志文件（可重复给，见下）
//   npm run capture-log -- --from-start       连文件里已有的日志一起归档
//   npm run capture-log -- --stdin            从管道读：npm run dev | npm run capture-log -- --stdin
//   npm run capture-log -- --max-rows 300     归档区最多留几行（默认 300，超出丢最早的）
//   npm run capture-log -- --out docs/X.md    归档到别的文件（默认 docs/TEST_LOG.md）
//
// 为什么 --file 可以重复给：`npm run dev:log` 把 stdout 和 stderr 分开落盘
// （console.log → dev.out.log，console.warn/error → dev.err.log）。
// **报错行全在 stderr**，只跟一个文件就漏掉一半——要两个都跟：
//   npm run capture-log -- --file dev.out.log --file dev.err.log
//
// 行格式与 lib/chat/trace.ts 一一对应，**改那边必须改这里**（脚本靠固定前缀捞行）：
//   [a7f3k2] [Request]  收到请求，用户输入: xxx | 入口=/api/ai userId=u1
//   [a7f3k2] [Brain]    模型判定意图: recommend, 抽取偏好: flavor=辣味;avoid=不吃辣
//   [a7f3k2] [Local]    触发拦截规则: 硬要忌口货, 兜底处理: 本地回绝，不进 LLM
//   [a7f3k2] [Response] 最终返回文案: xxx, 推荐卡片数: 3 | degraded=false route=workflow
//
// 只捞这四个打点：其它日志（Next 的请求行、报错栈）一行都不进表——
// 归档表的价值在于"一轮一行能看完"，混进噪声就没人看了。

import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

const ROOT = path.resolve(import.meta.dirname, "..");
const START_MARK = "<!-- AUTO-LOG:START -->";
const END_MARK = "<!-- AUTO-LOG:END -->";

const args = process.argv.slice(2);
const has = (name) => args.includes(`--${name}`);
const valueOf = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  const next = i >= 0 ? args[i + 1] : undefined;
  return next && !next.startsWith("--") ? next : dflt;
};

if (has("help")) {
  console.log(
    [
      "capture-log：把 [TraceID] 打点归档进 docs/TEST_LOG.md",
      "",
      "  --file <path>      监听哪个日志文件（默认 dev-server.log；可重复给，同时跟多个）",
      "  --stdin            从 stdin 读，适合 npm run dev | ...",
      "  --from-start       连文件里已有的日志一起归档（默认只收启动后的新日志）",
      "  --out <path>       归档到哪个文件（默认 docs/TEST_LOG.md）",
      "  --max-rows <n>     归档区最多留几行（默认 300）",
      "  --flush-after <ms> 半轮日志多久没等到 [Response] 也算一行（默认 15000）",
      "",
      "  用 dev:log 起服务时两个文件都要跟（报错行落在 stderr）：",
      "    npm run capture-log -- --file dev.out.log --file dev.err.log",
    ].join("\n"),
  );
  process.exit(0);
}

// --file 可以重复给：dev:log 把 stdout / stderr 分开落盘，
// 只跟一个就会漏掉报错行那一半（它们全在 stderr）
const fileArgs = args.reduce((acc, a, i) => {
  if (a === "--file" && args[i + 1] && !args[i + 1].startsWith("--")) {
    acc.push(args[i + 1]);
  }
  return acc;
}, []);
const LOG_FILES = (fileArgs.length ? fileArgs : ["dev-server.log"]).map((f) =>
  path.resolve(ROOT, f),
);
const OUT_FILE = path.resolve(ROOT, valueOf("out", "docs/TEST_LOG.md"));
const USE_STDIN = has("stdin");
const FROM_START = has("from-start");
const MAX_ROWS = Number(valueOf("max-rows", 300)) || 300;
const FLUSH_AFTER = Number(valueOf("flush-after", 15000)) || 15000;
/**
 * 收到 [Response] 后再等一会儿才落表（默认 1.2 秒）。
 * 同时在跟两个文件（dev.out.log + dev.err.log）时，报错行走的是 stderr，
 * 它和 stdout 的 [Response] 不一定落在同一拍；不等这一下，
 * 报错行就会挂在一条"永远等不到 Response"的新记录上，表里多出一行假的「半轮」。
 */
const ARCHIVE_DELAY = Number(valueOf("archive-delay", 1200)) || 0;

// ── 解析 ────────────────────────────────────────────────
// 第二个方括号不写死成四个打点：服务端报错行（`traceError` / `tracePrefix` 打的）
// 也带 TraceID，长相是 `[a7f3k2] [AI Route Error] xxx`。
// 这些正是排查时要找的行，捞进来挂到那一轮的「备注」上，别让它们躺在 dev.err.log 里没人看。
const RE_TRACE = /^\[([a-z0-9]{4,10})\]\s*\[([^\]]+)\]\s*(.*)$/;

const parseRequest = (rest) => {
  const m = /^收到请求，用户输入:\s*([\s\S]*?)(?:\s*\|\s*([\s\S]*))?$/.exec(rest);
  return { input: (m?.[1] ?? "").trim(), meta: (m?.[2] ?? "").trim() };
};
const parseBrain = (rest) => {
  const m = /^模型判定意图:\s*([\s\S]*?),\s*抽取偏好:\s*([\s\S]*)$/.exec(rest);
  return { intent: (m?.[1] ?? "").trim(), prefs: (m?.[2] ?? "").trim() };
};
const parseLocal = (rest) => {
  const m = /^触发拦截规则:\s*([\s\S]*?),\s*兜底处理:\s*([\s\S]*)$/.exec(rest);
  return { rule: (m?.[1] ?? "").trim(), handling: (m?.[2] ?? "").trim() };
};
// 文案里可能带逗号，所以锚到最后那个「推荐卡片数: N」
const parseResponse = (rest) => {
  const m =
    /^最终返回文案:\s*([\s\S]*),\s*推荐卡片数:\s*(\d+)(?:\s*\|\s*([\s\S]*))?$/.exec(
      rest,
    );
  return {
    reply: (m?.[1] ?? "").trim(),
    cards: Number(m?.[2] ?? 0),
    meta: (m?.[3] ?? "").trim(),
  };
};

const pickMeta = (meta, key) => {
  const m = new RegExp(`${key}=(\\S+)`).exec(meta || "");
  return m ? m[1] : "";
};

// ── 一轮对话的中间状态 ──────────────────────────────────
/** @type {Map<string, {traceId:string,time:string,input?:string,entry?:string,userId?:string,intent?:string,prefs?:string,locals:Array,reply?:string,cards?:number,respMeta?:string,at:number}>} */
const pending = new Map();
const archived = new Set();

const pad = (n) => String(n).padStart(2, "0");
function stamp(d = new Date()) {
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function handleLine(raw) {
  const line = String(raw).trim();
  if (!line) return;
  const m = RE_TRACE.exec(line);
  if (!m) return;
  const [, traceId, stage, rest] = m;

  if (!pending.has(traceId)) {
    pending.set(traceId, {
      traceId,
      time: stamp(),
      locals: [],
      anomalies: [],
      at: Date.now(),
    });
  }
  const rec = pending.get(traceId);
  rec.at = Date.now();

  // 四个正式打点靠**行首固定话术**认，不只认阶段名。
  // 阶段名会被复用：`[Brain] 模型判定意图: …` 和 `[Brain] 乱码输入，本地兜底：…`
  // 都叫 Brain，只认名字会把真打点的值覆盖成空。
  // 认不出来的行（服务端报错行）一律归到本轮的「异常」里，别丢。
  const isStage = (name, head) => stage === name && rest.startsWith(head);

  if (isStage("Request", "收到请求")) {
    const p = parseRequest(rest);
    rec.input = p.input;
    rec.entry = pickMeta(p.meta, "入口");
    rec.userId = pickMeta(p.meta, "userId");
    rec.time = stamp();
  } else if (isStage("Brain", "模型判定意图")) {
    const p = parseBrain(rest);
    rec.intent = p.intent;
    rec.prefs = p.prefs;
  } else if (isStage("Local", "触发拦截规则")) {
    rec.locals.push(parseLocal(rest));
  } else if (isStage("Response", "最终返回文案")) {
    const p = parseResponse(rest);
    rec.reply = p.reply;
    rec.cards = p.cards;
    rec.respMeta = p.meta;
    scheduleArchive(traceId);
  } else {
    // 报错行（AI Route Error / Stream Error / Brain:provider / Degrade …）
    const brief = rest.replace(/\s+/g, " ").trim();
    rec.anomalies.push(`${stage}: ${brief.slice(0, 90)}`);
  }
}

// ── 组装一行 ────────────────────────────────────────────
const INTENT_LABEL = { chat: "陪聊", recommend: "推荐", introduce: "介绍" };

function cell(text, max = 46) {
  const s = String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .replace(/\s+/g, " ")
    .trim();
  if (!s) return "—";
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function moduleOf(rec) {
  const entry =
    rec.entry === "/api/ai/stream" ? "SSE" : rec.entry === "/api/ai" ? "普通接口" : rec.entry || "—";
  let kind = "—";
  if (rec.intent) {
    kind = rec.intent.startsWith("unavailable")
      ? "本地降级"
      : INTENT_LABEL[rec.intent] || rec.intent;
  } else if (rec.locals.length) {
    // 没走到大脑就本地办结的（记忆问答 / 待确认 / 强索要），模块名取拦截规则的前半段
    kind = rec.locals[0].rule.replace(/[:：].*$/, "");
  }
  return `${entry}·${kind}`;
}

function behaviorOf(rec) {
  const bits = [];
  if (rec.intent) bits.push(`意图=${rec.intent}`);
  bits.push(`卡片=${rec.cards ?? 0}`);
  const respMeta = rec.respMeta || "";
  if (/degraded=true/.test(respMeta)) bits.push("降级");
  if (/awaiting_prefs=true/.test(respMeta)) bits.push("追问中");
  if (rec.locals.length) {
    bits.push(`本地接管：${rec.locals.map((l) => l.rule).join(" / ")}`);
  }
  return bits.join("；");
}

/**
 * 是否通过只是**初筛**，不是结论。
 * 本地接管常常是对的（比如硬要忌口货被拦），脚本判不了对错，一律留 ⚠️ 给人工复核。
 */
function verdictOf(rec) {
  const reply = (rec.reply || "").trim();
  const respMeta = rec.respMeta || "";
  const degraded = /degraded=true/.test(respMeta);
  const awaiting = /awaiting_prefs=true/.test(respMeta);
  const asked = rec.locals.some((l) => /约束不足/.test(l.rule));

  if (rec.cards === undefined) return "⚠️ 未收到 [Response]（半轮，配合日志看）";
  if (!reply || reply === "—") return "❌ 空文案";
  // 本地接管要排在"没出货"之前：不出货可能正是它拦的（忌口 / 过敏 / 硬要），
  // 那是设计行为，判成 ❌ 会把"拦对了"记成"出了 bug"
  if (rec.locals.length) return "⚠️ 本地接管，人工复核";
  // 服务端在这一轮打过报错行（provider 挂了 / 超时重试 / 路由异常）→ 排在降级之前
  if (rec.anomalies?.length) return "⚠️ 日志有报错行，看备注";
  if (degraded) return "⚠️ 走了降级，人工复核";
  if (awaiting || asked) return "⚠️ 追问中，看话术对不对";
  if (
    (rec.intent === "recommend" || rec.intent === "introduce") &&
    !rec.cards
  ) {
    return "❌ 判了推荐却没出货";
  }
  return "✅";
}

function notesOf(rec) {
  const bits = [];
  // 报错行排最前面：备注列会被截断，它比偏好更该被看见
  for (const a of (rec.anomalies || []).slice(0, 2)) bits.push(a);
  if (rec.prefs && rec.prefs !== "（无）") bits.push(`偏好=${rec.prefs}`);
  for (const l of rec.locals.slice(0, 2)) {
    bits.push(`${l.rule}→${l.handling}`);
  }
  if (rec.userId) bits.push(`user=${rec.userId}`);
  return bits.join("；") || "无本地打点";
}

/** 收到 [Response] 不立刻写表：留一个窗口让另一个文件的报错行赶上来 */
function scheduleArchive(traceId) {
  const rec = pending.get(traceId);
  if (!rec || rec.scheduled) return;
  rec.scheduled = true;
  setTimeout(() => archive(traceId), ARCHIVE_DELAY);
}

async function archive(traceId) {
  const rec = pending.get(traceId);
  if (!rec || archived.has(traceId)) return;
  archived.add(traceId);
  pending.delete(traceId);

  const row =
    `| ${cell(stamp())} | ${cell(rec.traceId, 12)} | ${cell(moduleOf(rec), 18)} | ` +
    `${cell(rec.input, 34)} | ${cell(behaviorOf(rec), 52)} | ${cell(verdictOf(rec), 22)} | ${cell(notesOf(rec), 60)} |`;

  await writeRow(row);
  console.log(
    `[capture-log] ${rec.traceId} ${verdictOf(rec)} — ${cell(rec.input, 30)}`,
  );
}

/**
 * 写文件必须串行：一轮请求几百毫秒就回来了，手动连发几句时
 * 会有好几个 archive() 同时在 readFile→writeFile 之间跑，
 * 后写的覆盖前写的，表格里就会出现重复的 END 标记和半截字符。
 * 所以这里用一条 Promise 链当锁（与 lib/memory/store.ts 的 MemoryMutex 同一个思路）。
 */
let writeChain = Promise.resolve();
function writeRow(row) {
  writeChain = writeChain.then(() => writeRowOnce(row)).catch((e) => {
    console.error("[capture-log] 写入失败：", e?.message);
  });
  return writeChain;
}

/** 把一行写进 TEST_LOG.md 的两个标记之间 */
async function writeRowOnce(row) {
  let text;
  try {
    text = await fsp.readFile(OUT_FILE, "utf8");
  } catch {
    console.error(`[capture-log] 读不到 ${OUT_FILE}`);
    return;
  }
  const start = text.indexOf(START_MARK);
  const end = text.indexOf(END_MARK);
  if (start < 0 || end < 0 || end < start) {
    console.error(
      `[capture-log] ${path.relative(ROOT, OUT_FILE)} 里找不到 ${START_MARK} / ${END_MARK}，没写进去`,
    );
    return;
  }

  const head = text.slice(0, start + START_MARK.length);
  const body = text.slice(start + START_MARK.length, end);
  const tail = text.slice(end);

  // 已有的数据行（排掉表头和分隔行），追加新的，再按上限砍掉最老的
  const data = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|"))
    .filter((l) => !/^\|[\s\-:|]+\|$/.test(l))
    .filter((l) => !/测试时间/.test(l));
  data.push(row);

  const kept = data.slice(Math.max(0, data.length - MAX_ROWS));
  const header =
    "| 测试时间 | TraceID | 测试模块 | 用户输入 | 系统表现 | 是否通过 | 备注/排查线索 |\n|---|---|---|---|---|---|---|\n";

  await fsp.writeFile(OUT_FILE, `${head}\n${header}${kept.join("\n")}\n${tail}`, "utf8");
}

// ── 日志来源：跟文件 / 读 stdin ─────────────────────────
function consume(chunk, offset) {
  const text = chunk.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  // 最后一段还没换行 = 半行，等凑齐了再解析（否则会捞到截断的 TraceID）
  if (lastNl < 0) return offset;
  const usable = text.slice(0, lastNl);
  for (const line of usable.split(/\r?\n/)) handleLine(line);
  return offset + Buffer.byteLength(usable, "utf8") + 1;
}

async function readRange(file, start, end) {
  const fh = await fsp.open(file, "r");
  try {
    const buf = Buffer.alloc(end - start);
    await fh.read(buf, 0, end - start, start);
    return buf;
  } finally {
    await fh.close();
  }
}

async function followFiles() {
  const tails = LOG_FILES.map((file) => ({ file, offset: 0, missing: true }));

  const tick = async () => {
    for (const t of tails) {
      try {
        const { size } = await fsp.stat(t.file);
        if (t.missing) {
          // 第一次见到（或刚被重新创建）：不加 --from-start 就从文件末尾开始，
          // 只收脚本启动之后的日志
          t.offset = FROM_START ? 0 : size;
          t.missing = false;
          continue;
        }
        // dev server 重启会截断日志：size 变小说明是重写过，从头再来
        if (size < t.offset) t.offset = 0;
        if (size > t.offset) {
          t.offset = consume(await readRange(t.file, t.offset, size), t.offset);
        }
      } catch {
        // 文件还不存在不算错：dev.err.log 要等到第一条报错才会被创建出来
        t.missing = true;
      }
    }
    setTimeout(tick, 400);
  };
  tick();
}

function readStdin() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", handleLine);
}

// 半轮日志（一直没等到 [Response]）也要留痕，否则崩掉的那轮在表里完全消失
setInterval(() => {
  const now = Date.now();
  for (const [tid, rec] of [...pending]) {
    // 已排了延迟归档的（收到过 Response）不用管，它自己会落表
    if (rec.scheduled) continue;
    if (now - rec.at > FLUSH_AFTER) archive(tid);
  }
}, 2000).unref?.();

function stop() {
  const left = [...pending.keys()];
  Promise.all(left.map((tid) => archive(tid))).finally(() => {
    console.log("[capture-log] 已停止");
    process.exit(0);
  });
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

console.log(
  [
    "[capture-log] 开始监听",
    ...(USE_STDIN
      ? ["  来源: stdin"]
      : LOG_FILES.map(
          (f) =>
            `  来源: ${path.relative(ROOT, f)}${FROM_START ? "（从文件开头）" : "（从文件末尾）"}`,
        )),
    `  归档到: ${path.relative(ROOT, OUT_FILE)}`,
    "  现在去页面上聊几句，聊完一轮这里就多一行。Ctrl+C 停止。",
  ].join("\n"),
);

if (USE_STDIN) readStdin();
else followFiles();
