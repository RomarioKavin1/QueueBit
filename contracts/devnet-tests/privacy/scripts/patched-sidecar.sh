#!/usr/bin/env bash
# A SECOND, private sidecar for the PoolPayer tests, next to the shared one (devnet/up.sh, port 14337), with
# MAX_VERIFY_GAS raised from 100,000 to 1,000,000 and precompiles 0x01-0x11 allowed (config). No image build: the same image digest as the shared sidecar, with
# the one compiled constant bind-mounted over (packages/executor/lib/.../validationPrefix.js, the build of
# validationPrefix.ts:10 that devnet/README.md "Sidecar: patching MAX_VERIFY_GAS" patches in source). It reads the
# same ethrex and the same staking registry, has its own mempool and reputation store, and does not touch the shared
# sidecar (other workstreams keep using 14337 unchanged). Stopgap: prefer devnet/patched-sidecar (BUDGET-010, 14340)
# once its config lists the precompiles (it rejects PoolPayer otherwise; IMPLEMENTATION-NOTES "PoolPayer").
#
#   scripts/patched-sidecar.sh up [manual]   # port 14338; "manual" = bundlingMode manual (txs stay New)
#   scripts/patched-sidecar.sh down
set -euo pipefail
NAME=leaked-privacy-sidecar
PORT=${PATCHED_SIDECAR_PORT:-14338}
IMAGE=${SKANDHA_IMAGE:-ghcr.io/forshtat/mempool-workshop-sidecar:latest}
HERE=$(cd "$(dirname "$0")/.." && pwd)
DEVNET=$(cd "$HERE/../../../devnet" && pwd)
WORK=${PATCHED_SIDECAR_DIR:-$HERE/results/patched-sidecar}
JS=/usr/app/packages/executor/lib/services/UserOpValidation/utils/validationPrefix.js

case "${1:-up}" in
  down)
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "removed $NAME" ;;
  up)
    MODE=auto; [ "${2:-}" = manual ] && MODE=manual
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    rm -rf "$WORK" && mkdir -p "$WORK/data"
    cid=$(docker create --platform linux/amd64 "$IMAGE")
    docker cp "$cid:$JS" "$WORK/validationPrefix.js"
    docker rm "$cid" >/dev/null
    grep -q 'export const MAX_VERIFY_GAS = BigInt(100000);' "$WORK/validationPrefix.js" \
      || { echo "constant not found in $JS: image changed, re-check the patch" >&2; exit 1; }
    sed -i.bak 's/export const MAX_VERIFY_GAS = BigInt(100000);/export const MAX_VERIFY_GAS = BigInt(1000000);/' "$WORK/validationPrefix.js"
    # Second patch, config only: the sidecar's default `precompiles` list is EMPTY, so its CODE_ACCESS rule rejects a
    # VERIFY frame that STATICCALLs 0x06/0x07/0x08 ("payer accesses un-deployed contract address 0x…06"), although
    # ERC-8421 CALLING-040 allows precompiles 0x01-0x11. PoolPayer's Groth16 check needs them.
    python3 -I -c 'import json,sys; c=json.load(open(sys.argv[1])); c["precompiles"]=["0x%040x" % i for i in range(1, 0x12)]; json.dump(c, open(sys.argv[2], "w"), indent=2)' \
      "$DEVNET/skandha/config.json" "$WORK/config.json"
    docker run -d --name "$NAME" --platform linux/amd64 --network leaked-devnet_default \
      -p "$PORT:14337" \
      -v "$WORK/config.json:/usr/app/config.json:ro" \
      -v "$WORK/validationPrefix.js:$JS:ro" \
      -v "$WORK/data:/usr/app/data" \
      "$IMAGE" standalone --configFile=/usr/app/config.json --dataDir=/usr/app/data \
      --api.address=0.0.0.0 --api.port=14337 --api.wsPort=14337 \
      --executor.bundlingMode=$MODE --redirectRpc --explorer.enable >/dev/null
    for _ in $(seq 1 60); do
      if curl -s -X POST -H 'content-type: application/json' \
        --data '{"jsonrpc":"2.0","id":1,"method":"web3_clientVersion","params":[]}' "http://localhost:$PORT/rpc" | grep -q skandha; then
        echo "patched sidecar up: http://localhost:$PORT/rpc (MAX_VERIFY_GAS 1000000, precompiles 0x01-0x11, bundlingMode $MODE)"; exit 0
      fi
      sleep 2
    done
    docker logs --tail 50 "$NAME"; exit 1 ;;
  *) echo "usage: $0 up [manual] | down" >&2; exit 2 ;;
esac
