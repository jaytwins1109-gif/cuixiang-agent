/**
 * 长期偏好守卫的 vitest 版。
 *
 * 断言逻辑**没有第二份**：直接调 `scripts/profile-guard.ts` 导出的 `runProfileGuard()`，
 * 同一批用例既能被 `npm run guard` / smoke 当 CLI 跑，也能在这里当正式单测跑。
 * 一条用例一个 `it`，失败时能看到具体是哪个说法抽错了，而不是"整份脚本红了"。
 */
import { describe, expect, it } from 'vitest';
import { runProfileGuard } from '../scripts/profile-guard';

const results = runProfileGuard();

describe('profile-guard：长期偏好必须有出处', () => {
  it('用例没有跑空（守卫文件被改坏时先在这里发现）', () => {
    expect(results.length).toBeGreaterThan(30);
  });

  for (const r of results) {
    it(r.name, () => {
      // 第二个参数是失败时的说明：把实际值贴出来
      expect(r.pass, r.actual).toBe(true);
    });
  }
});
