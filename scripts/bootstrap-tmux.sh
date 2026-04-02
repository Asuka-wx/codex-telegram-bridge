#!/usr/bin/env bash
set -euo pipefail

BOOTSTRAP_SESSIONS="${TMUX_BOOTSTRAP_SESSIONS:-}"
BOOTSTRAP_LAYOUT="${TMUX_BOOTSTRAP_LAYOUT:-}"
DEFAULT_ROOT="${PROJECT_ROOT:-${HOME:-$PWD}}"

resolve_root() {
  local requested="$1"

  if [[ -n "$requested" && -d "$requested" ]]; then
    echo "$requested"
    return
  fi

  if [[ -n "$requested" ]]; then
    echo "[bridge] bootstrap root not found: $requested, fallback to $DEFAULT_ROOT" >&2
  fi

  if [[ -d "$DEFAULT_ROOT" ]]; then
    echo "$DEFAULT_ROOT"
    return
  fi

  if [[ -n "${HOME:-}" && -d "$HOME" ]]; then
    echo "$HOME"
    return
  fi

  echo "$PWD"
}

create_session_if_missing() {
  local session="$1"
  local root="$2"

  if [[ -z "$session" ]]; then
    return
  fi

  if tmux has-session -t "$session" 2>/dev/null; then
    return
  fi

  tmux new-session -d -s "$session" -c "$root"
}

if [[ -n "$BOOTSTRAP_LAYOUT" ]]; then
  IFS=',' read -r -a ENTRIES <<< "$BOOTSTRAP_LAYOUT"
  for raw in "${ENTRIES[@]}"; do
    entry="$(echo "$raw" | xargs)"
    if [[ -z "$entry" ]]; then
      continue
    fi

    session="${entry%%:*}"
    root="${entry#*:}"
    if [[ "$root" == "$entry" || -z "$root" ]]; then
      root="$DEFAULT_ROOT"
    fi

    create_session_if_missing "$session" "$(resolve_root "$root")"
  done
  exit 0
fi

if [[ -z "$BOOTSTRAP_SESSIONS" ]]; then
  exit 0
fi

IFS=',' read -r -a SESSIONS <<< "$BOOTSTRAP_SESSIONS"
for raw in "${SESSIONS[@]}"; do
  session="$(echo "$raw" | xargs)"
  create_session_if_missing "$session" "$(resolve_root "$DEFAULT_ROOT")"
done
