#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
LAUNCH_AGENT_LABEL="local.codex.telegram-bridge"
PLIST_PATH="$HOME/Library/LaunchAgents/${LAUNCH_AGENT_LABEL}.plist"

log() {
  printf '[uninstall] %s\n' "$*"
}

warn() {
  printf '[uninstall] 警告：%s\n' "$*" >&2
}

prompt_yes_no() {
  local prompt="$1"
  local default="${2:-n}"
  local suffix="[y/N]"
  if [[ "$default" == "y" ]]; then
    suffix="[Y/n]"
  fi

  while true; do
    local reply
    read -r -p "$prompt $suffix " reply
    reply="${reply:-$default}"
    case "$reply" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) warn "请输入 y 或 n。" ;;
    esac
  done
}

purge_local_files() {
  local target
  for target in ".data" "dist" "node_modules" ".env"; do
    if [[ -e "$REPO_ROOT/$target" ]]; then
      rm -rf "$REPO_ROOT/$target"
      log "已删除 $target"
    fi
  done
}

main() {
  cd "$REPO_ROOT"

  if command -v launchctl >/dev/null 2>&1; then
    launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  fi

  if [[ -f "$PLIST_PATH" ]]; then
    rm -f "$PLIST_PATH"
    log "已移除 LaunchAgent：$PLIST_PATH"
  else
    log "没有检测到 LaunchAgent，跳过移除"
  fi

  if [[ "${1:-}" == "--purge" ]]; then
    if prompt_yes_no "要删除当前仓库的 .env / .data / dist / node_modules 吗？" "n"; then
      purge_local_files
    else
      log "已跳过本地文件清理"
    fi
  fi

  log "卸载完成"
}

main "$@"
