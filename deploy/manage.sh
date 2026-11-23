#!/bin/sh

set -eu

# Without QQ_BOT_ROOT, derive the app root from where this script lives:
# <root>/current/deploy/ (cron, operators) or <root>/releases/<id>/deploy/.
if [ -z "${QQ_BOT_ROOT:-}" ]; then
  script_dir="$(CDPATH="" cd -- "$(dirname "$0")" && pwd -L)"
  for up in ../.. ../../..; do
    # Resolve ".." lexically (cd -L) so <root>/current/deploy/../.. is <root>,
    # not the parent of the release directory the symlink points into.
    candidate="$(CDPATH="" cd -L -- "$script_dir/$up" 2>/dev/null && pwd -L)" || continue
    if [ -d "$candidate/shared" ] && [ -d "$candidate/releases" ]; then
      QQ_BOT_ROOT="$candidate"
      break
    fi
  done
fi
if [ -z "${QQ_BOT_ROOT:-}" ]; then
  echo "cannot locate the app root; set QQ_BOT_ROOT" >&2
  exit 2
fi
export QQ_BOT_ROOT
APP_ROOT="$QQ_BOT_ROOT"
SUPERVISOR="$APP_ROOT/current/deploy/supervise.sh"
SHARED_DIR="$APP_ROOT/shared"
LOG_DIR="$SHARED_DIR/logs"
PID_FILE="$SHARED_DIR/supervisor.pid"
APP_PID_FILE="$SHARED_DIR/app.pid"
LOCK_FILE="$SHARED_DIR/supervisor.lock"
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
STOP_TIMEOUT_SECONDS="${QQ_BOT_STOP_TIMEOUT_SECONDS:-30}"
# The bot rewrites its snapshot every BOT_HEALTH_INTERVAL_MS; like /readyz,
# tolerate two missed probes before calling it stale.
HEALTH_INTERVAL_MS="${BOT_HEALTH_INTERVAL_MS:-30000}"

case "$STOP_TIMEOUT_SECONDS" in
  *[!0-9]* | 0)
    echo "QQ_BOT_STOP_TIMEOUT_SECONDS must be a positive integer" >&2
    exit 2
    ;;
esac
case "$HEALTH_INTERVAL_MS" in
  "" | *[!0-9]* | 0)
    echo "BOT_HEALTH_INTERVAL_MS must be a positive integer" >&2
    exit 2
    ;;
esac
HEALTH_MAX_AGE_MS=$((HEALTH_INTERVAL_MS * 3))

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
      age > Number(process.argv[2]) ||
      snapshot.diagnostics?.gateway?.ready !== true ||
      typeof snapshot.diagnostics?.openApi?.lastSuccessAt !== "string"
    ) {
      process.exit(1);
    }
  ' "$HEALTH_FILE" "$HEALTH_MAX_AGE_MS"; then
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

  # A supervisor that cannot take the lock exits quietly, so wait for whatever
  # still holds it (a previous supervisor's leftovers) instead of racing it.
  waited=0
  while ! flock -n "$LOCK_FILE" true 2>/dev/null; do
    if [ "$waited" -ge "$STOP_TIMEOUT_SECONDS" ]; then
      echo "qq-bot supervisor lock is still held after ${STOP_TIMEOUT_SECONDS}s: $LOCK_FILE" >&2
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done

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
  while kill -0 "$pid" 2>/dev/null &&
    [ "$attempts" -lt "$STOP_TIMEOUT_SECONDS" ]; do
    sleep 1
    attempts=$((attempts + 1))
  done

  if kill -0 "$pid" 2>/dev/null; then
    echo "qq-bot did not stop within $STOP_TIMEOUT_SECONDS seconds" >&2
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
  outbox)
    # 直接读共享数据库，不经过机器人进程，所以机器人没跑也能查。
    shift
    DB_PATH="${BOT_DATABASE_PATH:-$SHARED_DIR/data/bot.sqlite}"
    node_bin="$RUNTIME_NODE"
    if [ ! -x "$node_bin" ]; then
      node_bin="$(command -v node || true)"
    fi
    if [ -z "$node_bin" ]; then
      echo "no node runtime found for the outbox tool" >&2
      exit 2
    fi
    exec "$node_bin" "$APP_ROOT/current/scripts/outbox.mjs" \
      ${1:+"$@"} --db "$DB_PATH"
    ;;
  logs)
    tail -n "${2:-100}" "$LOG_DIR/app.log"
    ;;
  *)
    echo "Usage: $0 {start|stop|restart|status|health|outbox [args]|logs [lines]}" >&2
    exit 2
    ;;
esac
