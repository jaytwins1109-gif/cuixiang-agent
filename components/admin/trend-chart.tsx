// components/admin/trend-chart.tsx — 近 7 天对话量趋势（recharts 面积折线图）
'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

export interface TrendPoint {
  date: string;
  count: number;
}

export function TrendChart({ data }: { data: TrendPoint[] }) {
  const points = data.map((t) => ({ ...t, day: t.date.slice(5) }));
  const hasData = points.some((p) => p.count > 0);

  return (
    <div className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
          <defs>
            <linearGradient id="trendFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#0284c7" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#0284c7" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
          <XAxis
            dataKey="day"
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            allowDecimals={false}
            tick={{ fontSize: 11, fill: '#94a3b8' }}
            tickLine={false}
            axisLine={false}
          />
          <Tooltip
            formatter={(v) => [`${v} 次对话`, '对话量']}
            labelFormatter={(l) => `${l}（本月）`}
            contentStyle={{
              borderRadius: 12,
              border: '1px solid #e2e8f0',
              fontSize: 12,
              boxShadow: '0 4px 12px rgba(15,23,42,.08)',
            }}
          />
          <Area
            type="monotone"
            dataKey="count"
            stroke="#0284c7"
            strokeWidth={2}
            fill="url(#trendFill)"
            dot={{ r: 3, fill: '#0284c7', strokeWidth: 0 }}
            activeDot={{ r: 5 }}
          />
        </AreaChart>
      </ResponsiveContainer>
      {!hasData && (
        <div className="pointer-events-none -mt-32 text-center text-xs text-slate-300">
          近 7 天还没有对话，等真实流量
        </div>
      )}
    </div>
  );
}
