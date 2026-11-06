// components/admin/products-client.tsx — 商品管理（client，fetch /api/admin/products）
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface ProductRow {
  skuId: string;
  name: string;
  category: string;
  price: number;
  active: boolean;
  emoji: string;
}

export function ProductsClient() {
  const [items, setItems] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch('/api/admin/products');
      if (!res.ok)
        throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onShelfToggle = async (row: ProductRow) => {
    setNotice('');
    try {
      const res = await fetch('/api/admin/products', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ skuId: row.skuId, active: !row.active }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      // PUT 成功 = 服务端已 forceProductSync，C 端下一个请求立即生效
      setNotice(
        `「${row.name}」已${row.active ? '下架' : '上架'}，内存缓存已刷新（cacheSize=${data.cacheSize}），C 端立即生效`,
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">商品管理</h1>
          <p className="text-xs text-slate-400">
            库为源 · 内存为算：写操作后自动刷新缓存，C 端下一个请求立即生效
          </p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCcw className="h-4 w-4" />
            刷新
          </Button>
          {/* 新增商品弹窗预留：表单在 UI 打磨轮接入 */}
          <Button size="sm" onClick={() => setNotice('新增商品弹窗在 UI 打磨轮开放')}>
            <Plus className="h-4 w-4" />
            新增商品
          </Button>
        </div>
      </div>

      {notice && <p className="text-xs text-emerald-600">{notice}</p>}
      {error && <p className="text-xs text-rose-600">出错：{error}</p>}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-14">图标</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-28">分类</TableHead>
                <TableHead className="w-24 text-right">价格</TableHead>
                <TableHead className="w-28">SKU</TableHead>
                <TableHead className="w-20">状态</TableHead>
                <TableHead className="w-24">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-400">
                    加载中…
                  </TableCell>
                </TableRow>
              ) : (
                items.map((p) => (
                  <TableRow key={p.skuId}>
                    <TableCell className="text-lg">{p.emoji}</TableCell>
                    <TableCell className="text-sm font-medium text-slate-700">{p.name}</TableCell>
                    <TableCell className="text-xs text-slate-500">{p.category}</TableCell>
                    <TableCell className="text-right tabular-nums text-sm text-slate-700">
                      ¥{p.price.toFixed(1)}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-slate-400">{p.skuId}</TableCell>
                    <TableCell>
                      <Badge variant={p.active ? 'success' : 'muted'}>
                        {p.active ? '在架' : '下架'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Button size="sm" variant="outline" onClick={() => void onShelfToggle(p)}>
                        {p.active ? '下架' : '上架'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
