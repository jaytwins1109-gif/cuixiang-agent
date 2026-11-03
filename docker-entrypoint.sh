#!/bin/sh
# 容器入口。
#
# 只做两件事：
#   1. 把数据目录交还给 nextjs(1001) —— compose 挂进来的 ./data 属主属于宿主机，
#      容器内不 chown 的话，SQLite 建库/写 WAL 会直接 EACCES。
#   2. 降权后启动 server.js —— 业务进程不以 root 跑。
#
# 以非 root 启动（部署平台强制 runAsNonRoot）时跳过 chown，直接跑。

set -eu

DATA_DIR="${DATA_DIR:-/app/data}"

run_as_app() {
  if [ "$(id -u)" = "0" ]; then
    exec su-exec nextjs:nodejs "$@"
  fi
  exec "$@"
}

mkdir -p "$DATA_DIR" 2>/dev/null || true

if [ "$(id -u)" = "0" ]; then
  # 修不了也别拦着启动：只读卷等场景下，权限问题会在第一次写库时暴露得更清楚
  chown -R nextjs:nodejs "$DATA_DIR" 2>/dev/null || true
fi

# 允许 `docker run <image> sh` 这类临时覆盖
if [ "$#" -gt 0 ]; then
  run_as_app "$@"
fi

run_as_app node server.js
