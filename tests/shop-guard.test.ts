/**
 * `/shop` 0 Token 红线的 vitest 版。
 *
 * 与另外两个守卫同一套：断言只在 `scripts/shop-guard.ts` 里写一份，
 * CLI（npm run guard / smoke 第 39 节）和这里共用 `runShopGuard()`。
 * 守卫会读源码文件，所以这里的 cwd 必须是项目根（vitest 默认就是）。
 */
import { describe, expect, it } from 'vitest';
import { runShopGuard, shopImportChain } from '../scripts/shop-guard';

const results = runShopGuard();
const sections = [...new Set(results.map((r) => r.section ?? ''))];

describe('shop-guard：/shop 页面内不消耗 Token', () => {
  it('用例没有跑空（扫描链或断言被改坏时先在这里发现）', () => {
    expect(results.length).toBeGreaterThan(10);
    expect(shopImportChain().length).toBeGreaterThanOrEqual(3);
  });

  for (const s of sections) {
    describe(s || '未分组', () => {
      for (const r of results.filter((x) => (x.section ?? '') === s)) {
        it(r.name, () => {
          expect(r.pass, r.actual).toBe(true);
        });
      }
    });
  }
});
