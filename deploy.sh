#!/usr/bin/env bash
# Nearby single-instance deployment. Never source .env. HTTPS terminates at Cloudflare; the origin is HTTP only.
set -euo pipefail

ROOT=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT"
ACTION=up
DOMAIN=""
TIMEOUT=120
SERVICE=all

usage() {
  cat <<'USAGE'
近邻 Nearby · Docker 部署

用法：./deploy.sh [命令] [选项]

命令：
  init       创建 .env，不启动容器，不覆盖已有配置
  up         构建镜像并启动，等待容器就绪（默认）
  update     拉取基础镜像、重新构建并更新容器
  down       停止并移除本项目容器
  logs       持续查看日志，可选 nearby / all（默认）
  status     查看容器状态
  check      校验域名与 Compose 配置，不要求 Docker 引擎启动
  refresh-proxies 更新 Cloudflare 官方可信代理网段

选项：
  --domain DOMAIN    配置访问域名，例如 nearby.your-domain.com；用于 init/up/update
  --timeout SECONDS 等待启动时间，默认 120 秒；用于 up/update
  -h, --help        查看帮助

示例：
  ./deploy.sh up --domain nearby.your-domain.com
  ./deploy.sh update
  ./deploy.sh logs nearby

启动前将域名 A 记录指向服务器，开启橙云，SSL/TLS 使用 Flexible。
源站只开放 HTTP 80；对外 HTTPS 由 Cloudflare 提供。
脚本不会安装 Docker、拉取项目源码或启用 TURN。
USAGE
}
die() { printf '错误：%s\n' "$*" >&2; exit 1; }

if [[ $# -gt 0 && "$1" != -* ]]; then ACTION=$1; shift; fi
case "$ACTION" in init|up|update|down|logs|status|check|refresh-proxies) ;; *) usage >&2; die "未知命令：$ACTION";; esac
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)
      [[ $# -ge 2 && -n "$2" ]] || die "--domain 后需要填写域名"
      DOMAIN=$2; shift 2;;
    --timeout)
      [[ $# -ge 2 && "$2" =~ ^[1-9][0-9]{0,3}$ ]] || die "--timeout 需要填写 1–9999 的整数"
      [[ "$ACTION" == up || "$ACTION" == update ]] || die "--timeout 仅用于 up/update"
      TIMEOUT=$2; shift 2;;
    -h|--help) usage; exit 0;;
    nearby|all)
      [[ "$ACTION" == logs ]] || die "服务名仅用于 logs 命令"
      SERVICE=$1; shift;;
    *) die "未知选项：$1；使用 --help 查看帮助";;
  esac
done
if [[ -n "$DOMAIN" ]]; then
  case "$ACTION" in init|up|update) ;; *) die "--domain 仅用于 init/up/update";; esac
fi

validate_domain() {
  local value=$1
  [[ ${#value} -le 253 && "$value" == *.* && "$value" != *[!a-zA-Z0-9.-]* ]] || die "请填写域名，不要包含协议、端口或路径：$value"
  printf '%s\n' "$value" | awk -F. '{for(i=1;i<=NF;i++) if(length($i)<1 || length($i)>63 || $i !~ /^[a-zA-Z0-9]/ || $i !~ /[a-zA-Z0-9]$/) exit 1; if($NF ~ /^[0-9]+$/) exit 1}' || die "域名格式无效：$value"
  case "$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')" in
    example.com|*.example.com|example.org|*.example.org|example.net|*.example.net|*.local|*.localhost|*.test|*.invalid|*.example)
      die "请将示例或本地域名替换为真实公网域名：$value";;
  esac
}

# Only explicit --domain changes existing configuration. No eval/source is used.
if [[ -n "$DOMAIN" ]]; then validate_domain "$DOMAIN"; fi
if [[ "$ACTION" == init || "$ACTION" == up || "$ACTION" == update ]]; then
  if [[ ! -f .env ]]; then
    [[ -f .env.example ]] || die "缺少 .env.example"
    (umask 077; cp .env.example .env)
    printf '已创建 %s/.env\n' "$ROOT"
  fi
  if [[ -n "$DOMAIN" ]]; then
    TEMP_ENV=$(mktemp "$ROOT/.env.deploy.XXXXXX")
    trap 'rm -f -- "$TEMP_ENV"' EXIT
    awk -v domain="$DOMAIN" '
      /^[[:space:]]*(export[[:space:]]+)?NEARBY_DOMAIN[[:space:]]*=/ {if(!found++) print "NEARBY_DOMAIN=" domain; next}
      {print}
      END {if(!found) print "NEARBY_DOMAIN=" domain}
    ' .env > "$TEMP_ENV"
    chmod 600 "$TEMP_ENV"
    mv -- "$TEMP_ENV" .env
    trap - EXIT
    # Match an explicitly requested domain even if the caller exported an older value.
    export NEARBY_DOMAIN="$DOMAIN"
  fi
fi
if [[ "$ACTION" == init || "$ACTION" == up || "$ACTION" == update ]]; then
  if [[ ! -f .env.cloudflare ]]; then
    (umask 077; cp .env.cloudflare.example .env.cloudflare)
  fi
fi

refresh_proxies() {
  command -v curl >/dev/null 2>&1 || die "更新 Cloudflare 网段需要 curl，请先安装"
  local temporary
  temporary=$(mktemp -d "$ROOT/.cloudflare-ips.XXXXXX")
  trap 'rm -rf -- "$temporary"' EXIT
  local family
  for family in 4 6; do
    if ! curl --proto '=https' --proto-redir '=https' -fsSL --connect-timeout 10 --max-time 30 "https://www.cloudflare.com/ips-v$family" -o "$temporary/ips$family"; then
      die "Cloudflare 官方网段下载失败；已有可信代理配置保持不变"
    fi
  done
  cat "$temporary/ips4" > "$temporary/all"
  printf '\n' >> "$temporary/all"
  cat "$temporary/ips6" >> "$temporary/all"
  # Accept only CIDR rows; never interpret the downloaded content as shell code.
  if ! tr -d '\r' < "$temporary/all" | awk '
    /^[[:space:]]*$/ {next}
    { if(split($0,a,"/")!=2 || a[2]!~/^[0-9]+$/) exit 1;
      if(a[1] ~ /:/) {if(a[1]!~/^[0-9a-fA-F:]+$/ || a[2]<16 || a[2]>128) exit 1; v6++}
      else {if(split(a[1],b,".")!=4 || a[2]<8 || a[2]>32) exit 1; for(i=1;i<=4;i++) if(b[i]!~/^[0-9]+$/ || b[i]>255) exit 1; v4++}
      print
    }
    END {if(!v4 || !v6) exit 1}
  ' > "$temporary/validated"; then die "Cloudflare 网段内容无效；已有配置保持不变"; fi
  printf 'CLOUDFLARE_TRUSTED_PROXIES=%s\n' "$(paste -sd, "$temporary/validated")" > "$temporary/env"
  chmod 600 "$temporary/env"
  mv -- "$temporary/env" "$ROOT/.env.cloudflare"
  rm -rf -- "$temporary"
  trap - EXIT
  printf '已更新 Cloudflare 官方可信代理网段。\n'
}
if [[ "$ACTION" == refresh-proxies ]]; then refresh_proxies; exit 0; fi
if [[ "$ACTION" == init ]]; then
  printf '配置已准备好，已有其他配置保持不变。填写 .env 后执行 ./deploy.sh check 或 ./deploy.sh up。\n'
  exit 0
fi

command -v docker >/dev/null 2>&1 || die "请先安装 Docker Engine 和 Docker Compose v2"
COMPOSE=()
if docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  for candidate in /opt/homebrew/lib/docker/cli-plugins/docker-compose /usr/local/lib/docker/cli-plugins/docker-compose /usr/libexec/docker/cli-plugins/docker-compose; do
    if [[ -x "$candidate" ]]; then COMPOSE=("$candidate"); break; fi
  done
fi
[[ ${#COMPOSE[@]} -gt 0 ]] || die "未找到 Docker Compose v2，请先安装"
VERSION=$("${COMPOSE[@]}" version --short)
VERSION=${VERSION#v}
MAJOR=${VERSION%%.*}; REST=${VERSION#*.}; MINOR=${REST%%.*}
[[ "$MAJOR" =~ ^[0-9]+$ && "$MINOR" =~ ^[0-9]+$ ]] || die "无法识别 Compose 版本：$VERSION"
if (( MAJOR < 2 || (MAJOR == 2 && MINOR < 18) )); then die "需要 Docker Compose 2.18 或更新版本（当前 ${VERSION}）"; fi

[[ -f .env ]] || die "缺少 .env，请先执行 ./deploy.sh init --domain 你的域名"
[[ -f .env.cloudflare ]] || die "缺少可信代理配置，请先执行 ./deploy.sh init"
compose() { "${COMPOSE[@]}" --project-name nearby --project-directory "$ROOT" --env-file "$ROOT/.env" --env-file "$ROOT/.env.cloudflare" -f "$ROOT/compose.yaml" "$@"; }
compose config --quiet
# Read Compose's resolved value, accounting for shell/.env interpolation precedence.
RESOLVED_DOMAIN=$(compose config --environment | awk -F= '$1=="NEARBY_DOMAIN" {print substr($0,index($0,"=")+1)}')
if [[ "$ACTION" == up || "$ACTION" == update || "$ACTION" == check ]]; then validate_domain "$RESOLVED_DOMAIN"; fi
if [[ "$ACTION" == check ]]; then printf '检查通过：Compose %s，访问域名 %s，TURN 未启用。\n' "$VERSION" "$RESOLVED_DOMAIN"; exit 0; fi
docker info >/dev/null 2>&1 || die "无法连接 Docker 引擎。请启动 Docker 并确认当前用户有访问权限"

case "$ACTION" in
  up|update)
    refresh_proxies
    compose config --quiet
    if [[ "$ACTION" == update ]]; then
      printf '正在更新镜像（请先将需要部署的源码更新到当前目录）…\n'
      compose build --pull nearby
    else
      compose build nearby
    fi
    if ! compose up -d --wait --wait-timeout "$TIMEOUT"; then
      printf '启动失败或等待超时。以下为容器状态与最近日志：\n' >&2
      compose ps >&2 || true
      compose logs --tail=60 nearby >&2 || true
      exit 1
    fi
    compose ps
    printf '\n容器已就绪。访问：https://%s\n' "$RESOLVED_DOMAIN"
    printf '源站仅提供 HTTP；请在 Cloudflare 开启橙云、Flexible 和 Always Use HTTPS。\n';;
  down) compose down; printf '服务已停止。\n';;
  status) compose ps;;
  logs) if [[ "$SERVICE" == all ]]; then compose logs --tail=100 -f; else compose logs --tail=100 -f "$SERVICE"; fi;;
esac
