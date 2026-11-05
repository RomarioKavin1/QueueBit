#!/usr/bin/env bash
# Stop every devnet container. Chain state stays in ./data; ./up.sh restarts from it.
set -euo pipefail
cd "$(dirname "$0")"
docker compose --profile sidecar down
