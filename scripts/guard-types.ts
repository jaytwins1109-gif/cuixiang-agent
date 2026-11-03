// scripts/guard-types.ts
// 守卫用例的统一形状。
//
// 为什么要有这层：守卫以前是"顶层跑完就 process.exit"的脚本，
// 只能在 node 里整份跑、靠 PASS/FAIL 行肉眼/正则看结果。
// 现在同一批断言有两个消费方：
//   1. `npm run guard` / smoke 拉起 CLI（保持原来的 PASS / FAIL 行格式不变）
//   2. vitest（tests/*.test.ts）把每条断言变成一个正式用例
// 所以断言逻辑下沉成"返回结果数组"的纯函数，打印与退出码交给各自的外壳。
export type GuardResult = {
  /** 用例名（CLI 里就是 PASS 后面那段） */
  name: string;
  /** 断言是否通过 */
  pass: boolean;
  /** 实际值，失败时贴出来便于排查 */
  actual: string;
  /** 分组标题（reco-guard 有【检索】【理由】【文案】这类小标题，vitest 里当 describe） */
  section?: string;
};
