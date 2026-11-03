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

import { PrismaClient } from '@prisma/client';

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
