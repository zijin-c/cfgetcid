#!/usr/bin/env bash
# 使用替身验证恢复逻辑，不连接 Docker，不改动真实服务。
set -Eeuo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/cfgetcid.sh"
test_dir=$(mktemp -d /tmp/cfgetcid-manager-test.XXXXXX)
cleanup() {
  [[ "$test_dir" == /tmp/cfgetcid-manager-test.* ]] || return 1
  rm -rf -- "$test_dir"
}
trap cleanup EXIT
CONFIG_DIR="$test_dir/config"
DATA_DIR="$test_dir/data"
BACKUP_DIR="$test_dir/backups"
mkdir -p "$CONFIG_DIR" "$DATA_DIR"
printf 'test\n' > "$DATA_DIR/log.json"
printf 'HOST_PORT=9567\nBIND_IP=0.0.0.0\n' > "$CONFIG_DIR/deploy.env"
printf 'LOG_PASSWORD=old-password\n' > "$CONFIG_DIR/app.env"
printf 'true' > "$test_dir/running"
FAIL_TAR=0
flock() { return 0; }
tar() { if [[ "$FAIL_TAR" == 1 ]]; then return 1; fi; command tar "$@"; }
docker() {
  printf '%s\n' "$*" >> "$test_dir/docker.calls"
  case "$1" in
    inspect) cat "$test_dir/running" ;;
    container)
      if [[ "$3" == cfgetcid-previous ]]; then [[ -f "$test_dir/previous" ]]; else return 0; fi ;;
    stop) printf 'false' > "$test_dir/running" ;;
    start) printf 'true' > "$test_dir/running" ;;
    rename)
      if [[ "$2" == cfgetcid ]]; then touch "$test_dir/previous"; else rm -f "$test_dir/previous"; fi ;;
    run)
      if [[ -n "${RESET_PASSWORD:-}" ]]; then
        local script="${!#}" node_data="$DATA_DIR"
        if command -v cygpath >/dev/null; then node_data=$(cygpath -m "$DATA_DIR"); fi
        script="${script//\/app\/data/$node_data}"
        command node -e "$script"
      else return 1; fi ;;
    logs|rm) return 0 ;;
    *) echo '意外的测试命令' >&2; return 1 ;;
  esac
}
backup
[[ "$(cat "$test_dir/running")" == true ]]
compgen -G "$BACKUP_DIR/*.tar.gz" >/dev/null
FAIL_TAR=1
if backup; then echo '错误：备份失败却返回成功'; exit 1; fi
[[ "$(cat "$test_dir/running")" == true ]]
if compgen -G "$BACKUP_DIR/*.tmp" >/dev/null; then echo '错误：留下不完整备份'; exit 1; fi
if apply_config; then echo '错误：启动失败却返回成功'; exit 1; fi
[[ "$(cat "$test_dir/running")" == true ]]
[[ ! -f "$test_dir/previous" ]]
command grep -q 'rename cfgetcid-previous cfgetcid' "$test_dir/docker.calls"
FAIL_TAR=0
reset_password <<< 'RESET' > "$test_dir/reset.output"
[[ "$(cat "$test_dir/running")" == true ]]
[[ -f "$DATA_DIR/log.json" ]]
password=$(command sed -n 's/^LOG_PASSWORD=//p' "$CONFIG_DIR/app.env")
[[ "$password" != old-password && ${#password} -eq 32 ]]
if command grep -q "$password" "$DATA_DIR/config.json"; then echo '错误：明文保存密码'; exit 1; fi
if command -v cygpath >/dev/null; then node_data=$(cygpath -m "$DATA_DIR"); else node_data=$DATA_DIR; fi
TEST_DATA="$node_data" TEST_PASSWORD="$password" node -e '
  const fs=require("fs"),crypto=require("crypto");
  const saved=JSON.parse(fs.readFileSync(process.env.TEST_DATA+"/config.json")).passwordHash;
  const [salt,hash]=saved.split(":");
  if(crypto.scryptSync(process.env.TEST_PASSWORD,salt,64).toString("hex")!==hash)process.exit(1);
'
printf '维护脚本检查通过：备份恢复、失败回退、密码重置保留日志并保存有效哈希。\n'
