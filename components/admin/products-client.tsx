// components/admin/products-client.tsx — 商品管理（client，fetch /api/admin/products）
'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, RefreshCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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

const EMPTY_FORM = {
  skuId: '',
  name: '',
  category: '',
  price: '',
  emoji: '🍪',
  reason: '',
  active: true,
};

export function ProductsClient() {
  const [items, setItems] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  // 新增商品弹窗：表单 + 提交状态
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

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

  /** 新增商品提交：POST 后端建行 + 强刷缓存；成功即关弹窗刷列表 */
  const submitCreate = async () => {
    setFormError('');
    // 前端先挡一轮必填，后端还有同一套校验兜底（责任分层同 API）
    if (!form.skuId.trim() || !form.name.trim() || !form.category.trim() || !form.reason.trim()) {
      setFormError('SKU / 名称 / 分类 / 推荐理由都是必填');
      return;
    }
    const price = Number(form.price);
    if (!form.price || Number.isNaN(price) || price <= 0) {
      setFormError('价格要是大于 0 的数字');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          skuId: form.skuId.trim(),
          name: form.name.trim(),
          category: form.category.trim(),
          price,
          emoji: form.emoji.trim() || '🍪',
          reason: form.reason.trim(),
          active: form.active,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setNotice(
        `「${form.name.trim()}」已创建，缓存已刷新（cacheSize=${data.cacheSize}）${
          form.active ? '，C 端立即可推' : ''
        }`,
      );
      setCreateOpen(false);
      setForm(EMPTY_FORM);
      await load();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
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
          {/* 新增商品：shadcn Dialog 弹窗表单 */}
          <Button
            size="sm"
            onClick={() => {
              setForm(EMPTY_FORM);
              setFormError('');
              setCreateOpen(true);
            }}
          >
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

      {/* 新增商品弹窗 */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新增商品</DialogTitle>
            <DialogDescription>
              保存后服务端立即刷新内存缓存，C 端下一个请求即可推荐该商品
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3">
            <label className="grid gap-1">
              <span className="text-xs font-medium text-slate-500">SKU ID（唯一）</span>
              <Input
                className="font-mono text-xs"
                placeholder="如 SKU060"
                value={form.skuId}
                onChange={(e) => setForm({ ...form, skuId: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-[1fr_5rem] gap-3">
              <label className="grid gap-1">
                <span className="text-xs font-medium text-slate-500">名称</span>
                <Input
                  placeholder="商品名"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-slate-500">价格 ¥</span>
                <Input
                  type="number"
                  step="0.1"
                  min="0"
                  placeholder="19.9"
                  value={form.price}
                  onChange={(e) => setForm({ ...form, price: e.target.value })}
                />
              </label>
            </div>
            <div className="grid grid-cols-[1fr_5rem] gap-3">
              <label className="grid gap-1">
                <span className="text-xs font-medium text-slate-500">分类</span>
                <Input
                  placeholder="如 海藻类"
                  value={form.category}
                  onChange={(e) => setForm({ ...form, category: e.target.value })}
                />
              </label>
              <label className="grid gap-1">
                <span className="text-xs font-medium text-slate-500">图标</span>
                <Input
                  className="text-center"
                  value={form.emoji}
                  onChange={(e) => setForm({ ...form, emoji: e.target.value })}
                />
              </label>
            </div>
            <label className="grid gap-1">
              <span className="text-xs font-medium text-slate-500">推荐理由（给 AI 的话术）</span>
              <Input
                placeholder="如 独立小包，办公室囤货首选"
                value={form.reason}
                onChange={(e) => setForm({ ...form, reason: e.target.value })}
              />
            </label>
            <label className="flex items-center gap-2.5 pt-1">
              <input
                type="checkbox"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
                className="h-4 w-4 rounded accent-sky-600"
              />
              <span className="text-sm text-slate-600">
                立即在架
                <span className="ml-1 text-xs text-slate-400">
                  （关掉则先建为下架态，之后手动上架）
                </span>
              </span>
            </label>
            {formError && <p className="text-xs text-rose-600">{formError}</p>}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)} disabled={submitting}>
              取消
            </Button>
            <Button onClick={() => void submitCreate()} disabled={submitting}>
              {submitting ? '保存中…' : '保存并刷新缓存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
