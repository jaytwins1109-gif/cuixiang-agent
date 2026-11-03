import type { Rec } from './types';

/** 实付价：算过优惠就按到手价走，没算过就是原价 */
export const finalPrice = (r: Rec) =>
  r.promo && r.promo.saved > 0 ? r.promo.final_price : r.price;

/**
 * 气泡上的时间：今天只给「 HH:mm 」，隔天的才带日期前缀。
 * 每条都顶一串完整日期会把聊天区挤满，反而没人看。
 */
export function formatMsgTime(ts?: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const now = new Date();
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();

  if (sameDay(d, now)) return hm;

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(d, yesterday)) return `昨天 ${hm}`;

  // 今年的省掉年份，跨年才补全
  return d.getFullYear() === now.getFullYear()
    ? `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
    : `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
