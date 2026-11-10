/**
 * 能力边界守卫：凑单 / 大额预算 / 无意义输入 / 无数据问价。
 *
 * 这四类判断全部是纯函数（不碰库、不碰模型），所以直接在这里钉死口径。
 * 真实的入口行为（不进模型、不出卡片）由 smoke 覆盖。
 */
import { describe, expect, it } from 'vitest';
import {
  asksPrice,
  isMeaninglessInput,
  meaninglessStreak,
  outOfScopeKind,
  priceDataGuard,
  OUT_OF_SCOPE_REPLY,
  PRICE_DATA_MISSING_REPLY,
} from '@/lib/chat/handlers';

describe('凑单 / 大额预算：本地直接办结，不进模型', () => {
  it('凑单、满减、搭一套都算超出能力', () => {
    expect(outOfScopeKind('帮我凑单到200')).toBe('combo');
    expect(outOfScopeKind('满减怎么算')).toBe('combo');
    expect(outOfScopeKind('给我搭一套零食')).toBe('combo');
    expect(outOfScopeKind('来点组合装')).toBe('combo');
  });

  it('预算 ≥ 100 且确实在说预算 → 拦', () => {
    expect(outOfScopeKind('预算150元')).toBe('budget');
    expect(outOfScopeKind('200块以内随便来')).toBe('budget');
    expect(outOfScopeKind('最多花100元')).toBe('budget');
  });

  it('预算没到 100 → 正常走推荐', () => {
    expect(outOfScopeKind('预算80元')).toBeNull();
    expect(outOfScopeKind('30元内来点辣的')).toBeNull();
  });

  it('只是在聊天里提到钱 → 不能拦（否则答非所问）', () => {
    expect(outOfScopeKind('我昨天吃了200块的火锅')).toBeNull();
    expect(outOfScopeKind('这个月工资还没发')).toBeNull();
  });

  it('话术守人设：不用"您"', () => {
    expect(OUT_OF_SCOPE_REPLY).not.toContain('您');
    expect(OUT_OF_SCOPE_REPLY).toContain('3 款');
  });
});

describe('无意义输入：单条放行，连续 3 轮才收尾', () => {
  it('1~2 个数字或符号算无意义', () => {
    expect(isMeaninglessInput('1')).toBe(true);
    expect(isMeaninglessInput('3')).toBe(true);
    expect(isMeaninglessInput('？？')).toBe(true);
    expect(isMeaninglessInput('。。')).toBe(true);
    expect(isMeaninglessInput('')).toBe(true);
  });

  it('有汉字 / 字母 / 语气短词一律不算', () => {
    expect(isMeaninglessInput('嗯')).toBe(false);
    expect(isMeaninglessInput('ok')).toBe(false);
    expect(isMeaninglessInput('666')).toBe(false);
    expect(isMeaninglessInput('想吃辣的')).toBe(false);
    expect(isMeaninglessInput('123')).toBe(false);
  });

  it('连续计数只看用户发言，中间夹着我们的回复不算断', () => {
    const messages = [
      { role: 'user' as const, content: '1' },
      { role: 'assistant' as const, content: '想吃点啥？' },
      { role: 'user' as const, content: '2' },
      { role: 'assistant' as const, content: '嗯？' },
      { role: 'user' as const, content: '3' },
    ];
    expect(meaninglessStreak(messages)).toBe(3);
  });

  it('中间说过一句正经的 → 计数归零/重来', () => {
    const messages = [
      { role: 'user' as const, content: '1' },
      { role: 'user' as const, content: '2' },
      { role: 'user' as const, content: '想吃辣的' },
      { role: 'user' as const, content: '3' },
    ];
    expect(meaninglessStreak(messages)).toBe(1);
  });
});

describe('问价但没有真实价格数据：兜底替换', () => {
  it('问价 + 回复里有价 → 整句换兜底', () => {
    expect(priceDataGuard('多少钱', '大概 15 块吧')).toBe(PRICE_DATA_MISSING_REPLY);
    expect(priceDataGuard('贵不贵', '8元一份')).toBe(PRICE_DATA_MISSING_REPLY);
  });

  it('问价但回复没报价 → 原样放行', () => {
    expect(priceDataGuard('多少钱', '你想吃哪一挂的？')).toBe('你想吃哪一挂的？');
  });

  it('没问价 → 不插手（别把正常接话换掉）', () => {
    expect(priceDataGuard('来点辣的', '8元一份')).toBe('8元一份');
  });

  it('"太贵了"是改条件，不是问价', () => {
    expect(asksPrice('多少钱')).toBe(true);
    expect(asksPrice('贵不贵')).toBe(true);
    expect(asksPrice('太贵了')).toBe(false);
  });
});
