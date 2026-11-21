#!/bin/sh

set -eu

APP_ROOT="${1:?app root is required}"
RELEASE_ID="${2:?release id is required}"
COMMIT="${3:?commit is required}"
KEEP_RELEASES="${4:-8}"
RELEASES_DIR="$APP_ROOT/releases"
STAGING_DIR="$RELEASES_DIR/.staging-$RELEASE_ID"
RELEASE_DIR="$RELEASES_DIR/$RELEASE_ID"
CURRENT_LINK="$APP_ROOT/current"
NODE_BIN="$APP_ROOT/runtime/node/bin"
SHARED_DIR="$APP_ROOT/shared"
BACKUP_DIR="$SHARED_DIR/backups"
LOG_DIR="$SHARED_DIR/logs"
PREVIOUS_RELEASE=""
BACKUP_FILE=""
LOCK_DIR="$SHARED_DIR/deploy.lock"
HEALTH_ATTEMPTS="${QQ_BOT_HEALTH_ATTEMPTS:-20}"
HEALTH_INTERVAL_SECONDS="${QQ_BOT_HEALTH_INTERVAL_SECONDS:-3}"

case "$RELEASE_ID" in
  *[!0-9a-f-]* | "")
    echo "invalid release id: $RELEASE_ID" >&2
    exit 2
    ;;
esac
case "$APP_ROOT" in
  /*) ;;
  *)
    echo "invalid app root: $APP_ROOT" >&2
    exit 2
    ;;
esac
case "$APP_ROOT" in
  *[!A-Za-z0-9_./-]*)
    echo "invalid app root: $APP_ROOT" >&2
    exit 2
    ;;
esac

# Run the deployment detached from the SSH session. If the connection drops
# halfway (after the old release is stopped, say), the deploy still finishes
# or rolls back instead of leaving the bot down and the lock held. The SSH
# side only follows the log and relays the exit code.
if [ "${QQ_BOT_DEPLOY_DETACHED:-}" != 1 ]; then
  mkdir -p "$LOG_DIR"
  DEPLOY_LOG="$LOG_DIR/deploy-$RELEASE_ID.log"
  : >"$DEPLOY_LOG"
  QQ_BOT_DEPLOY_DETACHED=1 nohup sh "$0" "$@" >"$DEPLOY_LOG" 2>&1 </dev/null &
  deploy_pid=$!
  tail -n +1 -f "$DEPLOY_LOG" &
  tail_pid=$!
  deploy_status=0
  wait "$deploy_pid" || deploy_status=$?
  # tail polls; give it a moment to print the final lines.
  sleep 1
  kill "$tail_pid" 2>/dev/null || true
  wait "$tail_pid" 2>/dev/null || true
  echo "deploy log: $DEPLOY_LOG"
  exit "$deploy_status"
fi

if [ ! -x "$NODE_BIN/node" ] || [ ! -x "$NODE_BIN/corepack" ]; then
  echo "Node runtime is incomplete: $NODE_BIN" >&2
  exit 1
fi
if [ ! -f "$SHARED_DIR/.env" ]; then
  echo "missing shared environment file: $SHARED_DIR/.env" >&2
  exit 1
fi
if [ -e "$RELEASE_DIR" ]; then
  echo "release already exists: $RELEASE_DIR" >&2
  exit 1
fi

# Same resolution as the bot itself: the shared env file, else the default.
DB_PATH="$(
  set -a
  # shellcheck disable=SC1091
  . "$SHARED_DIR/.env"
  printf '%s' "${BOT_DATABASE_PATH:-$SHARED_DIR/data/bot.sqlite}"
)"
case "$DB_PATH" in
  /*) ;;
  *)
    # The supervisor runs the bot from inside the release directory, so a
    # relative path would give every release its own empty database.
    echo "BOT_DATABASE_PATH must be absolute in $SHARED_DIR/.env (got $DB_PATH)" >&2
    exit 1
    ;;
esac

acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" >"$LOCK_DIR/pid"
    return 0
  fi
  holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  if [ -z "$holder" ]; then
    # The holder may sit between mkdir and writing its PID; look again.
    sleep 1
    holder="$(cat "$LOCK_DIR/pid" 2>/dev/null || true)"
  fi
  if [ -n "$holder" ] && kill -0 "$holder" 2>/dev/null; then
    echo "another deployment is already running (PID $holder)" >&2
    return 1
  fi
  # The holder died without cleaning up (SIGKILL, reboot): reclaim the lock.
  echo "removing stale deploy lock left by PID ${holder:-unknown}" >&2
  rm -rf -- "$LOCK_DIR"
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    echo "$$" >"$LOCK_DIR/pid"
    return 0
  fi
  echo "another deployment acquired the lock first" >&2
  return 1
}

acquire_lock
cleanup() {
  rm -rf -- "$LOCK_DIR"
  if [ -d "$STAGING_DIR" ]; then
    rm -rf -- "$STAGING_DIR"
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export PATH="$NODE_BIN:$PATH"
export COREPACK_HOME="$SHARED_DIR/corepack"
# manage.sh falls back to a hard-coded root; make it follow this deployment.
export QQ_BOT_ROOT="$APP_ROOT"

# Atomically repoint `current`; rename(2) replaces the old symlink in place.
point_current_to() {
  ln -s "$1" "$APP_ROOT/current.next"
  "$NODE_BIN/node" -e 'require("node:fs").renameSync(process.argv[1], process.argv[2])' \
    "$APP_ROOT/current.next" "$CURRENT_LINK"
}

wait_for_health() {
  attempt=1
  while [ "$attempt" -le "$HEALTH_ATTEMPTS" ]; do
    if "$RELEASE_DIR/deploy/manage.sh" health; then
      return 0
    fi
    if [ "$attempt" -lt "$HEALTH_ATTEMPTS" ]; then
      echo "health check attempt $attempt/$HEALTH_ATTEMPTS failed; retrying in ${HEALTH_INTERVAL_SECONDS}s"
      sleep "$HEALTH_INTERVAL_SECONDS"
    fi
    attempt=$((attempt + 1))
  done
  return 1
}

prune() {
  # $1 directory, $2 find -name pattern, $3 path that must be kept.
  kept=0
  find "$1" -mindepth 1 -maxdepth 1 -name "$2" |
    sort -r |
    while IFS= read -r candidate; do
      kept=$((kept + 1))
      if [ "$kept" -le "$KEEP_RELEASES" ] || [ "$candidate" = "$3" ]; then
        continue
      fi
      rm -rf -- "$candidate"
    done
}

cd "$STAGING_DIR"
echo "==> installing dependencies"
corepack pnpm install --frozen-lockfile
echo "==> building workspace"
corepack pnpm -r --if-present build
node --check apps/bot/dist/main.js

cat >deploy/release.env <<EOF
RELEASE_ID=$RELEASE_ID
GIT_COMMIT=$COMMIT
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
EOF

chmod +x deploy/manage.sh deploy/supervise.sh
cd "$APP_ROOT"
mv "$STAGING_DIR" "$RELEASE_DIR"
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK")"
fi

# Stop before the snapshot so it holds every write the old release made.
echo "==> stopping current release"
"$RELEASE_DIR/deploy/manage.sh" stop

echo "==> backing up database"
mkdir -p "$BACKUP_DIR"
snapshot="$BACKUP_DIR/pre-$RELEASE_ID.sqlite"
backup_status=0
"$NODE_BIN/node" "$RELEASE_DIR/scripts/db-snapshot.mjs" backup "$DB_PATH" "$snapshot" ||
  backup_status=$?
case "$backup_status" in
  0) BACKUP_FILE="$snapshot" ;;
  3) echo "no database yet at $DB_PATH; nothing to back up" ;;
  *)
    echo "database backup failed; keeping the current release" >&2
    rm -rf -- "$RELEASE_DIR"
    if [ -n "$PREVIOUS_RELEASE" ]; then
      "$PREVIOUS_RELEASE/deploy/manage.sh" start
    fi
    exit 1
    ;;
esac

echo "==> activating release"
point_current_to "$RELEASE_DIR"

if "$RELEASE_DIR/deploy/manage.sh" start && wait_for_health; then
  echo "release activated: $RELEASE_ID"
else
  echo "release failed health check" >&2
  if [ -z "$PREVIOUS_RELEASE" ] || [ ! -d "$PREVIOUS_RELEASE" ]; then
    echo "no previous release to roll back to; leaving $RELEASE_ID in place" >&2
    exit 1
  fi
  echo "==> rolling back to $(basename "$PREVIOUS_RELEASE")" >&2
  "$RELEASE_DIR/deploy/manage.sh" stop
  if [ -n "$BACKUP_FILE" ]; then
    # The failed release may have migrated the schema; the previous build
    # refuses to open a newer schema, so the data must go back with the code.
    "$NODE_BIN/node" "$RELEASE_DIR/scripts/db-snapshot.mjs" restore "$BACKUP_FILE" "$DB_PATH"
  fi
  point_current_to "$PREVIOUS_RELEASE"
  if "$PREVIOUS_RELEASE/deploy/manage.sh" start && wait_for_health; then
    echo "rolled back to $(basename "$PREVIOUS_RELEASE"); database restored from ${BACKUP_FILE:-<none>}" >&2
  else
    echo "ROLLBACK FAILED: $(basename "$PREVIOUS_RELEASE") is not healthy either; manual intervention needed" >&2
    echo "pre-deploy database snapshot: ${BACKUP_FILE:-<none>}" >&2
  fi
  exit 1
fi

current_release="$(readlink -f "$CURRENT_LINK")"
prune "$RELEASES_DIR" '20*' "$current_release"
prune "$BACKUP_DIR" 'pre-*.sqlite' "$BACKUP_FILE"
