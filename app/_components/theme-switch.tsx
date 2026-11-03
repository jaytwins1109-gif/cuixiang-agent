'use client';

import { useState } from 'react';

import { THEMES, type ThemeKey } from './constants';

/**
 * 换皮肤入口：平时就是一个小色点，点了才弹出三个选项。
 * 做成这么克制是因为它属于"顺手改一次就不用管"的设置，不该跟推荐入口抢位置。
 */
export function ThemeSwitch({
  theme,
  onChange,
}: {
  theme: ThemeKey;
  onChange: (key: ThemeKey) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = THEMES.find((t) => t.key === theme) ?? THEMES[0];

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-10 w-10 items-center justify-center rounded-full p-2 opacity-55 transition hover:bg-cx-50 hover:opacity-100"
        title="换个颜色"
        aria-label="切换皮肤"
        aria-expanded={open}
      >
        <span
          className="block h-3.5 w-3.5 rounded-full ring-1 ring-black/10"
          style={{ backgroundColor: current.dot }}
        />
      </button>

      {open && (
        <>
          {/* 点别处收起：铺一层透明底比给 window 挂监听省心 */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-32 animate-fade-in rounded-xl border border-cx-200 bg-white p-1.5 shadow-card">
            {THEMES.map((t) => (
              <button
                key={t.key}
                onClick={() => {
                  onChange(t.key);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition hover:bg-cx-50 ${
                  t.key === theme ? 'font-bold text-cx-700' : 'text-cx-600'
                }`}
              >
                <span
                  className="h-3 w-3 shrink-0 rounded-full ring-1 ring-black/10"
                  style={{ backgroundColor: t.dot }}
                />
                <span className="flex-1">{t.label}</span>
                {t.key === theme && <span className="text-[10px] text-cx-400">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
