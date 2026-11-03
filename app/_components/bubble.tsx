'use client';

import { formatMsgTime } from './format';
import type { Msg } from './types';

/**
 * 气泡下方的时间。极淡、极小，知道这条是几点发的就够，不该跟话术抢注意力。
 * 没有 ts 的时间一律不显示（旧记录 / 服务端直出的欢迎语），宁缺勿假。
 */
export function MsgTime({ ts, mine }: { ts?: number; mine?: boolean }) {
  const text = formatMsgTime(ts);
  if (!text) return null;
  return (
    <div className={`mt-1 flex ${mine ? 'justify-end' : 'justify-start'}`}>
      <span className="msg-time px-1 text-[10px] leading-none text-cx-400/70">{text}</span>
    </div>
  );
}

/** 一条对话气泡：用户右侧、脆脆左侧，时间挂在下面 */
export function Bubble({ msg }: { msg: Msg }) {
  const mine = msg.role === 'user';
  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'}`}>
      <div className={`flex items-end gap-2 ${mine ? 'justify-end' : ''}`}>
        {!mine && <span className="mb-1 text-xl">🧸</span>}
        <div
          className={`max-w-[78%] whitespace-pre-wrap rounded-bubble px-4 py-2.5 text-sm leading-relaxed shadow-sm ${
            mine
              ? 'rounded-br-md bg-cx-300 text-white'
              : 'rounded-bl-md border border-cx-100 bg-white text-cx-700'
          } ${msg.refreshed ? 'bubble-swap' : ''}`}
        >
          {msg.content}
        </div>
        {mine && <span className="mb-1 text-xl">👤</span>}
      </div>
      <MsgTime ts={msg.ts} mine={mine} />
    </div>
  );
}
