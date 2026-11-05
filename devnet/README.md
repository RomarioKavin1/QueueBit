# LEAKED local EIP-8141 devnet

A local, reproducible copy of the public alt-mempool devnet (`https://altmempool.forshtat.com`, chain 1337):
**ethrex `eip8141-tracer`** (execution) + **Lighthouse** (consensus; 2 beacon nodes + 1 validator client) +
the **ERC-8421 mempool sidecar** (the `mempool-workshop-sidecar` fork of Skandha). Same images, same fork
schedule, same chain id and codec profile as the public devnet, so everything that passes here is expected to
pass there.

| | Local | Public |
|---|---|---|
| ethrex JSON-RPC (chain 1337) | `http://localhost:8545` | `https://altmempool.forshtat.com` |
| sidecar JSON-RPC (alt mempool) | `http://localhost:14337/rpc` | `https://altmempool.forshtat.com/rpc` |
| beacon API | `http://localhost:5052` | – |
| `NaiveStakingRegistry` | `0x8464135c8F25Da09e49BC8782676a84730C318bC` | `0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f` |
| `EXPIRY_VERIFIER` (`0x81413f0c…FfFf`) | canonical code preloaded (**local only**) | no code |
| EIP-8250 `NONCE_MANAGER` `0x…8250`, EIP-8272 `RECENT_ROOT_ADDRESS` `0x…8272` | installed by ethrex at Hegota | same |
| Arachnid / EIP-7997 factory `0x4e59b44847b379578588920cA78FbF26c0B4956C` | in genesis (generator) | present |
| Faucet (`skandha_explorer_faucet`) | enabled (anvil #8) | on the gateway only |

## Requirements

- Docker (Desktop) with ~4 GB RAM for the stack. On Apple Silicon the `ethrex` and sidecar images are
  **amd64-only** and run under Rosetta/QEMU emulation (`platform: linux/amd64` in the compose file); it is
  slower but works. Lighthouse and the genesis tools have arm64 builds.
- `curl`, `python3`, `cast` (foundry) for `up.sh`; `bun` for `tools/`.

## Start / stop / reset

```sh
./up.sh      # first run: genesis (now + 60 s), chain, NaiveStakingRegistry, sidecar; waits until Hegota is active
./status.sh  # one-screen health check
./down.sh    # stop; state kept in ./data (git-ignored)
./reset.sh   # wipe ./data and start from a new genesis (same addresses: every dev key restarts at nonce 0)
```

Timeline after `up.sh` on a fresh genesis (6 s slots, 32-slot epochs): slot 0 at **+60 s**, Amsterdam (gloas)
at epoch 1 (**+252 s**), **Hegota (frame transactions) at epoch 2 (+444 s)**. `up.sh` blocks until Hegota
unless `WAIT_HEGOTA=0`. Gloas cannot be active at the CL genesis (Lighthouse rejects it), and ethrex's `--dev`
block producer cannot build Hegota payloads (see "Why not `ethrex --dev`"), so the ~7.5 minutes are the floor.

Env knobs: `ETHREX_PORT` (8545), `SKANDHA_PORT` (14337), `BEACON_PORT` (5052), `SKANDHA_IMAGE` (to run a
patched sidecar build, see below), `NO_SIDECAR=1`, `ETHREX_LOG_LEVEL`.

## Dev keys (public test keys, never real)

All balances are premined in `genesis.values.env`. **Never use any of these on a real network.**

| Role | Address | Private key |
|---|---|---|
| sidecar repo's devnet key; the sidecar's relayer; 1,000,000 ETH | `0x5544596212F91984C986A919C8026DF0576816f9` | `0x06f911c1ecb2053bb443ba0a0e28d630c583c3c0c2f334a9ecdc8c7c6ad4ea15` |
| anvil #0, 100,000 ETH | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | `0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80` |
| anvil #1, **registry deployer** (keep its nonce history: the registry address depends on it) | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | `0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d` |
| anvil #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | `0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a` |
| anvil #3 (`tools/src/smoke.ts`) | `0x90F79bf6EB2c4f870365E785982E1f101E93b906` | `0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6` |
| anvil #4 (`tools/src/probe-opcodes.ts`) | `0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65` | `0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a` |
| anvil #5 | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` | `0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba` |
| anvil #6 | `0x976EA74026E726554dB657fA54763abd0C3a0aa9` | `0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e` |
| anvil #7 | `0x14dC79964da2C08b23698B3D3cc7Ca32193d9955` | `0x4bbbf85ce3377467afe5d46f804f221813b2bb87f24d81f60f1fcdbf7cbf4356` |
| anvil #8, **sidecar faucet** | `0x23618e81E3f5cdF7f54C3d65f7FBc0aBf5B21E8f` | `0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97` |
| anvil #9 | `0xa0Ee7A142d267C1f36714E4a8F75612F20a79720` | `0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6` |

(anvil #0–#9 are the accounts of the well-known mnemonic `test test test test test test test test test test test junk`.)
The CL validator mnemonic is the generator's default (in `docker-compose.yml`).

Reserve a key per workstream / test suite so nonces do not collide: the sidecar admits **one frame tx in flight
per sender** (`Nonce mismatch` otherwise).

## Gas rules that bite (Amsterdam+ resource-based gas, EIP-2780 / EIP-8037)

- A transfer to a **new** account needs ~204,600 gas (`21000 + 183,600` state gas): use `gas: 250000`.
- Contract creation is charged state gas for every byte and every new account: the workshop's small wallet
  deploys with 6,000,000, but a `HegotaSupport` contract with 7 helper `CREATE`s (`OpcodeProbe`, 15.7 KB creation
  code) **used 20,440,510 gas and ran out at 6M**; `tools/` deploys with `gas: 25_000_000`. Block gas limit is
  186M (genesis generator default).
- A `SENDER` frame that creates an account (value to a fresh address) needs `limits.state > 0` (e.g. 200,000);
  with `state: 0` it halts and burns the whole execution limit.
- A `VERIFY` frame's `limits.execution` plus the signature cost (2,800 per SECP256K1 entry, 100 per ARBITRARY)
  must stay ≤ `MAX_VERIFY_GAS = 100,000` on the sidecar, regardless of stake (see below).

## Tools (`tools/`)

Self-contained bun project (not a pnpm workspace package). Uses the vendored
`@forshtat/hegota-support@0.0.1` (MIT; `vendor/forshtat-hegota-support-0.0.1.tgz`, sha256
`f7d17979e6d7b217e297e560941aa4376df10b22cf3f30f9aba02a9542657e84`, built from
`github.com/forshtat/hegota-support` commit `2377188a`) with the `ethrex-eip8141-tracer` codec profile, plus
`viem@2.57.16`. The workshop repo (`forshtat/mempool-workshop`) has **no LICENSE file**, so nothing from it is
copied; its only runtime dependency is this same package.

```sh
cd tools && bun install
bun run smoke          # legacy tx, deploy, frame tx via sidecar + via ethrex, skandha_config, stake, simulate/estimate -> "SMOKE OK"
bun run probe          # deploy OpcodeProbe, print what every TXPARAM/FRAMEPARAM/SIGPARAM/... answers, check against the codec
bun run src/bisect.ts  # one introspection read per VERIFY frame (IN_SENDER=1: per SENDER frame), simulated on ethrex
bun run src/privileged.ts   # does ethrex_submitPrivilegedFrameTransaction mine a >100k VERIFY prefix? (yes)
bun run build:contracts     # (foundry) rebuild contracts/src/*.sol -> artifacts/*.json
# the same against the public devnet (anvil #3/#4 need funds there; `bun run src/fund.ts` sends 2 ETH each from the published genesis key):
ETHREX_URL=https://altmempool.forshtat.com SIDECAR_URL=https://altmempool.forshtat.com/rpc STAKING_REGISTRY=0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f bun run smoke
```

`contracts/src/OpcodeProbe.sol` is a single-owner wallet on `HegotaSupport(Devnet.ERC8421_WORKSHOP)` whose
VERIFY frame reads every introspection opcode and whose SENDER frame emits their values as events;
`VerifyBisect.sol` performs one selected read per frame. Both are built with solc 0.8.28 against the vendored package.

## Verified on 2026-11-06 (local fork; the same scripts pass on the public devnet)

| Check | Result |
|---|---|
| legacy transfer to a fresh account | mined, 204,600 gas |
| deploy `OpcodeProbe` | mined, 20,440,510 gas |
| `eth_sendFrameTransaction` (sidecar) | `OnChain`; VERIFY 44,549 gas, SENDER 148,568 gas, 40 logs |
| `eth_sendRawTransaction` type `0x06` (ethrex) | mined, both frames `0x1` |
| `skandha_config` | `minStake 0.01 ETH`, `minUnstakeDelay 0`, registry wired, no budgets advertised |
| stake a wallet entity (SENDER frame -> `addStake`) | `getDepositInfo = (0.012 ETH, 86400, 0)` |
| `ethrex_simulateFrameTransaction {trace:true}` | `canonicalMempoolValid: true` (note: not `valid`), per-frame gas, 7562 trace |
| `eth_estimateFrameTransactionGas` | rejects signed txs with body frames ("Invalid frame transaction signature"); use simulate |
| opcode probe | all 19 codec-vs-chain checks true; `TXPARAM 0x04 = maxFeePerGas`; `SIGDATACOPY` works on ARBITRARY entries only; see `docs/plan/50-devnet-review.md` §3 |
| VERIFY limit 150k | rejected by sidecar and by ethrex `eth_sendRawTransaction`; **a 1,000,000 VERIFY mined via `ethrex_submitPrivilegedFrameTransaction`** |

## Sidecar: patching `MAX_VERIFY_GAS` (Path A / BUDGET-010 work)

`MAX_VERIFY_GAS = BigInt(100_000)` is a **hard-coded constant** in
`packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts:10` of the sidecar and is enforced in
`validationPrefix.ts:288-291` on the sum of prefix `limits.execution` + signature costs, **for staked and unstaked
entities alike**. It is **not** in `config.json`, not an env var, not a CLI flag (`standalone --help`: only
`--unsafeMode`, which "bypasses opcode & stake check", not this cap). `skandha_config` advertises no budgets.
Changing it means a source build:

```sh
git clone https://github.com/forshtat/mempool-workshop-sidecar && cd mempool-workshop-sidecar   # MIT
sed -i.bak 's/export const MAX_VERIFY_GAS = BigInt(100_000);/export const MAX_VERIFY_GAS = BigInt(1_000_000);/' \
  packages/executor/src/services/UserOpValidation/utils/validationPrefix.ts
docker build -t leaked/sidecar:budget .      # Dockerfile: bun 1.2.23-alpine, `bun run build:all`
SKANDHA_IMAGE=leaked/sidecar:budget ./up.sh  # or: docker compose --profile sidecar up -d --no-deps skandha
```

ethrex's own mempool (`eth_sendRawTransaction`) applies the EIP-8141 canonical rules separately; the sidecar's
relay path (`ethrex_submitPrivilegedFrameTransaction`) bypasses ethrex admission, so a patched sidecar is enough
to get a >100k VERIFY frame mined on this devnet. The proper fix is the BUDGET-010 PR (plan §40 P6): a
per-entity cap that reads the staking registry.

## Why not `ethrex --dev`

The `eip8141-tracer` image is built with the `dev` feature and `--dev --network genesis.json` starts, reads
`bogotaTime` and then fails on every block: `engine_forkchoiceUpdatedV4 cannot accept Hegotá payload attributes`
(the fork's dev block producer still calls the Osaka-era engine method). So a real CL is required. Plain-EVM
work that needs no frame transactions should use `anvil` instead (`anvil --hardfork prague`), which is fast and
needs no Docker.

## Layout and provenance

| File | Origin | License |
|---|---|---|
| `docker-compose.yml`, `genesis.values.env` | `forshtat/mempool-workshop-sidecar` `deploy/devnet/` @ `2e22ff0a` (2026-10-25), adapted (static IPs, multiaddr peering, amd64 platform, restart policy, sidecar service, extra premines, EXPIRY_VERIFIER preload, GENESIS_DELAY 60) | MIT (Etherspot / Alex Forshtat) |
| `skandha/config.json` | same repo, `deploy/devnet/README.md` §5, with the local registry address | MIT |
| `predeploy/src/NaiveStakingRegistry.sol` + `.bin`/`.abi.json` | same repo, `deploy/predeploy/src/contracts/`; compiled with solc 0.8.28, optimizer 200 | MIT |
| `tools/vendor/forshtat-hegota-support-0.0.1.tgz` | npm `@forshtat/hegota-support@0.0.1` (published 2026-10-25) | MIT (`vendor/LICENSE-hegota-support`) |
| `tools/contracts/src/OpcodeProbe.sol`, `tools/src/*` | written here | MIT (repo license) |

Images (pulled 2026-11-06):

| Image | Digest / note |
|---|---|
| `ghcr.io/forshtat/ethrex:eip8141-tracer-latest` | `sha256:920295ae5496669a6f90a44431d4cbcb4703feec0e89207599fe19a251739873`, built 2026-10-01, `web3_clientVersion` = `ethrex/v23.0.0-eip8141-tracer-9aa3645d…` (identical to the public devnet), **amd64 only** |
| `ghcr.io/forshtat/mempool-workshop-sidecar:latest` | `sha256:c4cdc5c707d94f3968566ba34904d1a7c4ab4dee962d822e1bac1bf6714e022e`, built 2026-10-25 (= repo `master` @ `2e22ff0a`), `skandha/v4.1.1-`, **amd64 only** |
| `ethpandaops/lighthouse:focil` | multi-arch |
| `ethpandaops/ethereum-genesis-generator:6.1.6` | multi-arch |
| `protolambda/eth2-val-tools:latest` | multi-arch |

The `:latest` tags follow upstream branches; pin by digest (`image: ghcr.io/forshtat/ethrex@sha256:…`) once the
contracts' devnet suite is in CI.

## Differences from the public devnet

- `EXPIRY_VERIFIER` has the canonical runtime here; it has **no code** on the public devnet. Tests that use an
  `expiry_verify` frame pass only locally until the operators deploy it.
- No gateway node, no p2p (`standalone` mode): `skandha_frameTransactionStatus` goes `New → Submitted → OnChain`
  on this one node.
- No mainnet contract library (LINK/USDT/USDC/Permit2/Uniswap v4/Railgun/Tornado); replay it with the sidecar
  repo's `bun run predeploy run --all` against `PREDEPLOY_RPC_URL=http://localhost:8545` if a test needs it.
- The explorer web UI (`explorer.altmempool.wtf`) is not run; the `skandha_explorer_*` RPC methods are.

## Funding-key allocation for parallel agents and CI

Each workstream funds itself from **its own** key, so concurrent scripts never collide on nonces:

| Key | Owner |
|---|---|
| anvil #0 | contracts / account devnet tests (`contracts/devnet-tests/account`) |
| anvil #2 | contracts / PQ role-signer devnet tests (`contracts/devnet-tests/pq`) |
| anvil #5 | privacy / PoolPayer devnet tests |
| anvil #6 | PQ benchmark harness (`bench/`) |
| anvil #7 | extension e2e (Playwright) |
| anvil #9 | watcher / misc |
| #1 | registry deployer only (never reuse) |
| #3, #4 | `devnet/tools` smoke and probe |
| #8 | sidecar faucet |
| genesis key | top-ups of the above only |

Derive any per-test sub-accounts from your own key (send them funds). Never use another workstream's key.
