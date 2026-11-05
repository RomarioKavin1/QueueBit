#!/usr/bin/env bash
# One-screen health check of the local devnet.
cd "$(dirname "$0")"
RPC="http://localhost:${ETHREX_PORT:-8545}"; SIDECAR="http://localhost:${SKANDHA_PORT:-14337}/rpc"
rpc() { curl -s -m 5 -X POST "$1" -H 'content-type: application/json' --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$2\",\"params\":${3:-[]}}"; echo; }
docker compose --profile sidecar ps --format 'table {{.Service}}\t{{.Status}}'
echo "chainId:        $(rpc $RPC eth_chainId)"
echo "clientVersion:  $(rpc $RPC web3_clientVersion)"
echo "blockNumber:    $(rpc $RPC eth_blockNumber)"
echo "hegota (bogotaTime): $(python3 -c "import json;print(json.load(open('data/genesis/metadata/genesis.json'))['config']['bogotaTime'])" 2>/dev/null)  now: $(date +%s)"
echo "0x..8250 code:  $(rpc $RPC eth_getCode '["0x0000000000000000000000000000000000008250","latest"]')"
echo "registry code len: $(rpc $RPC eth_getCode '["0x8464135c8F25Da09e49BC8782676a84730C318bC","latest"]' | wc -c)"
echo "sidecar:        $(rpc $SIDECAR web3_clientVersion)"
echo "beacon head:    $(curl -s -m 5 http://localhost:${BEACON_PORT:-5052}/eth/v1/node/syncing)"
