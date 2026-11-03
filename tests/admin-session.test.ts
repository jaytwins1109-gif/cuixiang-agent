/**
 * 后台会话票据（`lib/admin/session.ts`）的纯函数单测。
 *
 * 事故原型：`cx_admin=1` 是常量 cookie，DevTools 手写一条就进后台。
 * 这些断言（伪造 / 换密钥 / 篡改过期 / 篡改签名 / 过期 / 畸形值）
 * 以前是临时脚本跑完就删掉的，现在固化下来——改签名逻辑必须先过这一关。
 * 纯函数、时间可注入（`now` 参数），所以不依赖真实时钟、不会 flaky。
 */
import { describe, expect, it } from 'vitest';
import {
  createSessionTicket,
  verifySessionTicket,
  safeEqualHex,
  SESSION_MAX_AGE_SECONDS,
} from '@/lib/admin/session';

const SECRET = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const NOW = 1_700_000_000_000;
const ticket = createSessionTicket(SECRET, NOW);
const [exp, sig] = ticket.split('.');

describe('后台会话票据', () => {
  it('正常签发的票据能验过', () => {
    expect(verifySessionTicket(ticket, SECRET, NOW)).toBe(true);
  });

  it('有效期 8 小时（与 cookie maxAge 一致）', () => {
    expect(Number(exp)).toBe(Math.floor(NOW / 1000) + SESSION_MAX_AGE_SECONDS);
  });

  it('手写 cx_admin=1 混不进来', () => {
    expect(verifySessionTicket('1', SECRET, NOW)).toBe(false);
  });

  it('换了口令（密钥变了）→ 旧票据立即失效', () => {
    expect(verifySessionTicket(ticket, 'another-secret', NOW)).toBe(false);
  });

  it('篡改过期时间 → 签名对不上', () => {
    const forged = `${Number(exp) + 99999}.${sig}`;
    expect(verifySessionTicket(forged, SECRET, NOW)).toBe(false);
  });

  it('篡改签名 → 拒绝', () => {
    expect(verifySessionTicket(`${exp}.${'0'.repeat(64)}`, SECRET, NOW)).toBe(false);
  });

  it('过期 → 拒绝', () => {
    expect(verifySessionTicket(ticket, SECRET, NOW + SESSION_MAX_AGE_SECONDS * 1000 + 1)).toBe(
      false,
    );
  });

  it('没配 ADMIN_PASSWORD_HASH（后台没开）→ 一律未登录', () => {
    expect(verifySessionTicket(ticket, undefined, NOW)).toBe(false);
  });

  it('畸形值只拒绝、不抛异常', () => {
    const bad: (string | undefined | null)[] = [
      '',
      '.',
      'abc.def',
      '123.',
      '.abc',
      '123.' + 'z'.repeat(64),
      undefined,
      null,
    ];
    for (const v of bad) {
      expect(verifySessionTicket(v, SECRET, NOW)).toBe(false);
    }
  });
});

describe('口令常量时间比较', () => {
  it('相同 → true', () => {
    expect(safeEqualHex('abc', 'abc')).toBe(true);
  });

  it('不同 → false', () => {
    expect(safeEqualHex('abc', 'abd')).toBe(false);
  });

  it('长度不同 → false（不能抛 timingSafeEqual 的长度错）', () => {
    expect(safeEqualHex('abc', 'abcd')).toBe(false);
  });
});
