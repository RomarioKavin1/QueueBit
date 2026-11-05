#!/usr/bin/env bash
# Start the BUDGET-010 patched sidecar next to the stock one, on http://localhost:${SKANDHA_BUDGET_PORT:-14340}/rpc.
# Needs the devnet already up (devnet/up.sh); does not touch ethrex, lighthouse or the stock sidecar.
#   ./up-patched.sh            # build the image if missing, start, wait for skandha_config
#   REBUILD=1 ./up-patched.sh  # rebuild first
#   ./up-patched.sh down       # stop and remove only the patched sidecar
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEVNET="$(cd "$HERE/.." && pwd)"
IMAGE="${SKANDHA_BUDGET_IMAGE:-leaked/sidecar:budget-010}"
PORT="${SKANDHA_BUDGET_PORT:-14340}"
compose() { docker compose -f "$DEVNET/docker-compose.yml" -f "$HERE/compose.override.yml" --profile budget "$@"; }

if [ "${1:-}" = "down" ]; then
  compose rm -sf skandha-budget
  exit 0
fi
if [ "${REBUILD:-0}" = "1" ] || ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  "$HERE/build.sh"
fi
mkdir -p "$DEVNET/data/skandha-budget"
compose up -d --no-deps skandha-budget
URL="http://localhost:$PORT/rpc"
for _ in $(seq 1 60); do
  if out=$(curl -sf -H 'content-type: application/json' \
      -d '{"jsonrpc":"2.0","id":1,"method":"skandha_config","params":[]}' "$URL" 2>/dev/null) && [[ "$out" == *budgets* ]]; then
    echo "patched sidecar up: $URL"
    python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin)["result"]["budgets"]))' <<<"$out"
    exit 0
  fi
  sleep 2
done
echo "patched sidecar did not answer on $URL; logs:" >&2
compose logs --tail 50 skandha-budget >&2
exit 1
