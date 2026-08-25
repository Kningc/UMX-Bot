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
REMOTE_DIR="$APP_ROOT/shared/menu-sync"
MODE="${1:-}"

case "$MODE" in
  "" | --verify-only) ;;
  *) echo "Usage: $0 [--verify-only]" >&2; exit 2 ;;
esac

if [ -z "$DEPLOY_HOST" ]; then
  echo "QQ_BOT_DEPLOY_HOST is required; copy deploy/deploy.env.example to .deploy.env" >&2
  exit 2
fi
case "$APP_ROOT" in
  /*) ;;
  *) echo "QQ_BOT_ROOT must be an absolute path" >&2; exit 2 ;;
esac
case "$APP_ROOT" in
  *[!A-Za-z0-9_./-]*) echo "QQ_BOT_ROOT contains unsupported characters" >&2; exit 2 ;;
esac

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

node "$PROJECT_ROOT/scripts/sync-qq-menu.mjs" "$PROJECT_ROOT/deploy/qq-menu.json" --validate-only
ssh_run "mkdir -p '$REMOTE_DIR'"
scp_upload "$PROJECT_ROOT/scripts/sync-qq-menu.mjs" "$REMOTE_DIR/sync-qq-menu.mjs"
scp_upload "$PROJECT_ROOT/deploy/qq-menu.json" "$REMOTE_DIR/qq-menu.json"
ssh_run \
  "set -a &&
   . '$APP_ROOT/shared/.env' &&
   set +a &&
   '$APP_ROOT/runtime/node/bin/node' '$REMOTE_DIR/sync-qq-menu.mjs' '$REMOTE_DIR/qq-menu.json' '$MODE'"
