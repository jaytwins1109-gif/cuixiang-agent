// lib/db.ts
//
// Prisma Client 的唯一实例。
//
// 为什么必须做单例：Next 的 dev 是热重载的，每改一次文件模块可能被重新求值一次。
// 直接 `export const prisma = new PrismaClient()` 会在改代码几十次之后攒出一堆连接，
// SQLite 的文件句柄也一起泄漏——现象是「跑了半天突然连不上库」。
// 挂到 globalThis 上，热重载时复用同一个实例，只有进程重启才真正重建。
//
// 生产环境不需要这层：进程起来一次，模块只求值一次。

import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * 脚本侧的环境变量兜底。
 *
 * Next 起来时会自己加载 .env / .env.local，但 `node scripts/xxx.mjs` 不会——
 * Prisma Client 也不读 .env（只有 prisma CLI 读）。少了这一步，
 * 任何直连 store 的脚本都会抛 "Environment variable not found: DATABASE_URL"，
 * 而且报错位置在库内部，看着像连不上库，很容易误判。
 * 只在真的缺变量时才读一次，Next 里等于空转。
 */
function ensureDatabaseUrl(): void {
  if (process.env.DATABASE_URL) return;
  try {
    const raw = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = /^\s*DATABASE_URL\s*=\s*(.+?)\s*$/.exec(line);
      if (m) {
        process.env.DATABASE_URL = m[1].replace(/^["']|["']$/g, '');
        return;
      }
    }
  } catch {
    // 没有 .env 就交给 Prisma 自己报错，它的提示更准
  }
}

ensureDatabaseUrl();

/** 开发态挂在 global 上的缓存（Next 热重载会保留 globalThis） */
const globalForPrisma = globalThis as unknown as { cxPrisma?: PrismaClient };

function createClient(): PrismaClient {
  return new PrismaClient({
    // 开发态把 sqlite 的告警也打出来（比如慢查询、事务冲突）；
    // error 是生产也要看的，别关。
    log: process.env.NODE_ENV === 'development' ? ['warn', 'error'] : ['error'],
  });
}

export const prisma: PrismaClient = globalForPrisma.cxPrisma ?? createClient();

if (process.env.NODE_ENV !== 'production') {
  globalForPrisma.cxPrisma = prisma;
}
