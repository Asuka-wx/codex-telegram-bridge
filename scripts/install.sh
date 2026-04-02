#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
ENV_EXAMPLE_FILE="$REPO_ROOT/.env.example"
SETUP_LANG="${SETUP_LANG:-}"

msg() {
  local key="$1"
  case "$SETUP_LANG:$key" in
    en:warn_prefix) printf 'Warning' ;;
    en:fail_prefix) printf 'Error' ;;
    en:enter_yes_no) printf 'Please enter y or n.' ;;
    en:homebrew_missing_1) printf 'Homebrew was not detected.' ;;
    en:homebrew_missing_2) printf 'This installer uses Homebrew to install tmux / node / pnpm.' ;;
    en:homebrew_install_confirm) printf 'Install Homebrew first?' ;;
    en:homebrew_required) printf 'Please install Homebrew first, then re-run ./scripts/install.sh' ;;
    en:curl_required) printf 'Installing Homebrew requires curl, but curl was not found.' ;;
    en:homebrew_unavailable) printf 'Homebrew is still unavailable after installation. Please check your brew setup manually.' ;;
    en:detected) printf 'Detected %s' ;;
    en:installing_formula) printf 'Missing %s, installing %s via Homebrew' ;;
    en:formula_unavailable) printf '%s is still unavailable after installation. Please check it manually.' ;;
    en:node_ok) printf 'Detected Node.js %s' ;;
    en:node_upgrade) printf 'Node.js >= 22 is required. Installing/upgrading node via Homebrew' ;;
    en:node_missing_after_install) printf 'Node.js is still unavailable after installation. Please check it manually.' ;;
    en:node_version_too_low) printf 'Node.js is still below 22: %s' ;;
    en:env_keep) printf 'Found existing .env, keeping current configuration' ;;
    en:env_created) printf 'Created .env from .env.example' ;;
    en:token_skip) printf 'Found TELEGRAM_BOT_TOKEN, skipping prompt' ;;
    en:token_prompt) printf 'Enter TELEGRAM_BOT_TOKEN' ;;
    en:token_required) printf 'TELEGRAM_BOT_TOKEN cannot be empty.' ;;
    en:token_saved) printf 'Saved TELEGRAM_BOT_TOKEN' ;;
    en:allowlist_skip) printf 'Found Telegram allowlist configuration, skipping discovery flow' ;;
    en:allowlist_intro) printf 'Strict mode requires Telegram chat id / user id before first start.' ;;
    en:allowlist_discover_confirm) printf 'Run telegram:discover now?' ;;
    en:allowlist_discover_later) printf 'You can run pnpm telegram:discover later and update .env manually.' ;;
    en:chat_ids_prompt) printf 'Paste the chat id from discover output (comma-separated if multiple)' ;;
    en:user_ids_prompt) printf 'Paste the user id from discover output (comma-separated if multiple)' ;;
    en:control_chat_prompt) printf 'Enter the control chat id (usually the same as the chat id above)' ;;
    en:only_macos) printf 'This project currently supports macOS only.' ;;
    en:env_example_missing) printf 'Missing %s' ;;
    en:start_setup) printf 'Starting Codex Telegram Bridge setup' ;;
    en:codex_required) printf 'codex CLI was not found. Please install and log in to Codex CLI first, then re-run ./scripts/install.sh' ;;
    en:install_dependencies) printf 'Installing project dependencies' ;;
    en:build_project) printf 'Building project' ;;
    en:install_launchd) printf 'Installing launchd service' ;;
    en:setup_done) printf 'Setup complete. You can now open Telegram and send "current info" or bind the latest session for verification.' ;;
    en:setup_partial_1) printf 'Dependencies and build are complete, but Telegram allowlist is still incomplete for strict mode.' ;;
    en:setup_partial_2) printf 'Run pnpm telegram:discover, update .env, then run pnpm launchd:install.' ;;
    zh:warn_prefix) printf '警告' ;;
    zh:fail_prefix) printf '错误' ;;
    zh:enter_yes_no) printf '请输入 y 或 n。' ;;
    zh:homebrew_missing_1) printf '没有检测到 Homebrew。' ;;
    zh:homebrew_missing_2) printf '这个安装脚本会用 Homebrew 安装 tmux / node / pnpm。' ;;
    zh:homebrew_install_confirm) printf '要先安装 Homebrew 吗？' ;;
    zh:homebrew_required) printf '请先安装 Homebrew，再重新执行 ./scripts/install.sh' ;;
    zh:curl_required) printf '安装 Homebrew 需要 curl，但当前没有检测到 curl。' ;;
    zh:homebrew_unavailable) printf 'Homebrew 安装后仍不可用，请手动检查 brew 环境。' ;;
    zh:detected) printf '已检测到 %s' ;;
    zh:installing_formula) printf '未检测到 %s，开始通过 Homebrew 安装 %s' ;;
    zh:formula_unavailable) printf '%s 安装后仍不可用，请手动检查。' ;;
    zh:node_ok) printf '已检测到 Node.js %s' ;;
    zh:node_upgrade) printf '需要 Node.js >= 22，开始通过 Homebrew 安装/升级 node' ;;
    zh:node_missing_after_install) printf 'Node.js 安装后仍不可用，请手动检查。' ;;
    zh:node_version_too_low) printf '当前 Node.js 版本仍低于 22：%s' ;;
    zh:env_keep) printf '已检测到 .env，保留现有配置' ;;
    zh:env_created) printf '已从 .env.example 生成 .env' ;;
    zh:token_skip) printf '已检测到 TELEGRAM_BOT_TOKEN，跳过输入' ;;
    zh:token_prompt) printf '请输入 TELEGRAM_BOT_TOKEN' ;;
    zh:token_required) printf 'TELEGRAM_BOT_TOKEN 不能为空。' ;;
    zh:token_saved) printf '已写入 TELEGRAM_BOT_TOKEN' ;;
    zh:allowlist_skip) printf '已检测到 Telegram allowlist 配置，跳过发现引导' ;;
    zh:allowlist_intro) printf '严格模式下，首次安装前需要拿到 Telegram chat id / user id。' ;;
    zh:allowlist_discover_confirm) printf '现在要运行 telegram:discover 吗？' ;;
    zh:allowlist_discover_later) printf '你可以稍后执行 pnpm telegram:discover，然后手动补全 .env。' ;;
    zh:chat_ids_prompt) printf '把 discover 输出里的 chat id 粘贴进来（多个值用英文逗号分隔）' ;;
    zh:user_ids_prompt) printf '把 discover 输出里的 user id 粘贴进来（多个值用英文逗号分隔）' ;;
    zh:control_chat_prompt) printf '请输入总控 chat id（通常与上面的 chat id 相同）' ;;
    zh:only_macos) printf '当前只支持 macOS。' ;;
    zh:env_example_missing) printf '没有找到 %s' ;;
    zh:start_setup) printf '开始安装 Codex Telegram Bridge' ;;
    zh:codex_required) printf '没有检测到 codex CLI。请先安装并登录 Codex CLI，再重新执行 ./scripts/install.sh' ;;
    zh:install_dependencies) printf '开始安装项目依赖' ;;
    zh:build_project) printf '开始构建项目' ;;
    zh:install_launchd) printf '开始安装 launchd 常驻服务' ;;
    zh:setup_done) printf '安装完成。现在可以去 Telegram 里发“当前信息”或“绑定最新窗口”做联调。' ;;
    zh:setup_partial_1) printf '已完成依赖安装和构建，但还没有补齐严格模式需要的 Telegram allowlist。' ;;
    zh:setup_partial_2) printf '请先执行 pnpm telegram:discover，更新 .env 后再执行 pnpm launchd:install。' ;;
    *) printf '%s' "$key" ;;
  esac
}

detect_lang() {
  if [[ -n "$SETUP_LANG" ]]; then
    return
  fi

  local lang_source="${LANG:-}"
  if [[ "$lang_source" == en* ]]; then
    SETUP_LANG="en"
  else
    SETUP_LANG="zh"
  fi
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --lang)
        shift
        [[ $# -gt 0 ]] || fail "Missing value for --lang"
        case "$1" in
          zh|en) SETUP_LANG="$1" ;;
          *) fail "Unsupported language: $1" ;;
        esac
        ;;
      --lang=zh|--lang=en)
        SETUP_LANG="${1#--lang=}"
        ;;
      *)
        fail "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

log() {
  printf '[setup] %s\n' "$*"
}

warn() {
  printf '[setup] %s: %s\n' "$(msg warn_prefix)" "$*" >&2
}

fail() {
  printf '[setup] %s: %s\n' "$(msg fail_prefix)" "$*" >&2
  exit 1
}

command_exists() {
  command -v "$1" >/dev/null 2>&1
}

load_homebrew_shellenv() {
  if command_exists brew; then
    eval "$(brew shellenv)"
    export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"
  fi
}

prompt_yes_no() {
  local prompt="$1"
  local default="${2:-y}"
  local suffix="[Y/n]"
  if [[ "$default" != "y" ]]; then
    suffix="[y/N]"
  fi

  while true; do
    local reply
    read -r -p "$prompt $suffix " reply
    reply="${reply:-$default}"
    case "$reply" in
      y|Y|yes|YES) return 0 ;;
      n|N|no|NO) return 1 ;;
      *) warn "$(msg enter_yes_no)" ;;
    esac
  done
}

prompt_value() {
  local prompt="$1"
  local default="${2:-}"
  local value=""
  if [[ -n "$default" ]]; then
    read -r -p "$prompt [$default]: " value
    printf '%s' "${value:-$default}"
    return
  fi

  read -r -p "$prompt: " value
  printf '%s' "$value"
}

prompt_secret() {
  local prompt="$1"
  local value=""
  read -r -s -p "$prompt: " value
  printf '\n' >&2
  printf '%s' "$value"
}

read_env_value() {
  local key="$1"
  if [[ ! -f "$ENV_FILE" ]]; then
    return
  fi

  awk -F '=' -v target="$key" '$1 == target { sub($1 "=", ""); print; exit }' "$ENV_FILE"
}

upsert_env_value() {
  local key="$1"
  local value="$2"
  local temp_file
  temp_file="$(mktemp "${ENV_FILE}.XXXXXX")"

  if [[ -f "$ENV_FILE" ]]; then
    awk -v target="$key" -v replacement="${key}=${value}" '
      BEGIN { updated = 0 }
      $0 ~ ("^" target "=") {
        print replacement
        updated = 1
        next
      }
      { print }
      END {
        if (!updated) {
          print replacement
        }
      }
    ' "$ENV_FILE" >"$temp_file"
  else
    printf '%s\n' "${key}=${value}" >"$temp_file"
  fi

  mv "$temp_file" "$ENV_FILE"
}

ensure_homebrew() {
  if command_exists brew; then
    load_homebrew_shellenv
    return
  fi

  warn "$(msg homebrew_missing_1)"
  warn "$(msg homebrew_missing_2)"
  if ! prompt_yes_no "$(msg homebrew_install_confirm)" "y"; then
    fail "$(msg homebrew_required)"
  fi

  if ! command_exists curl; then
    fail "$(msg curl_required)"
  fi

  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  load_homebrew_shellenv

  if ! command_exists brew; then
    fail "$(msg homebrew_unavailable)"
  fi
}

ensure_formula_command() {
  local command_name="$1"
  local formula_name="$2"
  local display_name="$3"

  if command_exists "$command_name"; then
    log "$(printf "$(msg detected)" "$display_name")"
    return
  fi

  log "$(printf "$(msg installing_formula)" "$display_name" "$formula_name")"
  brew install "$formula_name"
  load_homebrew_shellenv

  if ! command_exists "$command_name"; then
    fail "$(printf "$(msg formula_unavailable)" "$display_name")"
  fi
}

ensure_node_runtime() {
  local node_major="0"
  if command_exists node; then
    node_major="$(node -p "process.versions.node.split('.')[0]")"
  fi

  if [[ "$node_major" =~ ^[0-9]+$ ]] && (( node_major >= 22 )); then
    log "$(printf "$(msg node_ok)" "$(node -v)")"
    return
  fi

  log "$(msg node_upgrade)"
  brew install node
  load_homebrew_shellenv

  if ! command_exists node; then
    fail "$(msg node_missing_after_install)"
  fi

  node_major="$(node -p "process.versions.node.split('.')[0]")"
  if [[ ! "$node_major" =~ ^[0-9]+$ ]] || (( node_major < 22 )); then
    fail "$(printf "$(msg node_version_too_low)" "$(node -v)")"
  fi
}

ensure_repo_env_file() {
  if [[ -f "$ENV_FILE" ]]; then
    log "$(msg env_keep)"
    return
  fi

  cp "$ENV_EXAMPLE_FILE" "$ENV_FILE"
  log "$(msg env_created)"
}

configure_bot_token() {
  local current_token
  current_token="$(read_env_value "TELEGRAM_BOT_TOKEN")"
  if [[ -n "$current_token" ]]; then
    log "$(msg token_skip)"
    return
  fi

  local token=""
  while [[ -z "$token" ]]; do
    token="$(prompt_secret "$(msg token_prompt)")"
    if [[ -z "$token" ]]; then
      warn "$(msg token_required)"
    fi
  done

  upsert_env_value "TELEGRAM_BOT_TOKEN" "$token"
  log "$(msg token_saved)"
}

configure_allowlist() {
  local current_chat_ids current_user_ids current_control_chat_id
  current_chat_ids="$(read_env_value "TELEGRAM_ALLOWED_CHAT_IDS")"
  current_user_ids="$(read_env_value "TELEGRAM_ALLOWED_USER_IDS")"
  current_control_chat_id="$(read_env_value "TELEGRAM_CONTROL_CHAT_ID")"

  if [[ -n "$current_chat_ids" && -n "$current_user_ids" && -n "$current_control_chat_id" ]]; then
    log "$(msg allowlist_skip)"
    return
  fi

  warn "$(msg allowlist_intro)"
  if ! prompt_yes_no "$(msg allowlist_discover_confirm)" "y"; then
    warn "$(msg allowlist_discover_later)"
    return
  fi

  (
    cd "$REPO_ROOT"
    pnpm telegram:discover
  )

  local chat_ids user_ids control_chat_id
  chat_ids="$(prompt_value "$(msg chat_ids_prompt)" "$current_chat_ids")"
  user_ids="$(prompt_value "$(msg user_ids_prompt)" "$current_user_ids")"
  control_chat_id="$(prompt_value "$(msg control_chat_prompt)" "${current_control_chat_id:-$chat_ids}")"

  if [[ -n "$chat_ids" ]]; then
    upsert_env_value "TELEGRAM_ALLOWED_CHAT_IDS" "$chat_ids"
  fi
  if [[ -n "$user_ids" ]]; then
    upsert_env_value "TELEGRAM_ALLOWED_USER_IDS" "$user_ids"
  fi
  if [[ -n "$control_chat_id" ]]; then
    upsert_env_value "TELEGRAM_CONTROL_CHAT_ID" "$control_chat_id"
  fi
}

main() {
  parse_args "$@"
  detect_lang

  [[ "$(uname -s)" == "Darwin" ]] || fail "$(msg only_macos)"
  [[ -f "$ENV_EXAMPLE_FILE" ]] || fail "$(printf "$(msg env_example_missing)" "$ENV_EXAMPLE_FILE")"

  cd "$REPO_ROOT"
  log "$(msg start_setup)"

  ensure_homebrew
  ensure_formula_command tmux tmux "tmux"
  ensure_node_runtime
  ensure_formula_command pnpm pnpm "pnpm"

  if ! command_exists codex; then
    fail "$(msg codex_required)"
  fi

  ensure_repo_env_file
  configure_bot_token

  log "$(msg install_dependencies)"
  pnpm install

  configure_allowlist

  log "$(msg build_project)"
  pnpm build

  local chat_ids user_ids control_chat_id
  chat_ids="$(read_env_value "TELEGRAM_ALLOWED_CHAT_IDS")"
  user_ids="$(read_env_value "TELEGRAM_ALLOWED_USER_IDS")"
  control_chat_id="$(read_env_value "TELEGRAM_CONTROL_CHAT_ID")"

  if [[ -n "$chat_ids" && -n "$user_ids" && -n "$control_chat_id" ]]; then
    log "$(msg install_launchd)"
    pnpm launchd:install
    log "$(msg setup_done)"
    return
  fi

  warn "$(msg setup_partial_1)"
  warn "$(msg setup_partial_2)"
}

main "$@"
