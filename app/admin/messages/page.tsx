// app/admin/messages/page.tsx — 对话审查页
import { redirect } from 'next/navigation';
import { isAdminPageAuthed } from '@/lib/admin/page-auth';
import { MessagesClient } from '@/components/admin/messages-client';

export const metadata = { title: '对话审查 · 脆香管理后台' };

export default async function AdminMessagesPage() {
  // middleware 只是体验层，页面自己再验（V1 口令票也要认）
  if (!(await isAdminPageAuthed())) redirect('/');
  return <MessagesClient />;
}
