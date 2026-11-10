'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';

import { useCart } from '@/app/_components/cart-context';

/**
 * 货架交互层（Client）——筛选 / 加购 / 详情 / 悬浮购物车 / 模拟结算，全部是本地 state。
 *
 * ⚠️ 0 Token 红线：本文件及它的 import 链里不许出现 fetch('/api/ai')、callBrain、
 * lib/llm、lib/chat、lib/prompts。唯一会「惊动 AI」的动作是 [问问脆脆]，
 * 而那一下已经 router.push 离开 /shop 了。scripts/shop-guard.ts 守这条线。
 */
export interface ShopProduct {
  sku_id: string;
  name: string;
  category: string;
  price: number;
  reason: string;
  emoji: string;
  taste_tags: string[];
  allergens: string[];
  scenes: string[];
  spicy: number;
}

type CheckoutStep = 'idle' | 'review' | 'done';

const SPICY_LABEL: Record<number, string> = { 0: '不辣', 1: '微辣', 2: '中辣', 3: '重辣' };

export function ShopShelf({
  products,
  categories,
}: {
  products: ShopProduct[];
  categories: string[];
}) {
  const router = useRouter();
  const cart = useCart();
  const [category, setCategory] = useState('全部');
  const [detail, setDetail] = useState<ShopProduct | null>(null);
  const [cartOpen, setCartOpen] = useState(false);
  const [step, setStep] = useState<CheckoutStep>('idle');
  const [lastTotal, setLastTotal] = useState(0);

  const shown = useMemo(
    () => (category === '全部' ? products : products.filter((p) => p.category === category)),
    [products, category],
  );

  function addToCart(p: ShopProduct) {
    cart.add({
      sku_id: p.sku_id,
      name: p.name,
      emoji: p.emoji,
      price: p.price,
    });
  }

  /** 犹豫时才惊动 AI：跳回聊天页并自动发一句，明确商品名让本地介绍链路抠得到 */
  function askAbout(p: ShopProduct) {
    router.push(`/?ask=${encodeURIComponent(`我想了解下【${p.name}】`)}`);
  }

  function confirmCheckout() {
    // 模拟结算：只清本地购物车，不建订单、不落库、不发任何请求
    setLastTotal(cart.total);
    cart.clear();
    setStep('done');
  }

  function closeCart() {
    setCartOpen(false);
    setStep('idle');
  }

  return (
    <div className="min-h-screen bg-slate-50 pb-28 text-slate-800">
      {/* 顶部：标题 + 返回聊天 */}
      <header className="sticky top-0 z-20 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-[1400px] items-center gap-3 px-4 py-3 sm:px-6">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-200 to-orange-300 text-xl">
            🛍️
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-base font-extrabold sm:text-lg">脆香超市</h1>
            <p className="hidden text-[11px] text-slate-400 sm:block">
              看中直接加购，不用等 AI · 页面内操作 0 Token
            </p>
          </div>
          <Link
            href="/"
            className="inline-flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700 transition hover:bg-slate-50 sm:px-4 sm:text-sm"
          >
            ← 返回聊天
          </Link>
        </div>

        {/* 分类标签：从真实商品数据去重得来 */}
        <div className="scroll-slim mx-auto flex max-w-[1400px] gap-2 overflow-x-auto px-4 pb-3 sm:px-6">
          {categories.map((c) => (
            <button
              key={c}
              onClick={() => setCategory(c)}
              className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold transition ${
                category === c
                  ? 'bg-slate-800 text-white'
                  : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      </header>

      <main className="mx-auto max-w-[1400px] px-4 pt-5 sm:px-6">
        <div className="mb-3 flex items-baseline justify-between">
          <span className="text-sm font-bold text-slate-600">{category}</span>
          <span className="text-[11px] text-slate-400">共 {shown.length} 款</span>
        </div>

        {shown.length ? (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {shown.map((p) => (
              <article
                key={p.sku_id}
                className="flex flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:shadow-card"
              >
                <div className="flex h-24 items-center justify-center bg-gradient-to-br from-amber-50 to-orange-100 text-5xl sm:h-28">
                  {p.emoji || '🍪'}
                </div>
                <div className="flex flex-1 flex-col p-3">
                  <div className="truncate text-sm font-bold text-slate-800" title={p.name}>
                    {p.name}
                  </div>
                  <div className="mt-0.5 line-clamp-2 min-h-[2.5rem] text-[11px] leading-relaxed text-slate-400">
                    {p.reason}
                  </div>
                  <div className="mt-2 text-base font-extrabold text-orange-500">
                    ¥{p.price.toFixed(1)}
                  </div>

                  <div className="mt-3 flex flex-col gap-1.5">
                    <button
                      onClick={() => addToCart(p)}
                      className="min-h-[36px] rounded-lg bg-cx-300 text-xs font-bold text-white transition hover:bg-cx-400"
                    >
                      直接加购
                    </button>
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => setDetail(p)}
                        className="min-h-[32px] flex-1 rounded-lg border border-slate-200 text-[11px] font-semibold text-slate-600 transition hover:bg-slate-50"
                      >
                        查看详情
                      </button>
                      <button
                        onClick={() => askAbout(p)}
                        className="min-h-[32px] flex-1 rounded-lg text-[11px] font-semibold text-orange-500 transition hover:bg-orange-50"
                        title="回聊天页让脆脆讲讲这包"
                      >
                        问问脆脆
                      </button>
                    </div>
                  </div>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <p className="rounded-2xl border border-dashed border-slate-200 bg-white p-10 text-center text-sm text-slate-400">
            {products.length ? '这个分类暂时没有在售商品' : '商品库正在同步，稍等一下再逛～'}
          </p>
        )}
      </main>

      {/* 悬浮购物车：加购后角标 +1，点开是简易清单 + 模拟结算 */}
      <button
        onClick={() => (cartOpen ? closeCart() : setCartOpen(true))}
        aria-label="购物车"
        className="fixed bottom-6 right-6 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-slate-800 text-2xl text-white shadow-lg transition hover:scale-105"
      >
        🛒
        {cart.count > 0 && (
          <span className="absolute -right-1 -top-1 flex h-6 min-w-6 items-center justify-center rounded-full bg-orange-500 px-1 text-[11px] font-bold text-white">
            {cart.count}
          </span>
        )}
      </button>

      {cartOpen && (
        <div className="fixed bottom-24 right-6 z-30 w-[min(92vw,340px)] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-sm font-bold text-slate-700">购物车</span>
            <button
              onClick={closeCart}
              className="text-xs text-slate-400 hover:text-slate-700"
              aria-label="关闭购物车"
            >
              ✕
            </button>
          </div>

          {step === 'done' ? (
            <div className="py-3 text-center">
              <div className="text-3xl">✅</div>
              <p className="mt-2 text-sm font-bold text-slate-700">模拟结算完成</p>
              <p className="mt-1 text-xs text-slate-500">合计 ¥{lastTotal.toFixed(1)}</p>
              <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
                这是模拟结算，没有生成真实订单，也没有扣款。
              </p>
              <button
                onClick={closeCart}
                className="mt-3 w-full rounded-lg bg-slate-800 py-2 text-xs font-bold text-white"
              >
                继续逛
              </button>
            </div>
          ) : step === 'review' ? (
            <div>
              <p className="mb-2 text-[11px] leading-relaxed text-slate-400">
                模拟结算：确认后只清空本地购物车，不会生成真实订单、不会扣款。
              </p>
              <div className="space-y-1.5">
                {cart.items.map((i) => (
                  <div key={i.sku_id} className="flex justify-between text-xs text-slate-600">
                    <span className="min-w-0 truncate">
                      {i.name} ×{i.qty}
                    </span>
                    <span className="shrink-0 font-semibold">¥{(i.price * i.qty).toFixed(1)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex justify-between border-t border-slate-100 pt-2 text-sm font-bold text-slate-800">
                <span>合计</span>
                <span>¥{cart.total.toFixed(1)}</span>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => setStep('idle')}
                  className="flex-1 rounded-lg border border-slate-200 py-2 text-xs font-semibold text-slate-600"
                >
                  返回
                </button>
                <button
                  onClick={confirmCheckout}
                  className="flex-1 rounded-lg bg-cx-300 py-2 text-xs font-bold text-white"
                >
                  确认模拟下单
                </button>
              </div>
            </div>
          ) : cart.items.length ? (
            <>
              <div className="scroll-slim max-h-60 space-y-2 overflow-y-auto">
                {cart.items.map((i) => (
                  <div key={i.sku_id} className="flex items-center gap-2">
                    <span className="text-lg">{i.emoji}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-slate-600">{i.name}</span>
                    <button
                      onClick={() => cart.setQty(i.sku_id, i.qty - 1)}
                      className="h-6 w-6 rounded bg-slate-100 text-xs text-slate-600"
                      aria-label={`减少 ${i.name}`}
                    >
                      −
                    </button>
                    <span className="w-4 text-center text-xs font-bold">{i.qty}</span>
                    <button
                      onClick={() => cart.setQty(i.sku_id, i.qty + 1)}
                      className="h-6 w-6 rounded bg-slate-100 text-xs text-slate-600"
                      aria-label={`增加 ${i.name}`}
                    >
                      ＋
                    </button>
                    <button
                      onClick={() => cart.remove(i.sku_id)}
                      className="text-xs text-slate-300 hover:text-rose-500"
                      aria-label={`移除 ${i.name}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2">
                <span className="text-xs text-slate-400">共 {cart.count} 件</span>
                <span className="text-sm font-extrabold text-orange-500">
                  ¥{cart.total.toFixed(1)}
                </span>
              </div>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={() => cart.clear()}
                  className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-500"
                >
                  清空
                </button>
                <button
                  onClick={() => setStep('review')}
                  className="flex-1 rounded-lg bg-slate-800 py-2 text-xs font-bold text-white"
                >
                  模拟结算
                </button>
              </div>
            </>
          ) : (
            <p className="py-6 text-center text-xs text-slate-400">
              购物车还空着，挑几包直接加购吧 🍪
            </p>
          )}
        </div>
      )}

      {/* 详情弹窗：纯本地 state，不查接口 */}
      {detail && (
        <div className="fixed inset-0 z-40 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/40" onClick={() => setDetail(null)} />
          <div className="relative w-[min(92vw,420px)] rounded-2xl bg-white p-5 shadow-2xl">
            <button
              onClick={() => setDetail(null)}
              className="absolute right-3 top-3 text-slate-400 hover:text-slate-700"
              aria-label="关闭详情"
            >
              ✕
            </button>
            <div className="flex items-center gap-3">
              <span className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-amber-50 to-orange-100 text-4xl">
                {detail.emoji || '🍪'}
              </span>
              <div className="min-w-0">
                <h2 className="text-base font-extrabold text-slate-800">{detail.name}</h2>
                <p className="text-lg font-extrabold text-orange-500">¥{detail.price.toFixed(1)}</p>
              </div>
            </div>
            <p className="mt-3 text-xs leading-relaxed text-slate-500">{detail.reason}</p>
            <dl className="mt-3 space-y-1.5 text-[11px] text-slate-500">
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-slate-400">分类</dt>
                <dd>{detail.category}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-slate-400">口味</dt>
                <dd>{detail.taste_tags.join(' · ') || '—'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-slate-400">辣度</dt>
                <dd>{SPICY_LABEL[detail.spicy] || '不辣'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-slate-400">场景</dt>
                <dd>{detail.scenes.join(' · ') || '随时都能吃'}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-14 shrink-0 text-slate-400">过敏原</dt>
                <dd>{detail.allergens.join(' · ') || '无标注'}</dd>
              </div>
            </dl>
            <div className="mt-4 flex gap-2">
              <button
                onClick={() => {
                  addToCart(detail);
                  setDetail(null);
                }}
                className="flex-1 rounded-lg bg-cx-300 py-2 text-xs font-bold text-white"
              >
                直接加购
              </button>
              <button
                onClick={() => askAbout(detail)}
                className="flex-1 rounded-lg border border-slate-200 py-2 text-xs font-semibold text-orange-500"
              >
                问问脆脆
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
