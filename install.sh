#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "部署失败（第 $LINENO 行）。已有配置和数据会保留。" >&2' ERR

# 可通过环境变量部署自己的 fork；配置和数据始终留在源码目录之外。
REPO_URL="${REPO_URL:-https://github.com/zijin-c/cfgetcid.git}"
BRANCH="${BRANCH:-main}"
INSTALL_DIR=/opt/cfgetcid
CONFIG_DIR=/etc/cfgetcid
DATA_DIR=/var/lib/cfgetcid
CONTAINER=cfgetcid
IMAGE=cfgetcid:local

[[ $EUID -eq 0 ]] || { echo '请使用 root 或 sudo bash 运行。' >&2; exit 1; }
[[ -f /etc/os-release ]] || { echo '仅支持 Debian/Ubuntu。'; exit 1; }
. /etc/os-release
[[ "$ID" == debian || "$ID" == ubuntu ]] || { echo '仅支持 Debian/Ubuntu。'; exit 1; }
command -v systemctl >/dev/null || { echo '需要使用 systemd 的 VPS。'; exit 1; }
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git openssl util-linux
mkdir -p "$INSTALL_DIR" "$CONFIG_DIR" "$DATA_DIR"
exec 9>"$CONFIG_DIR/install.lock"
flock -n 9 || { echo '另一个部署进程正在运行。'; exit 1; }
chmod 700 "$CONFIG_DIR"

if ! command -v docker >/dev/null; then
  # 使用系统仓库，避免替换现有 Docker/containerd。
  apt-get install -y docker.io
fi
systemctl enable --now docker
docker info >/dev/null

if [[ -d "$INSTALL_DIR/.git" ]]; then
  [[ -z "$(git -C "$INSTALL_DIR" status --porcelain)" ]] || {
    echo "$INSTALL_DIR 有本地修改，请先保存后再更新。"; exit 1;
  }
  [[ "$(git -C "$INSTALL_DIR" remote get-url origin)" == "$REPO_URL" ]] || {
    echo '仓库地址与现有安装不一致，请设置正确的 REPO_URL。'; exit 1;
  }
  git -C "$INSTALL_DIR" fetch origin "$BRANCH"
  git -C "$INSTALL_DIR" checkout --detach FETCH_HEAD
else
  [[ -z "$(ls -A "$INSTALL_DIR")" ]] || { echo "$INSTALL_DIR 非空，停止安装。"; exit 1; }
  git clone --branch "$BRANCH" --single-branch "$REPO_URL" "$INSTALL_DIR"
fi
[[ -f "$INSTALL_DIR/Dockerfile" ]] || { echo '所选 GitHub 分支尚未包含 VPS 部署文件，请先推送代码。'; exit 1; }

if [[ ! -f "$CONFIG_DIR/app.env" ]]; then
  password=$(openssl rand -hex 16)
  umask 077
  cat >"$CONFIG_DIR/app.env" <<EOF
LOG_PASSWORD=$password
PAGE_SIZE=20
TIMEZONE_OFFSET=8
TRUST_PROXY=
EOF
fi
if [[ ! -f "$CONFIG_DIR/deploy.env" ]]; then
  host_port="${HOST_PORT:-9567}"
  bind_ip="${BIND_IP:-0.0.0.0}"
  [[ "$host_port" =~ ^[0-9]+$ && ${#host_port} -le 5 ]] && ((10#$host_port >= 1 && 10#$host_port <= 65535)) || { echo 'HOST_PORT 无效。'; exit 1; }
  [[ "$bind_ip" == 0.0.0.0 || "$bind_ip" == 127.0.0.1 ]] || { echo 'BIND_IP 仅支持 0.0.0.0 或 127.0.0.1。'; exit 1; }
  printf 'HOST_PORT=%s\nBIND_IP=%s\n' "$host_port" "$bind_ip" >"$CONFIG_DIR/deploy.env"
fi

# 先构建，成功后再切换。升级失败时保留旧容器用于恢复。
docker build --pull -t "$IMAGE" "$INSTALL_DIR"
node_uid=$(docker run --rm --entrypoint id "$IMAGE" -u node)
node_gid=$(docker run --rm --entrypoint id "$IMAGE" -g node)
chown -R "$node_uid:$node_gid" "$DATA_DIR"
chmod 700 "$DATA_DIR"
install -m 755 "$INSTALL_DIR/scripts/cfgetcid.sh" /usr/local/bin/cfgetcid
printf 'REPO_URL=%q\nBRANCH=%q\n' "$REPO_URL" "$BRANCH" > "$CONFIG_DIR/source.env"
chmod 600 "$CONFIG_DIR/source.env"
chmod 755 /usr/local/bin/cfgetcid
/usr/local/bin/cfgetcid apply-config
echo '安装完成。访问 http://服务器IP:端口，日志后台路径 /logs。'
echo '首次后台密码见 /etc/cfgetcid/app.env 的 LOG_PASSWORD；网页修改后以新密码为准。'
echo '修改配置：编辑 /etc/cfgetcid/app.env，然后运行 cfgetcid apply-config。'
echo '管理菜单：cfgetcid；状态：cfgetcid status；运行日志：cfgetcid logs。'
echo '请在 VPS 服务商安全组放行端口，或配置 HTTPS 反向代理。'
