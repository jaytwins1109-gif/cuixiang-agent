/**
 * 记忆查询意图 + 侧栏快照校正。
 *
 * 事故：用户问「我喜欢什么口味」（侧栏挂着「口味·辣味」），系统没走本地记忆查询，
 * 模型回"我哪知道啊，咱俩才聊几句"——既失忆又顶撞人。
 * 根因是 `MEMORY_QUERY_PATTERN` 只认第二视角的"你记得我什么"，
 * 第一视角（"我喜欢什么""我喜好啥"）一条都不命中。
 *
 * 这里把两类问法都钉死，同时钉住"别把授权 / 表态 / 问吃什么误判成查记忆"。
 */
import { describe, expect, it } from 'vitest';
import { detectMemoryIntent, renderMemoryReply } from '@/lib/chat/handlers';
import { mergeProfileExclusive, reconcileProfileWithMemory } from '@/app/_components/storage';

describe('记忆查询：第一视角的问法必须本地办结', () => {
  it('「我喜欢什么口味」这类直接问偏好的', () => {
    expect(detectMemoryIntent('我喜欢什么口味')).toBe('query');
    expect(detectMemoryIntent('我喜好啥')).toBe('query');
    expect(detectMemoryIntent('我爱吃什么')).toBe('query');
    expect(detectMemoryIntent('我平时喜欢什么来着')).toBe('query');
    expect(detectMemoryIntent('我平时喜欢吃什么来着')).toBe('query');
  });

  it('「你记住我啥口味了吗」这类第二视角的变体', () => {
    expect(detectMemoryIntent('你记住我啥口味了吗')).toBe('query');
    expect(detectMemoryIntent('你还记得我吗')).toBe('query');
    expect(detectMemoryIntent('你都记了什么')).toBe('query');
  });

  it('「我不是跟你说过吗」这类带火气的提醒 → 本地秒回记忆', () => {
    expect(detectMemoryIntent('我不是跟你说过吗')).toBe('query');
    expect(detectMemoryIntent('我不是和你说过吗')).toBe('query');
    expect(detectMemoryIntent('我不是告诉你了吗')).toBe('query');
    expect(detectMemoryIntent('我不是跟你说过吗？')).toBe('query');
  });

  it('「我的偏好是啥」「我有什么忌口」', () => {
    expect(detectMemoryIntent('我的偏好是啥')).toBe('query');
    expect(detectMemoryIntent('我的口味是什么')).toBe('query');
    expect(detectMemoryIntent('我有什么忌口')).toBe('query');
    expect(detectMemoryIntent('你知道我不吃辣吗')).toBe('query');
  });

  it('「我的偏好呢」——停在语气词上的追问也算', () => {
    expect(detectMemoryIntent('我的偏好呢')).toBe('query');
    expect(detectMemoryIntent('我的忌口呢')).toBe('query');
    expect(detectMemoryIntent('我的口味呢？')).toBe('query');
  });
});

describe('记忆查询的反向闸：别把正常说话当成查记忆', () => {
  it('放权语气（"都行/你看着推"）不算提问', () => {
    expect(detectMemoryIntent('我喜欢什么都行，你看着推')).toBeNull();
    expect(detectMemoryIntent('我吃啥都可以，随便来点')).toBeNull();
  });

  it('问吃什么 ≠ 问记忆', () => {
    expect(detectMemoryIntent('我吃什么好呢')).toBeNull();
    expect(detectMemoryIntent('我今天想吃点辣的')).toBeNull();
  });

  it('陈述偏好不是提问', () => {
    expect(detectMemoryIntent('我平时都喜欢吃辣的')).toBeNull();
    expect(detectMemoryIntent('我的口味比较重')).toBeNull();
  });

  it('「不是跟你说过」后面还带新信息的，不许当纯查询吞掉', () => {
    // 这句里的「我吃辣」是这轮新说的事实，本地直接回记忆清单就等于没听见
    expect(detectMemoryIntent('我不是跟你说过我吃辣吗')).toBeNull();
    expect(detectMemoryIntent('我不是告诉你了，我不吃辣')).toBeNull();
  });

  it('删除 / 全清的优先级不被打乱', () => {
    expect(detectMemoryIntent('忘掉我喜欢辣味')).toBe('delete');
    expect(detectMemoryIntent('全都忘掉')).toBe('clear');
    expect(detectMemoryIntent('记住我喜欢吃辣的')).toBeNull();
  });
});

describe('记忆查询话术', () => {
  it('有记忆 → 列出来并留话口', () => {
    const reply = renderMemoryReply({
      core_profile: ['不吃辣：不吃辣'],
      summary_memory: [],
      active_fragments: [],
      pending_fragments: [],
    });
    expect(reply).toContain('不吃辣');
    expect(reply).toContain('记着这些');
  });

  it('没记忆 → 不许说"我哪知道"这类抬杠话', () => {
    const reply = renderMemoryReply({
      core_profile: [],
      summary_memory: [],
      active_fragments: [],
      pending_fragments: [],
    });
    expect(reply).not.toMatch(/我哪知道|才聊几句|你没说过/);
  });
});

describe('侧栏快照校正：服务端没有的，界面不许挂', () => {
  it('服务端一条都没有 → 本地全清（一次性需求不写长期记忆）', () => {
    expect(
      reconcileProfileWithMemory(
        { flavor: '辣味', budget: '30元内' },
        { core_profile: [], summary_memory: [], active_fragments: [] },
      ),
    ).toEqual({});
  });

  it('服务端记着忌口 → 同轴的口味标签让位，忌口保留', () => {
    expect(
      reconcileProfileWithMemory(
        { flavor: '辣味', avoid: '不吃辣' },
        { core_profile: ['不吃辣：不吃辣'], summary_memory: [], active_fragments: [] },
      ),
    ).toEqual({ avoid: '不吃辣' });
  });

  it('服务端记着口味 → 口味标签保留（"辣味"折成"辣"也能对上）', () => {
    expect(
      reconcileProfileWithMemory(
        { flavor: '辣味' },
        { core_profile: ['辣=喜欢辣'], summary_memory: [], active_fragments: [] },
      ),
    ).toEqual({ flavor: '辣味' });
  });

  it('预算对得上就留', () => {
    expect(
      reconcileProfileWithMemory(
        { budget: '30元内' },
        { core_profile: ['预算：30元内'], summary_memory: [], active_fragments: [] },
      ),
    ).toEqual({ budget: '30元内' });
  });
});

describe('applyPayload 的顺序约定：先校正快照，再合并本轮偏好', () => {
  /**
   * 这里组合的是 `app/page.tsx` 的调用顺序（两个纯函数按同一顺序串起来）：
   *   1. reconcileProfileWithMemory(prev, memory)  —— 清掉服务端没记过的历史缓存
   *   2. mergeProfileExclusive(cleared, incoming)  —— 合入本轮有出处的新偏好
   *
   * 现场：prev 挂着「口味·辣味」，本轮说「甜甜的，不能是辣的」→
   * 服务端记下「不吃辣」（同轴旧辣味作废），回包 profile 是 甜味 + 忌口。
   * 反序（先合并再校正）会把「甜味」当成"服务端没记"洗掉——一次性口味按设计不写长期记忆。
   */
  it('旧「辣味」被清掉，本轮「甜味 + 忌口」留下', () => {
    const prev = { flavor: '辣味' };
    const memory = {
      core_profile: ['不吃辣：不吃辣'],
      summary_memory: [],
      active_fragments: [],
    };
    const incoming = { flavor: '甜味', avoid: '不吃辣' };

    const cleared = reconcileProfileWithMemory(prev, memory);
    const next = mergeProfileExclusive(cleared, incoming);

    expect(cleared).toEqual({});
    expect(next).toEqual({ flavor: '甜味', avoid: '不吃辣' });
  });
});
