// components/admin/dashboard-client.tsx — 数据看板（client，fetch /api/admin/stats）
'use client';

import { useEffect, useState } from 'react';
import { Activity, MessageSquareText, Package, Users } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

interface Stats {
  totalUsers: number;
  totalMessages: number;
  activeUsers7d: number;
  activeProducts: number;
  trend7d: { date: string; count: number }[];
}

const CARDS = [
  { key: 'totalUsers', label: '总用户数', icon: Users, hint: '游客 + 注册' },
  { key: 'totalMessages', label: '总对话数', icon: MessageSquareText, hint: '用户轮次累计' },
  { key: 'activeUsers7d', label: '近 7 天活跃', icon: Activity, hint: '有过对话的去重用户' },
  { key: 'activeProducts', label: '在架商品', icon: Package, hint: '内存缓存中的 SKU' },
] as const;

export function DashboardClient() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/admin/stats')
      .then(async (res) => {
        if (!res.ok)
          throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        setStats(await res.json());
      })
      .catch((e) => setError(e.message));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold text-slate-800">数据看板</h1>
        <p className="text-xs text-slate-400">业务总览 · 实时读库</p>
      </div>

      {error && (
        <Card className="border-rose-200 bg-rose-50">
          <CardContent className="p-4 text-sm text-rose-700">加载失败：{error}</CardContent>
        </Card>
      )}

      <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
        {CARDS.map(({ key, label, icon: Icon, hint }) => (
          <Card key={key}>
            <CardHeader className="flex-row items-center justify-between">
              <div>
                <CardDescription>{label}</CardDescription>
                <CardTitle className="mt-1.5 text-2xl font-bold tabular-nums">
                  {stats ? stats[key].toLocaleString() : '—'}
                </CardTitle>
              </div>
              <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                <Icon className="h-5 w-5" />
              </span>
            </CardHeader>
            <CardContent>
              <p className="text-[11px] text-slate-400">{hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* 趋势图占位：步骤 7 接图表库（recharts）画折线 */}
      <Card>
        <CardHeader>
          <CardTitle>近 7 天对话量趋势</CardTitle>
          <CardDescription>
            {stats
              ? stats.trend7d.map((t) => `${t.date.slice(5)}=${t.count}`).join('  ')
              : '加载中…'}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex h-48 items-center justify-center rounded-lg border border-dashed border-slate-200 text-xs text-slate-400">
            趋势图占位（折线图在 UI 打磨轮接入）
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
