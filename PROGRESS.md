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
| 最后更新 | 2026-11-04（会话：V1.0 封版 → P1+P2+P3 收口 → V2.0 第 0~7 步 → V1.5 四条防线 → 数据清理 → V2.1 收口 + Docker 部署套件 → **改口味连环 Bug（同维度互斥）**） |
| 当前在做 | **部署套件已就绪 + 改口味连环已修复**：同维度互斥（忌口落库作废同轴旧口味）、改口味轮强制追问场景、场景抱怨先认错、前端 profile 互斥合并。下一步按 `DEPLOY.md` 上云 |
| 最近回归 | **改口味连环修复后**：`verify` **99/99**、`guard` profile 52 + reco 35 全过、lint 0/0、format 全绿、`smoke` **150/150（0 FAIL，含 14b 连环用例 12 条：改口味→追问场景→补场景出卡→要辣挂确认→确认后旧忌口顶掉）**；DB 探针 8/8（过敏原不牵连口味、旧的只 superseded 不物理删）；**部署套件**：`build` 成功、standalone 实跑 `/api/health` 返回 ok |
| 阻塞 | 无 |
| 下一步 | 按 `DEPLOY.md` 部署：`cp .env.example .env` → 填 `AUTH_SECRET` / `DATABASE_URL` / LLM Key → `mkdir -p data` → `docker compose up -d --build` → 四条 curl 验证（见 DEPLOY.md §4） |
| 怎么验证 | 快检（秒级、不用起服务）：`npm run verify` + `npm run lint` + `npm run format:check` + `npm run guard`；端到端 `npm run smoke` 要先在 3000 起 dev server，一轮约 1.5~5 分钟，**务必 `Start-Process` 后台跑**（前台超时会连带杀掉 dev server，见 §4 #8）；`npm run build` 前必须先停 dev server（两者共用 `.next`） |

---

## 1. 正在做（Doing）

### V2.0 数据库化 + 鉴权（Prisma + SQLite）

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 可行性闸门：装 `prisma`/`@prisma/client`/`bcryptjs`/`jose`、`prisma generate`、`migrate init`、读写往返自检 | ✅ 已提交 `ad869a9` |
| 1 | `schema.prisma`（User/Memory，补 `category/polarity/source/createdAt`）、`lib/db.ts` 单例 + `ensureDatabaseUrl()`、`scripts/migrate-memory-json.mjs` | ✅ 同上 |
| 2 | `lib/memory/store.ts` 切 Prisma：写路径包事务，分层/软删除/待确认语义一行未动 | ✅ 已提交 `236240b` |
| 3 | `lib/auth/{jwt,user-id,rate-limit,identity}.ts` + `api/auth/{login,upgrade,me,logout}` + 两个 AI 入口接身份解析与限流 | ✅ 已提交 `0fa32b1` |
| 4 | `scripts/smoke.mjs` 读写全换 Prisma + 统一 `x-guest-id` 头（顺带补两处漏 `await`） | ✅ 已提交 `a597ecc` |
| 5 | 前端：`use-auth.ts` / `auth-dialog.tsx` / `page.tsx` 接入 / 抽屉账号区 / 升级后清 profile 缓存 / 429 话术 | ✅ 已验，待提交 |
| — | 数据迁移已执行：**45 用户 / 51 条**入库，原文件改名 `data/memory.json.migrated-20261103` | ✅ |
| 6 | `prune-memory.ts`（Prisma 版：先归档再删，游客整行删 / 账号只清记忆）+ `backup-db.ts`（`VACUUM INTO` 在线备份 + 保留策略） | ✅ 待提交 |
| 7 | `系统prompt汇总.md` §4 / §8 同步、README 命令更新、`smoke` 全量回归 | ✅ 待提交 |

**V1.0 的 P1/P2/P3 已收口**（见 §2），此前的七项修复与两个 Bug 也都验过（见 §2）。

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
| 2026-11-06 | **V3.0 步骤 1：Schema 三连（Role / Message / Product）**：① 迁移前备份（data/backups/cuixiang-2026-11-06-04-49-29.db）② `schema.prisma`：User.role（String 默认 USER——SQLite 无 enum，与 Memory.status 同惯例）、Message 表（role/content/cards JSON 文本/traceId + 双索引）、Product 表（skuId/name 双 unique，**16 字段全量落库**——Product 接口的 reason/emoji/selling_points/allergens/gift_ok/child_ok/stock/quality/margin 缺一就是静默丢数据；数组字段存 JSON 文本，SQLite 无 scalar list/Json scalar）③ 单次迁移 `v3_admin_foundation`（纯增量：CREATE TABLE ×2 + User 表重建 12 步复制法，INSERT SELECT 原样搬行）④ `prisma/seed.ts` + `npm run db:seed`：snacks.ts 50 SKU 幂等 upsert，**导入后自验逐字段 diff 为空**（tags 按原派生逻辑重算比对） | ✅ 迁移干净应用；seed 50/50 diff 空、幂等复跑通过；存量 User 108 / Memory 120 完好；typecheck / format 全绿 | `schema.prisma` / `prisma/seed.ts` / `package.json` |
| 2026-11-06 | **根目录清理 + smoke 产物规范化**：① 物理删除根目录 48 个测试残留（smoke-*.txt 26 / *.flag 20 / dev-*.log 15 / build.* / s*.flag / .nextdev.log——均为历次 shell 重定向残留，dev 进程占用句柄导致部分删除失败，taskkill 后补删）② smoke.mjs 产物规范化：头部建 `tmp/smoke/`，`results` 改存用例名，运行结束自动把完整报告（汇总 + FAIL 明细 + 全量用例）覆盖写 `tmp/smoke/last-run.txt`——不再依赖 shell 重定向，根目录不会再被污染 ③ `.gitignore` 补 `/tmp/`（*.log、*.flag、smoke-*.txt 原已有）| ✅ smoke **166/166**（首跑 165/166，一例"还是不想吃辣"经大脑的用例抖动 FAIL，重跑全绿——符合"模型随机性不做强断言"原则）；产物确认落在 tmp/smoke/ 根目录零残留；format 全绿 | `scripts/smoke.mjs` / `.gitignore` |
| 2026-11-05 | **终审：记忆召回截断漏洞（P0）+ 身份签发打点（P1）**：① `recallMemory` 查询层排除 `deleted/superseded`（原 `take: limit` 先截断后过滤，废弃记忆攒满 20 条把"不吃辣"挤出结果集=伪失忆）；DB 探针先证伪（修前 core/pending 全空）再验证（修后全召回），探针用完即删 ② `resolveIdentity` 本就有"票据对得上不重发"早退，外审"每请求重签发"不成立；按建议给真签发路径加 trace 打点（首次/过期/换id），线上刷屏即前端 cookie 问题。schema / jwt 核实无需改 | ✅ `verify` 116/116、`smoke` 164/164、lint/format 全绿 | `store.ts` / `identity.ts` / 《系统prompt汇总》§4.2 |
| 2026-11-05 | **核心链路外审 5 处（P0×3 + P1×2）**：① 确认闭环死循环：否定开头答复一律本地按"否"办结（`isRetraction` 删除，`PENDING_NO_PATTERN` 锚定保证句中"不是"不误拦；10-31 的"长句放行"决策被外审推翻——大脑够不着 pending，放行=挂死）② 删 `blankStreak` 全局 Map（一个用户空白全体降级）③ 场景抽取否定闸（`sceneHit`：命中词前 4 字内有"不想/不去/别去/没去/再也不/不在"不抽）④ 前端 final 比 delta 短时垫"嘴瓢重说"+淡入动画（`refreshed` 机制已有、此前从未在 final 传值）⑤ `CATEGORY_WORDS` 补宽 20+ 词（mentionsGoods 链路本通，外审例词原已覆盖） | ✅ `verify` 116/116、`guard` profile 63 + reco 41、`smoke` 164/164、lint/format 全绿 | `handlers.ts` / `llm/index.ts` / `category-words.ts` / `page.tsx` / 双 guard / `smoke.mjs` / 《系统prompt汇总》§3.2 §4.5 §5.3 |
| 2026-11-05 | **外审 6 处修复**：① 删 `PROFANITY_PATTERN`（脏话本地拦截=规训用户；人设"模型自己不说脏话"保留）② `extractMemoryKeyword` 洗掉兜底捕获开头的"的"（「忘掉我**的**薯片」→「的薯片」删不掉）③ `CONSENT_PATTERN` 放宽短尾巴（"好的，来点"算点头，"好啊那我不买了"仍不算）④ `describeConstraint` 示例 10元内→30元内 ⑤⑥ **核实已达标无需改**：`RECOMMEND_PITCH_PATTERN` 只在流结束后对完整 reply 跑（brain-stream A/B/C 分层）；chat 由 `routeIntent` 本地分流走纯文本链路（`runChatChain`），主 prompt JSON 只进推荐/介绍链路，已在第七节补分流说明 | ✅ `verify` 全绿、`guard` profile 60 + reco 35 全过、`smoke` 全绿（+1 带尾巴点头用例）、lint 0/0、format 全绿 | `lib/rules/patterns.ts` / `lib/llm/index.ts` / `lib/chat/handlers.ts` / `lib/prompts/system-prompt.ts` / `scripts/profile-guard.ts` / `scripts/smoke.mjs` / 《系统prompt汇总》 |
| 2026-11-04 | **部署套件云端适配（用户确定 Render/Railway 路线，本地不装 Docker）**：① `Dockerfile` stage 顺序交换（migrator 提到 runner **前面**）——平台托管构建不读 compose、默认构建到最后一个 stage，原先 runner 在前会让云端起一个"迁完就退出"的一次性容器无限重启；compose 显式 `target:` 不受影响 ② `DEPLOY.md` 新增 §2.5：Render 原生环境全套配置表（Pre-Deploy Command 跑迁库 / Disk 挂 `/var/data` / `DATABASE_URL` 用**绝对路径** `file:/var/data/cuixiang.db`——相对路径依赖 schema 编译期位置，云盘路径一变就失联 / TZ / Health Check Path）+ Railway/Fly 迁库三选一走法 ③ runner 阶段预留注释行：解开 `COPY --from=migrator` 即给镜像带上 prisma CLI，配合启动命令 `npx prisma migrate deploy && node server.js`（幂等）。明确写死：**SQLite 只能单实例**，横向扩容先换 Postgres | ✅ compose 路线行为不变（target 显式指定）；`format:check` 全绿；`docker build` 仍未实测（本机无 Docker，用户已确认云端构建） | `Dockerfile` / `DEPLOY.md` |
| 2026-11-03 | **改口味连环 Bug：同维度互斥 + 改口味追问场景 + 找补话术** | 截图现场：「不想吃辣了，想吃甜的」→ 忌口入库但旧「口味·辣味」残留（侧栏对立标签并排）→ 且拿几轮前的「办公室」当本轮约束直接甩卡 → 用户问「场景呢」→ 机器式重问。先用复现脚本钉死五条现场（`_repro-pivot.ts`，纯函数）+ DB 探针（`_probe-pivot-db.ts`，落库级），再修：① `store.ts` 新增 `supersedeTasteConflicts(userId, axis)`——忌口落库时把同轴 `polarity='喜欢'` 的旧偏好标 superseded（限定 polarity 是关键：`supersedeMemory` 按包含匹配会把刚写的「不吃辣」自己也废掉；过敏原不含轴字天然不触发）② `handlers.ts` 导出 `avoidAxisOf`（忌口原话→轴）+ `syncMemory` 写入拒绝事实后作废同轴口味 + `pickTrustedProfile` 回包同轴互斥（模型回声把旧口味带回来也拦）+ `apologizeForMissedScene` ③ `patterns.ts` 新增 `TASTE_PIVOT_PATTERN`（改口味=新一轮，历史场景不再算数）与 `SCENE_COMPLAINT_PATTERN` ④ `recommendIntake`：改口味轮场景必须本轮原话说出，否则追问「这次是什么场合吃」；场景抱怨先认错「我的锅，忘了问你在哪儿吃——」 ⑤ 前端 `storage.ts` 新增 `mergeProfileExclusive`（裸 spread → 同维度互斥合并，过敏原永不误伤），`applyPayload` 接入 ⑥ 两个 AI 入口 chat 支路统一接找补垫话。**方向性原则**：忌口→口味是用户明说的作废，直接办；口味→忌口绝不能静默，必须走 pending 确认（过敏是死命令） | ✅ 复现脚本五条全中→修后全绿；DB 探针 **8/8**（忌口入库+辣味作废 / 过敏原不牵连口味 / 要辣挂待确认 / 确认后旧忌口 superseded）；`profile-guard` +9、`reco-guard` +5（pivot 追问 / 补场景出卡 / 普通要口味不误伤 / 找补认错），`verify` **99/99**、`guard` 全过、lint 0/0、format 全绿、`smoke` **150/150（新增 12 条连环用例：改口味→追问场景→补场景出卡→要辣挂确认→确认后旧忌口顶掉）** | `lib/rules/patterns.ts` / `lib/chat/handlers.ts` / `lib/memory/store.ts` / `lib/llm/local-workflow.ts` / `app/_components/storage.ts` / `app/page.tsx` / 两个 AI 入口 / `scripts/{profile,reco}-guard.ts` / `scripts/smoke.mjs` |
| 2026-11-03 | **Docker 部署套件 + `/api/health`** | `Dockerfile` 四阶段（deps / builder / runner / migrator）：`deps` 里 `npm ci` + `prisma generate`，`builder` 产出 `.next/standalone`，`runner` 只带 standalone + Prisma 引擎（`.prisma` / `@prisma` 显式 COPY，漏了会 `Query engine library not found`）+ `su-exec`，`migrator` 带完整 node_modules 专跑迁库。**app 镜像里故意没有 prisma CLI**，改库结构必须过 `docker compose run --rm migrate`。`next.config.ts` 加 `output: 'standalone'`。`docker-compose.yml`：`./data:/app/data` 卷挂载解决 SQLite 持久化，`app.depends_on.migrate: service_completed_successfully` 保证"先迁库再起服务"，migrate 跑完 `chown -R 1001:1001 /app/data`（否则 SQLite 写不进去）；healthcheck 用 busybox `wget` 打 `/api/health`。**踩到并处理**：Windows `core.autocrlf=true` 会把 `.sh` 转 CRLF，容器里 `sh` 报 "not found"（看着像文件不存在，其实是 `\r`）→ 新增 `.gitattributes` 钉 `*.sh text eol=lf`。`/api/health` 真打一次 `SELECT 1`，库断返回 503，不泄露连接串/路径/堆栈 | ✅ `verify` **86/86**、lint 0/0、format 全绿、`npm run build` **成功**（11/11 静态页，`.next/standalone/server.js` 存在，`node_modules/{.prisma,@prisma}` 已追踪）；**用 standalone 真起服务**：`PORT=3100 node server.js` → `GET /api/health` = `{"status":"ok","db":"connected","latencyMs":14,"uptimeSec":20}` | `Dockerfile` / `docker-compose.yml` / `docker-entrypoint.sh` / `.dockerignore` / `.gitattributes` / `DEPLOY.md` / `next.config.ts` / `app/api/health/route.ts` |
| 2026-11-03 | **V2.1 收口①②（删 `body.userId` / `cx_token` 滑动续期）+ ③限流评估** | ① `resolveIdentity(req)` 去掉 `bodyUserId` 入参与 `'body'` 来源，两个 AI 入口、前端两处请求、`AiRequestBody` / `StreamBody` 类型、`trace.identity` 注释、smoke 全部对齐；新增 smoke 断言"不带头 + body 写别人 id → 读不到记忆"（顺带发现 3 处手工 SSE fetch 还在用旧通道，已改头）② `/api/auth/me` 里做滑动续期：`userTokenRemaining()` 取剩余寿命，过半就重签并 `Set-Cookie`；不改 `verifyUserToken` 口径，另加同口径的剩余寿命读取函数。实测：剩 1 天→换票、剩 20 天→不换 ③ 限流持久化**评估后不做**：单实例 + SQLite 写放大，重启窗口仅数秒，随多实例一起上 Redis 再说 | ✅ `verify` 86/86、`lint` 0/0、`smoke` **138/138（0 FAIL）**；顺带修正旧记录里的错误（`cx_token` 其实是 30 天不是 7 天） | `lib/auth/identity.ts` / `lib/auth/jwt.ts` / `app/api/auth/me/route.ts` / `app/api/ai/route.ts` / `app/api/ai/stream/route.ts` / `app/page.tsx` / `lib/chat/trace.ts` / `scripts/smoke.mjs` |
| 2026-11-03 | **全量回归 + 修掉三处支路死角** | 清理数据后跑全量回归，红项逐条查证，**三条都不是本次改动引入，而是既有支路的死角**：① 候选不足 3 款的放宽补位丢了 `exclude`（「换一个」把上一轮那款补回来）② 普通接口 `/api/ai` 缺 SSE 的两段意图纠偏（催货升级、`chat + allowRecommend` → recommend），模型偶发判错时用户要货被回"我没太听懂"③ 我上一版改口让路只看 `taste`，被 `prefs.flavor` 的 history 回声带偏，`还是不想吃辣` 会被误删忌口。三处均已修 + `reco-guard` 补 4 条断言钉死。另：回归途中撞到 dev server 热重载后 `POST /api/ai` 全 404（路由表失效），重启即恢复，**重跑前一律重启 dev 并预热两条路由** | ✅ `verify` **86/86**、`guard` profile 42 + reco 31 全过、`lint` 0/0、`smoke` **137/137（0 FAIL）**；中间 5 轮 smoke 的失败项逐条定位（c1 36 条=路由 404、c2/c3/c4 各 1~2 条=模型空返回/意图误判+上述死角） | `lib/llm/local-workflow.ts` / `app/api/ai/route.ts` / `scripts/reco-guard.ts` / `系统prompt汇总.md` §7 §8 |
| 2026-11-03 | **清理幽灵忌口（一次性数据修复）** | 代码修好只保证"不再写脏"，**库里已有的脏记录不会自己消失**。新增 `scripts/clean-dirty-avoid.mjs`：只认结构证据——① `category='过敏忌口'` 且 content 命中**已知过敏原**（花生/坚果/海鲜/乳制品/鸡蛋/小麦/大豆/芒果）→ **永远保留**，真实过敏误删就是安全事故 ② content 是**口味**（辣/酸/甜/苦/咸）却挂在过敏分类下 → 幽灵（人不"过敏"于辣），默认只清游客与 `smoke_/probe_/test_` 测试号，正式账号要 `--include-accounts` ③ 归不了类的只报告 ④ 删除走软删除、`--apply` 前先归档。**注意 `source` 只存「对话提取」，库里没有原始用户消息，所以不猜"这句话是不是用户说的"，只认分类错挂** | ✅ 扫 82 用户 / 93 条记忆，忌口 78 条（active 69）：软删 **44** 条「过敏忌口·不吃辣」，真过敏原 **25** 条一条未动（active 69 → 25）；归档 `data/dirty-avoid-2026-11-03-13-58-24.json`（44 条，已核对全为「不吃辣」）；**复扫 0 条**（幂等），回滚 id 清单在归档里 | `scripts/clean-dirty-avoid.mjs`（新增） |
| 2026-11-03 | **V1.5 四条防线修复（幻影忌口 / 冲突闭环 / 指鹿为马 / 「条件刁钻」）** | **先查证再动手**：`git log --name-only` + `git diff` 确认 —— V2.0 第 2 步 `236240b` 只换存储（`decideMemoryAction` 是纯函数，注释明写"迁库时刻意一行没动"），第 3 步 `0fa32b1` 对 `handlers.ts` 只搬走 `normalizeUserId` 并 re-export，`local-workflow.ts` / `reply-composer.ts` / `patterns.ts` 自 `ae6a4ce` 起没动过 → **不是 V2.0 改坏的，是 V1.5 遗留**。四条现场全部本地复现后修复：① 裸 `不辣` 把「这些也不辣」抽成 `avoid='不吃辣'` 写进长期记忆 → `NO_SPICY_PATTERN` 收窄 + `PICK_REFERENCE_PATTERN`/`SPICY_DENIAL_PATTERN` 让抱怨句整轮不写记忆 ② `decideMemoryAction` 忌口早退 `facts.find(...)` 吞掉同轮改口 → 只判 `facts[0]` ③ `buildNeed` 同时产出 `taste=['辣味']`+`avoid=['辣味']` → 改口期删矛盾项 ④ `rank` 无辣度加分、`buildReasons` 用 `spicy>0` 就给微辣款写"冲着你要的辣味"→ `spicyBonus` + 门槛 `spicy>=2` ⑤ `needFollowUp(0)` 不再说「条件刁钻」 | ✅ 复现脚本四条全中→修后全绿；`profile-guard` 42 条（+7）、`reco-guard` 28 条（+6），`npm run guard` 全过、`verify` **82/82**、lint 0/0、`smoke` **137/137（r1 136/137 是 dev server 冷启动抖动，r2 全绿）** | `lib/rules/patterns.ts` / `lib/chat/handlers.ts` / `lib/memory/store.ts` / `lib/llm/local-workflow.ts` / `scripts/{profile,reco}-guard.ts` / `系统prompt汇总.md` §4.4 §7 §8 |
| 2026-11-03 | **V2.0 第 7 步：文档同步 + 全量回归** | ① `系统prompt汇总.md` §4「存储」口径从 `data/memory.json` 改成 SQLite（写明迁移留档与事务写入）；§8 变更记录补「鉴权接入前端只新增话术」一行，顺手补上表头缺失的 `|---|` 分隔行 ② `README.md` 更新 `prune-memory` / 新增 `db:backup` 用法与文件清单 ③ `app/page.tsx` 里"后端 `data/memory.json`"的注释改正 | ✅ `npm run smoke` **130/130（0 FAIL）**；`verify` 69/69、lint 0/0、format 全绿 | `系统prompt汇总.md` / `README.md` / `app/page.tsx` / `PROGRESS.md` / `docs/TEST_LOG.md` |
| 2026-11-03 | **V2.0 第 6 步：清理与备份脚本切到数据库** | ① `scripts/prune-memory.ts`（替代旧 `.mjs`）：默认只清**游客**、`--include-accounts` 才碰正式账号（且只清记忆、保留账号）；"未活跃"按**记忆最后更新时间**判（不能用 `User.updatedAt`——写记忆只在缺失时插用户行，不更新它）；真删之前先把原文写进 `data/memory-archive-<日期>.json`（结构仍是 `uid → 记忆数组`，可人工捞）；`--smoke-only` 只清 `smoke_` 前缀 ② `scripts/backup-db.ts`：`VACUUM INTO` 在线备份（WAL 下复制主文件会漏事务，三个文件一起 copy 又有写入竞态），`--keep=N` 只清自动命名的旧备份、`--out=` 指定的文件永不参与清理 ③ `package.json` 加 `db:backup`，`prune-memory` 改走 ts-alias-register ④ 清掉残留口径：`page.tsx` 注释、README、`系统prompt汇总.md` §4 都还写着 `data/memory.json` | ✅ 造两个 30 天未活跃用户（`@updatedAt` 手改不动，只能用原始 SQL 拨时间）验证：试运行默认列 1 个游客、加 `--include-accounts` 列 2 个；`--apply` 后游客行已删、账号行保留且记忆 0 条、归档文件含两条原文。备份连跑三次：文件名 `cuixiang-2026-11-03-13-12-44.db`、头部 `SQLite format 3`、`--keep=1` 清掉 2 份留存 1 份（**修了一个 bug**：初版时间戳留了 `T`，清理正则匹配不上，保留策略形同虚设） | `scripts/{prune-memory,backup-db}.ts`（新增）/ `scripts/prune-memory.mjs`（删除）/ `package.json` / `README.md` / `app/page.tsx` / `系统prompt汇总.md` §4 |
| 2026-11-03 | **V2.0 第 5 步：前端 `useAuth` + 注册/登录** | ① `use-auth.ts`：以 `/api/auth/me` 为唯一真源（**不**把账号态写进 localStorage），`userId` 永有值（未登录=本地 `u_xxx`，升级不换 id 所以记忆天然继承）；`upgrade / login / logout / refresh` 四个动作 ② `auth-dialog.tsx`：注册/登录同一组件双模式，前端先校验邮箱格式与密码长度 ③ `page.tsx`：抽屉顶部「账号」区、`AuthDialog` 挂载、三处 fetch 统一 `requestHeaders()`、流式 429 用服务端原话（不再落「刚卡了一下」）④ `use-debounced-write` 新增 `save()`：升级成功后**立刻**用 `{}` 盖掉 profile 缓存（只 `setProfile({})` 会被 pending 定时器写回旧值）⑤ 升级/登录后 `refresh()` 拿服务端快照覆盖本地 | ✅ `verify` 69/69、lint 0/0、format 全绿；Edge 实测：游客注册（新邮箱）→ 抽屉显示邮箱 → 刷新仍登录 → 退出回游客态 → 再登录成功；`cx_profile_v1` 升级后为 `{}`；两个测试账号已物理清理 | `app/_components/{use-auth,auth-dialog,use-debounced-write}` / `app/page.tsx` / `app/api/auth/{me,upgrade}/route.ts` |
| 2026-11-03 | **V2.0 第 5 步联调修了三个断点**（都是真机上点出来的） | ① 新访客点「注册」必 403：`cx_guest` 票据只在发过消息后才有 → `/api/auth/me` 认 `x-guest-id`，票据缺失时**补发一张** ② 从没聊过的人注册被 404「先聊一句再来注册」（库里无 User 行）→ 改 `upsert` 直接建行（票据已证明 id 归属，且无历史数据可继承）③ 账号被删后旧 `cx_token` 仍被当登录态（还能被 `writeMemory` upsert 复活）→ `me` 发现「票有效但库里没人」就清票，浏览器自愈 | ✅ 三条都在 Edge 里复现→修复→复测；直连 `me` 确认下发 `cx_guest=...; HttpOnly; SameSite=Lax` | `app/api/auth/me/route.ts` / `app/api/auth/upgrade/route.ts` |
| 2026-11-03 | **V2.0 第 4 步：smoke 适配数据库** | `seedMemories/readMemories/allUserIds/pruneUsers` 全改 async Prisma，`--only-prune` 按 `smoke_` 前缀物理清理；`ask()` 统一带 `x-guest-id`；第 13 节两处 `seed()` 调用漏 `await`（请求跑在写库前） | ✅ 补 `await` 后 r4~r6 稳定；SSE 一条失败是 DeepSeek 402 余额不足，与改造无关 | `scripts/smoke.mjs` |
| 2026-11-03 | **V2.0 第 3 步：鉴权体系** | `jwt.ts`（jose HS256 签 `cx_token`/`cx_guest`，校验 `typ` 防串用）、`user-id.ts`（`normalizeUserId` 搬出 + 新增 `strictUserId`）、`rate-limit.ts`（滑动窗口，默认 10 次/60 秒按 userId 计）、`identity.ts`（token > x-guest-id > body.userId > 新发 guest）；四路由：login（错密码与不存在统一话术防枚举）、upgrade（必须验 `cx_guest` 且与 guestId 一致，防账号被绑走）、me（游客返空快照而非 401）、logout | ✅ 19 条 HTTP 断言全过 | `lib/auth/*` / `app/api/auth/*` / 两个 AI 入口 |
| 2026-11-03 | **V2.0 第 0~2 步：Prisma + 迁移 + store 切换** | ① DB 落 `data/cuixiang.db`；`layer/status/polarity` 用 String（SQLite 无 enum，类型安全由 TS 联合类型守），不加 keyword+status 唯一键（软删除要留痕），加 `@@index([userId,layer,status])` / `@@index([userId,updatedAt])` ② `store.ts` 移除 fs/原子写/MemoryMutex，写路径包 `prisma.$transaction`，200 条上限按 `updatedAt` 删旧 ③ 迁移脚本试运行 45 用户/51 条 | ✅ `store` 12 条语义断言通过；`--apply` 后库内 45/51，抽样核对 `category/polarity/source` 齐全，原文件改名留档 | `prisma/schema.prisma` / `prisma/migrations/*` / `lib/db.ts` / `lib/memory/store.ts` / `scripts/migrate-memory-json.mjs` |
| 2026-11-03 | **生产构建 + 分两次提交** | ① `npx next build`：先停 dev server（两者共用 `.next`），cmd 前置清空 `CODEBUDDY_*` 身份变量 → `✓ Compiled successfully`，7/7 静态页，`/` 8.78 kB / 首屏 114 kB；唯一提示是 "Next.js plugin was not detected in your ESLint configuration"（没装 `eslint-config-next`，信息级，已记入 §3）② 提交前仓库没配 `user.name/email`（上一条 `3d44c09` 用的是 `Administrator <administrator@localhost>`），按「不改 git config」的规矩用 `-c user.name=… -c user.email=…` 临时带入同一身份 ③ 两个 commit：**`ae6a4ce`** chore（工具链 + 全仓格式化 + 死引用清理）、**`f6268c9`** refactor（`page.tsx` 拆件 + 防抖写盘 + 根目录清理 + 文档同步） | ✅ `git status` 无输出（工作区干净），提交序列 `3d44c09 → ae6a4ce → f6268c9` | `.next` / `build.log` / git |
| 2026-11-03 | **P1：lint / 单测 / verify 基线** | ① `eslint.config.mjs`（ESLint 9 flat，宽松优先：`no-explicit-any` 关、`no-unused-vars` 降 warn、风格类交 Prettier）② `vitest.config.ts` + `tests/` 3 个文件共 **69 条**（admin 票据 12 / profile-guard 35 / reco-guard 22），断言仍只在 `scripts/*-guard.ts` 写一份，`scripts/guard-types.ts` 的 `GuardResult` 给 CLI 与 vitest 共用 ③ `npm run verify` = `tsc --noEmit && vitest run` ④ 本次补齐：`.prettierrc` 改 `singleQuote: true`（对齐既有代码，避免全仓引号大改）、`.prettierignore` 排除 `*.md`（手写中文表格格式化只制造噪声），`format:check` 从 56 个文件不通过 → **全绿**；删掉搬走后残留的死引用、未用形参改 `_plan` / `_query` / `_reason` 并注明为何保留，`npm run lint` 35 警告 → **0** | ✅ `verify` 69/69；lint 0 error 0 warning；format:check 全绿；全都不需要 dev server | `eslint.config.mjs` / `vitest.config.ts` / `.prettierrc` / `.prettierignore` / `tests/*` / `scripts/guard-types.ts` / `lib/llm/{index,brain-stream,local-workflow}.ts` / `lib/memory/store.ts` |
| 2026-11-03 | **P2：`page.tsx` 拆件 + localStorage 防抖** | `app/page.tsx` 1672 → **929 行**，拆出 `app/_components/`：`bubble` / `snack-card` / `filter-panel` / `nav-btn` / `theme-switch` / `theme` / `format` / `storage` / `types` / `constants`（`WELCOME`/`SCENES`/`QUICK`/`BUDGETS`/可信 key）/ `use-debounced-write`。写盘从"每次变化同步 setItem"改成 `useDebouncedWrite`（三处：`cx_chat_v1` 400ms、`cx_profile_v1` 与 `cx_want_v1` 300ms），带 `hydrated` 闸门（首帧不许写，否则只有欢迎语的一版覆盖历史）+ `pagehide` / `visibilitychange` / 卸载时 flush（否则最后几百毫秒的改动会丢） | ✅ Edge 实测：首屏 / 侧栏 / 场景卡渲染正常；发「来点不辣的」出 1 条气泡 + 3 张卡（卡上有价、气泡无价无编号）；刷新后 `cx_chat_v1` 仍有 3 条消息，读档没被首帧覆盖。控制台只有 favicon 404（既有，项目本来就没有 favicon） | `app/page.tsx` / `app/_components/*` / `系统prompt汇总.md` §6 / `AGENTS.md` 规则表 / `README.md` |
| 2026-11-03 | **P3：根目录清理** | 删掉用完的一次性脚本 `probe4.mjs` / `probe5.mjs` / `tmp-timecheck.mjs` / `scripts/_dedupe.mjs`（都无引用）；`mobile-375.png` 移到 `docs/`；删掉 0 字节的 `smoke-p2.txt`。**刻意保留**：`index.html`（`打开脆香.url` 指向它，服务没起时提示双击 `启动.bat`）、`workflow.txt`（README 与代码注释里的 Coze 节点编号对照）、`启动.bat` / `run-server.bat` / `silent-start.vbs` / `开机自启.bat` / `取消开机自启.bat`（用户双击的启动器，挪走就断链）、`cuixiang_prompt.md`（已是指向真源的入口文件） | ✅ 根目录只剩文档 / 启动器 / 配置；tmp 脚本在 git 里显示为 `D`，全仓库无残留引用 | 根目录 / `docs/` / `scripts/` |
| 2026-11-03 | **两条 Bug 的回归复核（无代码改动）** | 复现路径重跑：①「忘掉我喜欢辣味」→ `memory_action=deleted`，再查 core_profile 无辣（三轮全过）② 追问两轮 →「换一批」→ 气泡无 `1. ` 编号、无价格、无「说句/我就直接/给你排上」（三轮全过）③ 脚本里的两份断言（smoke 35/36 节 + profile-guard 删除关键词组 + reco-guard【文案】9 条）本来就是为这两条写的，本轮**全部绿**，未新增用例。**顺带发现并清掉一个假故障**：`.next/types/*.ts` 被半截写入（尾部 NUL），`tsc` 报一堆 `TS1127 Invalid character` 指向生成文件，删/改名 `.next` 后 typecheck 恢复 0 错误（见 §4 #18） | smoke `smoke-r1/r2/r3.txt`；profile-guard / reco-guard；`.next`（构建缓存，已重新生成） |
| 2026-11-03 | **记忆删除正则盲区 + 强推文案缝合（两个用户报的 Bug）** | ①「忘掉我喜欢辣味」回"你要我忘掉哪条"：`MEMORY_KEYWORD_PATTERN` 末尾那条 `喜欢[^…]{1,6}` 把动词一起抠成「喜欢辣味」，`deleteMemory` 的 `includes` 比不中记忆里的「辣味」→ 改为**只列偏好对象本身**（含 `海产品过敏`/`牛奶过敏`/新预算档，单字 辣/甜/咸/酸/脆/软 垫底），正向说法交给新增 `MEMORY_LIKE_PATTERN`（只取动词后面的宾语）。②「换一批」后气泡出现"要不你先说句「随便」，我就直接给你排上 1. 麻辣魔芋爽｜29.9元…"：`composeRecommendReply` **不再往气泡里排 `1. XX｜X元` 明细**（明细归卡片），新增 `sanitizeTransition()`——按行截掉模型自写的清单、按句切掉带价句与 `META_INSTRUCTION_PATTERN`（"你先说句随便/如果…我就…"），切光落「行，换个方向给你挑——」；⚠ 风险行只留不带价事实，超预算/凑单归卡片；两条 route 的 transition 都先过清洗；提示词两处"系统会逐款拼在 reply 后面"同步改成"做成卡片挂在气泡下面"。**typecheck 0；guard profile 34 + reco 21（各 +8/+9）；smoke 130/130（r3；r1/r2 失败的两条：一条是旧断言要求气泡必须有 `1.`，按新口径已改；另一条"还是不想吃辣→3 张卡"在 r2 出 2 张，r1/r3 均过，属模型随机会话态偶发，见 §4 #12 同类）** | `lib/rules/patterns.ts` / `lib/chat/handlers.ts` / `lib/llm/reply-composer.ts` / `app/api/ai/route.ts` / `app/api/ai/stream/route.ts` / `lib/prompts/system-prompt.ts` / `scripts/profile-guard.ts` / `scripts/reco-guard.ts` / `scripts/smoke.mjs` / `系统prompt汇总.md` §5.1 §5.5 §8 |
| 2026-11-03 | **V1.0 封版 + P0 三件（安全/数据）** | ① 装 git 2.56.0（choco）+ `git init`，首次提交 `5654104 feat: V1.0 封版`（58 文件，日志与 `data/` 已排除；`.gitignore` 补 `*.log` / `smoke-*.txt` / `*.flag` / `.playwright-cli/`）② `/admin` 登录态从常量 cookie `cx_admin=1` 改为 HMAC 票据 `<exp>.<hmac(exp)>`，密钥由 `ADMIN_PASSWORD_HASH` 派生（改口令即让旧会话失效），校验含过期/格式/`timingSafeEqual`，口令比对也改常量时间；临时脚本验 9/9（伪造 `1`、换密钥、篡改 exp、篡改签名、过期全挡）③ `writeStore` 覆盖前先 `copyFile` 出 `memory.json.bak`；实测 4/4：写入后主文件变了、`.bak` 存在且等于写入前那一版，并已用它还原干净。**typecheck 0 错误；`npm run guard` profile 26 + reco 12 全过**（未跑 smoke：不涉及选品/提示词） | `lib/admin/session.ts`（新增）/ `app/admin/page.tsx` / `lib/memory/store.ts` / `.gitignore` / 仓库根 `.git` |
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

2026-11-03 **V2.0 已收口**：第 0~7 步全部完成，`smoke 138/138`。V2.1 前三条已办（见 §2），下表只剩未做的：

| # | 待办 | 为什么（出处） | 优先级 |
|---|---|---|---|
| ~~1~~ | ~~删掉 `body.userId` 兼容通道~~ | ✅ 已删：`resolveIdentity(req)` 只认 `cx_token` / `x-guest-id`；smoke 补了"不带头 + body 写别人 id 读不到记忆"的断言 | 已完成 |
| ~~2~~ | ~~`rate-limit.ts` 换持久化~~ | **决定不做**：单实例部署 + SQLite 每分钟写放大，收益不抵成本；进程重启窗口只有几秒，撞库者要恰好卡在窗口内才赚。真要上多实例时随 Redis 一起做（`lib/auth/rate-limit.ts` 顶部注释已写明） | 搁置 |
| ~~3~~ | ~~`cx_token` 续期~~ | ✅ 已做：票期 30 天（不是 7 天，旧记录写错了），`/api/auth/me` 里寿命过半就换新票；实测"剩 1 天→续期、剩 20 天→不续" | 已完成 |
| 4 | 登录失败也记一条审计 | 现在只统一话术防枚举，没有任何"有人在撞库"的观测手段 | 低 |
| 5 | 部署前必配 `AUTH_SECRET` | 没配（或短于 16 字符）时**签发会抛错、校验一律当未登录**：本地 dev 靠 `.env.local` 里那份，上云必须在平台环境变量里配一份 32 位以上随机串 | 高（部署前置） |

V1.0 遗留（优先级更低）：

| # | 待办 | 为什么（出处） | 优先级 |
|---|---|---|---|
| 1 | `page.tsx` 再拆 | 拆完还剩 929 行主壳（状态 + 发送链路）；继续拆要动流式/中止逻辑，风险高于收益 | 低 |
| 2 | 两条偶发用例根治 | §4 #12：模型当轮脑补 `category` / 只凑出 2 款，会把"无偏好仍追问""3 张卡"这两条断言撞红 | 中（要拍板才算行为变更） |
| 3 | 陪聊链路补 `emotion` 抽取 | §4 #9，影响小，只在本地兜底池挑档时用到 | 低 |
| 4 | 接 `eslint-config-next` | `next build` 会提示 "The Next.js plugin was not detected in your ESLint configuration"；接上要新装依赖，且大概率刷出一批新告警，单独一轮做 | 低 |

历史（2026-11-02 已清空）：移动端触摸目标放大 / 360×640 矮屏复测 / 兜底链路并入长期记忆忌口，三条都验完了，结论见 §2。

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
| 7 | ~~**本机没有 git**~~ → ✅ **2026-11-03 已解决** | 原状：`git` 报 CommandNotFound，历史只存在 `系统prompt汇总.md` | 已用 choco 装 git 2.56.0 并 `git init`（首次提交 `5654104 feat: V1.0 封版`）。**注意**：装了之后新开的 shell 才有 `git`；当前工具会话仍需走全路径 `C:\Program Files\Git\cmd\git.exe`。身份用 `-c user.name/-c user.email` 临时指定，未写进全局配置 |
| 8 | **长任务在前台跑会被工具超时掐断，并连带杀掉 dev server** | 日志停在 kill 那一刻、无任何报错，之后全 `ECONNREFUSED` | 一律 `Start-Process` 后台起 + 短命令轮询 |
| 9 | **陪聊链路不再有模型填的 `preferences`**：纯文本输出拿不到结构，`emotion`（烦/难过/开心…）只有模型会填，本地 `extractPrefsFromText` 不抽。影响面只到本地兜底池挑档（落不到 `emotion` 组就掉进通用池），且只在"模型没吐正文"这条兜底路上才会用到。真要补就给 `extractPrefsFromText` 加一组情绪词 | `lib/llm/index.ts` → `chatResponseFromText` / `settleChatReply` | 影响很小，先记着；要动就同时补 smoke |
| 12 | **smoke「无任何偏好 → 仍要追问不出卡片」偶发失败**（scripts/smoke.mjs:1065）：2026-11-02 跑三轮里 r1 挂了一次——全新用户单轮发「有什么好吃的」，却出了卡片（奥利奥/每日坚果/海苔卷），模型多半是当轮脑补出了 category / 口味，把追问闸绕过去了；r2 / r3 都是 84/84。**与本次 scene 改动无关**（该用例不传 userProfile、不涉及 profile 回传） | smoke-r1.txt:132（FAIL 行）/ smoke-r2、r3 全绿 | 会话态用例受模型随机性影响，**不要单次通过就下结论**（记忆里的老教训）。真要根治得让 `recommendIntake` 对"模型当轮填的 category"也要求有出处（参照 `statedTaste` 的做法）——属行为变更，等用户拍板 |
| 13 | ~~**兜底链路没并入长期记忆的忌口**~~：`orchestrator.matchLocalFallback` 的 `avoid_tags` 只来自 `user_profile.avoid`，主链路 `buildNeed` 却有 `memoryAvoidTags(memory)` ——编排抛错 / 选不出货走兜底时，纯靠 `memory.json` 记着的忌口（这轮没提）会漏过滤，过敏用户吃上过敏原 | 2026-11-02 审计发现；`lib/llm/orchestrator.ts` vs `lib/llm/local-workflow.ts:311` | ✅ **2026-11-02 已修**：`matchLocalFallback` 新增可选 `avoidTags`（标签口径，与 `avoidTagsFromText` 翻译出来的合并），`runRecommendation` 把 `memoryAvoidTags(memory)` 传进去。smoke 新增 `scripts/fallback-guard.ts` 守卫 3 条（含反向对照，证明用例有牙） |
| 17 | **模型脑补的偏好被当成"一直记着"，忌口脑补还会真的执行**：用户一句「有什么好吃的」，模型自己填了 `avoid=花生过敏`，前端无条件合并 → 侧栏挂出「忌口·花生」，且 `violateHardConstraint` 照着它拦，用户从此吃不到花生（根本不过敏）。后端长期记忆里其实一条花生都没有（29 个 uid 全查过），纯是前端 profile 缓存的脏数据 | 2026-11-02 用户报（`data/memory.json` 0 命中花生） | ✅ **2026-11-02 已修（方案 A）**：长期化必须有出处——本地 `extractPrefsFromText` 抽到，或模型填的词原样出现在用户原话里；模型当轮 preferences 只服务本轮选品。选品口径拆成 `sanitizeProfile`（不变）。附带：过敏原正则补全 + 前端历史脏 profile 一次性作废 + ✕ 删除精准匹配关键词 |
| 19 | **dev server 起在错误的工作目录 → 全站 404**：`Start-Process cmd.exe … npm run dev` 没指定 `-WorkingDirectory` 时，进程可能继承到别的目录，表现为 3000 端口有响应但 `/` 与 `/api/ai` 全 404；`dev-server.log` 里能看到 `Watchpack Error … lstat 'D:\System Volume Information'`（在扫整个 D 盘，说明 root 错了） | 2026-11-03 补跑 smoke 时撞到：r3 大面积空 FAIL（连 `/` 都 404） | 起服务一律 `Start-Process -WorkingDirectory 'd:\codebuddy\脆香cuixiang'`；判断依据是日志里出现 `System Volume Information` 或 `/` 返回 404 |
| 20 | **dev server 半死 / 被编辑打断 → smoke 中途 `ECONNRESET`**：进程还在、端口还 LISTENING，但请求连接被重置；或 smoke 跑着的时候改了源码，Next 重编译把在建的连接掐断 | 2026-11-03 实测：r1 在 70 秒处 `TypeError: fetch failed … ECONNRESET`；另一次 `Invoke-WebRequest` 直接 down 而 `netstat` 仍显示监听 | 1) 跑 smoke 期间**不要改任何文件**（含文档，Next 会 watch）；2) 开跑前先 `Invoke-WebRequest http://localhost:3000` 探活；3) 半死的进程要 `taskkill /PID <pid> /T /F` 重起，别等它自己恢复 |
| 18 | **`.next/types/*.ts` 被半截写入 → `tsc` 报一片「假错误」**：`npm run typecheck` 吐出几十条 `.next/types/app/page.ts(1,367x): error TS1127: Invalid character`，源码一行没改。实测那个生成文件 5864 字节、只有一行、**尾部全是 `\u0000`**——dev / 编译过程被打断留下的坏缓存，与代码无关 | 2026-11-03 复核时撞到：typecheck 从 0 错误变成一大片红，先删单个文件又换另一个文件继续报 | 把 `.next` 改名或删掉，再 `npm run typecheck` 即恢复（构建缓存可重新生成，`.gitignore` 已排除 `/.next/`）。**判别依据**：报错行全指向 `.next/` 下的生成文件、且该文件尾部是 NUL 字节；别去改业务代码 |
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
