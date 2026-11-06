// components/admin/messages-client.tsx — 对话审查（client，fetch /api/admin/messages）
'use client';

import { useCallback, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
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

interface MessageRow {
  id: string;
  userId: string;
  role: string;
  content: string;
  cards: string | null;
  traceId: string | null;
  createdAt: string;
}

const PAGE_SIZE = 20;

export function MessagesClient() {
  const [items, setItems] = useState<MessageRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [keyword, setKeyword] = useState('');
  const [role, setRole] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async (p: number, kw: string, rl: string) => {
    setLoading(true);
    setError('');
    try {
      const sp = new URLSearchParams({ page: String(p), pageSize: String(PAGE_SIZE) });
      if (kw.trim()) sp.set('keyword', kw.trim());
      if (rl) sp.set('role', rl);
      const res = await fetch(`/api/admin/messages?${sp}`);
      if (!res.ok)
        throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
      const data = await res.json();
      setItems(data.items);
      setTotal(data.total);
      setPage(data.page);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1, '', '');
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold text-slate-800">对话审查</h1>
        <p className="text-xs text-slate-400">只读 · 共 {total.toLocaleString()} 条记录</p>
      </div>

      {/* 筛选栏 */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            className="pl-8"
            placeholder="按内容关键词筛选，回车执行"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void load(1, keyword, role)}
          />
        </div>
        <div className="flex gap-1">
          {[
            { v: '', label: '全部' },
            { v: 'user', label: '用户' },
            { v: 'assistant', label: '助手' },
          ].map(({ v, label }) => (
            <Button
              key={v}
              size="sm"
              variant={role === v ? 'default' : 'outline'}
              onClick={() => {
                setRole(v);
                void load(1, keyword, v);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
        <Button size="sm" variant="secondary" onClick={() => void load(1, keyword, role)}>
          查询
        </Button>
      </div>

      {error && (
        <Card className="border-rose-200 bg-rose-50">
          <CardContent className="p-4 text-sm text-rose-700">加载失败：{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-36">时间</TableHead>
                <TableHead className="w-48">用户</TableHead>
                <TableHead className="w-20">角色</TableHead>
                <TableHead>内容</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-sm text-slate-400">
                    加载中…
                  </TableCell>
                </TableRow>
              ) : items.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-10 text-center text-sm text-slate-400">
                    没有匹配的对话记录
                  </TableCell>
                </TableRow>
              ) : (
                items.map((m) => (
                  <TableRow key={m.id}>
                    <TableCell className="whitespace-nowrap text-xs text-slate-500">
                      {new Date(m.createdAt).toLocaleString('zh-CN', { hour12: false })}
                    </TableCell>
                    <TableCell className="max-w-48 truncate font-mono text-xs text-slate-500">
                      {m.userId}
                    </TableCell>
                    <TableCell>
                      <Badge variant={m.role === 'user' ? 'muted' : 'default'}>
                        {m.role === 'user' ? '用户' : '助手'}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-xl whitespace-pre-wrap break-words text-sm text-slate-700">
                      {m.content}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* 分页 */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-slate-400">
          第 {page} / {totalPages} 页
        </span>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1 || loading}
            onClick={() => void load(page - 1, keyword, role)}
          >
            <ChevronLeft className="h-4 w-4" />
            上一页
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= totalPages || loading}
            onClick={() => void load(page + 1, keyword, role)}
          >
            下一页
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}
