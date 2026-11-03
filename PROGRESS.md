# 项目进度看板（PROGRESS.md）

> **防断网 / 防重启用。** 电脑重启、对话上下文丢失后，新会话第一件事就是读这个文件
> （规则写在 `AGENTS.md` 顶部【新会话启动规则】）。
>
> **更新纪律**：完成一个重大功能、修完一个 Bug、或者准备收工前，**必须更新本文件**。
> 不写等于没做——上下文一丢，没人知道上次做到哪、哪些事验过了、哪些还没验。

---

## 0. 最新状态（30 秒看完）

| 项 | 状态 |
|---|---|
| 最后更新 | 2026-11-02（会话：检索重构 · 强约束与诚实理由） |
| 当前在做 | **无进行中任务**。长期记忆确定性写入 + 检索重构（强约束/诚实理由）均已改完并验过（见 §2 首行） |
| 最近回归 | typecheck **0 错误**；`npm run guard` **profile + reco 全过**（`fallback-guard` 经 smoke 跑通）；`npm run smoke` **117/117，0 FAIL**；`data/memory.json` 已清到只剩 3 个真实会话 |
| 阻塞 | 无 |
| 下一步 | 待定。§3 已清空；剩下的都是 §4 里的观察项（#12 smoke 偶发，#13–#17 均已修） |
| 怎么验证 | `npm run typecheck` + `npm run guard` + `npm run smoke`（dev server 要在 3000 端口；smoke 一轮约 4~5 分钟，后台跑） |

---

## 1. 正在做（Doing）

**无进行中任务。** 七项修复已全部改完并验过（见 §2 首行 + 下表第 7 项）。

| # | 任务 | 做法 | 状态 |
|---|---|---|---|
| 7 | **长期偏好确定性写入（方案 A）**（用户报 Bug + 拍板） | ① `pickTrustedProfile(message, prefs)`：模型当轮 preferences **只服务本轮选品**，长期化必须有出处（本地抽取 / 字面出现在原话），选品口径拆出 `sanitizeProfile` ② 过敏原正则补全（花生/坚果/海鲜/乳制品）+ 忌酸 ③ 前端不再无条件合并 `data.profile`，历史脏 profile 一次性作废 ④ ✕ 删除送后端抠得出的关键词 | ✅ 已改，守卫 22 条 + smoke 第 34 节 |
| 8 | **检索重构 · 强约束与诚实理由**（用户报"指鹿为马"Bug） | 用户说"辣的吧，去海边吃"→ 系统按"海边场景不适合重辣"砍掉重辣款、推不辣雪饼、理由还写"冲着你要的辣味挑的"。修法：① `violateHardConstraint` 加口味强约束（要辣 `spicy===0` 出局，甜/咸/酸/清淡须 `taste_tags` 真含；口感词不算）② `CALM_SCENES` 压重辣只在**用户没要辣**时生效 ③ `buildReasons` 口味理由必须落到商品自身，不带场景标签的卡写"虽然不一定是专属，但在X吃也很爽" ④ `needFollowUp` 有货就出卡、0 货才追问；`shortfall_note`（诚实说货少）经 `composeRecommendReply` 的 `hint` 透传 ⑤ 新增 `scripts/reco-guard.ts`（12 条断言），`package.json` 加 `guard` 脚本 | ✅ 已改，reco-guard 12/12 + smoke 113/113 |
| 9 | **适配 50 SKU 真实商品库 + 价格档位断层**（用户替换 `snacks.ts` 后） | ① `Raw` 类型 bug 修复（原继承 `Product` 却要求数组字段，数据用 `str` 字段→typecheck 必挂）；`taste_tags` 描述词（微辣/咸香/香甜/麻辣）归一化成系统内部词（辣味/甜味/咸味/酸味/清淡/坚果），否则"要甜"会被硬过滤 0 候选 ② 价格档位三处同步：`page.tsx` `BUDGETS`、`local-workflow.ts` `BUDGET_MAP`、`system-prompt.ts` 文案、`index.ts` `CHEAP_PATTERN`→"30元内" ③ smoke + `fallback-guard` 旧商品名（火鸡面/旺旺雪饼/奥利奥/变态辣鸡翅/花生过敏）全改为新库（海苔脆片原味装/麻辣魔芋爽/海产品过敏），过敏原用例改海产品 ④ `reco-guard`/`profile-guard` 预算档位断言同步 | ✅ typecheck 0；guard 全过；`npm run smoke` **117/117** |

| # | 任务 | 做法 | 状态 |
|---|---|---|---|
| 6 | **「预算·不限」脑补标签**（用户报的 Bug） | ① 提示词 schema 去掉「不限」选项 + 加硬约束「没提就填 null」② `pickTrustedProfile` 只留 `budgetFromText` 认得出的档位；前端按侧栏 `BUDGETS` 同源过滤，读档时剔掉并写回 ③ 「清空手选」顺带清 profile 里的 budget | ✅ 已改，smoke 93/93 ×2 |

| # | 任务 | 做法 | 状态 |
|---|---|---|---|
| 1 | 移动端触摸目标放大（§3 #1） | `CardBtn` / `NavBtn` / 换皮肤 / 快捷短语 / 口味价格按钮 / 抽屉 ✕ / 想要清单 ✕ 统一 `min-h-[40px]` + `inline-flex items-center justify-center`；`NavBtn` 另加 `whitespace-nowrap`（360 宽下「+ 新对话」被压成竖排 92px 高） | ✅ 已改，矮屏复测全过 |
| 2 | 360×640 矮屏复测（§3 #2） | playwright-cli（Edge）360×640：首屏 / 卡片 / 口味抽屉三处 | ✅ 全过（0 溢出、按钮全 ≥40） |
| 3 | 场景/情绪脏数据清理 | 前端读档剔 `scene`/`emotion` 并写回；`applyPayload` 只收可信字段；后端 `pickTrustedProfile` 白名单（flavor/budget/avoid/texture） | ✅ 已改，浏览器实测脏 profile 刷新后自动清干净 |
| 4 | 兜底链路忌口击穿（§3 #3） | `matchLocalFallback` 新增 `avoidTags`，`runRecommendation` 把 `memoryAvoidTags(memory)` 传进去 | ✅ 已改，smoke 新增守卫 3 条 |
| 5 | JSON 解析崩溃 | `requestOnce` / Coze / Dify（触发 + 轮询）/ smoke 的 SSE 解析全部包 try-catch | ✅ 已改 |

## 1b. 逆向审计结论（2026-11-02）

| # | 修复点 | 结论 | 证据（在哪看到的） |
|---|---|---|---|
| 1 | 并发锁 MemoryMutex | ✅ 已完成 | `lib/memory/store.ts:80` `class MemoryMutex`，`fileLock.runExclusive` 包住 `recallMemory` / `listMemory` / `writeMemory` / `deleteMemory` / `resolvePending` / `clearMemory` / `supersededMemory` 共 7 个 |
| 2 | 硬过滤兜底（allergens + 缺货） | ✅ 已完成 | `lib/llm/local-workflow.ts:250` `violateHardConstraint`：`out_of_stock` → 「没货了」、`p.allergens.find(a => avoid_tags.includes(a))` → 「含X，用户过敏」；兜底 `orchestrator.matchLocalFallback` 不再自判，直接复用它 |
| 3 | userId 清洗 + guest_xxx | ✅ 已完成 | `lib/chat/handlers.ts:645` `normalizeUserId`：白名单 `[^a-zA-Z0-9_-]` + `RESERVED_USER_ID` 挡原型链保留字，空/非法 → `guest_${时间36进制}_${随机}`（不再落 `anonymous` 共享桶） |
| 4 | 时间感知注入 | ✅ 已完成 | `lib/prompts/system-prompt.ts` 第 210 行（业务提示词）与第 329 行（陪聊提示词）都拼了 `${timeSection()}`；`lib/llm/time-context.ts:18` `NIGHT_START = 23`，21:13 → 「晚上」`isNight=false`（smoke 第 31 节 8 条纯函数断言守着） |
| 5 | SSE 流式防断（abort / sessionId） | ✅ 已完成 | `app/page.tsx`：`streamAbort.current?.abort()` + `sessionId.current += 1`；`streamChat` 里每块 delta 与 final 渲染前都比对 `sessionId.current === session` |
| 6 | 流式文字不再被覆盖 | ✅ 已完成 | 两条入口都是 `brainRes.reply?.trim() \|\| pickTransition(...)`（普通 `route.ts:314`、SSE `stream/route.ts:432`）——模型写了过渡语就留它的，`pickTransition` 只在模型没给时兜底 |
| 7 | 左侧栏口味不算"没约束" | ✅ 已完成 | `handlers.statedTasteOf` 收 `input.filters?.flavor`，`local-workflow.recommendIntake` 的 `tasteCounts` 只看 `statedTaste`；注释明写"UI 侧栏选的 flavor 同理" |
| 8 | 长短期记忆隔离（scene） | ⚠️ 部分完成 → **本次补齐** | `factsFromMessage` 不抽 `scene`（memory.json 侧一直干净 ✅）；但 `cleanProfile` 会把 `scene` 回给前端，侧栏「一直记着」里出现「场景·办公室」❌ → 已改（见 §2 首行） |

---

## 2. 已完成（Done）

按时间倒序。只记"改了什么 + 验到什么程度"，细节去 `系统prompt汇总.md` 的变更记录表查。

| 日期 | 任务 | 结果 | 关键落点 |
|---|---|---|---|
| 2026-11-02 | **长期记忆重构收尾：口语用例 + 开发规范 + 清库** | ① 守卫加 4 条真人口语用例（吃海鲜起疹子 / 喝牛奶拉肚子 / 吃完坚果身上痒 / 我一吃花生就过敏）——补正则前 **3 条抽不到**，给四类过敏原加"吃/喝 + 症状词"变体后全中，反向对照「想吃坚果了」不误伤（症状词是硬要求，防抽反）② `AGENTS.md` 新增【长期记忆抽取规则】：新属性必须动四处（patterns 正则 / extractPrefsFromText / AVOID_TAGS 标签对得上 allergens / guard 断言），断言必须正向+反向成对；顺手删掉「什么算提示词变更」表里重复的一行 ③ 清库：`--days=0` 被 `prune-memory.mjs` 自己拒（`days<=0` 要求正数，且按未活跃天数筛不到今天的测试用户），改按 uid 前缀归档 `guest_`/`probe_`/`smoke_`——主文件 29 → **3 个**（全是真实浏览器会话 `u_*`），39 个进 `data/memory-archive-20261102.json`（不物理删除），备份 `data/memory.json.bak-20261102`。**typecheck 0 错误；smoke 115/115 ×2 轮 0 FAIL**（111 → 115） | `scripts/profile-guard.ts` / `lib/rules/patterns.ts` / `AGENTS.md` / `系统prompt汇总.md` §六 / `docs/TEST_LOG.md` / `data/memory.json` |
| 2026-11-02 | **长期偏好确定性写入（方案 A，用户拍板）** | 事故：用户在空请求「有什么好吃的」上被记成「忌口·花生」——后端 `data/memory.json` 里 29 个 uid **零命中花生**，纯是前端 profile 缓存的脏数据；而忌口会真的执行，用户吃不到根本不过敏的花生。① **拆两条口径**：`sanitizeProfile`（白名单 + budget 档位，本轮选品用，行为不变）与 `pickTrustedProfile(message, prefs)`（长期化用，**必须有出处**：本地 `extractPrefsFromText` 抽到，或模型填的词原样出现在原话里）② 过敏原正则补全：花生/坚果/海鲜/乳制品 + 忌酸，`extractPrefsFromText` 改用 `patterns.ts` 的正则（原先只在两处各写一份）③ 前端不再无条件合并 `data.profile`；历史脏 profile **一次性作废**（`cx_profile_reset_20261102` 标记位，只清一次）④ ✕「忘掉这条」改成后端抠得出的说法（口味/预算说成"忘掉我喜欢辣味"），`MEMORY_KEYWORD_PATTERN` 同步补口味/预算/口感词；`handlers.extractMemoryKeyword` 那份内联正则并回 `patterns.ts`。**踩坑**：过敏原正则最初写了 `吃坚果`，结果「想吃坚果了」被抽成坚果过敏（想要的东西被当过敏原全滤掉，smoke「点名要坚果」当场挂）——已改为只认"过敏/不行/不能/不碰"否定语境，并补 4 条防误伤反向对照。守卫 22 条 + smoke 第 34 节 | `lib/chat/handlers.ts` / `lib/rules/patterns.ts` / `lib/llm/index.ts` / `app/page.tsx` / `app/api/ai/route.ts` / `app/api/ai/stream/route.ts` / `scripts/profile-guard.ts` / `scripts/smoke.mjs` / `系统prompt汇总.md` §六 + §8 / `docs/TEST_LOG.md` |
| 2026-11-02 | **修「预算·不限」脑补标签（用户报 Bug）**：用户只提了口味/什么都没提，发一句「有什么好吃的」后侧栏「当前偏好」就冒出「预算·不限」，反复要求去掉也摘不掉 | ① **源头**：提示词输出 schema 里 `preferences.budget` 原本写着 `10元内\|10-30元\|不限\|null`，模型照着填「不限」→ 改成 `10元内\|10-30元\|null` 并加硬约束（没提 / "随便""都行""不限"一律 null，自造档"5块"也 null）② **后端**：`pickTrustedProfile` 对 budget 加一道 `budgetFromText` 判定——只留 min/max 不全为 null 的档位，「不限」「5块」都是"选品认不出"的假偏好 ③ **前端**：`stripVolatileProfile` 按侧栏 `BUDGETS` 同源档位过滤，读 localStorage 时剔掉**并写回** ④ **清空手选**顺带清掉 profile 里的 budget（口味/忌口不动）。新增 `scripts/profile-guard.ts` 守卫 5 条（含反向对照：10元内 / 10-30元 必须留着）+ smoke 端到端 1 条。**typecheck 0 错误；smoke 93/93 ×2 轮 0 FAIL**（87 → 93） | `lib/prompts/system-prompt.ts` / `lib/chat/handlers.ts` / `app/page.tsx` / `scripts/profile-guard.ts`（新增）/ `scripts/smoke.mjs` / `系统prompt汇总.md` §2 输出格式 + §六 + §8 / `docs/TEST_LOG.md` |
| 2026-11-02 | **五项：移动端触摸目标放大 + 360×640 矮屏复测 + 场景/情绪脏数据清理 + 兜底忌口防击穿 + JSON 解析包裹** | ① 13 个 30–32px 的按钮统一抬到 `min-h-[40px]`（`NavBtn` 另加 `whitespace-nowrap`——360 宽下「+ 新对话」被挤成竖排 92px）② 360×640 复测：首屏 / 卡片 / 口味抽屉**三处 0 横向溢出**，19 个按钮**全部 ≥40px**，抽屉 288px 不出屏、内容不被裁 ③ 前后端统一长期偏好白名单 `flavor/budget/avoid/texture`（`pickTrustedProfile` + `PROFILE_TRUSTED_KEYS`），浏览器实测：塞一份含 `scene`/`emotion` 的脏 profile 刷新后，localStorage 自动被清成 `{flavor, avoid}` ④ 兜底 `matchLocalFallback` 新增 `avoidTags`，`runRecommendation` 传入 `memoryAvoidTags(memory)`——以前兜底只认"这轮说出口"的忌口，编排抛错时花生过敏的人会收到每日坚果；新增 `scripts/fallback-guard.ts` 守卫 3 条（含反向对照：不并忌口时兜底**确实**推出每日坚果，证明用例有牙）⑤ `requestOnce` / Coze / Dify（触发 + 轮询）的 `res.json()` 全部包 try-catch，smoke 新增 `sseEvents()`。**typecheck 0 错误；smoke 87/87 ×2 轮 0 FAIL**（84 → 87） | `app/page.tsx` / `lib/chat/handlers.ts` / `lib/llm/orchestrator.ts` / `lib/llm/index.ts` / `scripts/fallback-guard.ts`（新增）/ `scripts/ts-alias-loader.mjs`（新增）/ `scripts/ts-alias-register.mjs`（新增）/ `scripts/smoke.mjs` / `系统prompt汇总.md` §六 + §8 / `docs/TEST_LOG.md` |
| 2026-11-02 | **8 点代码健康度逆向审计 + 补齐第 8 条**：通读 `route.ts` / `handlers.ts` / `store.ts` / `local-workflow.ts` / `orchestrator.ts` / `system-prompt.ts` / `page.tsx`，逐条核对（并发锁 / 硬过滤 allergens+缺货 / userId 清洗 / 时间注入 / SSE 防串台 / 过渡语不覆盖 / 左侧栏口味 / 长短期记忆隔离） | **7 条已落地，第 8 条部分完成**：`factsFromMessage` 不抽 `scene`（memory.json 侧干净），但 `cleanProfile` 把 `scene` 回给前端 → 侧栏长期偏好出现「场景·办公室」。已补齐：`cleanProfile` 排除 `scene`（与 `product_name` 同等待遇）+ `page.tsx` 写 profile 时跳过 `scene`、渲染「一直记着」时过滤 `scene`（清掉旧数据）。选品不受影响（`need.scene` 仍取当轮 `prefs.scene`）。**typecheck 0 错误；smoke 三轮：r2 / r3 = 84/84，r1 = 83/84（偶发 1 条，与改动无关）** | `lib/chat/handlers.ts` / `app/page.tsx` / `系统prompt汇总.md` §8 变更记录 / 本文件 §1b |
| 2026-11-02 | **清空 §3 三条待办（都是验证类，没改运行时代码）**：① 移动端 UI 兼容性（375 / 414 / 768 / 1024 四种宽度实测）② `npm run dev:log` 在 PowerShell 下能否分离 stderr ③ `capture-log` 长跑（`--max-rows`）裁剪 | ① 四种宽度**零横向溢出**：卡片 375/414 单列、768/1024 两列，`aside` 与汉堡在 1024 正确切换，两个抽屉（288 / 320px）都不出屏；**唯一问题：16 个按钮里 13 个高只有 30–32px，触摸目标偏小**（见 §4 #11）② `dev:log` **确实分离**：`dev.out.log` 收 Next 启动横幅，故意发的非法 JSON 触发的 `[b70c2k] [AI Route Error] SyntaxError…` 落在 `dev.err.log`（141 字节）③ `--max-rows 5` 灌 14 轮只留最新 5 行，再追加 3 轮后仍是 5 行、最老的被丢、表头与 `AUTO-LOG` 标记不坏 | `docs/TEST_LOG.md` §1（新增实测记录）/ `PROGRESS.md`；**未改任何运行时代码** |
| 2026-11-02 | **按意图拆分大模型调用链路**（陪聊纯文本自由化 / 推荐结构化严格化）（84/84 ×2 轮）：新增 `routeIntent()` 本地先定意图 → 陪聊走 `callChatOnly()`（关 `json_object` + `buildChatPrompt()` 精简提示词 + 温度 0.75 + 偏好不向模型要），推荐/介绍保持完整业务提示词 + `json_object`；出口新增 `settleChatReply()`**默认放行模型原话**，只有 `INTERNAL_LEAK_PATTERN` / `PROFANITY_PATTERN` 才落 `COMPANION_POOL`，半句夸海口按句裁、整句画饼先让模型自己重写；SSE 同步（`streamBrain(…, chatOnly)` + 纯文本不送 `parseBrainResponse`）；降级支路也改走陪聊链路补写，删掉 `askCompanionReply` / `COMPANION_ONLY_HINT`；两条入口 `lead_in` 统一到 `LEAD_IN_REPLY_PATTERN`；smoke 新增 2.6 节 2 条 | typecheck 0 错误，**smoke 84/84 0 FAIL**；实测三链路：陪聊「因为啥吵的？能气到连饭都不吃，这架不小啊」（无卡片、无 JSON 痕迹）、推荐「推荐个不辣的」出 3 张卡、介绍「火鸡面啥样」出 1 张卡；SSE 陪聊 delta 流式正常 | `lib/prompts/system-prompt.ts` / `lib/llm/index.ts` / `lib/llm/brain-stream.ts` / `app/api/ai/route.ts` / `app/api/ai/stream/route.ts` / `scripts/smoke.mjs` / `系统prompt汇总.md` §3.8 |
| 2026-11-02 | **记忆冲突确认链路修复**（同轮改口撞忌口不挂待确认）：`factsFromMessage` 废除 `!out.length` 门槛，改「忌口只认本轮原话 + 冲突事实 unshift 到 facts[0] + 重申忌口不算改口」；smoke 新增 14.5 节 3 场景 5 条，用例总数 67 → 80 | typecheck 0 错误，**smoke 80/80 ×3 轮 0 FAIL**；实测 3 场景：改口挂 pending（`辣=想吃辣`）且旧忌口保留、重申忌口不挂、确认后旧条 `superseded` + 新条 `active` | `lib/chat/handlers.ts` / `scripts/smoke.mjs` / `系统prompt汇总.md` §4.4、§8 |
| 2026-11-02 | **时间感知阈值收尾**：`NIGHT_START` 21→23 的文档口径同步（§0 / §6 / §7.1 / 本文件 §4）；smoke 时间用例窗口 `05:00–21:00` → `05:00–23:00`；新增第 31 节 8 条纯函数断言（含 21:13 事故现场） | typecheck 0 错误，**smoke 80/80 ×3 轮 0 FAIL**；第 31 节 8 条纯函数断言（不起服务）三轮全绿 | `lib/llm/time-context.ts`（11-01 已改）/ `scripts/smoke.mjs` / `系统prompt汇总.md` / `PROGRESS.md` |
| 2026-11-01 | **强化 Log 追溯**：`lib/llm/index.ts` / `brain-stream.ts` / `handlers.ts` 里所有报错行都带上 `[TraceID]`（用 AsyncLocalStorage 包住整轮请求，不把 traceId 当参数往下传）；新增 `npm run dev:log` 把 stderr 单独落 `dev.err.log`；前端报错也回传 `trace_id` | typecheck 0 错误，**smoke 67/67 ×3 轮**；实测乱码输入触发的深处告警行带上了本轮 TraceID | `lib/chat/trace.ts` / 两个 route / `lib/llm/*` / `app/page.tsx` / `package.json` |
| 2026-11-01 | **读档快捷指令「继续」**：`.codebuddy/rules/prompt-sync.md` 新增【快捷指令：继续】——用户单独发「继续」时读 `AGENTS.md` → `PROGRESS.md` → `docs/TEST_LOG.md`（没有则忽略），只汇报不改代码，格式 `当前项目进度 -> 最近修复的 Bug -> 下一步计划`，收尾问「接下来做哪个？」 | 规则文件已写入并复核；**没有跑 smoke**（不动运行时代码） | `.codebuddy/rules/prompt-sync.md` / `系统prompt汇总.md` |
| 2026-11-01 | **`capture-log` 强化**：`--file` 可重复给（同时跟 `dev.out.log` + `dev.err.log`）、新增 `--out` / `--archive-delay`；报错行（带 TraceID 的）挂进那一轮的备注并让初筛变 ⚠️ | 用固定样本验过：两个文件的行能合到同一行记录；`[Brain] 乱码输入` 不会覆盖真打点的意图；假的「半轮」行不再出现 | `scripts/capture-log.mjs` / `docs/TEST_LOG.md` |
| 2026-11-01 | **复活流程**：建立 `PROGRESS.md` + `AGENTS.md` 顶部【新会话启动规则】 | 已生效（本文件） | `PROGRESS.md`（新增）/ `AGENTS.md` |
| 2026-11-01 | **链路日志与测试归档**：每请求一个 6 位 TraceID + `Request`/`Brain`/`Local`/`Response` 四个打点；`docs/TEST_LOG.md` 模板 + `scripts/capture-log.mjs` 自动归档 | 实测 6 轮（含 SSE）归档正确，初筛能区分 ✅/⚠️ | `lib/chat/trace.ts`（新增）/ `docs/TEST_LOG.md`（新增）/ `scripts/capture-log.mjs`（新增） |
| 2026-11-01 | **「想吃零食」不出货**：SSE 补上反向防呆（chat→recommend 升级）+ `definiteGoods`（明确要货时一个 delta 都不吐，消掉文字闪烁） | smoke 67/67 | `app/api/ai/stream/route.ts` / `lib/llm/index.ts` |
| 2026-11-01 | **追问闸只认有出处的口味**（`statedTaste`）：不再拿模型当轮推测的 flavor/texture 当约束 | smoke 66→67 | `lib/llm/local-workflow.ts` / `lib/chat/handlers.ts` |
| 2026-11-01 | **放宽要绕开 `retrieve`**："不吃辣 + 10元内"只剩 1 张卡的 bug | 三轮稳定复现修复 | `lib/llm/local-workflow.ts` |
| 2026-11-01 | **无大脑降级**（已知问题 #7）：Key 欠费不再 500，转 `runLocalBrain()` 本地链路 | 真实 402 下 17/60 → 66/66 | `lib/llm/index.ts` / `lib/chat/handlers.ts` / 两个 route |

---

## 3. 下一步待办（Next）

2026-11-02 **已清空**：原三条（移动端 UI / `dev:log` / `capture-log` 长跑）都验完了，结论见 §2 首行。

| # | 待办 | 为什么（出处） | 优先级 |
|---|---|---|---|
2026-11-02 用户拍板「两条待办都做」→ **#1、#3 已做（见 §2），只剩 #2 在跑**。

| # | 待办 | 为什么（出处） | 优先级 / 状态 |
|---|---|---|---|
| 1 | ~~移动端触摸目标放大（30px → ≥40px）~~ | 见 §4 #11 | ✅ **2026-11-02 已做** |
| 2 | ~~移动端矮屏 360×640 复测~~ | 上次只测到 375×667，更窄的安卓机没验 | ✅ **2026-11-02 已验**（0 溢出 / 按钮全 ≥40） |
| 3 | ~~兜底链路并入长期记忆的忌口~~ | 审计发现，见 §4 #13 | ✅ **2026-11-02 已做** |

---

## 4. 遗留问题 / 已知坑（Known Issues）

`系统prompt汇总.md` §9 那 7 条已全部修复；下面是**修完又冒出来的**和**一直没根治的**。

| # | 问题 | 证据 / 出处 | 处理建议 |
|---|---|---|---|
| 1 | **改口撞忌口**：~~同一轮里同时带忌口和口味时不会挂待确认~~ **2026-11-02 已修**（`!out.length` 门槛废除，smoke 14.5 节守着），待 3 轮 smoke 确认 | 原 `PROGRESS.md` §4 #1 / `系统prompt汇总.md` §4.4 | 已闭环 |
| 2 | **DeepSeek 偶发吐空白**，只做了缓解没根治 | `系统prompt汇总.md` §9 #3 | 偶发时仍多花一次 token，接受现状 |
| 3 | **smoke 夜里会跳过 2 条时间用例**（"白天不许提深夜"只在 05:00–23:00 生效，2026-11-02 窗口已随阈值改对） | `系统prompt汇总.md` §0 | 夜里跑出全绿不等于那 2 条验过，白天补跑一次；第 31 节的纯函数断言不受时段影响，算兜底 |
| 4 | **`capture-log` 的 ⚠️ 只是初筛**，不是结论 | `系统prompt汇总.md` §16.4 | 本地接管常常是对的（比如硬要忌口货被拦），必须人工复核 |
| 5 | **`dev.err.log` 默认不会单独落盘** | `npm run dev` 打到终端；要 `npm run dev:log` 才分离 stdout / stderr | 排查异常时记得用 `dev:log` 起服务 |
| 6 | **`AGENTS.md` 可能被 IDE 重新生成覆盖**（它是扫描项目生成的） | 本轮观察 | 顶部【新会话启动规则】若消失，照本文件 §5 和 `系统prompt汇总.md` §16.5 重新贴回 |
| 7 | **本机没有 git** | `git log` / `git status` 都报 CommandNotFound | 改代码必须同步 `系统prompt汇总.md` 变更记录表（那是唯一的历史） |
| 8 | **长任务在前台跑会被工具超时掐断，并连带杀掉 dev server** | 日志停在 kill 那一刻、无任何报错，之后全 `ECONNREFUSED` | 一律 `Start-Process` 后台起 + 短命令轮询 |
| 9 | **陪聊链路不再有模型填的 `preferences`**：纯文本输出拿不到结构，`emotion`（烦/难过/开心…）只有模型会填，本地 `extractPrefsFromText` 不抽。影响面只到本地兜底池挑档（落不到 `emotion` 组就掉进通用池），且只在"模型没吐正文"这条兜底路上才会用到。真要补就给 `extractPrefsFromText` 加一组情绪词 | `lib/llm/index.ts` → `chatResponseFromText` / `settleChatReply` | 影响很小，先记着；要动就同时补 smoke |
| 12 | **smoke「无任何偏好 → 仍要追问不出卡片」偶发失败**（scripts/smoke.mjs:1065）：2026-11-02 跑三轮里 r1 挂了一次——全新用户单轮发「有什么好吃的」，却出了卡片（奥利奥/每日坚果/海苔卷），模型多半是当轮脑补出了 category / 口味，把追问闸绕过去了；r2 / r3 都是 84/84。**与本次 scene 改动无关**（该用例不传 userProfile、不涉及 profile 回传） | smoke-r1.txt:132（FAIL 行）/ smoke-r2、r3 全绿 | 会话态用例受模型随机性影响，**不要单次通过就下结论**（记忆里的老教训）。真要根治得让 `recommendIntake` 对"模型当轮填的 category"也要求有出处（参照 `statedTaste` 的做法）——属行为变更，等用户拍板 |
| 13 | ~~**兜底链路没并入长期记忆的忌口**~~：`orchestrator.matchLocalFallback` 的 `avoid_tags` 只来自 `user_profile.avoid`，主链路 `buildNeed` 却有 `memoryAvoidTags(memory)` ——编排抛错 / 选不出货走兜底时，纯靠 `memory.json` 记着的忌口（这轮没提）会漏过滤，过敏用户吃上过敏原 | 2026-11-02 审计发现；`lib/llm/orchestrator.ts` vs `lib/llm/local-workflow.ts:311` | ✅ **2026-11-02 已修**：`matchLocalFallback` 新增可选 `avoidTags`（标签口径，与 `avoidTagsFromText` 翻译出来的合并），`runRecommendation` 把 `memoryAvoidTags(memory)` 传进去。smoke 新增 `scripts/fallback-guard.ts` 守卫 3 条（含反向对照，证明用例有牙） |
| 17 | **模型脑补的偏好被当成"一直记着"，忌口脑补还会真的执行**：用户一句「有什么好吃的」，模型自己填了 `avoid=花生过敏`，前端无条件合并 → 侧栏挂出「忌口·花生」，且 `violateHardConstraint` 照着它拦，用户从此吃不到花生（根本不过敏）。后端长期记忆里其实一条花生都没有（29 个 uid 全查过），纯是前端 profile 缓存的脏数据 | 2026-11-02 用户报（`data/memory.json` 0 命中花生） | ✅ **2026-11-02 已修（方案 A）**：长期化必须有出处——本地 `extractPrefsFromText` 抽到，或模型填的词原样出现在用户原话里；模型当轮 preferences 只服务本轮选品。选品口径拆成 `sanitizeProfile`（不变）。附带：过敏原正则补全 + 前端历史脏 profile 一次性作废 + ✕ 删除精准匹配关键词 |
| 16 | **「预算·不限」脑补标签**：提示词 schema 里 `preferences.budget` 原本允许填「不限」，模型在用户**没提预算**时就填它，前端照单全收写进 localStorage，侧栏「当前偏好」挂出「预算·不限」，用户反复要求也摘不掉（2026-11-02 用户报）。同类隐患：自造档「5块」选品认不出，挂上去也是"说了不算" | 用户报 Bug | ✅ **2026-11-02 已修**：提示词禁止填「不限」+ 前后端都只存选品认得的档位（`budgetFromText` / 侧栏 `BUDGETS`）+ 读档时清理并写回 + 「清空手选」顺带清 budget。smoke 新增第 33 节 6 条（93/93 ×2 轮） |
| 15 | **JSON 解析崩溃**：`requestOnce` 里 `await res.json()` 没包 try-catch，上游返回 HTML 错误页 / 半截响应时抛 SyntaxError（"Unexpected token '<'"），看不出是谁家、也不知道该不该重试 | 2026-11-02 用户要求全局排查 | ✅ **2026-11-02 已修**：`requestOnce` / Coze / Dify（触发 + 轮询，轮询那处遇非 JSON 跳过等下一轮而不是判死）全部包上，翻成中文错误；前端两个 `res.json()` 与 SSE `JSON.parse` 本就在 try 里；smoke 新增 `sseEvents()` helper 解析 SSE，半截帧丢掉而不是让整个 smoke 崩在解析上 |
| 11 | ~~**移动端触摸目标偏小**~~ | 2026-11-02 移动端实测 | ✅ **2026-11-02 已修**：卡片「想要/换一个」、`NavBtn`、换皮肤、快捷短语、口味/价格按钮、抽屉 ✕ 统一抬到 `min-h-[40px]`（`inline-flex items-center justify-center`）；桌面端高度基本不变。见 §2 与 §3 #1 |
| 14 | **场景 / 情绪脏数据会跨会话复活**：老版本把 `scene`（办公室）和 `emotion`（烦）也攒进了前端那份长期 profile，写进 localStorage 后再也摘不掉，还会在选品时冒充"用户这轮提的约束" | 2026-11-02 用户指出（幽灵串台） | ✅ **2026-11-02 已修**：前后端统一白名单 `flavor / budget / avoid / texture`——`lib/chat/handlers.ts` 新增 `pickTrustedProfile`（`cleanProfile` 与 `runRecommendation`/`runLocalBrain` 的 profile 合并都走它），`app/page.tsx` 读档时剔掉并**写回** localStorage（只清内存不落盘的话刷新又回来）。场景仍认当轮那份（`prefs.scene`），只是不再长期化 |：375px 下 16 个可见按钮里 13 个高度只有 30–32px（`CardBtn` 的「想要 / 换一个」=30px、`NavBtn`（🍿/👤）=32px、换皮肤=30px、快捷短语=30px）；只有 ☰（44）、+ 新对话（52）、发送（52）达标。常见规范建议 ≥44px（iOS）/ 48px（Material） | 2026-11-02 移动端实测（Edge + `playwright-cli`，375×812 / 375×667） | 布局**没有**溢出问题，这只是"手指好不好点"。要改就是给 `CardBtn` / `NavBtn` / 快捷短语加 `py-2`（或 `min-h-[40px]`），桌面端也会一起变高一点——**属于视觉改动，等用户拍板再动** |
| 10 | **并发会话（IDE 任务执行器）会互相干扰**：另一个会话在同一工作区跑任务时，会往 dev server 和 smoke 进程发 Ctrl+C（日志文件里留下 `^C`）、把正在跑的脚本短暂还原成旧版 | 2026-11-02 实测：smoke 3 轮里的 r1 被 `^C` 掐断、`dev-server.log` 尾部出现 `^C^C`，r2/r3 跑的是**没有新用例的旧脚本**（75/75 而非 80/80），同一时间 `scripts/smoke.mjs` 的编辑在磁盘上出现过一次回退 | 只在**一个**会话里跑回归；发现「用例数不对 / 日志里出现 ^C」先查是不是有别的会话在动，别急着改代码 |

---

## 5. 更新纪律与字段口径（给下一个会话照着做）

### 什么时候更新

| 时机 | 更新哪一节 |
|---|---|
| 开始干一件非 trivival 的事 | §1 正在做 |
| 做完一个功能 / 修完一个 Bug | §1 → 移进 §2 已完成，写清验到什么程度 |
| 准备结束一天开发 | §0 最新状态 + §1/§2/§3，并确认 §4 没遗漏新坑 |
| 发现坑但没修 | §4 遗留问题（**必须写证据**，别写"可能有 bug"这种没法查的话） |

### 三份文件怎么分工（别写重）

| 文件 | 记什么 | 不记什么 |
|---|---|---|
| `PROGRESS.md`（本文件） | **做到哪了**：正在做 / 已完成 / 下一步 / 遗留问题 | 不记规则细节 |
| `系统prompt汇总.md` | **规则是什么**：口径、正则、变更记录（唯一的历史，本机没 git） | 不记"今天做了啥" |
| `docs/TEST_LOG.md` | **测了什么**：每轮的输入、表现、初筛结论 | 不复述代码规则 |

### 字段口径

- **结果**：必须写验证方式（`smoke 67/67` / `实测 6 轮` / `未验`）。写"已完成"却没验证，等于给下一个人埋雷。
- **关键落点**：写文件路径，下一个人 grep 就能找到。
- **遗留问题**：必须带**证据**（实测输出、日志行、文档章节号）。"疑似有问题"这种条目留着只会让人再查一遍。
