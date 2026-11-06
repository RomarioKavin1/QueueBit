# BUDGET-010 patched sidecar (local devnet)

The ERC-8421 sidecar with **per-entity verification gas budgets** (ERC-8421 [BUDGET-010]). Unstaked entities get
100,000 and staked entities 1,000,000. It runs **next to** the stock sidecar on the local devnet, which it does not
replace or touch.

| | Endpoint |
|---|---|
| **patched sidecar (BUDGET-010)** | **`http://localhost:14340/rpc`** (container `queuebit-devnet-skandha-budget-1`, `172.28.0.40`, in-network `http://skandha-budget:14337/rpc`) |
| stock sidecar (flat `MAX_VERIFY_GAS` 100k) | `http://localhost:14337/rpc` (unchanged) |
| ethrex | `http://localhost:8545` (shared) |

Both sidecars read the same ethrex and the same `NaiveStakingRegistry` (`0x8464…18bC`). Each keeps its own mempool
and reputation store (`devnet/data/skandha-budget`). The patched one has no faucet (anvil #8 belongs to the stock
one). Port 14338 / IP `.7` are taken by the privacy workstream's own sidecar
(`contracts/devnet-tests/privacy/scripts/patched-sidecar.sh`, a flat 1M constant patch). Use this one for
BUDGET-010 semantics.

## Use

```sh
cd devnet && ./up.sh                  # the devnet itself (once)
./patched-sidecar/up-patched.sh        # builds queuebit/sidecar:budget-010 if missing, starts it, prints skandha_config.budgets
REBUILD=1 ./patched-sidecar/up-patched.sh
./patched-sidecar/up-patched.sh down   # remove only the patched sidecar
```

Under the hood (same thing by hand):

```sh
docker compose -f devnet/docker-compose.yml -f devnet/patched-sidecar/compose.override.yml --profile budget up -d --no-deps skandha-budget
```

`./up.sh`, `./down.sh` and `./status.sh` are unaffected. The new service is in a profile that only this override
defines. Knobs: `SKANDHA_BUDGET_PORT` (14340), `SKANDHA_BUDGET_IMAGE` (`queuebit/sidecar:budget-010`),
`MAX_VERIFY_GAS_PER_ENTITY` / `MAX_VERIFY_GAS_STAKED_ENTITY` (100000 / 1000000; e.g. `250000`/`2500000` to try the
landing page's values), `PLATFORM=linux/amd64 ./build.sh` (the default builds for the host; the sidecar is plain JS
on Bun, so arm64 is fine). To run the patched build *as* the stock sidecar on 14337 instead:
`SKANDHA_IMAGE=queuebit/sidecar:budget-010 ./up.sh` (devnet/README.md).

Read the advertised budgets:

```sh
curl -s localhost:14340/rpc -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"skandha_config","params":[]}' | jq .result.budgets
# {"rule":"BUDGET-010","maxVerifyGasPerEntity":100000,"maxVerifyGasStakedEntity":1000000,"signatureCostAttributedTo":"sender","maxVerifyStateGas":500000}
```

## What the rule is

For each validation-prefix entity (the sender `tx.sender`, the payer of the `pay`/`self_verify` frame, the factory
of `deploy`), the node sums `limits.execution` of its frames:

- `pre_verify` counts toward the approving frame it precedes.
- the signature cost (secp256k1 2,800, ARBITRARY 100, P256 6,700) counts toward the sender.
- `expiry_verify` counts toward no entity and is held to 100k on its own.

Each sum must be ≤ 100,000, or ≤ 1,000,000 when the registry reports the entity staked (stake ≥ `minStake` 0.01 ETH,
delay ≥ `minUnstakeDelay`, no withdrawal) and it is not a default-code account. Rejections carry
`BUDGET-010: <role> <address> verification gas <sum> (...) exceeds MAX_VERIFY_GAS_PER_ENTITY|STAKED_ENTITY ...`, and
the explorer reports rule `BUDGET-010`.

**ethrex still enforces the combined 100k** on `eth_sendRawTransaction` and in simulate (`canonicalMempoolValid:
false`). Over-100k transactions therefore reach the chain only through this sidecar. It relays everything via
`ethrex_submitPrivilegedFrameTransaction`, an unauthenticated builder hook that is only acceptable because ethrex is
private to the devnet. Do not send such transactions to ethrex directly. Where ethrex would need to change upstream
is described in `upstream/skandha-budget-010/PR.md`.

## Source

`upstream/skandha-budget-010/`: `UPSTREAM` (origin `forshtat/mempool-workshop-sidecar`, base `2e22ff0a` = the stock
image), `patches/*.patch` (the PR as `git am` series), `apply.sh` (clone + apply into the git-ignored
`upstream/skandha-budget-010/sidecar/`), `PR.md`. `build.sh` here runs `apply.sh` and `docker build`s the checkout
with the upstream `Dockerfile`.

## E2E

```sh
cd devnet/patched-sidecar/tests && bun install && bun run test    # funding key anvil #9; ~2 min
```

`budget010.e2e.ts` (via `@queuebit/frames` + `@queuebit/rpc`) deploys a fresh wallet and runs these steps:

1. An unstaked 150k VERIFY is rejected with BUDGET-010 (the stock sidecar and ethrex reject it with `MAX_VERIFY_GAS`).
2. The wallet stakes 0.012 ETH.
3. The same 150k shape is admitted and mined.
4. A 1.1M VERIFY is rejected even though the wallet is staked.
5. The explorer admission reports are printed.

The script also checks `skandha_config.budgets`. Results go to `tests/last-run.json`.
