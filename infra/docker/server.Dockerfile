# syntax=docker/dockerfile:1
# 统一的服务端镜像：api / worker / migrate 三个 target 共享同一份依赖层，
# 保证三个运行时看到的依赖树完全一致（环境结果一致）。

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# 仅生产依赖（tsx 是运行时执行器，属于 dependencies）
FROM base AS prod-deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod \
      --filter @map/api... --filter @map/worker... --filter @map/db...

FROM base AS sources
COPY packages/shared packages/shared
COPY packages/db packages/db
COPY apps/api apps/api
COPY apps/worker apps/worker

# ── API ──────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS api
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=sources /app/packages/shared ./packages/shared
COPY --from=sources /app/packages/db ./packages/db
COPY --from=sources /app/apps/api ./apps/api
COPY pnpm-workspace.yaml package.json ./
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["./node_modules/.bin/tsx", "src/index.ts"]

# ── Worker ───────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS worker
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=prod-deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=sources /app/packages/shared ./packages/shared
COPY --from=sources /app/packages/db ./packages/db
COPY --from=sources /app/apps/worker ./apps/worker
COPY pnpm-workspace.yaml package.json ./
WORKDIR /app/apps/worker
EXPOSE 3100
CMD ["./node_modules/.bin/tsx", "src/index.ts"]

# ── 迁移（一次性任务容器；默认 up，可用 docker compose run 覆盖为 status/down/verify）──
FROM node:22-bookworm-slim AS migrate
ENV NODE_ENV=production
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/packages/shared/node_modules ./packages/shared/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY --from=sources /app/packages/shared ./packages/shared
COPY --from=sources /app/packages/db ./packages/db
COPY pnpm-workspace.yaml package.json ./
WORKDIR /app/packages/db
ENTRYPOINT ["./node_modules/.bin/tsx", "src/migrate.ts"]
CMD ["up"]
