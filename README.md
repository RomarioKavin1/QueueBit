# QueueBit

**A browser wallet whose everyday key is safe to leak.** (QueueBit was formerly LEAKED, its working name.)

Browser wallets keep their key in the browser, and browsers get compromised: malicious extensions, phishing, stolen
laptops, leaked seed phrases. QueueBit assumes that will happen and limits the damage on chain:

- The **everyday key** in the browser extension can only spend within limits the account contract enforces: a daily
  USD cap, a per-payment maximum, a fee bound, and the tokens and apps you allowed. A thief with that key gets at most
  what is left of today's allowance, and cannot raise it.
- Everything else (larger payments, changing the limits, replacing the everyday key) needs the **Vault**: a
  post-quantum (hash-based, SPHINCS- C13) key on a separate offline device, the companion app, which talks to the
  browser only through QR codes. Anything that loosens the rules waits behind a timelock.
- A separate **Recovery** key, kept offline, can cancel any pending Vault action and replace a lost or stolen Vault.
  **Guardians** (a friend, a second device) can only pause the everyday key.

Optionally, the everyday key can be **quantum-safe**: a post-quantum (leanSPHINCS) key signs everyday payments, a
**LeanPool** node verifies and batches the signatures off-chain, and the account only checks a Merkle inclusion
proof, so no PQ signature goes on-chain and the alt mempool admits it without stake (ported from LeanPool; same daily
limit; trust: [THREAT-MODEL §8.1](docs/security/THREAT-MODEL.md)).

It is built on native account abstraction (EIP-8141 frame transactions, expected in the Hegotá fork), with an
ERC-4337 / ERC-7579 backend for today's chains, and it routes transactions between the public mempool and ERC-8421
alternative mempools. Privacy Pools withdrawals can pay their own gas through a paymaster contract.

> **Status: research prototype, unaudited, devnets only.** Read [Security status](#security-status) first.

## Architecture

```
 Browser extension (apps/extension)                        Vault companion (apps/companion)
 ┌──────────────────────────────────────┐   animated QR    ┌─────────────────────────────────┐
 │ everyday key + fee-tank key          │ ───────────────► │ offline PWA, no network at all  │
 │ FrameEngine / 4337 engine, policy    │   sign request   │ post-quantum Vault key (C13)    │
 │ pre-checks, Vault QR flow, privacy   │ ◄─────────────── │ decodes and shows every call    │
 └──────┬──────────────┬────────────────┘    signature     └─────────────────────────────────┘
        │ public       │ ERC-8421 alt mempool     │ ERC-4337 bundler
        ▼              ▼                          ▼
 ┌─────────────────────────────────────┐   ┌──────────────────────────────────────┐
 │ EIP-8141 (Hegotá) contracts          │   │ today's chains: 4337 v0.8 + 7579      │
 │ QueueBitAccount: caps, allowlists,     │   │ QueueBitHotValidator · QueueBitPolicyHook │
 │ timelock, freeze, scoped ERC-1271    │   │ QueueBitRoleExecutor on a host account  │
 │ VaultSigner / RecoverySigner (PQ),   │   └──────────────────────────────────────┘
 │ GuardianSigner, PoolPayer            │      watcher (services/watcher): alerts
 └─────────────────────────────────────┘
```

Components, transaction shapes (Path A / Path B), the QR protocol, privacy and the watcher:
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository map

| Path | What |
|---|---|
| [`contracts/`](contracts/) | Foundry: the frame-native account, PQ role signers, guardian, factories, ERC-7579 modules, PoolPayer; `devnet-tests/` (gate G1, the 4337 anvil e2e, PQ and privacy runs) |
| [`packages/frames`](packages/frames/) | EIP-8141 frame-transaction codec and signature hash, per-network profiles |
| [`packages/pq-signer`](packages/pq-signer/) | SPHINCS- C13 / leanSphincs-s signer (Rust → committed, reproducible WASM) |
| [`packages/lean-sphincs`](packages/lean-sphincs/) | leanVM leanSPHINCS for the quantum-safe everyday key (Rust → committed, reproducible WASM) |
| [`services/leanpool-node`](services/leanpool-node/) | The LeanPool node: verifies, batches and delivers quantum-safe everyday payments; STARK audit CLI |
| [`packages/ur`](packages/ur/) | BC-UR types for the browser ⇄ companion QR protocol |
| [`packages/rpc`](packages/rpc/) | Transports for ethrex, the alt-mempool sidecar and bundlers |
| [`packages/privacy`](packages/privacy/) | Privacy Pools v1 client, frame-paymaster broadcaster, Vault envelope signer |
| [`packages/groth16`](packages/groth16/) | MIT Groth16 prover (arkworks → WASM) for the privacy circuits |
| [`packages/watcher-core`](packages/watcher-core/), [`services/watcher`](services/watcher/) | Alert rules; the self-hosted alert service |
| [`apps/extension`](apps/extension/) | The MV3 browser extension (WXT + viem) |
| [`apps/companion`](apps/companion/) | The Vault companion PWA |
| [`bench/`](bench/) | Post-quantum verifier benchmark |
| [`devnet/`](devnet/) | Local EIP-8141 devnet (ethrex + Lighthouse + sidecar), deploy scripts, the BUDGET-010 sidecar, the local 4337 chain |
| [`upstream/`](upstream/) | Upstream contributions as patch series (BUDGET-010) |
| [`scripts/`](scripts/) | Release tooling (reproducible builds) and supply-chain checks (audit, SBOM) |
| [`docs/`](docs/) | [Plan](docs/plan/QueueBit-implementation-plan.md), [design decisions](docs/plan/00-v4-design-decisions.md), [implementation notes](docs/plan/IMPLEMENTATION-NOTES.md), [backlog](docs/plan/BACKLOG.md), [threat model](docs/security/THREAT-MODEL.md), [release checklist](docs/release/CHECKLIST.md), [research](docs/research/) |

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
./patched-sidecar/up-patched.sh # optional: the BUDGET-010 sidecar on :14340 (Path A, PoolPayer)
```

**2. Deploy the contracts** (CREATE2, idempotent; writes `devnet/deploy/addresses.local.json`):

```sh
cd devnet/deploy && bun install && bun run deploy
bun run up:4337                 # optional: anvil :8546 + EntryPoint v0.8 + modules + bundler :4337
```

**3. Run the extension and the companion locally:**

```sh
pnpm --filter @queuebit/extension build:local   # then chrome://extensions → Load unpacked → apps/extension/.output/chrome-mv3
pnpm --filter @queuebit/companion dev           # or: build + preview on http://localhost:4317 (the production CSP)
```

Open the companion on a phone (or a second browser window), create a Vault, and pair it from the extension's
onboarding. The devnet keys in [`devnet/README.md`](devnet/README.md) are public test keys: never use them elsewhere.

**4. Run the tests:**

```sh
pnpm typecheck && pnpm lint && pnpm test                     # every workspace package (vitest)
(cd contracts && forge test)                                 # FOUNDRY_PROFILE=ci for 10k fuzz runs
contracts/script/lint-verify.sh                              # VERIFY-frame admission lint
pnpm --filter @queuebit/companion e2e                          # Playwright on the built PWA
pnpm --filter @queuebit/extension e2e                          # Playwright with the built extension (4337 + devnet flows)
(cd contracts/devnet-tests/4337 && bun install && bun run e2e)   # 4337 backend on anvil
# with the devnet up and deployed (and the patched sidecar for G1 (g)):
(cd contracts/devnet-tests/g1 && bun install && bun run test)    # gate G1
LIVE_DEVNET=1 pnpm --filter @queuebit/watcher test             # watcher against the devnet
```

CI runs all of this: [`ci.yml`](.github/workflows/ci.yml) on every push (unit, lint, both e2e suites, contracts, the
4337 e2e, WASM and release reproducibility), [`devnet.yml`](.github/workflows/devnet.yml) nightly (G1, the extension
e2e and the live tests against a fresh devnet), [`supply-chain.yml`](.github/workflows/supply-chain.yml) (audit,
SBOMs) and [`release.yml`](.github/workflows/release.yml) (reproducible release artifacts).

## Security status

Honest summary; the details are in the [threat model](docs/security/THREAT-MODEL.md).

- **No external audit** of anything: contracts, the post-quantum signer and verifiers, the extension, the companion,
  the Groth16 engine. Internal reviews and their regression tests are recorded in the implementation notes.
- **Devnets and anvil only.** EIP-8141 and ERC-8421 are drafts and the bytecode is pinned to a devnet profile; the
  frame-native backend cannot reach mainnet before Hegotá. The 4337 backend is disabled on Sepolia and mainnet until
  its module addresses are audited and recorded.
- **What the design bounds:** a leaked everyday key (and the fee-tank key next to it) can spend the rest of the daily
  allowance to allowed destinations and burn fee-tank funds; it cannot change limits, allowlists or keys.
- **What it does not:** a compromised Recovery key can take over the Vault after an uncancellable 7 days (by design);
  token prices are static and Vault-set; some known gaps are open (THREAT-MODEL §11, [`BACKLOG.md`](docs/plan/BACKLOG.md)).
- **Post-quantum assumptions:** SPHINCS- C13 is a hash-based scheme with a Lean-proof-pinned parameter set but a young
  implementation; leanSphincs-s is experimental with no formal proof.
- **Path A** (PQ verification inside VERIFY) needs the BUDGET-010 change to ERC-8421 sidecars, which is not upstream
  yet; Path B works with today's mempools.

Report vulnerabilities privately: [`SECURITY.md`](SECURITY.md). Release gates: [`docs/release/CHECKLIST.md`](docs/release/CHECKLIST.md).

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md): the git rules for a shared working tree (never stash, reset or clean it), commit
conventions, and the checks to run before pushing.

## Licenses

QueueBit is [MIT](LICENSE). Code copied or adapted from other projects (the hegota-support codec, the SPHINCS- verifiers
and signer logic, the devnet compose files) is listed with its origin and license in [`THIRD_PARTY.md`](THIRD_PARTY.md).
Notes:

- The shipped WASM includes two permissive non-MIT/Apache crates, `subtle` (BSD-3-Clause) and `foldhash` (Zlib).
- snarkjs (GPL-3.0) is a test-only dev dependency (the cross-check oracle); it is never bundled. No `@kohaku-eth/*`
  package is a dependency (their licenses are unclear).
- **Open legal question:** the Privacy Pools withdrawal circuit artifact (`withdraw.wasm`) is circom compiler output,
  and circom is GPL-3.0. Whether that reaches the artifact is unresolved; it is a release gate.
- Foundry submodules (`contracts/lib/`) and npm / crates dependencies ship their own licenses; the
  [`supply-chain`](.github/workflows/supply-chain.yml) workflow publishes CycloneDX SBOMs of what we ship.
