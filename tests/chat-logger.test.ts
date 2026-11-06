/**
 * 聊天日志落库的纯函数单测（lib/chat/logger.ts）。
 *
 * ADMIN_REVIEW_SCOPE 是隐私边界：guest_only 模式下注册用户的对话**不落库**，
 * 这两条断言挂了等于把个人数据记进审查表。落库本身是 fire-and-forget（不测 DB），
 * 这里只固化开关判定与卡片精简两个纯函数。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shouldLog, slimCards } from '@/lib/chat/logger';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('ADMIN_REVIEW_SCOPE 开关', () => {
  it('未配置 → 默认 all：游客与注册用户都记', () => {
    vi.stubEnv('ADMIN_REVIEW_SCOPE', '');
    expect(shouldLog(true)).toBe(true);
    expect(shouldLog(false)).toBe(true);
  });

  it('all → 都记', () => {
    vi.stubEnv('ADMIN_REVIEW_SCOPE', 'all');
    expect(shouldLog(true)).toBe(true);
    expect(shouldLog(false)).toBe(true);
  });

  it('guest_only → 只记游客，注册用户跳过', () => {
    vi.stubEnv('ADMIN_REVIEW_SCOPE', 'guest_only');
    expect(shouldLog(true)).toBe(true);
    expect(shouldLog(false)).toBe(false);
  });

  it('大小写与首尾空格不敏感', () => {
    vi.stubEnv('ADMIN_REVIEW_SCOPE', ' GUEST_ONLY ');
    expect(shouldLog(false)).toBe(false);
    expect(shouldLog(true)).toBe(true);
  });

  it('配置成别的值 → 按 all 处理（不会误伤记录）', () => {
    vi.stubEnv('ADMIN_REVIEW_SCOPE', 'whatever');
    expect(shouldLog(false)).toBe(true);
  });
});

describe('推荐卡精简', () => {
  it('只留四件套：name / price / reason / emoji', () => {
    const slim = slimCards([
      {
        name: '海苔脆片原味装',
        price: 29.9,
        reason: '口味清淡',
        emoji: '🍙',
        tags: ['咸味'],
        spicy: 0,
        margin: 43,
        sku_id: 'SKU001',
      },
    ]);
    expect(slim).toEqual([
      { name: '海苔脆片原味装', price: 29.9, reason: '口味清淡', emoji: '🍙' },
    ]);
  });

  it('非数组 / 空数组 → null（user 轮与无卡轮不落 cards）', () => {
    expect(slimCards(undefined)).toBeNull();
    expect(slimCards(null)).toBeNull();
    expect(slimCards([])).toBeNull();
    expect(slimCards('not an array')).toBeNull();
  });
});
