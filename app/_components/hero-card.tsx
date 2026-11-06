'use client';

import { SCENES } from './constants';

/**
 * 左侧信息卡片（V3.0 步骤 7 SaaS 化改版）：
 * 头像 + 问候语 + 快捷场景竖排入口。
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
    <div className="rounded-3xl bg-white p-5 shadow-sm">
      {/* 占位头像：呼吸动画让页面“活着”，等真形象接入后换 <img> */}
      <div className="flex items-center gap-3">
        <span className="relative flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-amber-200 to-orange-300 text-2xl shadow-inner animate-pulse">
          🥜
        </span>
        <div>
          <div className="text-base font-bold text-slate-800">嘿，我是脆脆</div>
          <div className="text-xs text-slate-400">今天想吃点什么？</div>
        </div>
      </div>

      {/* 快捷场景：竖排小按钮，点一句就聊起来 */}
      <div className="mt-4 space-y-1.5 border-t border-slate-100 pt-4">
        {SCENES.map((s) => (
          <button
            key={s.title}
            onClick={() => onScene(s.text)}
            disabled={busy}
            className="group flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition hover:bg-slate-50 disabled:opacity-40"
          >
            <span className="text-lg transition group-hover:scale-110">{s.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium text-slate-700">{s.title}</span>
              <span className="block truncate text-[11px] text-slate-400">{s.sub}</span>
            </span>
            <span className="text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-400">
              →
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** 骨架气泡：首个 delta 还没到时的“脆脆在想”占位（animate-pulse 呼吸灯） */
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
