// components/admin/sidebar.tsx — 左侧固定侧边栏（client：导航高亮 + 退出登录）
'use client';

import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Brain,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Package,
  Popcorn,
  Undo2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

const NAV = [
  { href: '/admin', label: '数据看板', icon: LayoutDashboard, exact: true },
  { href: '/admin/messages', label: '对话审查', icon: MessagesSquare },
  { href: '/admin/memories', label: '记忆管理', icon: Brain },
  { href: '/admin/products', label: '商品管理', icon: Package },
] as const;

export function AdminSidebar() {
  const pathname = usePathname();
  const router = useRouter();

  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.push('/');
    router.refresh();
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-slate-200 bg-white">
      {/* Logo */}
      <div className="flex items-center gap-2.5 px-5 pb-6 pt-6">
        <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-sky-600 text-white shadow-sm">
          <Popcorn className="h-5 w-5" />
        </span>
        <div>
          <div className="text-sm font-semibold text-slate-800">脆香管理后台</div>
          <div className="text-[11px] text-slate-400">Cuixiang Admin · V3.0</div>
        </div>
      </div>

      {/* 导航 */}
      <nav className="flex-1 space-y-1 px-3">
        {NAV.map(({ href, label, icon: Icon, ...rest }) => {
          const active =
            'exact' in rest && rest.exact ? pathname === href : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                'flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors',
                active
                  ? 'bg-sky-50 font-medium text-sky-700'
                  : 'text-slate-600 hover:bg-slate-50 hover:text-slate-900',
              )}
            >
              <Icon className="h-4 w-4" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* 底部操作 */}
      <div className="space-y-1 border-t border-slate-100 px-3 py-4">
        <a
          href="/"
          className="flex w-full items-center justify-start gap-2 rounded-lg px-3 py-1.5 text-sm text-slate-600 transition-colors hover:bg-slate-100 hover:text-slate-900"
        >
          <Undo2 className="h-4 w-4" />
          返回前台
        </a>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-slate-500 hover:text-rose-600"
          onClick={logout}
        >
          <LogOut className="h-4 w-4" />
          退出登录
        </Button>
      </div>
    </aside>
  );
}
