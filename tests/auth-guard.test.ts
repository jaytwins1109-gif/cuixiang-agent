/**
 * Admin API 守卫（lib/auth/guard.ts）单测。
 *
 * requireAdmin 是所有 /api/admin/* 的安全边界，这里固化它的判定矩阵：
 * ADMIN 票放行；USER 票 / 旧格式票（无 role）/ 无票一律拦截。
 * 签发用真 jose + 测试密钥，与线上的签名/过期/typ 校验同一条链路。
 */
import { NextRequest } from 'next/server';
import { SignJWT } from 'jose';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { TOKEN_COOKIE, signUserToken } from '@/lib/auth/jwt';
import { requireAdmin } from '@/lib/auth/guard';

const SECRET = 'test-secret-for-vitest-0123456789';
const ISSUER = 'cuixiang';

function reqWithCookie(cookieValue?: string): NextRequest {
  const headers = new Headers();
  if (cookieValue) headers.set('cookie', cookieValue);
  return new NextRequest('http://localhost/api/admin/stats', { headers });
}

/** 模拟 V3.0 之前签发的旧票：只有 typ，没有 role 字段 */
async function legacyUserToken(userId: string): Promise<string> {
  return new SignJWT({ typ: 'user' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(userId)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 3600)
    .sign(new TextEncoder().encode(SECRET));
}

beforeAll(() => {
  vi.stubEnv('AUTH_SECRET', SECRET);
});

describe('requireAdmin', () => {
  it('ADMIN 票 → 放行，返回 userId', async () => {
    const token = await signUserToken('u_boss', 'ADMIN');
    const result = await requireAdmin(reqWithCookie(`${TOKEN_COOKIE}=${token}`));
    expect(result).toEqual({ userId: 'u_boss' });
  });

  it('USER 票 → 拦截（返回 null）', async () => {
    const token = await signUserToken('u_normal', 'USER');
    const result = await requireAdmin(reqWithCookie(`${TOKEN_COOKIE}=${token}`));
    expect(result).toBeNull();
  });

  it('旧格式票（无 role 字段）→ 默认 USER，拦截', async () => {
    const token = await legacyUserToken('u_old');
    const result = await requireAdmin(reqWithCookie(`${TOKEN_COOKIE}=${token}`));
    expect(result).toBeNull();
  });

  it('无票 → 拦截', async () => {
    expect(await requireAdmin(reqWithCookie())).toBeNull();
  });

  it('伪造的 cookie 值 → 拦截（签名校验不过）', async () => {
    const result = await requireAdmin(reqWithCookie(`${TOKEN_COOKIE}=not.a.jwt`));
    expect(result).toBeNull();
  });
});
