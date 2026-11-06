# QueueBit

**A browser wallet whose account is post-quantum, without waiting for a fork.** (QueueBit was formerly LEAKED, its
working name.)

QueueBit is a smart account, **LeanAccount**, and the browser extension that drives it. Every transaction is an
EIP-8141 frame transaction, and the account decides for itself which signatures count:

- An **owner key** that is post-quantum (leanVM leanSPHINCS, hash-based). A PQ signature is too large and expensive
  to check on chain for every transaction, so a **LeanPool** node verifies it off chain, batches it with others and
  posts one Merkle root; the account only checks that its transaction is in that root. No signature bytes go on chain,
  and the ERC-8421 alternative mempool admits the account without stake.
- **Session keys** for everyday use and for apps: each may call only the contracts it was given, within a per-payment
  and a daily ETH cap and per-token caps, until it expires, and can never change a key or a setting. A session key
  can be a key the extension holds or a browser wallet such as MetaMask (EIP-712 typed data that shows the calls).
- Passkeys (WebAuthn, checked with P256VERIFY), other ECDSA/P256 keys, weighted thresholds, `requirePQ` (every admin
  action needs a PQ signer) and **guardian recovery** (guardians reset the keys after a delay the owner can cancel).
- **Move to PQ**: an EOA (its tokens and ETH move into a new LeanAccount, or it keeps its address with EIP-7702), an
  upgradeable smart account (upgraded in place, same address) or a **Safe** (its owners sign one Safe transaction that
  moves everything) becomes a LeanAccount.

The account is ERC-8286 + ERC-7579 (modular: validators, executors, a hook), UUPS and ERC-7201-namespaced. Privacy
Pools withdrawals can pay their own gas through a paymaster contract.

> **Status: research prototype, unaudited, devnets only.** Read [Security status](#security-status) first.

## Architecture

```
 Browser extension (apps/extension)
 ┌──────────────────────────────────────────────┐
 │ seed → PQ owner key (leanSPHINCS, WASM)        │   dapps ⇄ EIP-1193 provider
 │      → session keys (secp256k1), setup key    │
 │ @queuebit/account: build, sign, migrate       │
 └──────┬──────────────────────────┬─────────────┘
        │ owner tx {raw, PQ sig}   │ session tx (signed entry)
        ▼                          │
 ┌───────────────────────┐         │
 │ LeanPool node          │         │
 │ verify, batch, post    │──root──►│ DepsRegistry (per-account ring of roots)
 │ root, fill witness     │         │
 └──────┬─────────────────┘         │
        └──────────────► ERC-8421 alt mempool (sidecar) ──► EIP-8141 chain
                                    │
 LeanAccount ─ verify ─► KeystoreValidator: PQ inclusion │ passkey │ ECDSA/P256 │ EIP-712 ─► roles, thresholds,
 (ERC-8286)               sessions (allowlist, per-tx caps), requirePQ
             ─ execute ─► SpendingLimitHook (daily caps, key expiry) ─► the calls
             GuardianRecovery (executor) · watcher (services/watcher): alerts on key, policy and recovery events
```

Components, transaction shapes, migration and the trust model: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository map

| Path | What |
|---|---|
| [`contracts/`](contracts/) | Foundry: `src/account` (LeanAccount, KeystoreValidator, SpendingLimitHook, GuardianRecovery, WebAuthn, factory), `src/leanpool` (DepsRegistry), PoolPayer, PQ verifiers; `devnet-tests/leanpool-account` (SDK scripts and live runs), `devnet-tests/privacy` |
| [`packages/account`](packages/account/) | The LeanAccount SDK: keys, sessions, tx building and signing, submission, migration rails, Safe adapter |
| [`packages/frames`](packages/frames/) | EIP-8141 frame-transaction codec and signature hash, per-network profiles |
| [`packages/lean-sphincs`](packages/lean-sphincs/) | leanVM leanSPHINCS, the owner key's scheme (Rust → committed, reproducible WASM) |
| [`services/leanpool-node`](services/leanpool-node/) | The LeanPool node: verifies, batches and delivers PQ-signed transactions; STARK audit CLI |
| [`packages/pq-signer`](packages/pq-signer/) | SPHINCS- C13 / leanSphincs-s signer and on-chain verifiers (benchmarks; PQ checked in the EVM) |
| [`packages/rpc`](packages/rpc/) | Transports for ethrex, the alt-mempool sidecar and the LeanPool node |
| [`packages/privacy`](packages/privacy/) | Privacy Pools v1 client, frame-paymaster broadcaster, note signer |
| [`packages/groth16`](packages/groth16/) | MIT Groth16 prover (arkworks → WASM) for the privacy circuits |
| [`packages/watcher-core`](packages/watcher-core/), [`services/watcher`](services/watcher/) | Alert rules for LeanAccount; the self-hosted alert service |
| [`apps/extension`](apps/extension/) | The MV3 browser extension (WXT + viem) |
| [`bench/`](bench/) | Post-quantum verifier benchmark |
| [`devnet/`](devnet/) | Local EIP-8141 devnet (ethrex + Lighthouse + sidecar), deploy scripts, the BUDGET-010 sidecar |
| [`upstream/`](upstream/) | Upstream contributions as patch series (BUDGET-010) |
| [`scripts/`](scripts/) | Release tooling (reproducible builds) and supply-chain checks (audit, SBOM) |
| [`docs/`](docs/) | [LeanAccount rebuild](docs/plan/70-leanaccount-rebuild.md), [architecture](docs/ARCHITECTURE.md), [threat model](docs/security/THREAT-MODEL.md), [backlog](docs/plan/BACKLOG.md), [implementation notes](docs/plan/IMPLEMENTATION-NOTES.md), [research](docs/research/) |

## Quickstart

Requirements: Node ≥ 22.12 (CI uses 26) and pnpm 10 (`corepack enable`), Foundry 1.3.5, Bun 1.3, Docker with
~4 GB RAM (the devnet), Python 3. Rust is needed only to rebuild the committed WASM.

```sh
git clone --recurse-submodules <this repo> && cd queuebit-wallet   # or: git submodule update --init --recursive
pnpm install --frozen-lockfile
pnpm build
(cd contracts && forge build)
```

**1. The local devnet** (chain 1337; ~7.5 minutes until frame transactions activate):

```sh
cd devnet && ./up.sh            # ethrex :8545, sidecar :14337; ./status.sh, ./down.sh, ./reset.sh
```

**2. Deploy the contracts** (CREATE2, idempotent; writes `devnet/deploy/addresses.local.json`): the LeanPool
registry, the LeanAccount stack, Safe v1.4.1 and the migration fixtures, test tokens.

```sh
cd devnet/deploy && bun install && bun run deploy
```

**3. Run a LeanPool node** (it posts roots, so its key needs devnet ETH; it bonds itself with `LEANPOOL_AUTO_BOND_WEI`):

```sh
pnpm --filter @queuebit/leanpool-node build
LEANPOOL_PRIVATE_KEY=0x… LEANPOOL_RPC_URL=http://localhost:8545 LEANPOOL_SIDECAR_URL=http://localhost:14337/rpc/ \
  LEANPOOL_REGISTRY=<DepsRegistry> LEANPOOL_KEYSTORE=<KeystoreValidator> LEANPOOL_AGGREGATE=1 \
  LEANPOOL_AUTO_BOND_WEI=10000000000000000 pnpm --filter @queuebit/leanpool-node start   # see its README
```

**4. Run the extension:**

```sh
pnpm --filter @queuebit/extension build:local   # then chrome://extensions → Load unpacked → apps/extension/.output/chrome-mv3
```

The devnet keys in [`devnet/README.md`](devnet/README.md) are public test keys: never use them elsewhere.

**5. Run the tests:**

```sh
pnpm typecheck && pnpm lint && pnpm test                     # every workspace package (vitest)
(cd contracts && forge test)                                 # FOUNDRY_PROFILE=ci for 10k fuzz runs
contracts/script/lint-verify.sh                              # VERIFY-frame admission lint
(cd contracts/devnet-tests/leanpool-account && bun install && bun run test)   # SDK vectors shared with forge
pnpm --filter @queuebit/extension e2e                          # Playwright with the built extension
LIVE_DEVNET=1 pnpm --filter @queuebit/watcher test             # watcher against the devnet
```

The live devnet runs (sessions with token caps and an EIP-712 key, the four migration paths, guardian recovery,
keystore rotation, passkeys) are scripts in
[`contracts/devnet-tests/leanpool-account`](contracts/devnet-tests/leanpool-account/), with their recorded
transactions in its `deployments/`.

CI: [`ci.yml`](.github/workflows/ci.yml) on every push (unit, lint, the extension e2e, contracts and the LeanAccount
devnet-tests' unit suite, WASM and release reproducibility), [`devnet.yml`](.github/workflows/devnet.yml) nightly (deploy
reproducibility, the extension e2e and the live tests against a fresh devnet),
[`supply-chain.yml`](.github/workflows/supply-chain.yml) (audit, SBOMs) and [`release.yml`](.github/workflows/release.yml).

## Security status

Honest summary; the details are in the [threat model](docs/security/THREAT-MODEL.md).

- **No external audit** of anything: contracts, the leanSPHINCS signer, the LeanPool node, the extension, the Groth16
  engine.
- **Devnets only.** EIP-8141, EIP-8288 and ERC-8421 are drafts; the bytecode is pinned to a devnet profile.
- **The owner key's approvals trust the LeanPool aggregator** the account names: the chain checks inclusion in the
  aggregator's root, not the PQ signature. A dishonest aggregator, or one whose ECDSA posting key is broken, could
  approve owner actions. Every batch's recursive STARK hash is on chain, so this is auditable after the fact, not
  prevented. A direct on-chain PQ path for admin actions is in the backlog.
- **Sessions bound what they can move,** not the fees they can burn: a session key (or an expired one until it is
  pruned) can spend the account's ETH on fees with transactions that revert.
- **EIP-7702 migration keeps the EOA's ECDSA key alive** (it can still sign and re-delegate) until key deactivation
  (EIP-7851) exists: PQ-ready, not PQ-safe.

Report vulnerabilities privately: [`SECURITY.md`](SECURITY.md). Release gates: [`docs/release/CHECKLIST.md`](docs/release/CHECKLIST.md).

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md): the git rules for a shared working tree (never stash, reset or clean it), commit
conventions, and the checks to run before pushing.

## Licenses

QueueBit is [MIT](LICENSE). Code copied or adapted from other projects (LeanAccount and LeanPool from
LeoFranklin015/Queue-bit, the hegota-support codec, the SPHINCS- verifiers and signer logic, the devnet compose files) is
listed with its origin and license in [`THIRD_PARTY.md`](THIRD_PARTY.md). Notes:

- Safe v1.4.1 (LGPL-3.0, a Foundry submodule) is compiled and deployed only on devnets as the migration fixture; it is
  not part of the account.
- The shipped WASM includes two permissive non-MIT/Apache crates, `subtle` (BSD-3-Clause) and `foldhash` (Zlib).
- snarkjs (GPL-3.0) is a test-only dev dependency (the cross-check oracle); it is never bundled. No `@kohaku-eth/*`
  package is a dependency (their licenses are unclear).
- **Open legal question:** the Privacy Pools withdrawal circuit artifact (`withdraw.wasm`) is circom compiler output,
  and circom is GPL-3.0. Whether that reaches the artifact is unresolved; it is a release gate.
- Foundry submodules (`contracts/lib/`) and npm / crates dependencies ship their own licenses; the
  [`supply-chain`](.github/workflows/supply-chain.yml) workflow publishes CycloneDX SBOMs of what we ship.
