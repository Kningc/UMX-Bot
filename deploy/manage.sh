#!/bin/sh

set -eu

APP_ROOT="${QQ_BOT_ROOT:-/home/kningc/apps/qq-bot}"
SUPERVISOR="$APP_ROOT/current/deploy/supervise.sh"
SHARED_DIR="$APP_ROOT/shared"
LOG_DIR="$SHARED_DIR/logs"
PID_FILE="$SHARED_DIR/supervisor.pid"
ENV_FILE="$SHARED_DIR/.env"

is_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi

  pid="$(cat "$PID_FILE")"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  case "$(ps -p "$pid" -o args=)" in
    *qq-bot/current/deploy/supervise.sh*) return 0 ;;
    *) return 1 ;;
  esac
}

start() {
  mkdir -p "$LOG_DIR"
  if is_running; then
    echo "qq-bot is already running (PID $(cat "$PID_FILE"))"
    return
  fi

  if [ ! -f "$ENV_FILE" ]; then
    echo "missing environment file: $ENV_FILE" >&2
    exit 1
  fi

  if grep -q '^BOT_ADAPTER=qq-official$' "$ENV_FILE"; then
    if ! grep -Eq '^QQ_APP_ID=.+$' "$ENV_FILE" ||
      ! grep -Eq '^QQ_CLIENT_SECRET=.+$' "$ENV_FILE"; then
      echo "QQ_APP_ID and QQ_CLIENT_SECRET must be configured before start" >&2
      exit 1
    fi
  fi

  nohup "$SUPERVISOR" </dev/null >>"$LOG_DIR/supervisor.log" 2>&1 &
  sleep 1
  if is_running; then
    echo "qq-bot started (PID $(cat "$PID_FILE"))"
  else
    echo "qq-bot failed to start; check $LOG_DIR/supervisor.log" >&2
    exit 1
  fi
}

stop() {
  if ! is_running; then
    echo "qq-bot is not running"
    rm -f "$PID_FILE"
    return
  fi

  pid="$(cat "$PID_FILE")"
  kill -TERM "$pid"
  attempts=0
  while kill -0 "$pid" 2>/dev/null && [ "$attempts" -lt 20 ]; do
    sleep 1
    attempts=$((attempts + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "qq-bot did not stop within 20 seconds" >&2
    exit 1
  fi
  echo "qq-bot stopped"
}

case "${1:-status}" in
  start) start ;;
  stop) stop ;;
  restart)
    stop
    start
    ;;
  status)
    if is_running; then
      echo "qq-bot is running (PID $(cat "$PID_FILE"))"
    else
      echo "qq-bot is not running"
      exit 1
    fi
    ;;
  logs)
    tail -n "${2:-100}" "$LOG_DIR/app.log"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|logs [lines]}" >&2
    exit 2
    ;;
esac
