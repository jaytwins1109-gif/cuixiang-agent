// app/api/admin/memories/route.ts — 记忆管理（V3.0 Admin）
//
// GET    ?userId=    → 该用户的记忆列表（复用 listMemory，与用户侧同一份视图）
// DELETE ?userId=&keyword= → 按关键词软删除（复用 deleteMemory：status→deleted，
//                            保留轨迹可追溯，与用户侧"你之前说过X"同一套语义）
//
// 两处都是薄封装：V2 已把 CRUD 语义做全，Admin 只是把按钮接到现有函数上，
// 任何行为变更都在 store.ts 改，这里不写第二套口径。
import { NextResponse, type NextRequest } from 'next/server';
import { requireAdmin } from '@/lib/auth/guard';
import { deleteMemory, listMemory } from '@/lib/memory/store';

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  const userId = req.nextUrl.searchParams.get('userId')?.trim();
  if (!userId) return NextResponse.json({ error: '缺少 userId' }, { status: 400 });

  try {
    return NextResponse.json({ items: await listMemory(userId) });
  } catch (err) {
    console.error('[admin/memories GET]', err);
    return NextResponse.json({ error: '记忆读取失败' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (!admin) return NextResponse.json({ error: '需要管理员权限' }, { status: 403 });

  const sp = req.nextUrl.searchParams;
  const userId = sp.get('userId')?.trim();
  const keyword = sp.get('keyword')?.trim();
  if (!userId || !keyword) {
    return NextResponse.json({ error: '缺少 userId 或 keyword' }, { status: 400 });
  }

  try {
    const deleted = await deleteMemory(userId, keyword);
    return NextResponse.json({ ok: true, deleted });
  } catch (err) {
    console.error('[admin/memories DELETE]', err);
    return NextResponse.json({ error: '记忆删除失败' }, { status: 500 });
  }
}
