#!/usr/bin/env bash
# 班主任作业追踪 —— Linux 服务器一键部署（Ubuntu 22.04+ / Debian 12+）
# 适用：腾讯云 CVM、轻量应用服务器、其他云主机
#
# 用法（二选一）：
#   A. 代码已在这台服务器上： sudo bash scripts/deploy-linux.sh
#   B. 服务器上还没有代码：   sudo bash deploy-linux.sh   （脚本会自己 git clone）
#
# 可覆盖：APP_DIR=/opt/hw-tracker  PORT=3000  REPO=<git 地址>
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/hw-tracker}"
PORT="${PORT:-3000}"
SERVICE="hw-tracker"
REPO="${REPO:-https://github.com/zhangdake123/homework-tracker.git}"

log() { echo ""; echo "==> $*"; }

if [ "$(id -u)" -ne 0 ]; then
  echo "请用 root 运行：sudo bash $0"
  exit 1
fi

log "1/7 安装基础工具（git / curl / ca-certificates）"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git curl ca-certificates

log "2/7 检查 Node.js 版本（需要 22.13+ 或 23.4+）"
need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'process.versions.node.split(".")[0]')"
  minor="$(node -p 'process.versions.node.split(".")[1]')"
  echo "当前版本：$(node --version)"
  if [ "$major" -ge 24 ]; then need_node=0; fi
  if [ "$major" -eq 23 ] && [ "$minor" -ge 4 ]; then need_node=0; fi
  if [ "$major" -eq 22 ] && [ "$minor" -ge 13 ]; then need_node=0; fi
fi
if [ "$need_node" -eq 1 ]; then
  echo "安装 Node.js 24（NodeSource）"
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
  apt-get install -y nodejs
fi
NODE_BIN="$(command -v node)"
echo "使用 Node：$NODE_BIN $($NODE_BIN --version)"

log "3/7 准备代码目录 $APP_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
if [ -f "$SRC_DIR/server.js" ] && [ "$SRC_DIR" != "$APP_DIR" ]; then
  echo "从本地目录复制：$SRC_DIR"
  mkdir -p "$APP_DIR"
  tar -C "$SRC_DIR" --exclude=./data --exclude=./.git --exclude=./work --exclude=./.vercel --exclude=./node_modules -cf - . | tar -C "$APP_DIR" -xf -
elif [ -f "$APP_DIR/server.js" ]; then
  echo "代码已存在于 $APP_DIR，保留原样"
elif [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" reset --hard origin/main
else
  echo "从 GitHub 克隆：$REPO"
  git clone "$REPO" "$APP_DIR"
fi
mkdir -p "$APP_DIR/data"

log "4/7 写入 systemd 服务（开机自启 + 崩溃自动重启）"
cat > "/etc/systemd/system/$SERVICE.service" <<UNIT
[Unit]
Description=Homework Tracker (班主任作业追踪)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
Environment=PORT=$PORT
Environment=HOST=0.0.0.0
Environment=NODE_ENV=production
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null

log "5/7 启动服务"
systemctl restart "$SERVICE"
sleep 2
systemctl --no-pager -l status "$SERVICE" | head -n 10 || true

log "6/7 安装每天 21:00 自动备份（保留最近 14 份）"
cat > "/etc/cron.d/hw-tracker-backup" <<CRON
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
0 21 * * * root APP_DIR=$APP_DIR bash $APP_DIR/scripts/backup-db.sh >> /var/log/hw-tracker-backup.log 2>&1
CRON
chmod 644 /etc/cron.d/hw-tracker-backup

log "7/7 自检"
if curl -fsS "http://127.0.0.1:$PORT/api/meta" >/dev/null; then
  echo "本地接口 /api/meta 正常"
else
  echo "接口自检失败，查看日志：journalctl -u $SERVICE -n 50 --no-pager"
fi
IP="$(curl -fsS --max-time 5 https://api.ipify.org || echo '服务器公网IP')"
cat <<TIP

========================================
部署完成
访问地址：http://$IP:$PORT
数据文件：$APP_DIR/data/tracker.db
备份目录：$APP_DIR/data/backups（每天 21:00 自动，保留 14 份）
查看日志：journalctl -u $SERVICE -f
重启服务：systemctl restart $SERVICE
更新代码：cd $APP_DIR && git pull && systemctl restart $SERVICE
========================================

还需要手动做一件事：到腾讯云控制台 → 轻量应用服务器/CVM → 防火墙或安全组，
放行 TCP $PORT，否则手机和电脑都连不上。
大陆服务器用 IP+端口访问不需要备案；若想用 80/443 且绑域名，则必须完成 ICP 备案。
TIP
