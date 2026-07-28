#!/bin/sh

set -u

APP_ROOT="${QQ_BOT_ROOT:-/home/kningc/apps/qq-bot}"
RUNTIME_NODE="$APP_ROOT/runtime/node/bin/node"
CURRENT_DIR="$APP_ROOT/current"
SHARED_DIR="$APP_ROOT/shared"
LOG_DIR="$SHARED_DIR/logs"
PID_FILE="$SHARED_DIR/supervisor.pid"
LOCK_FILE="$SHARED_DIR/supervisor.lock"
ENV_FILE="$SHARED_DIR/.env"

mkdir -p "$LOG_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

echo "$$" >"$PID_FILE"
child_pid=""

shutdown() {
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid"
    wait "$child_pid"
  fi
  rm -f "$PID_FILE"
  exit 0
}

trap shutdown INT TERM
trap 'rm -f "$PID_FILE"' EXIT

while true; do
  if [ ! -x "$RUNTIME_NODE" ]; then
    echo "$(date -Iseconds) Node runtime not found: $RUNTIME_NODE" >>"$LOG_DIR/supervisor.log"
    sleep 10
    continue
  fi

  if [ ! -f "$ENV_FILE" ]; then
    echo "$(date -Iseconds) Environment file not found: $ENV_FILE" >>"$LOG_DIR/supervisor.log"
    sleep 10
    continue
  fi

  cd "$CURRENT_DIR" || {
    sleep 10
    continue
  }

  "$RUNTIME_NODE" \
    --env-file="$ENV_FILE" \
    "$CURRENT_DIR/dist/main.js" \
    >>"$LOG_DIR/app.log" 2>&1 &
  child_pid=$!
  wait "$child_pid"
  exit_code=$?
  child_pid=""

  echo "$(date -Iseconds) bot exited with code $exit_code; restarting in 5s" >>"$LOG_DIR/supervisor.log"
  sleep 5
done
