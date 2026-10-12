#!/usr/bin/env bash
# 备份数据库：bash scripts/backup-db.sh
# APP_DIR 默认取本脚本所在仓库的根目录，可用环境变量覆盖
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="${APP_DIR:-$(cd "$SCRIPT_DIR/.." && pwd)}"
APP_DIR="$APP_DIR" node "$SCRIPT_DIR/backup-db.js"
