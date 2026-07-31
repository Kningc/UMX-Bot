#!/bin/sh

set -eu

PROJECT_ROOT="$(CDPATH= cd -- "$(dirname "$0")/.." && pwd)"
CONFIG_FILE="${QQ_BOT_DEPLOY_CONFIG:-$PROJECT_ROOT/.deploy.env}"

if [ -f "$CONFIG_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$CONFIG_FILE"
  set +a
fi

DEPLOY_HOST="${QQ_BOT_DEPLOY_HOST:-}"
IDENTITY="${QQ_BOT_DEPLOY_IDENTITY:-}"
APP_ROOT="${QQ_BOT_ROOT:-/home/kningc/apps/qq-bot}"
KEEP_RELEASES="${QQ_BOT_KEEP_RELEASES:-8}"

if [ -z "$DEPLOY_HOST" ]; then
  echo "QQ_BOT_DEPLOY_HOST is required; copy deploy/deploy.env.example to .deploy.env" >&2
  exit 2
fi
case "$APP_ROOT" in
  /*) ;;
  *)
    echo "QQ_BOT_ROOT must be an absolute path" >&2
    exit 2
    ;;
esac
case "$APP_ROOT" in
  *[!A-Za-z0-9_./-]*)
    echo "QQ_BOT_ROOT contains unsupported characters" >&2
    exit 2
    ;;
esac
case "$KEEP_RELEASES" in
  *[!0-9]* | 0 | 1)
    echo "QQ_BOT_KEEP_RELEASES must be an integer greater than 1" >&2
    exit 2
    ;;
esac

cd "$PROJECT_ROOT"
if [ -n "$(git status --porcelain)" ]; then
  echo "deployment requires a clean Git worktree" >&2
  exit 2
fi

COMMIT="$(git rev-parse HEAD)"
SHORT_COMMIT="$(git rev-parse --short=7 HEAD)"
RELEASE_ID="$(date -u +%Y%m%d%H%M%S)-$SHORT_COMMIT"
REMOTE_ARCHIVE="$APP_ROOT/releases/.$RELEASE_ID.tar.gz"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/qq-bot-release.XXXXXX")"
ARCHIVE="$TEMP_DIR/$RELEASE_ID.tar.gz"

cleanup() {
  rm -rf "$TEMP_DIR"
}
trap cleanup EXIT INT TERM

ssh_run() {
  if [ -n "$IDENTITY" ]; then
    ssh -i "$IDENTITY" -o BatchMode=yes "$DEPLOY_HOST" "$@"
  else
    ssh -o BatchMode=yes "$DEPLOY_HOST" "$@"
  fi
}

scp_upload() {
  if [ -n "$IDENTITY" ]; then
    scp -i "$IDENTITY" -o BatchMode=yes "$1" "$DEPLOY_HOST:$2"
  else
    scp -o BatchMode=yes "$1" "$DEPLOY_HOST:$2"
  fi
}

echo "==> verifying commit $SHORT_COMMIT"
CI=true corepack pnpm check

echo "==> packaging release $RELEASE_ID"
git archive --format=tar HEAD | gzip -9 >"$ARCHIVE"

echo "==> uploading to $DEPLOY_HOST"
ssh_run "mkdir -p '$APP_ROOT/releases' '$APP_ROOT/shared/logs' '$APP_ROOT/shared/data'"
scp_upload "$ARCHIVE" "$REMOTE_ARCHIVE"

echo "==> installing and activating release"
ssh_run \
  "mkdir -p '$APP_ROOT/releases/.staging-$RELEASE_ID' &&
   tar -xzf '$REMOTE_ARCHIVE' -C '$APP_ROOT/releases/.staging-$RELEASE_ID' &&
   rm -f '$REMOTE_ARCHIVE' &&
   sh '$APP_ROOT/releases/.staging-$RELEASE_ID/deploy/remote-release.sh' '$APP_ROOT' '$RELEASE_ID' '$COMMIT' '$KEEP_RELEASES'"

echo "==> deployed $RELEASE_ID"
