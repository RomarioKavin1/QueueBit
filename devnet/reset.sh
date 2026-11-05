#!/usr/bin/env bash
# Wipe the chain (containers + ./data) and start over from a new genesis. Addresses deployed by the dev keys
# come back identical because every deployer restarts at nonce 0.
set -euo pipefail
cd "$(dirname "$0")"
docker compose --profile sidecar down -v --remove-orphans || true
if [ -d data ]; then
  # ./data is written by root inside the containers; remove it through a container if we cannot.
  rm -rf data 2>/dev/null || docker run --rm -v "$PWD:/w" alpine sh -c 'rm -rf /w/data'
fi
exec ./up.sh "$@"
