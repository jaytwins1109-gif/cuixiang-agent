// app/admin/products/page.tsx — 商品管理页
import { redirect } from 'next/navigation';
import { isAdminPageAuthed } from '@/lib/admin/page-auth';
import { ProductsClient } from '@/components/admin/products-client';

export const metadata = { title: '商品管理 · 脆香管理后台' };

export default async function AdminProductsPage() {
  if (!(await isAdminPageAuthed())) redirect('/');
  return <ProductsClient />;
}
