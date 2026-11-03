/**
 * 检索/推荐守卫的 vitest 版。
 *
 * 与 profile-guard 同样的思路：断言只在 `scripts/reco-guard.ts` 里写一份，
 * 这里按【检索】【理由】【兜底】【文案】分组，一条用例一个 `it`。
 */
import { describe, expect, it } from 'vitest';
import { runRecoGuard } from '../scripts/reco-guard';

const results = runRecoGuard();
const sections = [...new Set(results.map((r) => r.section ?? ''))];

describe('reco-guard：强约束 / 诚实理由 / 气泡文案', () => {
  it('用例没有跑空', () => {
    expect(results.length).toBeGreaterThan(15);
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
