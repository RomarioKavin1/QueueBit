# Self-hosted QueueBit watcher. Build from the REPOSITORY ROOT (the service is a pnpm workspace package):
#
#   docker build -f services/watcher/Dockerfile -t queuebit/watcher .
#   docker run -d --name queuebit-watcher -p 127.0.0.1:8787:8787 -v queuebit-watcher:/data \
#     -v $PWD/watcher.json:/config/watcher.json:ro -e WATCHER_CONFIG=/config/watcher.json queuebit/watcher
#
# Holds no keys; reads the chain through the RPC you configure; state (cursor, alert history) lives in /data.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/frames/package.json packages/frames/
COPY packages/rpc/package.json packages/rpc/
COPY packages/watcher-core/package.json packages/watcher-core/
COPY services/watcher/package.json services/watcher/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter queuebit-wallet --filter "@queuebit/watcher..."
COPY packages/frames/tsconfig*.json packages/frames/
COPY packages/frames/src packages/frames/src
COPY packages/rpc/tsconfig*.json packages/rpc/
COPY packages/rpc/src packages/rpc/src
COPY packages/watcher-core/tsconfig*.json packages/watcher-core/
COPY packages/watcher-core/src packages/watcher-core/src
COPY services/watcher/tsconfig*.json services/watcher/
COPY services/watcher/src services/watcher/src
RUN pnpm --filter "@queuebit/watcher..." run build \
 && pnpm --filter @queuebit/watcher deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production \
    WATCHER_HOST=0.0.0.0 \
    WATCHER_PORT=8787 \
    WATCHER_STORE=sqlite:/data/watcher.db
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz >/dev/null || exit 1
CMD ["node", "dist/main.js"]
