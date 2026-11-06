'use client';

import { SCENES } from './constants';

/**
 * 左侧品牌卡片（深色沉浸式，对齐参考稿）：
 * eyebrow + 3D 头像占位 + 大标题 + 快捷咨询竖排按钮 + 底部版权。
 * 纯展示组件：场景点击直接复用既有的 send()，不带任何状态。
 */
export function HeroCard({
  onScene,
  busy,
}: {
  onScene: (text: string) => void;
  /** 对话进行中时场景按钮禁用（与输入框发送按钮同一语义） */
  busy: boolean;
}) {
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
        <p className="mt-2 text-xs leading-relaxed text-white/50">
          从入职第一天，到日常想吃点什么，
          <br />
          聊着聊着，它就记住了。
        </p>
      </div>

      {/* 快捷咨询竖排：bg-white/10 半透明底，右侧箭头 */}
      <div className="mt-6 space-y-2">
        <div className="text-[11px] font-semibold tracking-wider text-white/40">常见咨询</div>
        {SCENES.map((s) => (
          <button
            key={s.title}
            onClick={() => onScene(s.text)}
            disabled={busy}
            className="group flex w-full items-center gap-3 rounded-xl bg-white/10 px-4 py-3 text-left transition hover:bg-white/20 disabled:opacity-40"
          >
            <span className="text-lg transition group-hover:scale-110">{s.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{s.title}</span>
              <span className="block truncate text-[11px] text-white/50">{s.sub}</span>
            </span>
            <span className="text-white/30 transition group-hover:translate-x-0.5 group-hover:text-white/60">
              →
            </span>
          </button>
        ))}
      </div>

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
