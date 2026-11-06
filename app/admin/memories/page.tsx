// app/admin/memories/page.tsx — 记忆管理页
import { redirect } from 'next/navigation';
import { isAdminPageAuthed } from '@/lib/admin/page-auth';
import { MemoriesClient } from '@/components/admin/memories-client';

export const metadata = { title: '记忆管理 · 脆香管理后台' };

export default async function AdminMemoriesPage() {
  if (!(await isAdminPageAuthed())) redirect('/');
  return <MemoriesClient />;
}
