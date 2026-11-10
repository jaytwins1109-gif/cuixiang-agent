'use client';

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { useDebouncedWrite } from './use-debounced-write';

/**
 * 购物车状态（2026-11-10 /shop「0 Token 货架」）。
 *
 * 选 React Context 而不是 Zustand：只有 items / add / setQty / remove / clear 五个动作，
 * 项目里没有 zustand，为这点状态加依赖不划算；Context 挂在根 layout 上，
 * `/` 与 `/shop` 之间客户端导航不会卸载 Provider，购物车自然跨页保留。
 *
 * 与聊天页的「想要清单」(`cx_want_v1`) **刻意分开存**：那份是 AI 推荐卡攒出来的
 * Rec[]（含 promo 字段），这边是用户自己从货架加的 CartItem。两边互不写回，
 * 保持「明确购买意图 0 Token / 犹豫时才找 AI」的软解耦。
 *
 * ⚠️ 本模块不得 import 任何 lib/llm、lib/chat、lib/prompts 或调用 /api/ai——
 * scripts/shop-guard.ts 会扫这条链路，守住 /shop 的 0 Token 红线。
 */
export const CART_KEY = 'cx_cart_v1';

export interface CartItem {
  sku_id: string;
  name: string;
  emoji: string;
  price: number;
  qty: number;
}

export type CartProduct = Omit<CartItem, 'qty'>;

interface CartApi {
  items: CartItem[];
  /** 总件数（角标用），不是 SKU 数 */
  count: number;
  total: number;
  add: (p: CartProduct) => void;
  setQty: (sku_id: string, qty: number) => void;
  remove: (sku_id: string) => void;
  clear: () => void;
}

const CartContext = createContext<CartApi | null>(null);

function isCartItem(x: unknown): x is CartItem {
  const v = x as CartItem | null;
  return (
    !!v &&
    typeof v.sku_id === 'string' &&
    typeof v.name === 'string' &&
    typeof v.price === 'number' &&
    typeof v.qty === 'number' &&
    v.qty > 0
  );
}

function readCart(): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isCartItem) : [];
  } catch {
    return [];
  }
}

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<CartItem[]>([]);
  const [hydrated, setHydrated] = useState(false);

  // 首帧不写盘：读档完成前把空数组写回去会盖掉上次的购物车（与聊天页同一条纪律）
  useEffect(() => {
    setItems(readCart());
    setHydrated(true);
  }, []);
  useDebouncedWrite(CART_KEY, items, hydrated);

  const api = useMemo<CartApi>(
    () => ({
      items,
      count: items.reduce((n, i) => n + i.qty, 0),
      total: items.reduce((n, i) => n + i.price * i.qty, 0),
      add: (p) =>
        setItems((prev) =>
          prev.some((i) => i.sku_id === p.sku_id)
            ? prev.map((i) => (i.sku_id === p.sku_id ? { ...i, qty: i.qty + 1 } : i))
            : [...prev, { ...p, qty: 1 }],
        ),
      setQty: (sku_id, qty) =>
        setItems((prev) =>
          qty <= 0
            ? prev.filter((i) => i.sku_id !== sku_id)
            : prev.map((i) => (i.sku_id === sku_id ? { ...i, qty } : i)),
        ),
      remove: (sku_id) => setItems((prev) => prev.filter((i) => i.sku_id !== sku_id)),
      clear: () => setItems([]),
    }),
    [items],
  );

  return <CartContext.Provider value={api}>{children}</CartContext.Provider>;
}

export function useCart(): CartApi {
  const ctx = useContext(CartContext);
  if (!ctx) throw new Error('useCart 必须在 CartProvider 内使用');
  return ctx;
}
