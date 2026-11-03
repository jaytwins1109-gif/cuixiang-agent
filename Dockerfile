# syntax=docker/dockerfile:1
#
# 四个阶段：
#   deps     —— 装依赖 + prisma generate（只有这一层碰网络）
#   builder  —— next build，产出 .next/standalone
#   runner   —— 生产镜像（app），只带 standalone 产物与 Prisma 引擎
#   migrator —— 一次性容器，跑 prisma migrate deploy
#
# 为什么 migrate 不塞进 app 镜像：Prisma CLI 连带引擎约 20MB，且发布时只跑一次。
# app 镜像里**故意没有** prisma CLI —— 想在业务容器里改库结构，得先过
# `docker compose run --rm migrate` 这一关。
#
# SQLite 落在 /app/data，由 compose 挂卷持久化；容器重建不丢数据。

###############################################################################
# 1. deps
###############################################################################
FROM node:20-alpine AS deps
WORKDIR /app

# libc6-compat：Next 的 SWC 二进制在 musl 上需要
# openssl：Prisma 引擎要
RUN apk add --no-cache libc6-compat openssl

COPY package.json package-lock.json ./
COPY prisma ./prisma

# npm ci 按 lockfile 装，保证和本地一致；此处还没设 NODE_ENV=production，
# 否则 devDependencies（prisma / typescript / tailwind）会被跳过，build 直接失败
RUN npm ci && npx prisma generate

###############################################################################
# 2. builder
###############################################################################
FROM node:20-alpine AS builder
WORKDIR /app

RUN apk add --no-cache libc6-compat openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

ENV NEXT_TELEMETRY_DISABLED=1
# build 期不连库，给个占位符就够；真实 DATABASE_URL 只在运行时注入。
# 不设的话 PrismaClient 初始化就会抱怨变量缺失。
ENV DATABASE_URL="file:../data/build-placeholder.db"

RUN npm run build

###############################################################################
# 3. runner（生产镜像）
###############################################################################
FROM node:20-alpine AS runner
WORKDIR /app

# su-exec：entrypoint 以 root 修好数据目录属主后，降权到 nextjs 跑业务
RUN apk add --no-cache openssl su-exec

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0

RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 nextjs

# standalone 自带 server.js 与裁剪过的 node_modules
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

# Prisma 的查询引擎是 .node 二进制，standalone 的静态追踪不保证带上。
# 漏了它的症状：启动即报 "Query engine library not found"。
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh \
    && mkdir -p /app/data \
    && chown -R nextjs:nodejs /app/data

# 保持 root 启动：bind mount 下来的 ./data 属主属于宿主机，
# 只有 root 才能 chown 回 nextjs，随后 entrypoint 里立刻降权
USER root
EXPOSE 3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

###############################################################################
# 4. migrator（一次性）
###############################################################################
FROM node:20-alpine AS migrator
WORKDIR /app

RUN apk add --no-cache openssl

# 迁库要完整 CLI 与依赖树，这里不裁剪
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY prisma ./prisma

ENV NODE_ENV=production

# compose 里会覆盖成带 chown 的 shell 命令；直接 docker run 也能用
ENTRYPOINT ["npx", "prisma", "migrate", "deploy"]
