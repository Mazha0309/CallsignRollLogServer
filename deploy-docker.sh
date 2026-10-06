#!/bin/bash
set -euo pipefail

# OpenLogTool Server Docker Compose 一键部署脚本
# 用法: bash deploy-docker.sh [host_port]
# 或: curl -fsSL https://raw.githubusercontent.com/Mazha0309/CallsignRollLogServer/main/deploy-docker.sh | bash -s -- [host_port]
# 可通过 OPENLOGTOOL_BRANCH=dev 部署其他远端分支；默认部署 main。

REQUESTED_HOST_PORT="${1:-}"
HOST_PORT="${REQUESTED_HOST_PORT:-3000}"
PROJECT_DIR="${OPENLOGTOOL_PROJECT_DIR:-$HOME/OpenLogToolServer}"
BACKUP_ROOT="${OPENLOGTOOL_BACKUP_DIR:-$HOME/OpenLogToolServer-backups}"
BRANCH="${OPENLOGTOOL_BRANCH:-main}"

fail() {
  echo "错误: $*" >&2
  exit 1
}

validate_port() {
  local value="$1"
  [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ] \
    || fail "端口必须是 1-65535 之间的整数"
}

validate_port "$HOST_PORT"

for command_name in git docker; do
  command -v "$command_name" &>/dev/null || fail "请先安装 ${command_name}"
done
docker compose version &>/dev/null || fail "需要 Docker Compose v2（docker compose）"
docker info &>/dev/null || fail "无法连接 Docker daemon，请启动 Docker 并确认当前用户有权限访问"
git check-ref-format --branch "$BRANCH" &>/dev/null || fail "无效的 Git 分支名: $BRANCH"

echo "=== 1. 克隆/更新代码 ==="
if [ -e "$PROJECT_DIR" ]; then
  [ -d "$PROJECT_DIR/.git" ] || fail "$PROJECT_DIR 已存在但不是 Git 仓库，请手动处理后重试"
  cd "$PROJECT_DIR"
  [ -z "$(git status --porcelain --untracked-files=no)" ] || fail "仓库存在未提交的已跟踪文件修改，部署已停止"
  git fetch --prune origin "$BRANCH"
  if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
    git switch "$BRANCH"
  else
    git switch --track -c "$BRANCH" "origin/$BRANCH"
  fi
  git pull --ff-only origin "$BRANCH"
else
  git clone --branch "$BRANCH" --single-branch \
    https://github.com/Mazha0309/CallsignRollLogServer.git "$PROJECT_DIR"
  cd "$PROJECT_DIR"
fi

echo "=== 2. 配置环境与独立密钥 ==="
umask 077
if [ ! -f .env ]; then
  cp .env.example .env
fi

read_env_value() {
  local value
  value="$(awk -v key="$1" '
    {
      line = $0
      sub(/^[[:space:]]*/, "", line)
      if (index(line, key) != 1) next
      rest = substr(line, length(key) + 1)
      if (rest !~ /^[[:space:]]*=/) next
      sub(/^[[:space:]]*=[[:space:]]*/, "", rest)
      result = rest
    }
    END { printf "%s", result }
  ' .env)"
  value="${value%$'\r'}"
  if [[ ${#value} -ge 2 && "$value" == \"*\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ ${#value} -ge 2 && "$value" == \'*\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

write_env_value() {
  local name="$1"
  local value="$2"
  if grep -Eq "^[[:space:]]*${name}[[:space:]]*=" .env; then
    sed -i -E "s|^[[:space:]]*${name}[[:space:]]*=.*$|${name}=${value}|" .env
  else
    printf '%s=%s\n' "$name" "$value" >> .env
  fi
}

ensure_secret() {
  local name="$1"
  local minimum_bytes="$2"
  local generated_bytes="$3"
  local value
  local actual_bytes

  value="$(read_env_value "$name")"
  if [ -z "$value" ]; then
    value="$(od -An -N "$generated_bytes" -tx1 /dev/urandom | tr -d '[:space:]')"
    write_env_value "$name" "$value"
    echo "已生成 ${name}"
    return
  fi

  actual_bytes="$(LC_ALL=C printf '%s' "$value" | wc -c | tr -d '[:space:]')"
  if [ "$actual_bytes" -lt "$minimum_bytes" ]; then
    fail "${name} 已存在但只有 ${actual_bytes} 字节，至少需要 ${minimum_bytes} 字节；为避免静默轮换，部署已停止"
  fi
}

ensure_secret JWT_SECRET 32 32
ensure_secret ADMIN_BOOTSTRAP_TOKEN 24 24
ensure_secret INVITE_HMAC_KEY 32 32
ensure_secret PUBLIC_SHARE_HMAC_KEY 32 32
if [ -z "$REQUESTED_HOST_PORT" ]; then
  configured_host_port="$(read_env_value HOST_PORT)"
  if [ -n "$configured_host_port" ]; then
    validate_port "$configured_host_port"
    HOST_PORT="$configured_host_port"
  fi
fi
write_env_value HOST_PORT "$HOST_PORT"
chmod 600 .env

mkdir -p data
if ! chown -R 1000:1000 data 2>/dev/null; then
  mismatched_owner="$(find data \( ! -uid 1000 -o ! -gid 1000 \) -print -quit)"
  [ -z "$mismatched_owner" ] || fail "data 目录必须可由容器内 UID/GID 1000:1000 写入；请执行 sudo chown -R 1000:1000 '$PROJECT_DIR/data'"
fi
chmod 700 data

echo "=== 3. 构建 Docker 镜像 ==="
docker compose build server

if [ -f data/openlogtool.db ]; then
  echo "=== 4. 停服并备份 SQLite ==="
  backup_dir="$BACKUP_ROOT/$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$backup_dir"
  docker compose stop server
  cp -a data/. "$backup_dir/"
  echo "数据库已备份到: $backup_dir"
else
  echo "=== 4. 首次部署，无现有数据库需要备份 ==="
fi

echo "=== 5. 重建并启动服务 ==="
docker compose up -d --force-recreate server

echo "=== 6. 等待健康检查 ==="
healthy=false
for _ in $(seq 1 60); do
  container_id="$(docker compose ps --all --quiet server)"
  if [ -n "$container_id" ]; then
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$container_id" 2>/dev/null || true)"
    if [ "$health" = "healthy" ]; then
      healthy=true
      break
    fi
    if [ "$health" = "unhealthy" ] || [ "$health" = "exited" ] || [ "$health" = "dead" ]; then
      break
    fi
  fi
  sleep 2
done

if [ "$healthy" != true ]; then
  docker compose ps
  docker compose logs --tail=100 server
  fail "服务未通过健康检查，请根据上方日志排查"
fi

echo ""
echo "=== 部署完成 ==="
echo "分支: $BRANCH"
echo "服务器: http://localhost:$HOST_PORT"
echo "管理后台: http://localhost:$HOST_PORT/admin"
echo "Public Live Share: http://localhost:$HOST_PORT/live/<share-id>#token=<secret>"
echo "首次初始化管理员需要使用 $PROJECT_DIR/.env 中的 ADMIN_BOOTSTRAP_TOKEN"
