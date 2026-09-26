# syntax=docker/dockerfile:1
# Web 静态资源镜像：构建期注入 VITE_* 变量，产物由 nginx 提供。

FROM node:22-bookworm-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter @map/web...

COPY packages/shared packages/shared
COPY apps/web apps/web

# 构建期变量（生产必须提供 VITE_TILE_URL，见 README「地图瓦片」）
ARG VITE_TILE_URL=""
ARG VITE_MAP_STYLE_URL=""
ARG VITE_MAP_GLYPHS_URL=""
ARG VITE_DEFAULT_MAP_CENTER="116.39,39.90"
ARG VITE_DEFAULT_MAP_ZOOM="12"
ENV VITE_TILE_URL=$VITE_TILE_URL \
    VITE_MAP_STYLE_URL=$VITE_MAP_STYLE_URL \
    VITE_MAP_GLYPHS_URL=$VITE_MAP_GLYPHS_URL \
    VITE_DEFAULT_MAP_CENTER=$VITE_DEFAULT_MAP_CENTER \
    VITE_DEFAULT_MAP_ZOOM=$VITE_DEFAULT_MAP_ZOOM

RUN pnpm --filter @map/web build

FROM nginx:1.27-alpine
COPY infra/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 80
