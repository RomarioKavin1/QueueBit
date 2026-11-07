# QueueBit LeanPool node. Build from the REPOSITORY ROOT (the service is a pnpm workspace package):
#
#   docker build -f services/leanpool-node/Dockerfile -t queuebit/leanpool-node .
#   docker run -d --name leanpool -p 127.0.0.1:8711:8711 -v leanpool:/data \
#     -e LEANPOOL_PRIVATE_KEY=0x… -e LEANPOOL_RPC_URL=https://altmempool.forshtat.com \
#     -e LEANPOOL_SIDECAR_URL=https://altmempool.forshtat.com/rpc -e LEANPOOL_REGISTRY=0x… \
#     -e LEANPOOL_AGGREGATE=1 -e LEANPOOL_AUTO_BOND_WEI=10000000000000000 queuebit/leanpool-node
#
# Holds one ECDSA key (the aggregator: bond, root posts, proof hashes), or in PQ mode (LEANPOOL_PQ_AGGREGATOR,
# LEANPOOL_PQ_KEY_FILE mounted read-only) the PQAggregator's C13 key, the ECDSA key then only paying gas. STARKs are kept in /data so their on-chain
# hashes stay checkable after a restart. Proving peaks at ~1.7 GB of RAM. @kevaundray/lean-pq ships prebuilt musl
# binaries for x64 (AVX2) and arm64.
FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/frames/package.json packages/frames/
COPY packages/pq-signer/package.json packages/pq-signer/
COPY services/leanpool-node/package.json services/leanpool-node/
RUN pnpm install --frozen-lockfile --ignore-scripts --filter queuebit-wallet --filter "@queuebit/leanpool-node..."
COPY packages/frames/tsconfig*.json packages/frames/
COPY packages/frames/src packages/frames/src
COPY packages/pq-signer/tsconfig*.json packages/pq-signer/
COPY packages/pq-signer/src packages/pq-signer/src
COPY packages/pq-signer/wasm packages/pq-signer/wasm
COPY services/leanpool-node/tsconfig*.json services/leanpool-node/
COPY services/leanpool-node/src services/leanpool-node/src
RUN pnpm --filter "@queuebit/leanpool-node..." run build \
 && pnpm --filter @queuebit/leanpool-node deploy --prod --legacy /out

FROM node:24-alpine
ENV NODE_ENV=production \
    LEANPOOL_HOST=0.0.0.0 \
    LEANPOOL_PORT=8711 \
    LEANPOOL_DATA_DIR=/data
WORKDIR /app
COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8711
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8711/ >/dev/null || exit 1
CMD ["node", "dist/main.js"]
