#!/usr/bin/env bash
# Build leaked/sidecar:budget-010 from upstream/skandha-budget-010 (pinned upstream base + patches/*.patch).
#   ./build.sh                     # native platform (arm64 on Apple Silicon: no emulation needed, the sidecar is JS)
#   PLATFORM=linux/amd64 ./build.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
IMAGE="${SKANDHA_BUDGET_IMAGE:-leaked/sidecar:budget-010}"
"$ROOT/upstream/skandha-budget-010/apply.sh"
SRC="$ROOT/upstream/skandha-budget-010/sidecar"
REV="$(git -C "$SRC" rev-parse HEAD)"
docker build ${PLATFORM:+--platform "$PLATFORM"} -t "$IMAGE" \
  --label org.opencontainers.image.source=https://github.com/forshtat/mempool-workshop-sidecar \
  --label org.opencontainers.image.revision="$REV" \
  --label leaked.patch=BUDGET-010 "$SRC"
echo "built $IMAGE from $REV"
