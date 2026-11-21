FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

# Manifests first so the dependency layer is cached across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY examples ./examples
COPY packages ./packages
COPY plugins ./plugins

RUN pnpm install --frozen-lockfile
RUN pnpm build
# Workspace plugins declare @qq-bot/plugin-sdk as a peer dependency. Without
# this, legacy deploy auto-installs it from the npm registry (404 when the
# version is unpublished, or a mismatched copy when it is) instead of using
# the workspace package the app already depends on.
ENV npm_config_auto_install_peers=false
RUN pnpm deploy --legacy --filter @qq-bot/app --prod /out

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production \
    BOT_DATABASE_PATH=/data/bot.sqlite \
    BOT_METRICS_HOST=127.0.0.1 \
    BOT_METRICS_PORT=9095

COPY --from=build /out ./

# SQLite database and health snapshot live here; mount a volume to persist.
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]

USER node

# Liveness over loopback only (the ops server is unauthenticated).
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.BOT_METRICS_PORT||9095)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/main.js"]
