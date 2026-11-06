'use client';

import { finalPrice } from './format';
import type { Rec } from './types';

/** 一张推荐卡：图 + 价格 + 理由 + 促销 + 想要/换一个 */
export function SnackCard({
  rec,
  onWant,
  onSwap,
  wanted,
  best,
}: {
  rec: Rec;
  onWant: () => void;
  onSwap: () => void;
  /** 已经在想要清单里了，按钮给个已存的反馈 */
  wanted?: boolean;
  /** 排在第一位：给个"最搭"的记号，三张卡不至于一模一样 */
  best?: boolean;
}) {
  const saved = rec.promo?.saved || 0;
  const addOn = rec.promo?.add_on;
  const reasons = rec.user_visible_reasons?.length
    ? rec.user_visible_reasons
    : rec.reason
      ? [rec.reason]
      : [];

  return (
    <div
      className={`animate-fade-in flex h-full flex-col overflow-hidden rounded-2xl border bg-white shadow-card ${
        best ? 'border-cx-300 ring-1 ring-cx-200' : 'border-slate-100'
      }`}
    >
      {/* 图区：真实图优先，没有就给 emoji 一个白色圆托底，别让橙色底抢戏 */}
      <div className="relative flex h-20 shrink-0 items-center justify-center bg-gradient-to-br from-slate-100 to-slate-200">
        {rec.image ? (
          // 走的是商品库里的外链图，尺寸只有卡片这么大，不值得占用 next/image 的优化额度
          <img src={rec.image} alt={rec.name} className="h-full w-full object-cover" />
        ) : (
          <span className="flex h-14 w-14 items-center justify-center rounded-full bg-white/85 text-4xl shadow-sm">
            {rec.emoji || '🍪'}
          </span>
        )}
        {best && (
          <span className="absolute left-2 top-2 rounded-full bg-cx-500 px-2 py-0.5 text-[10px] font-bold text-white shadow-sm">
            最搭
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col p-3">
        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate font-bold text-slate-800">{rec.name}</h3>
          <span className="shrink-0 font-extrabold text-cx-500">
            ¥{finalPrice(rec)}
            {saved > 0 && (
              <span className="ml-1 text-[11px] font-normal text-slate-400 line-through">
                ¥{rec.price}
              </span>
            )}
          </span>
        </div>

        {/* 省多少紧跟价格，视线不用跳到图区右上角 */}
        {saved > 0 && (
          <div className="mt-1">
            <span className="rounded-full bg-cx-500/10 px-2 py-0.5 text-[11px] font-bold text-slate-700">
              省 ¥{saved}
            </span>
          </div>
        )}

        {reasons.length > 0 && (
          <ul className="mt-1 space-y-0.5">
            {reasons.slice(0, 2).map((r, i) => (
              <li key={i} className="line-clamp-2 text-xs leading-relaxed text-slate-500">
                · {r}
              </li>
            ))}
          </ul>
        )}

        {(rec.promo?.activity || rec.promo?.coupon) && (
          <div className="mt-2 flex flex-wrap gap-1">
            {rec.promo?.activity && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                {rec.promo.activity}
              </span>
            )}
            {rec.promo?.coupon && (
              <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">
                {rec.promo.coupon}
              </span>
            )}
          </div>
        )}

        {addOn && addOn.gap > 0 && (
          <p className="mt-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[11px] leading-relaxed text-slate-500">
            再加份{addOn.name}（¥{addOn.gap}），这单能多省 ¥{addOn.extra_saved}
          </p>
        )}

        {/* mt-auto：理由长短不一时，按钮统一贴着卡片底部，三张卡才齐 */}
        <div className="mt-auto flex gap-2 pt-3">
          <CardBtn primary onClick={onWant}>
            {wanted ? '✓ 已记下' : '想要'}
          </CardBtn>
          <CardBtn onClick={onSwap}>换一个</CardBtn>
        </div>
      </div>
    </div>
  );
}

function CardBtn({
  children,
  onClick,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  /**
   * 触摸目标：手机上这些按钮以前只有 30px 高，手指不好点。
   * 统一抬到 40px（min-h），桌面端因为本来就够大，视觉上几乎没变化。
   */
  return (
    <button
      onClick={onClick}
      className={`inline-flex min-h-[40px] flex-1 items-center justify-center rounded-full px-3 py-2 text-xs font-semibold transition ${
        primary
          ? 'bg-cx-300 text-white hover:bg-cx-400'
          : 'border border-slate-200 bg-white text-slate-500 shadow-sm hover:bg-slate-50'
      }`}
    >
      {children}
    </button>
  );
}
