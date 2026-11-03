# 项目规则

## 【新会话启动规则】先读三个文件，再动手

每次开启新的会话（或者用户让你"继续之前的开发"），**第一件事**必须是读取以下文件：

1. `AGENTS.md`（本文件）—— 了解架构与强制规则
2. `PROGRESS.md` —— 了解当前进度、正在做什么、下一步计划、遗留问题
3. `docs/TEST_LOG.md` —— 了解最近测了哪些内容、哪些还没通过

读完以后：

- **先向用户汇报当前进度**（正在做 / 已完成 / 下一步 / 遗留问题，各一两句），并**询问下一步动作**；
- **不要盲目修改代码**——用户没确认方向之前动手，就是拿一次回归跑的时间赌运气；
- 用户给出方向后，先更新 `PROGRESS.md` 的「正在做」，再开始改；做完回来更新「已完成」。

> 本节是手写规则，`AGENTS.md` 本身由 IDE 扫描项目生成，**存在被重新生成覆盖的可能**。
> 若发现本节消失，照 `PROGRESS.md` §5 的分工表重新贴回即可。

## 提示词变更必须同步《系统prompt汇总》

本项目的提示词散落在多处，且同一条规则常常**同时存在于 LLM 提示词和本地确定性代码里**。
只改一边会让文档失真、后续维护踩坑，因此为强制规则。

### 什么算「提示词变更」

下列文件的下列内容发生增删改，都算，无一例外：

| 文件 | 需要同步的内容 |
|---|---|
| `lib/rules/patterns.ts` | **全部规则表达式**：意图防呆正则（`BUY_PATTERN` / `REFUSE_PATTERN` / `ADJUST_PATTERN` / `INTRODUCE_PATTERN` / `CONSENT_PATTERN`）、偏好抽取正则、记忆意图正则、待确认答复正则 |
| `lib/prompts/system-prompt.ts` | 人设正文、`describeCatalog()`、`describeConstraint()` |
| `lib/llm/index.ts` | 意图防呆的**调用**与兜底判断、偏好兜底抽取、乱码拦截、话术池、重试与温度策略（正则本体在 `lib/rules/patterns.ts`） |
| `lib/memory/store.ts` | 记忆分层 / 状态语义、`decideMemoryAction` 规则顺序、`renderMemoryForPrompt` |
| `app/api/ai/route.ts` | 记忆意图识别与待确认闭环、`factsFromMessage` 写入门槛、`pickTransition` 过渡语池、`renderMemoryReply` 模板（正则本体在 `lib/rules/patterns.ts`） |
| `app/_components/constants.ts` | `WELCOME` / `SCENES` / `QUICK` / `BUDGETS` / 可信偏好 key（2026-11-03 从 `page.tsx` 搬出，改文案来这里） |
| `app/page.tsx` | 报错兜底文案（"啊？刚卡了一下" / "啊？网断了"） |
| `lib/llm/local-workflow.ts` | 选品链路的节点职责与过滤规则 |

### 改之前

先读根目录 **`系统prompt汇总.md`** 对应章节，确认要改的规则在全链路里的所有落点。
例：「不吃辣」同时存在于——提示词正文的输出规范、`extractPrefsFromText` 的 `noSpicy` 正则、`local-workflow` 的硬过滤。**改一边必须检查另一边。**

### 改完之后必须做

1. 更新 `系统prompt汇总.md` 对应章节；
2. 在该文档末尾「变更记录」表格追加一行（日期、改了什么、涉及文件）；
3. 跑 `npm run smoke`（需 dev server 已启动），确认 21 条回归用例没退化；
4. 新增行为同时补 smoke 用例。

> 注意：smoke 的空状态文案里含「我不吃辣」字样，
> 断言长期记忆是否被删除时**不能**拿 `reply` 做文本匹配，只能断言结构化快照 `data.memory`。

### 不要做的事

- 不要在 `docs/脆香零食-完整项目文档.md` 里改人设——它是设计留档，已不是运行时真源，
  唯一真源是 `lib/prompts/system-prompt.ts`。（根目录 `cuixiang_prompt.md` 已改为入口文件，
  不再保存正文副本。）
- 不要把具体商品清单写死进提示词，商品一律由 `lib/data/snacks.ts` 动态生成。

---

## 【长期记忆抽取规则】改了忌口/口味属性，必须同步补抽取正则

长期偏好的**唯一**写入依据是本地确定性抽取，不是模型输出：

- 模型当轮的 `preferences` 只服务**本轮选品**（`sanitizeProfile` 口径）；
- 能不能进"一直记着"由 `pickTrustedProfile(message, prefs)` 决定——
  只认两种出处：① `extractPrefsFromText` 从**用户原话**抽到；② 模型填的词原样出现在原话里。
  两条都不占即模型脑补，丢弃（2026-11-02 的事故：空请求被记成「忌口·花生」，而忌口会真的执行）。

**推论：正则漏了 = 用户说了也白说。** 新增任何过敏原 / 忌口 / 口味 / 口感属性时，
只改提示词或只改商品数据是**不够的**——系统看完还是记不住，而且不会报错。

### 加一个新属性要动的地方（四处，缺一不可）

| # | 位置 | 改什么 |
|---|---|---|
| 1 | `lib/rules/patterns.ts` | 抽取正则本体（**所有正则集中在这里，别在别处内联**——`handlers.extractMemoryKeyword` 曾内联过一份，正则改了那边没跟着改） |
| 2 | `lib/llm/index.ts` 的 `extractPrefsFromText` | 加对应分支，让它真的写进 `prefs` |
| 3 | `lib/llm/local-workflow.ts` 的 `AVOID_TAGS` | 忌口文案 → 硬过滤标签。标签必须对得上 `lib/data/snacks.ts` 的 `allergens`（实际用到 `花生/坚果/海产品/乳制品`），对不上就是"记了但拦不住" |
| 4 | `scripts/profile-guard.ts` | 补断言，见下 |

### 断言必须成对（正向 + 反向）

```
正向："吃海鲜起疹子" → 海鲜过敏      // 真人口语，别只测标准说法"海鲜过敏"
反向："想吃坚果了"   → 抽不出忌口    // 防抽反
```

反向那条**不是可选项**：过敏原正则曾经写成 `吃坚果`，于是「想吃坚果了」被抽成坚果过敏——
用户点名要的东西被当成过敏原全滤掉。方向反了比抽不到更糟，所以症状类正则必须带症状词
（见 `ALLERGY_SYMPTOM`），光有"吃XX"不算忌口。

### 别忘了

忌口目前是**单值**字段（`prefs.avoid`），一次只记得住一条；用户同时说两种过敏时只会留一条。
要支持多条得先改 `Preferences.avoid` 的类型，别在正则里打补丁。

---

## 【检索/推荐：强约束与诚实理由】口味是死命令，场景只是加分

推荐链路（`lib/llm/local-workflow.ts` 的 `retrieve` → `hardFilter`/`violateHardConstraint` → `rank` → `buildReasons`）里，
诉求分两档，错档就会出"指鹿为马"的事故——用户说"辣的吧，去海边吃"，系统把重辣款按
"海边场景不适合重辣"砍掉，反而推不辣的雪饼，还在理由里写"冲着你要的辣味挑的"。

### 强约束（必须进 `violateHardConstraint` 硬过滤，不合格直接出局）

| 诉求 | 判定 | 红线 |
|---|---|---|
| 口味（`HARD_TASTE_WORDS`：辣味/甜味/咸味/酸味/清淡） | 要辣 → `spicy===0` 出局；其他 → `taste_tags` 必须真含 | **口感词（脆/软/嚼感解压）不算强约束**，它们是软偏好，只进 `rank` 打分 |
| 忌口 `avoid_tags` | 标签命中 / `allergens` 命中即出局 | 死命令，微辣也避开 |
| 预算 | 超 20% 才砍 | 略超留着当备选 |

### 软约束（只进 `rank` 打分，绝不参与硬过滤）

- **场景 `scene`**：只给带匹配标签的商品加权（如海边 → 带"便携/清爽"标签的加分），**不要求商品必须有 `scenes:['海边']`**。
- **情绪 `emotion`**：同理，弱加权。
- `CALM_SCENES`（海边/办公室等轻松场景压重辣）只在**用户没开口要辣**时生效；用户明说"要辣"时场景不能反客为主。

### `buildReasons` 理由必须落到商品自身（杜绝假理由）

- "冲着你要的X挑的"里的 X，**只认商品自己 `taste_tags` 真有的口味**（辣味还需 `spicy>0` 佐证）——绝不靠 `matched` 里碰巧命中的场景/情绪词。
- 商品不带用户说的场景标签时，写"虽然不一定是${scene}专属，但在${scene}吃也很爽"，**不许吹成场景专属**。
- `matchLocalFallback`（兜底链路）走的是**同一份** `violateHardConstraint`，但**不传 `required_taste`**——点名商品不应被口味硬过滤误伤，这是刻意的保守。

### 找零不凑数

`needFollowUp` 口径：有货（`ranked.length>=1`）就出卡片，只有**一款都没有**才追问。
候选不足 3 款且用户点名了口味时，由 `runLocalWorkflow` 生成 `shortfall_note`（"海边带辣的确实少…要不要看看别的"），
经 `composeRecommendReply` 的 `hint` 接在气泡末句——**诚实说货少，绝不假装很丰富**。

### 守卫

`scripts/reco-guard.ts`（`npm run guard` 的一部分）守住以上四条，改这块务必让它过：

1. 要辣 → 推出来的全是辣的，不辣的进 `filtered_out` 且原因明确；
2. 海边+要辣 → 火鸡面/辣味花生这类重辣款不被场景误杀；
3. 写"冲着你要的辣味"的卡一定真辣；不带场景标签的卡诚实写"不一定专属"；
4. `needFollowUp(0)` 追问、`needFollowUp(1/3)` 不追问。

---

## 【价格档位：四处必须同步】

预算档位只有三档：**30元内 / 30-60元 / 60元以上**（旧的两档 `10元内 / 10-30元` 已废弃）。任何一处动档位，四处都得改且保持一致，否则 `profile-guard` / smoke 直接红：

1. `app/page.tsx` 的 `BUDGETS` 常量（前端筛选栏）
2. `lib/llm/local-workflow.ts` 的 `BUDGET_MAP`（硬过滤阈值）
3. `lib/prompts/system-prompt.ts` 的价格档位文案（让模型按新档说）
4. `lib/llm/index.ts` 的 `CHEAP_PATTERN` 分支（`"便宜点" → "30元内"`，否则长期记忆把"便宜点"记成旧档位）

`scripts/profile-guard.ts` 的预算断言（`budgetFromText("30元内").max === 30`）盯着这张表，改档位别忘了它。

---

## 其他约定

- 回归测试入口：`npm run smoke`（60 条用例，需先启动 dev server；用例数会随功能增加，以脚本实际输出为准）。
- 业务删除一律**软删除**（保留痕迹便于追溯）；仅 smoke 测试用户走物理清理。
- 详细待办与已知问题清单见 `系统prompt汇总.md` 第 9 节。
