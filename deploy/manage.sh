#!/bin/sh

set -eu

APP_ROOT="${QQ_BOT_ROOT:-/home/kningc/apps/qq-bot}"
SUPERVISOR="$APP_ROOT/current/deploy/supervise.sh"
SHARED_DIR="$APP_ROOT/shared"
LOG_DIR="$SHARED_DIR/logs"
PID_FILE="$SHARED_DIR/supervisor.pid"
APP_PID_FILE="$SHARED_DIR/app.pid"
RUNNING_RELEASE_FILE="$SHARED_DIR/running-release"
ENV_FILE="$SHARED_DIR/.env"
RUNTIME_NODE="$APP_ROOT/runtime/node/bin/node"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
HEALTH_FILE="${BOT_HEALTH_FILE:-$SHARED_DIR/data/health.json}"

is_running() {
  if [ ! -f "$PID_FILE" ]; then
    return 1
  fi

  pid="$(cat "$PID_FILE")"
  if ! kill -0 "$pid" 2>/dev/null; then
    return 1
  fi

  case "$(ps -p "$pid" -o args=)" in
    *"$SUPERVISOR"*) return 0 ;;
    *) return 1 ;;
  esac
}

is_app_running() {
  if [ ! -f "$APP_PID_FILE" ]; then
    return 1
  fi

  app_pid="$(cat "$APP_PID_FILE")"
  kill -0 "$app_pid" 2>/dev/null
}

health() {
  if ! is_running; then
    echo "qq-bot supervisor is not running" >&2
    return 1
  fi
  if ! is_app_running; then
    echo "qq-bot application is not running" >&2
    return 1
  fi
  if [ ! -f "$RUNNING_RELEASE_FILE" ]; then
    echo "qq-bot running release is unknown" >&2
    return 1
  fi

  current_release="$(readlink -f "$APP_ROOT/current")"
  running_release="$(cat "$RUNNING_RELEASE_FILE")"
  if [ "$current_release" != "$running_release" ]; then
    echo "qq-bot is running an outdated release: $running_release" >&2
    return 1
  fi
  if [ ! -f "$HEALTH_FILE" ]; then
    echo "qq-bot business health snapshot is missing" >&2
    return 1
  fi
  if ! "$RUNTIME_NODE" -e '
    const fs = require("node:fs");
    const snapshot = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const age = Date.now() - Date.parse(snapshot.updatedAt);
    if (
      snapshot.status !== "ready" ||
      !Number.isFinite(age) ||
      age < 0 ||
      age > 90000 ||
      snapshot.diagnostics?.gateway?.ready !== true ||
      typeof snapshot.diagnostics?.openApi?.lastSuccessAt !== "string"
    ) {
      process.exit(1);
    }
  ' "$HEALTH_FILE"; then
    echo "qq-bot business health is stale or Gateway/OpenAPI is unavailable" >&2
    return 1
  fi

  echo "qq-bot is healthy (supervisor $(cat "$PID_FILE"), app $(cat "$APP_PID_FILE"), Gateway/OpenAPI ready, release $(basename "$running_release"))"
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
    rm -f "$PID_FILE" "$APP_PID_FILE" "$RUNNING_RELEASE_FILE"
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
      echo "qq-bot supervisor is running (PID $(cat "$PID_FILE"))"
      if is_app_running; then
        echo "qq-bot application is running (PID $(cat "$APP_PID_FILE"))"
      else
        echo "qq-bot application is not running"
      fi
    else
      echo "qq-bot is not running"
      exit 1
    fi
    ;;
  health) health ;;
  logs)
    tail -n "${2:-100}" "$LOG_DIR/app.log"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|health|logs [lines]}" >&2
    exit 2
    ;;
esac
