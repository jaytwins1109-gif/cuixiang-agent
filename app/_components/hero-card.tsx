'use client';

import type { ReactNode } from 'react';

/**
 * 左侧品牌卡片（深色沉浸式，对齐参考稿）：
 * eyebrow + 3D 头像占位 + 大标题 + children（筛选面板插槽）+ 底部版权。
 * children 里的交互（选口味/价格/忘偏好）直接复用 page 的既有回调，本组件不带状态。
 */
export function HeroCard({ children }: { children?: ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col rounded-3xl bg-[#1E293B] p-6 text-white">
      {/* eyebrow 行：品牌定位 + 在线状态 */}
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[0.18em] text-white/40">
          YOUR SNACK COMPANION
        </span>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[10px] font-semibold text-white/80">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
          在线
        </span>
      </div>

      {/* 3D 头像占位：呼吸动画让页面"活着"，等真形象接入后换 <img> */}
      <div className="mt-6 flex justify-center">
        <div className="relative">
          <span className="flex h-28 w-28 items-center justify-center rounded-3xl bg-gradient-to-br from-white/20 to-white/5 text-6xl shadow-inner ring-1 ring-white/10 animate-pulse">
            🧸
          </span>
          <span className="absolute -bottom-2 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-white/10 px-2.5 py-1 text-[10px] text-white/70 backdrop-blur">
            ⚡ 认识你，越聊越懂你
          </span>
        </div>
      </div>

      {/* 大标题 */}
      <div className="mt-7">
        <h1 className="text-xl font-extrabold leading-snug">
          我是脆脆，
          <br />
          你的零食好帮手。
        </h1>
        <p className="mt-2 text-xs leading-relaxed text-white/50">馋了直接说，想找人说话也行。</p>
      </div>

      {/* 筛选面板插槽：口味/价格/当前偏好（page 传入深色适配的 FilterPanel） */}
      {children && <div className="mt-6">{children}</div>}

      {/* 底部版权：mt-auto 贴着卡片底 */}
      <div className="mt-auto pt-6">
        <p className="text-[10px] leading-relaxed text-white/30">
          脆香零食 · 数字零食助手 v3.0
          <br />© 2026 Cuixiang. All rights reserved.
        </p>
      </div>
    </div>
  );
}

/** 骨架气泡：首个 delta 还没到时的"脆脆在想"占位（animate-pulse 呼吸灯） */
export function SkeletonBubble() {
  return (
    <div className="flex items-end gap-2">
      <span className="mb-1 text-xl">🧸</span>
      <div className="w-56 space-y-2 rounded-bubble rounded-bl-md border border-slate-100 bg-white p-4 shadow-sm animate-pulse">
        <div className="h-3 w-3/4 rounded-full bg-slate-200" />
        <div className="h-3 w-full rounded-full bg-slate-100" />
        <div className="h-3 w-1/2 rounded-full bg-slate-100" />
      </div>
    </div>
  );
}
