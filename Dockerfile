FROM node:24-alpine AS build

WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json vitest.config.ts ./
COPY apps ./apps
COPY packages ./packages
COPY plugins ./plugins

RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm deploy --legacy --filter @qq-bot/app --prod /out

FROM node:24-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /out ./

USER node
CMD ["node", "dist/main.js"]
