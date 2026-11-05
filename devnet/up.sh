#!/usr/bin/env bash
# Bring up the local EIP-8141 devnet (ethrex eip8141-tracer + Lighthouse + the ERC-8421 sidecar).
# First run: generates genesis (GENESIS_TIMESTAMP = now), starts the chain, waits for blocks, deploys the
# NaiveStakingRegistry, starts the sidecar. Later runs: just restarts the containers (state in ./data).
# Env knobs: ETHREX_PORT (8545), SKANDHA_PORT (14337), BEACON_PORT (5052), SKANDHA_IMAGE, NO_SIDECAR=1,
# WAIT_HEGOTA=0 (do not block until Hegota is active).
set -euo pipefail
cd "$(dirname "$0")"

RPC="http://localhost:${ETHREX_PORT:-8545}"
SIDECAR="http://localhost:${SKANDHA_PORT:-14337}/rpc"
rpc() { curl -s -m 10 -X POST "$1" -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}"; }
hexdec() { printf '%d' "$1"; }

if [ ! -f data/genesis/metadata/genesis.json ]; then
  echo "[up] fresh genesis (timestamp = now; slot 0 in GENESIS_DELAY seconds)"
  mkdir -p data
  export GENESIS_TIMESTAMP=$(date +%s)
  docker compose up genesis validator-keys
  echo "$GENESIS_TIMESTAMP" > data/genesis-timestamp
  FRESH=1
else
  FRESH=0
fi

echo "[up] starting ethrex + lighthouse"
docker compose up -d --no-deps ethrex lighthouse-beacon lighthouse-beacon-2 lighthouse-validator

echo "[up] waiting for ethrex RPC"
for i in $(seq 1 60); do
  if rpc "$RPC" eth_chainId | grep -q 0x539; then break; fi; sleep 2
done
rpc "$RPC" eth_chainId | grep -q 0x539 || { echo "ethrex RPC not answering on $RPC"; exit 1; }

echo "[up] waiting for block 1 (first blocks ~GENESIS_DELAY after genesis)"
for i in $(seq 1 240); do
  BN=$(rpc "$RPC" eth_blockNumber | sed -E 's/.*"result":"(0x[0-9a-f]+)".*/\1/')
  if [ -n "$BN" ] && [ "$(hexdec "$BN")" -ge 1 ]; then break; fi; sleep 3
done
echo "[up] block number $BN"

# Staking registry: deployed by anvil account #1 at nonce 0 => always 0x8464135c8F25Da09e49BC8782676a84730C318bC.
REG=0x8464135c8F25Da09e49BC8782676a84730C318bC
CODE=$(rpc "$RPC" eth_getCode "[\"$REG\",\"latest\"]" | sed -E 's/.*"result":"(0x[0-9a-f]*)".*/\1/')
if [ "$CODE" = "0x" ]; then
  echo "[up] deploying NaiveStakingRegistry from anvil #1 (nonce 0)"
  ./predeploy/deploy-registry.sh "$RPC"
else
  echo "[up] NaiveStakingRegistry already at $REG"
fi

if [ "${NO_SIDECAR:-0}" != "1" ]; then
  echo "[up] starting the sidecar"
  docker compose --profile sidecar up -d --no-deps skandha
  for i in $(seq 1 60); do
    if rpc "$SIDECAR" skandha_config | grep -q stakingRegistryAddress; then break; fi; sleep 2
  done
  rpc "$SIDECAR" skandha_config | grep -q "$(echo $REG | tr 'A-F' 'a-f')" && echo "[up] sidecar up, registry wired" || echo "[up] WARNING: sidecar config does not show the registry"
fi

if [ "${WAIT_HEGOTA:-1}" = "1" ]; then
  HT=$(python3 -c "import json;print(json.load(open('data/genesis/metadata/genesis.json'))['config']['bogotaTime'])")
  NOW=$(date +%s)
  if [ "$NOW" -lt "$HT" ]; then
    echo "[up] Hegota (frame txs) activates at $HT, in $((HT-NOW)) s; waiting (WAIT_HEGOTA=0 to skip)"
    while [ "$(date +%s)" -lt "$((HT+12))" ]; do sleep 5; done
  fi
  echo "[up] Hegota active. 0x...8250 code: $(rpc "$RPC" eth_getCode '["0x0000000000000000000000000000000000008250","latest"]' | sed -E 's/.*"result":"(0x[0-9a-f]*)".*/\1/')"
fi

echo
echo "ethrex RPC:   $RPC          (chain 1337, frame txs via eth_sendRawTransaction, ethrex_simulateFrameTransaction)"
echo "sidecar RPC:  $SIDECAR  (eth_sendFrameTransaction, skandha_*, explorer)"
echo "beacon API:   http://localhost:${BEACON_PORT:-5052}"
echo "status:       ./status.sh    smoke test: cd tools && bun run smoke"
