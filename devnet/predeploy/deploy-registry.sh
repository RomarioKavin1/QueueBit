#!/usr/bin/env bash
# Deploys NaiveStakingRegistry (vendored from forshtat/mempool-workshop-sidecar deploy/predeploy, MIT) from
# anvil test account #1 at nonce 0, so the address is always 0x8464135c8F25Da09e49BC8782676a84730C318bC.
# Needs `cast` (foundry). Usage: ./deploy-registry.sh <ethrex rpc url>
set -euo pipefail
cd "$(dirname "$0")"
RPC="${1:-http://localhost:8545}"
KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # anvil #1 (public test key)
FROM=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
EXPECT=0x8464135c8F25Da09e49BC8782676a84730C318bC
NONCE=$(cast nonce "$FROM" --rpc-url "$RPC")
if [ "$NONCE" != "0" ]; then echo "deployer nonce is $NONCE, not 0: the address would differ from $EXPECT"; exit 1; fi
# Amsterdam+ resource-based gas: contract creation needs a large limit (state gas). 6M works; 900k reverts.
TX=$(cast send --rpc-url "$RPC" --private-key "$KEY" --legacy --gas-price 1gwei --gas-limit 6000000 --create "$(cat NaiveStakingRegistry.bin)" --json)
ADDR=$(echo "$TX" | python3 -c 'import sys,json;print(json.load(sys.stdin)["contractAddress"])')
STATUS=$(echo "$TX" | python3 -c 'import sys,json;print(json.load(sys.stdin)["status"])')
echo "NaiveStakingRegistry at $ADDR (status $STATUS)"
[ "$(echo $ADDR | tr A-F a-f)" = "$(echo $EXPECT | tr A-F a-f)" ] || { echo "unexpected address"; exit 1; }
