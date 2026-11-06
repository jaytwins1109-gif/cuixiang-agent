/**
 * Admin API 越权矩阵（V3.0）。
 *
 * 红线：所有 /api/admin/* 的安全边界是 requireAdmin——这里固化
 * 「无票 / 游客票 / USER 票 → 一律 403，且 403 判定发生在任何查库之前」。
 * ADMIN 放行与业务逻辑的端到端验证走本地 dev 实测（见 PROGRESS 步骤 5），
 * 单测不连库，保证快且稳。
 */
import { NextRequest } from 'next/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TOKEN_COOKIE, signUserToken } from '@/lib/auth/jwt';
import { GET as statsGET } from '@/app/api/admin/stats/route';
import { GET as messagesGET } from '@/app/api/admin/messages/route';
import { GET as memoriesGET, DELETE as memoriesDELETE } from '@/app/api/admin/memories/route';
import { GET as productsGET } from '@/app/api/admin/products/route';

const SECRET = 'test-secret-for-vitest-0123456789';

function req(path: string, cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) headers.set('cookie', cookieValue);
  return new NextRequest(`http://localhost${path}`, { headers });
}

beforeAll(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
});

describe('Admin API 越权矩阵', () => {
  it('无票 → 四个接口全 403', async () => {
    expect((await statsGET(req('/api/admin/stats'))).status).toBe(403);
    expect((await messagesGET(req('/api/admin/messages'))).status).toBe(403);
    expect((await memoriesGET(req('/api/admin/memories'))).status).toBe(403);
    expect((await productsGET(req('/api/admin/products'))).status).toBe(403);
  });

  it('USER 票（登录但非管理员）→ 四个接口全 403', async () => {
    const token = await signUserToken('u_normal', 'USER');
    const cookie = `${TOKEN_COOKIE}=${token}`;
    expect((await statsGET(req('/api/admin/stats', cookie))).status).toBe(403);
    expect((await messagesGET(req('/api/admin/messages', cookie))).status).toBe(403);
    expect((await memoriesGET(req('/api/admin/memories', cookie))).status).toBe(403);
    expect((await productsGET(req('/api/admin/products', cookie))).status).toBe(403);
  });

  it('伪造票 → 403（签名校验不过）', async () => {
    expect((await statsGET(req('/api/admin/stats', `${TOKEN_COOKIE}=not.a.jwt`))).status).toBe(403);
  });

  it('ADMIN 票 + 缺参数 → 400（守卫放行了，业务校验接管——证明 403/400 责任分层）', async () => {
    const token = await signUserToken('u_boss', 'ADMIN');
    const res = await memoriesGET(req('/api/admin/memories', `${TOKEN_COOKIE}=${token}`));
    expect(res.status).toBe(400);
  });

  it('ADMIN 票 + DELETE 缺 keyword → 400', async () => {
    const token = await signUserToken('u_boss', 'ADMIN');
    const res = await memoriesDELETE(
      req('/api/admin/memories?userId=u_x', `${TOKEN_COOKIE}=${token}`),
    );
    expect(res.status).toBe(400);
  });
});
