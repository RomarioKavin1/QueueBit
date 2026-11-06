#!/usr/bin/env bash
# Build the shared-devnet explorer (@skandha/devnet-ui) into ./dist, ready to copy to the server's gateway/explorer/.
#   BASE_URL=https://<main-tunnel>.trycloudflare.com ./build.sh   # build-time fallback instance list
#   ./build.sh                                                     # no fallback: /instances.js must be served
# Needs git and bun (1.3.9 was used). The running gateway generates /instances.js from gateway/public/base-url.txt,
# so BASE_URL only matters if /instances.js is unavailable.
set -euo pipefail
cd "$(dirname "$0")"
./apply.sh
BASE_URL="${BASE_URL%/}"
if [ -n "$BASE_URL" ]; then
  export VITE_EXPLORER_INSTANCES="[{\"name\":\"Stock mempool\",\"url\":\"$BASE_URL/sidecar\"},{\"name\":\"Staked mempool (BUDGET-010)\",\"url\":\"$BASE_URL/sidecar-staked\"}]"
else
  unset VITE_EXPLORER_INSTANCES
fi
(cd sidecar && { bun install --frozen-lockfile 2>/dev/null || bun install; })
(cd sidecar/packages/devnet-ui && bun install && bun run build:hosted)
rm -rf dist && cp -R sidecar/packages/devnet-ui/dist dist
entry=(dist/assets/index-*.js)
echo "explorer built into $(pwd)/dist (${entry[*]##*/})"
echo "deploy: rsync -a --delete dist/ OCI_ARM_1:queuebit-devnet/gateway/explorer/"
