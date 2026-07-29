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
PREVIOUS_RELEASE=""
LOCK_DIR="$APP_ROOT/shared/deploy.lock"

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
if [ ! -x "$NODE_BIN/node" ] || [ ! -x "$NODE_BIN/corepack" ]; then
  echo "Node runtime is incomplete: $NODE_BIN" >&2
  exit 1
fi
if [ ! -f "$APP_ROOT/shared/.env" ]; then
  echo "missing shared environment file: $APP_ROOT/shared/.env" >&2
  exit 1
fi
if [ -e "$RELEASE_DIR" ]; then
  echo "release already exists: $RELEASE_DIR" >&2
  exit 1
fi
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "another deployment is already running" >&2
  exit 1
fi
cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
  if [ -d "$STAGING_DIR" ]; then
    rm -rf -- "$STAGING_DIR"
  fi
}
trap cleanup EXIT INT TERM

export PATH="$NODE_BIN:$PATH"
export COREPACK_HOME="$APP_ROOT/shared/corepack"

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
mv "$STAGING_DIR" "$RELEASE_DIR"
if [ -L "$CURRENT_LINK" ]; then
  PREVIOUS_RELEASE="$(readlink -f "$CURRENT_LINK")"
fi

ln -s "$RELEASE_DIR" "$APP_ROOT/current.next"
mv -Tf "$APP_ROOT/current.next" "$CURRENT_LINK"

if "$RELEASE_DIR/deploy/manage.sh" restart &&
  sleep 3 &&
  "$RELEASE_DIR/deploy/manage.sh" health; then
  echo "release activated: $RELEASE_ID"
else
  echo "release failed health check" >&2
  if [ -n "$PREVIOUS_RELEASE" ] && [ -d "$PREVIOUS_RELEASE" ]; then
    echo "rolling back to $(basename "$PREVIOUS_RELEASE")" >&2
    ln -s "$PREVIOUS_RELEASE" "$APP_ROOT/current.next"
    mv -Tf "$APP_ROOT/current.next" "$CURRENT_LINK"
    "$PREVIOUS_RELEASE/deploy/manage.sh" restart
  fi
  exit 1
fi

current_release="$(readlink -f "$CURRENT_LINK")"
kept=0
find "$RELEASES_DIR" -mindepth 1 -maxdepth 1 -type d -name '20*' |
  sort -r |
  while IFS= read -r candidate; do
    kept=$((kept + 1))
    if [ "$kept" -le "$KEEP_RELEASES" ] || [ "$candidate" = "$current_release" ]; then
      continue
    fi
    rm -rf -- "$candidate"
  done
