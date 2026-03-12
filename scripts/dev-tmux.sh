#!/usr/bin/env bash

set -euo pipefail

SESSION_NAME="dlkn-dev"
BRIDGE_BIND_ADDR="127.0.0.1:3000"
BRIDGE_URL="http://127.0.0.1:3000"
APP_HOST="127.0.0.1"
APP_PORT="5173"
APP_URL="http://${APP_HOST}:${APP_PORT}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
BRIDGE_DIR="${REPO_ROOT}/packages/dlkn-socket-bridge-rs"
TELEGRAM_DIR="${REPO_ROOT}/examples/telegram-worker"
DEV_VARS_PATH="${TELEGRAM_DIR}/.dev.vars"

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "error: required command not found: ${cmd}" >&2
    exit 1
  fi
}

require_command tmux

if tmux has-session -t "${SESSION_NAME}" 2>/dev/null; then
  echo "tmux session '${SESSION_NAME}' already exists."
  echo "Attach with: tmux attach -t ${SESSION_NAME}"
  exit 0
fi

if [[ ! -f "${DEV_VARS_PATH}" ]]; then
  echo "error: missing ${DEV_VARS_PATH}" >&2
  echo "Create it with TELEGRAM_API_ID and TELEGRAM_API_HASH before starting dev." >&2
  exit 1
fi

tmux new-session -d -s "${SESSION_NAME}" -c "${BRIDGE_DIR}"
tmux send-keys -t "${SESSION_NAME}:0.0" "BIND_ADDR=${BRIDGE_BIND_ADDR} cargo run" C-m

tmux split-window -h -t "${SESSION_NAME}:0" -c "${TELEGRAM_DIR}"
tmux send-keys -t "${SESSION_NAME}:0.1" \
  "npm run dev -- --host ${APP_HOST} --port ${APP_PORT} --strictPort" C-m

tmux select-layout -t "${SESSION_NAME}:0" even-horizontal

cat <<EOF
Started tmux session '${SESSION_NAME}'.

Attach:
  tmux attach -t ${SESSION_NAME}

Fixed URLs:
  bridge: ${BRIDGE_URL}
  app:    ${APP_URL}

Notes:
  - Rust bridge is forced to ${BRIDGE_BIND_ADDR}.
  - Vite is forced to ${APP_HOST}:${APP_PORT} with --strictPort.
  - If port 3000 or 5173 is unavailable, the corresponding pane will error instead of choosing another port.
EOF
