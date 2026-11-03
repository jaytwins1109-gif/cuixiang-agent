// scripts/profile-guard.ts
// 长期偏好的守卫：**没有出处就不许沉淀**。
//
// 事故原型（2026-11-02）：用户一句「有什么好吃的」，模型自己填了
// `avoid=花生过敏` `flavor=辣味` `budget=30元内`，前端无条件合并 →
// 侧栏「一直记着」挂着用户从没说过的忌口，而忌口会真的执行，
// 用户从此吃不到花生，可他根本不过敏。
//
// 修法：模型当轮的 preferences 只服务本轮选品；能不能长期记住，
// 唯一的依据是本地 `extractPrefsFromText` 从**用户原话**里抽出来的那份。
//
// 三种跑法：
//   1. `npm run guard` / 直接 node --import ./scripts/ts-alias-register.mjs scripts/profile-guard.ts
//      → CLI 模式，打印 PASS / FAIL 行（smoke 也是拉这个，靠 `^(PASS|FAIL)\s` 解析，格式别改）
//   2. `npm run test` → tests/profile-guard.test.ts 把每条断言变成 vitest 用例
//   3. smoke 第 33 节 → 同样拉起 CLI
// 所以断言逻辑在 `runProfileGuard()` 里，`process.argv[1]` 判断了才走 CLI。

import { pickTrustedProfile, cleanProfile, extractMemoryKeyword } from '@/lib/chat/handlers';
import { extractPrefsFromText } from '@/lib/llm';
import { avoidTagsFromText, budgetFromText } from '@/lib/llm/local-workflow';
import type { GuardResult } from './guard-types';

export function runProfileGuard(): GuardResult[] {
  const results: GuardResult[] = [];
  const report = (ok: boolean, name: string, actual: string) => {
    results.push({ name, pass: !!ok, actual });
  };
  const keys = (o: Record<string, string>) => Object.keys(o).sort().join('/') || '（空）';

  /** 事故本体：用户什么都没提，模型脑补了一整套偏好——一个都不许留下 */
  const ghost = pickTrustedProfile('有什么好吃的', {
    flavor: '辣味',
    budget: '30元内',
    avoid: '花生过敏',
    texture: '脆',
  });
  report(Object.keys(ghost).length === 0, '空请求 + 模型脑补 → 一条都不长期化', keys(ghost));

  /** 原话里真说了的，要留下来（长期化通道没被整个关死） */
  const real = pickTrustedProfile('我花生过敏，来点吃的', {
    avoid: '花生过敏',
    flavor: '辣味',
  });
  report(real.avoid === '花生过敏', '用户说了「花生过敏」→ 记住忌口', keys(real));

  /** 只说了忌口，模型顺手填的口味不算数 */
  const avoidOnly = pickTrustedProfile('来点不辣的', {
    avoid: '不吃辣',
    flavor: '甜味',
  });
  report(
    avoidOnly.avoid === '不吃辣' && !('flavor' in avoidOnly),
    '只说了「不辣」→ 忌口记住、模型填的甜味不要',
    keys(avoidOnly),
  );

  /** 预算：本地抽得到（"便宜点"）才留 */
  const cheap = pickTrustedProfile('便宜点，有啥吃的', { budget: '30元内' });
  report(cheap.budget === '30元内', '说了「便宜点」→ 记住 30元内', keys(cheap));

  /** 出处②：模型填的词原样出现在用户原话里——「来点30元内的」本地嫌贵说法没命中，但确实是用户说的 */
  const literal = pickTrustedProfile('来点30元内的 snacks', { budget: '30元内' });
  report(literal.budget === '30元内', '字面出处：「来点30元内的」→ 记住预算', keys(literal));

  /** 反向对照：空请求里模型填的值，在原话里找不到 → 仍然不沉淀 */
  const literalMiss = pickTrustedProfile('随便给我来点', { budget: '30元内' });
  report(!('budget' in literalMiss), '反向对照：原话里没提「30元内」→ 不沉淀', keys(literalMiss));

  /** 「不限」既不是本地能抽到的，也不是选品认得的档位 */
  const unlimited = pickTrustedProfile('随便来点', { budget: '不限' });
  report(!('budget' in unlimited), '「预算·不限」不进长期偏好', keys(unlimited));

  /** 反向对照：明说要辣的，口味要留得住，别把长期化通道整个关死 */
  const spicy = pickTrustedProfile('我要辣的，来点零食', { flavor: '辣味' });
  report(spicy.flavor === '辣味', '反向对照：说了「辣的」→ 口味记住', keys(spicy));

  /** 过敏原覆盖：长期化全靠本地抽，漏一个就等于用户说了白说 */
  for (const [text, expect] of [
    ['我花生过敏', '花生过敏'],
    ['对坚果不行', '坚果过敏'],
    ['吃海鲜过敏', '海鲜过敏'],
    ['我乳糖不耐', '乳制品过敏'],
  ] as const) {
    const p = extractPrefsFromText(text);
    report(p.avoid === expect, `过敏原覆盖：「${text}」→ ${expect}`, p.avoid || '（空）');
  }

  /**
   * **真人口语**用例：上面那组是"标准说法"，可用户不会照着正则说话。
   * 长期化全靠本地抽，这类"吃海鲜起疹子""喝牛奶拉肚子"抽不到就等于说了白说——
   * 记不住的忌口会一直漏给用户吃，比记错还危险。
   */
  for (const [text, expect] of [
    ['吃海鲜起疹子', '海鲜过敏'],
    ['喝牛奶拉肚子', '乳制品过敏'],
    ['吃完坚果身上痒', '坚果过敏'],
    ['我一吃花生就过敏', '花生过敏'],
  ] as const) {
    const p = extractPrefsFromText(text);
    report(p.avoid === expect, `真人口语：「${text}」→ ${expect}`, p.avoid || '（抽不到）');
  }

  /** 反向对照（最重要）：**想要**的说法绝不能被抽成过敏——方向反了比漏抽更糟 */
  for (const text of ['想吃坚果了', '来点花生', '想吃海鲜', '想喝牛奶']) {
    const p = extractPrefsFromText(text);
    report(p.avoid === undefined, `反向对照：「${text}」不能抽成忌口`, p.avoid || '（空，正确）');
  }

  /** 抽出来的忌口必须能翻译成硬过滤标签，否则等于记了但拦不住 */
  for (const avoid of ['花生过敏', '坚果过敏', '海鲜过敏', '乳制品过敏']) {
    report(
      avoidTagsFromText(avoid).length > 0,
      `忌口「${avoid}」能翻译成硬过滤标签`,
      avoidTagsFromText(avoid).join('/') || '（空）',
    );
  }

  /** 回给前端的与内部合并的必须是同一套口径 */
  const dirty = { flavor: '甜味', budget: '不限', scene: '看海', avoid: '花生过敏' };
  report(
    keys(cleanProfile('随便', dirty)) === keys(pickTrustedProfile('随便', dirty)),
    'cleanProfile 与 pickTrustedProfile 同一套口径',
    `clean=${keys(cleanProfile('随便', dirty))}`,
  );

  /** 选品口径（sanitizeProfile 那一路）不要求出处，但仍挡「不限」 */
  report(
    budgetFromText('30元内').max === 30 && budgetFromText('不限').max === null,
    '预算档位表本身没被改坏',
    `30元内=${budgetFromText('30元内').max} / 不限=${budgetFromText('不限').max}`,
  );

  /**
   * 删除关键词：正向偏好说法也要抠得出**偏好对象本身**。
   *
   * 事故原型（2026-11-03）：说「忘掉我喜欢辣味」，正则末尾那条
   * `喜欢[^…]{1,6}` 把动词一起抠成了「喜欢辣味」，`deleteMemory` 拿它去
   * `includes` 比不中 memory 里的「辣味」，于是回"你要我忘掉哪条，我不猜"——
   * 用户明明说了要忘，系统当他没说清。
   */
  for (const [text, expect] of [
    ['忘掉我喜欢辣味', '辣味'],
    ['忘掉我爱吃甜的', '甜'],
    ['忘掉我喜欢嚼感', '嚼感'],
    ['忘掉辣味', '辣味'], // 侧栏 ✕ 发来的原话，不能改坏
    ['忘掉我花生过敏', '花生过敏'],
    ['忘了我说过不吃辣', '不吃辣'],
  ] as const) {
    const kw = extractMemoryKeyword(text);
    report(kw === expect, `删除关键词：「${text}」→ ${expect}`, kw || '（抠不出）');
  }

  /** 反向对照：动词后面不是已知偏好时，兜底只取宾语，不许把「喜欢」带出去 */
  report(
    extractMemoryKeyword('忘掉我喜欢薯片') === '薯片',
    '兜底只取动词后面的宾语',
    extractMemoryKeyword('忘掉我喜欢薯片') || '（抠不出）',
  );
  report(
    extractMemoryKeyword('忘掉吧') === '',
    '反向对照：没有偏好词就老实抠不出（不瞎猜）',
    extractMemoryKeyword('忘掉吧') || '（空，正确）',
  );

  return results;
}

/** 只有被 node 直接执行时才打印 + 退出；被 vitest import 时什么都不做 */
const isCli = process.argv[1]?.replace(/\\/g, '/').endsWith('/scripts/profile-guard.ts');
if (isCli) {
  const results = runProfileGuard();
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name} — ${r.actual}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`GUARD_FAILED=${failed}`);
  process.exit(failed ? 1 : 0);
}
