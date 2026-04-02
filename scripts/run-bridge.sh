#!/bin/zsh

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "$0")" && pwd)"
BRIDGE_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
DEFAULT_WORKSPACE_ROOT="$(cd -- "$BRIDGE_ROOT/.." && pwd)"
export PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin:${PATH:-}"

if [[ -f "$BRIDGE_ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$BRIDGE_ROOT/.env"
  set +a
fi

export BRIDGE_DATA_DIR="${BRIDGE_DATA_DIR:-$BRIDGE_ROOT/.data}"
export PROJECT_ROOT="${PROJECT_ROOT:-$DEFAULT_WORKSPACE_ROOT}"

mkdir -p "$BRIDGE_DATA_DIR"
cd "$BRIDGE_ROOT"

if [[ -n "${HOME:-}" && -f "$HOME/.nvm/nvm.sh" ]]; then
  # shellcheck disable=SC1091
  source "$HOME/.nvm/nvm.sh"
  nvm use --silent default >/dev/null 2>&1 || true
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
  echo "[bridge] node not found in PATH" >&2
  exit 1
fi

if [[ "${TMUX_AUTO_BOOTSTRAP:-false}" == "true" ]]; then
  if ! "$BRIDGE_ROOT/scripts/bootstrap-tmux.sh"; then
    echo "[bridge] tmux bootstrap failed, continuing without precreated sessions" >&2
  fi
fi

if [[ ! -f "$BRIDGE_ROOT/dist/src/index.js" ]]; then
  PNPM_BIN="$(command -v pnpm || true)"
  if [[ -z "$PNPM_BIN" ]]; then
    echo "[bridge] pnpm not found in PATH" >&2
    exit 1
  fi
  "$PNPM_BIN" build
fi

exec "$NODE_BIN" "$BRIDGE_ROOT/dist/src/index.js"
