'use client';

import { useState } from 'react';

import { BUDGETS, FLAVORS, PROFILE_LABEL } from './constants';
import type { Filters } from './types';

/** 左侧口味栏 / 移动端抽屉 / 深色品牌卡里的同一份筛选面板 */
export function FilterPanel({
  filters,
  onToggle,
  onClear,
  active,
  profile,
  onForget,
  dark,
}: {
  filters: Filters;
  onToggle: (key: keyof Filters, value: string) => void;
  onClear: () => void;
  active: string[];
  /** 对话里攒下来的长期偏好，显示出来才知道脆脆记住了什么 */
  profile: Record<string, string>;
  onForget: (key: string) => void;
  /** 深色品牌卡内的适配样式：bg-white/10 + white/20 边框，不再用白底 */
  dark?: boolean;
}) {
  /** 记太多会把侧栏撑满，默认只露 3 条，其余折叠 */
  const [showAllProfile, setShowAllProfile] = useState(false);
  const remembered = Object.entries(profile);
  const shownRemembered = showAllProfile ? remembered : remembered.slice(0, 3);
  const hiddenCount = remembered.length - shownRemembered.length;

  return (
    <div className="space-y-5">
      <FilterGroup
        title="口味"
        items={FLAVORS}
        value={filters.flavor}
        onPick={(v) => onToggle('flavor', v)}
        dark={dark}
      />
      <FilterGroup
        title="价格"
        items={BUDGETS}
        value={filters.budget}
        onPick={(v) => onToggle('budget', v)}
        dark={dark}
      />

      <div
        className={
          dark ? 'rounded-2xl border border-white/20 bg-white/5 p-3' : 'rounded-2xl border border-slate-200 bg-white p-3 shadow-sm'
        }
      >
        <div className={`mb-2 text-xs font-bold ${dark ? 'text-white/50' : 'text-slate-500'}`}>
          当前偏好
        </div>

        {/* 手选的：这次说了要什么 */}
        {active.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {active.map((a) => (
              <span
                key={a}
                className="rounded-full bg-cx-300 px-2.5 py-1 text-xs font-semibold text-white"
              >
                {a}
              </span>
            ))}
          </div>
        )}

        {/* 长期记住的：聊出来过，跨会话一直生效 */}
        {remembered.length > 0 && (
          <div className={active.length ? 'mt-2' : ''}>
            <div className={`mb-1 text-[11px] ${dark ? 'text-white/40' : 'text-slate-400'}`}>
              一直记着
            </div>
            <div className="flex flex-wrap gap-1.5">
              {shownRemembered.map(([k, v]) => (
                <span
                  key={k}
                  className={
                    dark
                      ? 'inline-flex items-center gap-1 rounded-full border border-white/20 bg-white/10 px-2.5 py-1 text-xs font-semibold text-slate-200'
                      : 'inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-2.5 py-1 text-xs font-semibold text-slate-600 shadow-sm'
                  }
                >
                  {PROFILE_LABEL[k] || k}·{v}
                  <button
                    onClick={() => onForget(k)}
                    className={dark ? 'text-white/40 hover:text-white' : 'text-slate-300 hover:text-slate-600'}
                    aria-label="忘掉这条"
                  >
                    ✕
                  </button>
                </span>
              ))}
              {hiddenCount > 0 && (
                <button
                  onClick={() => setShowAllProfile(true)}
                  className={`inline-flex min-h-[40px] items-center rounded-full border border-dashed px-3 py-1 text-xs font-semibold ${
                    dark
                      ? 'border-white/20 text-white/50 hover:bg-white/10'
                      : 'border-slate-300 text-slate-500 hover:bg-slate-50'
                  }`}
                >
                  +{hiddenCount}
                </button>
              )}
              {showAllProfile && remembered.length > 3 && (
                <button
                  onClick={() => setShowAllProfile(false)}
                  className={`inline-flex min-h-[40px] items-center rounded-full px-3 py-1 text-xs ${
                    dark ? 'text-white/40 hover:text-white' : 'text-slate-400 hover:text-slate-600'
                  }`}
                >
                  收起
                </button>
              )}
            </div>
          </div>
        )}

        {!active.length && !remembered.length && (
          <p className={`text-xs ${dark ? 'text-white/40' : 'text-slate-400'}`}>
            还没选，脆脆会按你聊天里的意思来
          </p>
        )}

        {active.length > 0 && (
          <button
            onClick={onClear}
            className={`mt-2 text-xs underline-offset-2 hover:underline ${
              dark ? 'text-white/60' : 'text-slate-500'
            }`}
          >
            清空手选
          </button>
        )}
      </div>

      <p className={`text-[11px] leading-relaxed ${dark ? 'text-white/40' : 'text-slate-400'}`}>
        选了之后直接说「来点吃的」就行，不用再重复口味。「一直记着」是从聊天里攒下来的，长期生效。
      </p>
    </div>
  );
}

function FilterGroup({
  title,
  items,
  value,
  onPick,
  dark,
}: {
  title: string;
  items: { label: string; icon: string }[];
  value?: string;
  onPick: (v: string) => void;
  dark?: boolean;
}) {
  return (
    <div>
      <h3 className={`mb-2 text-xs font-bold tracking-wider ${dark ? 'text-white/40' : 'text-slate-400'}`}>
        {title}
      </h3>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => {
          const on = value === it.label;
          return (
            <button
              key={it.label}
              onClick={() => onPick(it.label)}
              className={`inline-flex min-h-[40px] items-center rounded-full border px-3 py-1.5 text-xs transition ${
                on
                  ? 'border-cx-500 bg-cx-500 font-semibold text-white shadow'
                  : dark
                    ? 'border-white/20 bg-white/10 text-slate-200 hover:bg-white/20'
                    : 'border-slate-200 bg-white text-slate-600 shadow-sm hover:bg-slate-50'
              }`}
            >
              <span className="mr-1">{it.icon}</span>
              {it.label}
              {/* 选中态除了底色再加个勾，扫一眼就知道选了什么 */}
              {on && <span className="ml-1 text-[10px]">✓</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
