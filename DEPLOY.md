# 部署指南（Docker 通用版）

面向单机 / VPS / 任意支持 Docker 的云主机。全程只需要 Docker 与 docker compose v2。

> **为什么不能用 Vercel / Netlify 这类纯 serverless**：数据落在 SQLite 文件里，
> serverless 的文件系统是只读且临时销毁的，写不进去。要用托管平台，请确认它支持
> **持久磁盘**（Render Disk / Fly Volume / Railway Volume / CloudBase 持久存储均可）。

---

## 0. 三分钟快速开始

```bash
git clone <你的仓库地址> cuixiang && cd cuixiang

cp .env.example .env
#   打开 .env，至少填这三项：
#     DATABASE_URL="file:../data/cuixiang.db"   ← 保持这个相对路径别改
#     AUTH_SECRET=<下面第 1 步生成>
#     DEEPSEEK_API_KEY=<你的 Key>

mkdir -p data
docker compose up -d --build
docker compose ps          # 两个服务：migrate 应为 exited(0)，app 应为 healthy
curl -s http://localhost:3000/api/health
```

看到 `{"status":"ok","db":"connected",...}` 就成了。

---

## 1. 生成 AUTH_SECRET（**必做**，缺了登录功能全坏）

```bash
# 方式一（有 openssl 的机器）
openssl rand -hex 48

# 方式二（只有 node）
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

把输出贴进 `.env` 的 `AUTH_SECRET=` 后面。要求 ≥16 字符，建议 96 位 hex。

**没配会怎样**：签发登录票据时直接抛错、校验一律当未登录 → 注册/登录全部失败，
所有人都退回游客态。服务不会崩，但账号功能等于没有。

**换掉会怎样**：所有已签发的 `cx_token` 立刻失效（用户被登出），游客票据也会重发。
后台口令（`ADMIN_PASSWORD_HASH`）是另一套，不受影响。

顺便生成后台口令（可选，不配则 `/admin` 自动禁用）：

```bash
node -e "console.log(require('crypto').createHash('sha256').update('你的口令').digest('hex'))"
# 填到 .env 的 ADMIN_PASSWORD_HASH=
```

---

## 2. 环境变量

`.env` 是 compose 的 `env_file`，也是 Prisma CLI 唯一读取的文件（它**不读** `.env.local`）。

| 变量 | 必填 | 说明 |
|---|---|---|
| `DATABASE_URL` | ✅ | 固定写 `file:../data/cuixiang.db`。相对 `prisma/schema.prisma`，容器内解析为 `/app/data/cuixiang.db` |
| `AUTH_SECRET` | ✅ | 见上一步，≥16 字符 |
| `DEEPSEEK_API_KEY` / `GLM_API_KEY` | 至少一个 | 两个都没配会直接抛「没有可用的大脑」 |
| `LLM_PROVIDER` | | `deepseek`（默认）/ `glm` |
| `ORCHESTRATOR` | | `local`（默认，不依赖外部服务）|
| `ADMIN_PASSWORD_HASH` | | 不填 = 后台禁用（fail-closed）|
| `RATE_LIMIT_MAX` | ❌ | **生产不要配**，那是本地跑 smoke 用的 |

---

## 2.5 平台托管路线（Render / Railway，本地不装 Docker）

`docker-compose.yml` 里的迁库编排（`depends_on: service_completed_successfully`）**只有 compose 会读**。
Render / Railway 这类平台拿到仓库后直接 `docker build` 整个 `Dockerfile`（默认构建到最后一个 stage，
也就是 `runner`——顺序已经为此调整过，别再把它挪回去），然后跑容器，**没有任何迁库步骤**。

按平台分两条走法：

### 走法 A：Render 原生环境（推荐，绕开 Dockerfile 迁库难题）

Render 的 Native Environment（不是 Docker Runtime）自带 **Pre-Deploy Command**，且在 build 之后、
实例启动前执行——正好放迁库。控制台配置：

| 配置项 | 值 |
|---|---|
| Environment | `Node` |
| Build Command | `npm ci && npx prisma generate && npm run build` |
| Pre-Deploy Command | `npx prisma migrate deploy` |
| Start Command | `npm start` |
| Environment → `NODE_VERSION` | `20` |
| Environment → `TZ` | `Asia/Shanghai`（记忆里的"今天/昨天"按北京时间算） |
| Environment → `DATABASE_URL` | `file:/var/data/cuixiang.db`（**绝对路径**，指向挂载盘） |
| Environment → `AUTH_SECRET` / `DEEPSEEK_API_KEY` 等 | 同 §2 表格 |
| Disk | 任意大小，挂载路径 `/var/data`（SQLite 就写在这里；**免费实例没有 Disk，必须付费档**） |
| Health Check Path | `/api/health` |

验证：部署完成后 `curl https://<你的域名>/api/health`，应返回 `{"status":"ok","db":"connected"}`。

### 走法 B：Railway / Fly（Dockerfile 路线）

这类平台对多阶段 `target` 支持不一，稳妥做法是**把迁库并进启动流程**：

1. Volume：Railway 挂到 `/app/data`，Fly 挂到 `/app/data`
2. `DATABASE_URL=file:/app/data/cuixiang.db`（**绝对路径**；相对路径依赖 schema 的编译期位置，云盘路径一变就失联）
3. 迁库三选一：
   - 平台支持"release command / deploy 前任务"且能指定 `target: migrator` → 直接用；
   - 平台支持在启动命令前插一步 shell（如 Railway 的 start command）→ 临时换 `Dockerfile` 里加 prisma CLI 的镜像；
   - 都不支持 → 在云盘初始化时用**本地一次性容器**连云盘？SQLite 做不到远程迁库——
     这时最省事的做法是给 `runner` 镜像加回 prisma CLI（把 `Dockerfile` runner 阶段注释里预留的两行
     `COPY --from=migrator` 解开），再让启动命令带 `npx prisma migrate deploy && node server.js`
     （`migrate deploy` 幂等，每次启动多花几秒，换来永不手滑漏迁库）。

> **SQLite + 多实例 = 必炸**：无论哪个平台，SQLite 只能单实例。要横向扩容，先把库换成 Postgres
> （schema 基本兼容，改 `datasource` provider + 迁移历史重建）。

### 云平台通用提醒

- `TZ=Asia/Shanghai` 一定要配，平台默认 UTC，推荐理由里的"今天刚上的"会差 8 小时；
- `RATE_LIMIT_MAX` 同样**不要配**；
- HTTPS 平台自动配好，`NODE_ENV=production` 下 Secure Cookie 生效，不用担心 §4 的 cookie 丢失问题；
- 备份：平台托管拿不到宿主机 shell，用平台自带的盘快照；`npm run db:backup` 只适用于 VPS 路线。

---

## 3. 启动（迁库已自动编排）

```bash
docker compose up -d --build
```

发生了什么：

1. `migrate` 服务先跑 `prisma migrate deploy`，把 `prisma/migrations/` 里的表建好，然后退出（`restart: "no"`）
2. `app` 服务等它**成功退出**（`service_completed_successfully`）才启动
3. 启动前 entrypoint 会把 `/app/data` 的属主改回 `nextjs(1001)`，再降权跑 `server.js`

所以不需要手工"先 migrate 再起服务"，顺序由编排保证。

想单独迁库（例如只改库结构、不想重启业务）：

```bash
docker compose run --rm migrate
```

> 为什么 app 镜像里没有 prisma CLI：它连带引擎约 20MB，而迁库在发布时只跑一次。
> 想改库结构只能通过 migrator 镜像，这是刻意的隔离。

---

## 4. 验证（curl 四条）

### 4.1 健康检查

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok","db":"connected","latencyMs":1,"uptimeSec":12}
```

库连不上时返回 **503** 且 `{"status":"degraded","db":"error"}`——探活会真的执行一次 `SELECT 1`。

### 4.2 鉴权①：错误凭据必须 401（防枚举）

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"nobody@example.com","password":"whatever"}'
# 401
```

响应话术固定为「邮箱或密码不对」，不区分"账号不存在"与"密码错"。

### 4.3 鉴权②：游客身份只认请求头

```bash
curl -s -X POST http://localhost:3000/api/ai \
  -H 'content-type: application/json' \
  -H 'x-guest-id: u_deploy_check' \
  -d '{"message":"你记得我什么"}' | head -c 200
```

`body.userId` 已在 V2.1 删除——客户端自报身份等于能读别人的记忆。

### 4.4 鉴权③：游客注册（原地升级，记忆继承）

用 cookie jar 把两张票串起来：

```bash
JAR=$(mktemp)

# 先聊一句，拿 cx_guest（同时写一条记忆）
curl -s -c "$JAR" -X POST http://localhost:3000/api/ai \
  -H 'content-type: application/json' -H 'x-guest-id: u_deploy_check' \
  -d '{"message":"我不吃辣"}' > /dev/null

# 用这张游客票注册
curl -s -b "$JAR" -c "$JAR" -X POST http://localhost:3000/api/auth/upgrade \
  -H 'content-type: application/json' \
  -d '{"email":"deploy-check@example.com","password":"passw0rd!","guestId":"u_deploy_check"}'
# {"userId":"u_deploy_check","email":"deploy-check@example.com","isGuest":false}

# 刷新等价物：只带 cookie 打 me，应该还是同一个人、记忆还在
curl -s -b "$JAR" http://localhost:3000/api/auth/me | head -c 300
```

第三行返回的 `userId` 必须仍是 `u_deploy_check`（原地升级不换 id），
`memory.core_profile` 里应出现「不吃辣」。

清掉这条测试数据：

```bash
docker compose run --rm --entrypoint sh migrate -c \
  "node -e \"const {PrismaClient}=require('@prisma/client');const p=new PrismaClient();p.memory.deleteMany({where:{userId:'u_deploy_check'}}).then(r=>p.user.deleteMany({where:{id:'u_deploy_check'}})).then(()=>p.\$disconnect())\""
```

---

## 5. HTTPS 反代（**上线必做**）

生产环境 `NODE_ENV=production` 会给登录 cookie 加 `Secure` 属性。
**纯 HTTP 下浏览器会直接丢弃 cookie**，现象是"登录成功但一刷新就掉"——不是你代码的问题。

Nginx 最小配置（注意 SSE）：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain.com;

    ssl_certificate     /etc/letsencrypt/live/your-domain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/your-domain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # /api/ai/stream 是 SSE：不关缓冲会憋成"一次性吐一大段"，打字机效果全没了
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 300s;
    }
}
```

反代在别的机器上时，记得把 compose 的 `ports` 改成 `"127.0.0.1:3000:3000"`，别把 3000 直接暴露到公网。

---

## 6. 备份与恢复

SQLite 开着 WAL，**不能直接 `cp`**（可能漏掉未落盘的事务）。用内置脚本（`VACUUM INTO`，安全快照）：

```bash
# 备份到容器内 /app/data/backups（宿主机 ./data/backups 直接可见）
docker compose run --rm --entrypoint sh migrate -c "npm run db:backup"

# 只留最近 7 份
docker compose run --rm --entrypoint sh migrate -c "npm run db:backup -- --keep=7"
```

恢复：

```bash
docker compose stop app
cp data/backups/cuixiang-YYYYMMDD-HHmmss.db data/cuixiang.db
rm -f data/cuixiang.db-wal data/cuixiang.db-shm   # 旧 WAL 与新库不匹配，必须清掉
docker compose start app
```

建议加个宿主机 crontab：

```cron
0 4 * * * cd /opt/cuixiang && docker compose run --rm --entrypoint sh migrate -c "npm run db:backup -- --keep=7" >> /var/log/cuixiang-backup.log 2>&1
```

---

## 7. 升级发布

```bash
git pull
docker compose up -d --build     # migrate 先跑，app 后起；旧容器自动替换
docker compose ps
curl -s http://localhost:3000/api/health
```

只改代码不动表结构时也一样——`migrate` 发现没有待应用的迁移会直接退出，无副作用。

---

## 8. 常用运维命令

```bash
docker compose logs -f app                 # 跟着看业务日志（含 [Local] / [Brain] trace）
docker compose logs --tail=100 migrate     # 迁库输出
docker compose exec app sh                 # 进容器（非 root 用户 nextjs）
docker compose restart app                 # 只重启业务
docker compose down                        # 停服（数据在 ./data，不会丢）
docker compose build --no-cache app        # 彻底重建
du -h data/cuixiang.db                     # 库多大
```

---

## 9. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 登录成功，刷新就掉线 | 没上 HTTPS，`Secure` cookie 被浏览器丢弃 | 配好证书，或用 `http://localhost` 访问（localhost 是例外） |
| `/api/health` 返回 503 | 库文件不可写 / 未迁库 | `docker compose logs migrate` 看迁移；`docker compose run --rm migrate` 补跑 |
| 写库报 `EACCES` / `readonly database` | `./data` 属主不是 1001（Linux 宿主机常见） | `docker compose run --rm migrate` 会 chown；或手工 `sudo chown -R 1001:1001 data` |
| 启动即 `Query engine library not found` | 镜像缺 Prisma 引擎 | 本 Dockerfile 已显式拷 `node_modules/.prisma` 与 `@prisma`，自定义镜像请保留这两行 |
| `Cannot find module '@prisma/client'` | 改动了构建阶段顺序 | 确认 `deps` 里跑过 `npx prisma generate`，且 builder 用的是 `--from=deps` 的 node_modules |
| 注册/登录全 500 | `AUTH_SECRET` 没配 | 见第 1 步 |
| 中文回复里日期差 8 小时 | 容器默认 UTC | compose 已设 `TZ=Asia/Shanghai` |
| 流式输出变成"憋一大段再吐" | 反代开了 buffering | Nginx 加 `proxy_buffering off` |
| `port is already allocated` | 3000 被占用 | 改 compose `ports: "8080:3000"`，反代指到 8080 |

---

## 10. 镜像结构说明

```
deps       node:20-alpine + npm ci + prisma generate
builder    next build → .next/standalone
runner     standalone 产物 + Prisma 引擎 + su-exec   ← 生产镜像，无 prisma CLI
migrator   完整 node_modules + prisma/              ← 只在部署时跑一次
```

- 业务进程以 `nextjs(1001)` 运行，只有 entrypoint 短暂以 root 修数据目录权限
- `./data` 是唯一需要持久化的路径；`.env` 不入镜像（`.dockerignore` 已排除）
- 换机器时带走 `./data` 与 `.env` 即可，其余都能重建

---

## 11. 部署前自检

```bash
npm run verify        # 类型 + 单测
npm run guard         # profile / reco 两份守卫
npm run build         # 确认 standalone 能产出
npm run smoke         # 端到端（需本地 dev server 在跑）
```

四条都绿再上，别把回归留到线上做。
