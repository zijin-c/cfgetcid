#!/usr/bin/env bash
set -Eeuo pipefail
CONFIG_DIR=/etc/cfgetcid
DATA_DIR=/var/lib/cfgetcid
SOURCE_DIR=/opt/cfgetcid
BACKUP_DIR=/var/backups/cfgetcid

status() {
  docker ps -a --filter name='^/cfgetcid$'
  if [[ -d "$SOURCE_DIR/.git" ]]; then
    printf '当前版本：'
    git -C "$SOURCE_DIR" log -1 --format='%h %s'
  fi
  echo "配置目录：$CONFIG_DIR；数据目录：$DATA_DIR"
}

apply_config() {
  exec 8>"$CONFIG_DIR/deploy.lock"
  flock -n 8 || { echo '另一个启动或更新进程正在运行。'; return 1; }
  (
    . "$CONFIG_DIR/deploy.env"
    [[ "$HOST_PORT" =~ ^[0-9]+$ && ${#HOST_PORT} -le 5 ]] && ((10#$HOST_PORT >= 1 && 10#$HOST_PORT <= 65535)) || { echo '端口配置无效。'; exit 1; }
    [[ "$BIND_IP" == 0.0.0.0 || "$BIND_IP" == 127.0.0.1 ]] || { echo '监听地址无效。'; exit 1; }
    if docker container inspect cfgetcid-previous >/dev/null 2>&1; then
      echo '存在 cfgetcid-previous，请先检查上次更新留下的容器。'; exit 1
    fi
    previous=false
    if docker container inspect cfgetcid >/dev/null 2>&1; then
      docker stop -t 40 cfgetcid >/dev/null
      docker rename cfgetcid cfgetcid-previous
      previous=true
    fi
    rollback() {
      docker logs --tail 30 cfgetcid 2>/dev/null || true
      docker rm -f cfgetcid >/dev/null 2>&1 || true
      if $previous; then
        docker rename cfgetcid-previous cfgetcid
        docker start cfgetcid >/dev/null
        echo '新版本启动失败，已恢复旧容器。' >&2
      fi
      exit 1
    }
    docker run -d --name cfgetcid --restart unless-stopped --init \
      --env-file "$CONFIG_DIR/app.env" -p "$BIND_IP:$HOST_PORT:9567" \
      -v "$DATA_DIR:/app/data" \
      --log-driver json-file --log-opt max-size=10m --log-opt max-file=3 \
      cfgetcid:local >/dev/null || rollback
    for ((i=0; i<60; i++)); do
      health=$(docker inspect --format '{{.State.Health.Status}}' cfgetcid) || rollback
      if [[ "$health" == healthy ]]; then
        if $previous; then docker rm cfgetcid-previous >/dev/null; fi
        echo "服务启动成功，端口 $HOST_PORT。"
        exit 0
      fi
      sleep 2
    done
    rollback
  )
  local code=$?
  flock -u 8
  exec 8>&-
  return "$code"
}

backup() (
  exec 8>"$CONFIG_DIR/deploy.lock"
  flock -n 8 || { echo '另一个维护进程正在运行。'; exit 1; }
  mkdir -p "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  local archive restart=false
  archive="$BACKUP_DIR/cfgetcid-$(date +%Y%m%d-%H%M%S)-${BASHPID}.tar.gz"
  if [[ "$(docker inspect --format '{{.State.Running}}' cfgetcid 2>/dev/null || true)" == true ]]; then
    docker stop -t 40 cfgetcid >/dev/null || { echo '无法停止服务，已取消备份。' >&2; exit 1; }
    restart=true
  fi
  resume() { if $restart; then docker start cfgetcid >/dev/null || echo '服务恢复失败，请执行 cfgetcid start。' >&2; fi; }
  trap resume EXIT
  umask 077
  if ! tar -czf "$archive.tmp" -C / "${CONFIG_DIR#/}" "${DATA_DIR#/}"; then
    rm -f -- "$archive.tmp"
    echo '备份失败，未生成完整备份。' >&2
    exit 1
  fi
  mv "$archive.tmp" "$archive"
  echo "备份完成：$archive"
)

reset_password() (
  echo '重置后所有已登录会话会失效。'
  read -r -p '输入 RESET 确认重置后台密码：' answer
  [[ "$answer" == RESET ]] || { echo '已取消。'; exit 0; }
  backup || exit 1
  exec 8>"$CONFIG_DIR/deploy.lock"
  flock -n 8 || { echo '另一个维护进程正在运行。'; exit 1; }
  local password restart=false
  password=$(openssl rand -hex 16)
  if [[ "$(docker inspect --format '{{.State.Running}}' cfgetcid)" == true ]]; then
    docker stop -t 40 cfgetcid >/dev/null
    restart=true
  fi
  trap 'if $restart; then docker start cfgetcid >/dev/null; fi' EXIT
  RESET_PASSWORD="$password" docker run --rm --env RESET_PASSWORD -v "$DATA_DIR:/app/data" \
    --entrypoint node cfgetcid:local -e '
      const fs=require("fs"),crypto=require("crypto");
      const salt=crypto.randomBytes(16).toString("hex");
      const hash=salt+":"+crypto.scryptSync(process.env.RESET_PASSWORD,salt,64).toString("hex");
      fs.writeFileSync("/app/data/config.json.tmp",JSON.stringify({passwordHash:hash}),{mode:0o600});
      fs.renameSync("/app/data/config.json.tmp","/app/data/config.json");
    '
  umask 077
  sed "s/^LOG_PASSWORD=.*/LOG_PASSWORD=$password/" "$CONFIG_DIR/app.env" > "$CONFIG_DIR/app.env.tmp"
  mv "$CONFIG_DIR/app.env.tmp" "$CONFIG_DIR/app.env"
  echo "新后台密码：$password"
  echo '请保存密码，重新登录后台。'
)

update() (
  local repo_url branch installer
  repo_url=$(git -C "$SOURCE_DIR" remote get-url origin)
  branch=main
  if [[ -f "$CONFIG_DIR/source.env" ]]; then
    . "$CONFIG_DIR/source.env"
    repo_url=$REPO_URL
    branch=$BRANCH
  fi
  backup || exit 1
  git -C "$SOURCE_DIR" fetch origin "$branch"
  installer=$(mktemp /tmp/cfgetcid-update.XXXXXX.sh)
  trap 'rm -f -- "$installer"' EXIT
  git -C "$SOURCE_DIR" show FETCH_HEAD:install.sh > "$installer"
  env REPO_URL="$repo_url" BRANCH="$branch" bash "$installer"
)

dispatch() {
  case "$1" in
    status) status ;;
    logs) docker logs --tail 100 -f cfgetcid ;;
    stop) docker stop -t 40 cfgetcid ;;
    start) docker start cfgetcid ;;
    restart) docker restart -t 40 cfgetcid ;;
    apply-config) apply_config ;;
    backup) backup ;;
    reset-password) reset_password ;;
    update) update ;;
    *) echo '用法：cfgetcid [status|logs|start|stop|restart|apply-config|backup|reset-password|update]'; return 1 ;;
  esac
}

menu() {
  [[ -t 0 ]] || { echo '菜单需要交互终端；可直接运行 cfgetcid status 等命令。'; return 1; }
  local choice command
  while true; do
    printf '\n=== IID 查询服务管理 ===\n1. 查看状态和版本\n2. 查看运行日志（Ctrl+C 退出）\n3. 更新到 GitHub 最新版（先备份）\n4. 重启服务\n5. 备份配置和查询日志\n6. 重置后台密码\n7. 应用配置修改\n8. 停止服务\n9. 启动服务\n0. 退出\n'
    read -r -p '请选择：' choice || return 0
    case "$choice" in
      1) command=status ;; 2) command=logs ;; 3) command=update ;;
      4) command=restart ;; 5) command=backup ;; 6) command=reset-password ;;
      7) command=apply-config ;; 8) command=stop ;; 9) command=start ;;
      0) return 0 ;; *) echo '请输入 0–9。'; continue ;;
    esac
    # 每个操作独立执行，失败或日志操作被中断不会退出菜单。
    trap ':' INT
    "$0" "$command" || echo '操作已结束或未完成，请查看上方提示。'
    trap - INT
  done
}

main() {
  [[ $EUID -eq 0 ]] || { echo '请用 root 或 sudo 运行。'; return 1; }
  if [[ $# -eq 0 ]]; then menu; else dispatch "$1"; fi
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then main "$@"; fi
