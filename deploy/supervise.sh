#!/bin/sh

set -u

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
RUNTIME_NODE="$APP_ROOT/runtime/node/bin/node"
CURRENT_DIR="$APP_ROOT/current"
SHARED_DIR="$APP_ROOT/shared"
LOG_DIR="$SHARED_DIR/logs"
PID_FILE="$SHARED_DIR/supervisor.pid"
APP_PID_FILE="$SHARED_DIR/app.pid"
RUNNING_RELEASE_FILE="$SHARED_DIR/running-release"
LOCK_FILE="$SHARED_DIR/supervisor.lock"
ENV_FILE="$SHARED_DIR/.env"

# Restart backoff: a crash within STABLE_SECONDS of starting doubles the delay
# (up to MAX); a run that lasted longer resets it. A broken config therefore
# settles at one attempt every few minutes instead of every 5 seconds.
RESTART_DELAY_SECONDS="${QQ_BOT_RESTART_DELAY_SECONDS:-5}"
RESTART_MAX_DELAY_SECONDS="${QQ_BOT_RESTART_MAX_DELAY_SECONDS:-300}"
STABLE_SECONDS="${QQ_BOT_STABLE_SECONDS:-60}"
# Size-based rotation (copytruncate: the app appends, so truncating is safe).
LOG_MAX_BYTES="${QQ_BOT_LOG_MAX_BYTES:-52428800}"
LOG_KEEP="${QQ_BOT_LOG_KEEP:-5}"
LOG_CHECK_SECONDS="${QQ_BOT_LOG_CHECK_SECONDS:-60}"

for setting in "$RESTART_DELAY_SECONDS" "$RESTART_MAX_DELAY_SECONDS" \
  "$STABLE_SECONDS" "$LOG_MAX_BYTES" "$LOG_KEEP" "$LOG_CHECK_SECONDS"; do
  case "$setting" in
    "" | *[!0-9]* | 0)
      echo "supervisor settings must be positive integers (got '$setting')" >&2
      exit 2
      ;;
  esac
done

mkdir -p "$LOG_DIR"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  exit 0
fi

echo "$$" >"$PID_FILE"
child_pid=""
rotator_pid=""

log() {
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >>"$LOG_DIR/supervisor.log"
}

# Sleep in the background so INT/TERM interrupt the wait immediately instead
# of after a backoff that may be minutes long.
pause() {
  sleep "$1" &
  wait "$!" || true
}

rotate_if_large() {
  file="$1"
  [ -f "$file" ] || return 0
  size="$(wc -c <"$file" | tr -d ' ')"
  [ "$size" -gt "$LOG_MAX_BYTES" ] || return 0
  index="$LOG_KEEP"
  rm -f "$file.$index"
  while [ "$index" -gt 1 ]; do
    previous=$((index - 1))
    if [ -f "$file.$previous" ]; then
      mv -f "$file.$previous" "$file.$index"
    fi
    index="$previous"
  done
  cp "$file" "$file.1"
  : >"$file"
}

log_rotator() {
  trap - INT TERM EXIT
  while true; do
    rotate_if_large "$LOG_DIR/app.log"
    rotate_if_large "$LOG_DIR/supervisor.log"
    sleep "$LOG_CHECK_SECONDS"
  done
}

shutdown() {
  if [ -n "$child_pid" ] && kill -0 "$child_pid" 2>/dev/null; then
    kill -TERM "$child_pid"
    wait "$child_pid"
  fi
  exit 0
}

cleanup() {
  if [ -n "$rotator_pid" ]; then
    kill "$rotator_pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE" "$APP_PID_FILE" "$RUNNING_RELEASE_FILE"
}

trap shutdown INT TERM
trap cleanup EXIT

log_rotator &
rotator_pid=$!

delay="$RESTART_DELAY_SECONDS"
while true; do
  if [ ! -x "$RUNTIME_NODE" ]; then
    log "Node runtime not found: $RUNTIME_NODE"
    pause 10
    continue
  fi

  if [ ! -f "$ENV_FILE" ]; then
    log "Environment file not found: $ENV_FILE"
    pause 10
    continue
  fi

  cd "$CURRENT_DIR" || {
    pause 10
    continue
  }

  started_at="$(date +%s)"
  "$RUNTIME_NODE" \
    --env-file="$ENV_FILE" \
    "$CURRENT_DIR/apps/bot/dist/main.js" \
    >>"$LOG_DIR/app.log" 2>&1 &
  child_pid=$!
  echo "$child_pid" >"$APP_PID_FILE"
  readlink -f "$CURRENT_DIR" >"$RUNNING_RELEASE_FILE"
  exit_code=0
  wait "$child_pid" || exit_code=$?
  child_pid=""
  rm -f "$APP_PID_FILE" "$RUNNING_RELEASE_FILE"

  ran_for=$(($(date +%s) - started_at))
  if [ "$ran_for" -ge "$STABLE_SECONDS" ]; then
    delay="$RESTART_DELAY_SECONDS"
  fi
  log "bot exited with code $exit_code after ${ran_for}s; restarting in ${delay}s"
  pause "$delay"
  delay=$((delay * 2))
  if [ "$delay" -gt "$RESTART_MAX_DELAY_SECONDS" ]; then
    delay="$RESTART_MAX_DELAY_SECONDS"
  fi
done
