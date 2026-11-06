// components/admin/memories-client.tsx — 记忆管理（client，fetch /api/admin/memories）
'use client';

import { useState } from 'react';
import { Search, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

interface MemoryRow {
  id: string;
  layer: string;
  keyword: string;
  content: string;
  status: string;
  updatedAt: string;
}

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'muted'> = {
  active: 'success',
  superseded: 'warning',
  deleted: 'muted',
};

export function MemoriesClient() {
  const [userId, setUserId] = useState('');
  const [items, setItems] = useState<MemoryRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  const query = async (id: string) => {
    if (!id.trim()) {
      setMessage('请输入要查询的 userId');
      return;
    }
    setLoading(true);
    setMessage('');
    try {
      const res = await fetch(`/api/admin/memories?userId=${encodeURIComponent(id.trim())}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setItems(data.items);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const remove = async (keyword: string) => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/admin/memories?userId=${encodeURIComponent(userId.trim())}&keyword=${encodeURIComponent(keyword)}`,
        { method: 'DELETE' },
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setMessage(data.deleted ? `已软删除：「${keyword}」（轨迹保留）` : '没有匹配的活跃记忆');
      await query(userId);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-800">记忆管理</h1>
        <p className="text-xs text-slate-400">
          复用用户侧同一套存储语义 · 删除为软删除（保留轨迹）
        </p>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative w-96">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="pl-8 font-mono text-xs"
            placeholder="输入 userId（如 guest_xxx / u_xxx），回车查询"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void query(userId)}
          />
        </div>
        <Button size="sm" onClick={() => void query(userId)} disabled={loading}>
          查询
        </Button>
      </div>

      {message && <p className="text-xs text-slate-500">{message}</p>}

      {items !== null && (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-24">层级</TableHead>
                  <TableHead className="w-40">关键词</TableHead>
                  <TableHead>内容</TableHead>
                  <TableHead className="w-24">状态</TableHead>
                  <TableHead className="w-16">操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-slate-400">
                      该用户暂无记忆
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell>
                        <Badge variant="default">{m.layer}</Badge>
                      </TableCell>
                      <TableCell className="text-sm text-slate-700">{m.keyword}</TableCell>
                      <TableCell className="max-w-xl whitespace-pre-wrap break-words text-sm text-slate-600">
                        {m.content}
                      </TableCell>
                      <TableCell>
                        <Badge variant={STATUS_VARIANT[m.status] ?? 'muted'}>{m.status}</Badge>
                      </TableCell>
                      <TableCell>
                        {m.status === 'active' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 w-7 p-0 text-slate-400 hover:text-rose-600"
                            onClick={() => void remove(m.keyword)}
                            disabled={loading}
                            title="软删除"
                          >
                            <Trash2 className="h-4 w-4" />
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
