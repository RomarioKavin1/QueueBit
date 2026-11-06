# Architecture

How the pieces of QueueBit fit together and how data moves between them. The binding design is
[`plan/00-v4-design-decisions.md`](plan/00-v4-design-decisions.md); the build specs are the four section files in
[`plan/sections/`](plan/sections/); what the code actually does, with measurements, is
[`plan/IMPLEMENTATION-NOTES.md`](plan/IMPLEMENTATION-NOTES.md). What each key can and cannot do is
[`security/THREAT-MODEL.md`](security/THREAT-MODEL.md). If this page disagrees with the code, the code wins.

## 1. Components

```
 ┌─────────────────────────── Browser (Chromium MV3): apps/extension ───────────────────────────┐
 │ inpage provider (EIP-1193 + EIP-6963) ⇄ content script ⇄ service worker                      │
 │ service worker: keyring (hot key, fee-tank key), router, FrameEngine (@queuebit/frames),       │
 │   4337 engine (viem account-abstraction), policy pre-checks, typed-data classifier            │
 │ app.html (full tab): onboarding, Vault QR display + camera scan                              │
 │ offscreen.html: Anon-RPC harness, the Privacy Pools prover (@queuebit/groth16 WASM)            │
 └──────────┬─────────────────────────────────┬────────────────────────────┬────────────────────┘
            │ public mempool (ethrex)         │ ERC-8421 alt mempool       │ ERC-4337 bundler
            │ hot txs, Vault Path B           │ (sidecar) Path A, PoolPayer│ (pre-Hegotá chains)
 ┌──────────▼─────────────────────────────────▼──────────┐ ┌──────────────▼─────────────────────┐
 │ Frame-native (EIP-8141, Hegotá): contracts/src         │ │ ERC-4337 v0.8 + ERC-7579 modules   │
 │  QueueBitAccount (UUPS proxy → QueueBitAccountImpl,        │ │  on a host account (MSA, Safe7579, │
 │    QueueBitAccountRoles): hot path, RollingCap, policy,  │ │  Kernel):                          │
 │    timelock, freeze, scoped ERC-1271                   │ │  QueueBitHotValidator (type 1)       │
 │  PQRoleSigner clones (VaultSigner, RecoverySigner)     │ │  QueueBitPolicyHook (type 4)         │
 │    via RoleSignerFactory, C13Verifier                  │ │  QueueBitRoleExecutor (type 2)       │
 │  GuardianSigner (freeze only) · PoolPayer (privacy)    │ │  C13Verifier                       │
 └───────────────────────────────▲────────────────────────┘ └────────────────────────────────────┘
                                 │ ur:queuebit-sign-request / ur:queuebit-signature (BC-UR, animated QR)
 ┌───────────────────────────────┴─────────── Vault companion (separate device): apps/companion ┐
 │ offline PWA (CSP connect-src 'none'); @queuebit/pq-signer (Rust → WASM, SPHINCS- C13);          │
 │ decodes and clear-signs every request itself; holds the Vault PQ key and its payer key;       │
 │ Recovery is a separate seed (offline ceremony)                                               │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
   services/watcher (self-hosted alerts) and the extension's light mode read the chain, never sign.
```

| Package | Role |
|---|---|
| `contracts/` | Foundry. Account, role signers, guardian, factories, 7579 modules, PQ verifier adapters (vendored SPHINCS- verifiers), PoolPayer. `test/frame/` simulates EIP-8141 frames (`FrameSim`); `devnet-tests/` run the real stack on the devnet or anvil. |
| `packages/frames` | Profile-driven EIP-8141 codec and signature hash, pinned vectors per network profile. Shared by the extension and the companion. |
| `packages/pq-signer` | SPHINCS- C13 (default) and leanSphincs-s (experimental) in Rust, compiled to a committed, reproducible WASM; TS API `keygen` / `sign` / `verify`. |
| `packages/ur` | The BC-UR types of the QR protocol (strict deterministic CBOR). |
| `packages/rpc` | JSON-RPC transports for ethrex, the sidecar and bundlers; rejection-reason mapping. |
| `packages/privacy` | Privacy Pools v1 client (sync, notes, deposit, withdraw), host adapters, the frame-paymaster broadcaster, the Vault envelope signer over QR. |
| `packages/groth16` | MIT Groth16 (BN254) prover for circom circuits, arkworks → committed WASM; replaces GPL snarkjs at runtime. |
| `packages/watcher-core` | Pure TS alert rules over account events and receipts (used by the service and the extension's light mode). |
| `services/watcher` | Node service: polls a node, applies `watcher-core`, delivers alerts (SSE, HMAC webhook, ntfy). |
| `apps/extension` | WXT + viem MV3 wallet. |
| `apps/companion` | The vault device PWA. |
| `bench/` | PQ verifier benchmark harness and published table. |
| `devnet/` | Local EIP-8141 devnet (ethrex + Lighthouse + sidecar), deploy scripts, the BUDGET-010 patched sidecar, the local 4337 chain. |
| `upstream/` | Our upstream contributions as patch series (the BUDGET-010 sidecar PR). |

## 2. Keys and roles

The hot key and the fee-tank key live in the extension; the Vault key (post-quantum) and its secp256k1 payer key live
on the companion; the Recovery key is a separate offline seed; Guardians are third-party secp256k1 keys that can only
pause. The account enforces the hot key's bound on chain (rolling 24 h USD cap, per-transaction max, fee bound,
priced token allowlist, Vault-approved targets); loosening anything is timelocked; Recovery can cancel any queued Vault
action and rotate the Vault in 7 days. Full table: THREAT-MODEL §2.

The role signers are **separate senders**: each `PQRoleSigner` clone is its own contract account with its own nonce,
stake and mempool reputation, and the only address the account accepts `vault*` / `recovery*` calls from. A throttled
or banned role signer never affects the account's hot lane.

## 3. Frame transaction paths (EIP-8141)

Every frame tx is built by the FrameEngine, **simulated first** (`ethrex_simulateFrameTransaction`), and sent only if
the simulation is canonical-mempool valid, frame-0 gas is within budget and the maximum cost is within the account's
fee bound. A tx that fails simulation is never offered to the mempool.

| Flow | Frames | Signatures | Mempool |
|---|---|---|---|
| **Hot payment** | `[VERIFY(account, verifyFrame()), pay(fee-tank EOA), SENDER(account, hotExecute(...))]` | hot key (secp256k1), tank key | public (`eth_sendRawTransaction`) |
| **Vault, Path B** (default) | `[VERIFY(roleSigner, verifyFrame(0)), SENDER(roleSigner, executePQ(0, account, roleCalldata))]` | `[0]` PQ witness (ARBITRARY, 3,688 B for C13), `[1]` the Vault payer key (secp256k1) | public |
| **Vault, Path A** | `[VERIFY(roleSigner, verifyFrame(0)) with the PQ check inside, SENDER(roleSigner, relay(account, roleCalldata))]` | `[0]` PQ witness only | ERC-8421 sidecar, role signer staked |
| **Recovery** | as the Vault paths, through the RecoverySigner, with the Recovery payer key on Path B | | public / alt |
| **Guardian freeze** | `GuardianSigner` → `account.guardianFreeze` | guardian key | public |

**Path B** keeps VERIFY cheap: it checks only that entry 1 was signed by the pinned payer key over the transaction's
signature hash and that the single SENDER frame is `executePQ` to itself. The PQ signature (over the same signature
hash) is verified in execution. A forged PQ witness therefore gets mined with a reverted SENDER frame and changes
nothing; it costs the payer the fee.

**Path A** verifies the PQ signature inside VERIFY, so the tx is valid or invalid before inclusion, but C13's ~105k
gas verification does not fit the flat 100k `MAX_VERIFY_GAS` of today's mempools. It needs a staked entity and a
sidecar implementing ERC-8421 BUDGET-010 per-entity budgets: `upstream/skandha-budget-010` is our patch, run as
`devnet/patched-sidecar` (`:14340`). leanSphincs-s (46,899 gas VERIFY) is the documented option for Path A under the
stock 100k budget; it is experimental and has no formal proof.

VERIFY-reachable code obeys the devnet's admission rules (no banned opcodes, no logs, no transient storage, no
writes, no storage outside the sender): `contracts/script/lint-verify.sh` checks the bytecode, the source and the
opcodes executed in every VERIFY branch; gate G1 checks the traces on the devnet.

## 4. The ERC-4337 / ERC-7579 backend (before Hegotá)

On chains without EIP-8141 the same policy runs as modules on a host account: `QueueBitHotValidator` validates hot
userOps, `QueueBitPolicyHook` enforces the cap, targets, freeze and the fee bound in pre/post checks, and
`QueueBitRoleExecutor` takes Vault and Recovery calls authenticated by a PQ signature over an EIP-712 digest. Everyday
userOps go to a bundler (EntryPoint v0.8); Vault actions are `QueueBitRoleExecutor` calls relayed as plain transactions
by the fee tank (the PQ check runs in execution). The QR request is `ur:queuebit-sign-request` tx-type 3: the executor
calldata with an empty signature, from which the phone recomputes the digest. The account address differs from the
frame-native one (each host derives its own). Host compatibility and the review fixes: THREAT-MODEL §6. Locally:
`devnet/deploy` `up-4337.ts` (anvil + EntryPoint v0.8 + the modules + a minimal bundler).

## 5. The companion QR protocol

The browser and the phone share no network; everything crosses as animated BC-UR QR codes (strict, canonical CBOR;
unknown keys, non-canonical bytes and control/bidi characters are rejected). Types (`packages/ur`):

| UR | Direction | Contents |
|---|---|---|
| `ur:queuebit-pq-key` | phone → browser | pairing: scheme id, public key, role, payer address |
| `ur:queuebit-sign-request` | browser → phone | request id, chain, tx type (frame tx · PP note envelope · 4337 executor call), the exact bytes to sign, advisory intent (key 11) and policy (key 12) |
| `ur:queuebit-signature` | phone → browser | request id, PQ witness, payer signature (Path B) or typed signature |
| `ur:queuebit-recovery-challenge` / `ur:queuebit-recovery-test` | browser → phone → browser | the Recovery key test, bound to a browser-chosen request id |

The phone never trusts the browser's description: it decodes the bytes itself, recomputes the signature hash, renders
the calls from its own registry (`apps/companion/src/registry`, ABI sections generated from `contracts/out`), and
refuses unknown steps unless the user explicitly overrides. The advisory intent is compared with the decoded calls and
a mismatch demotes "Approve" to "Approve anyway". The signing worker decodes the same bytes again and refuses unless
its digest equals the displayed one. The browser checks the returned witness against the on-chain public key before
broadcasting. The PWA has no network access at all (CSP `connect-src 'none'`); its service worker installs an update
only if every file matches the SHA-256 table in `sw.js` (the same digests the release tooling publishes:
`scripts/release/README.md`).

## 6. Privacy (Privacy Pools v1)

`@queuebit/privacy` syncs a Privacy Pools v1 pool fail-closed (every event's root recomputed and checked against the
on-chain root), keeps notes in encrypted storage, and derives note secrets from Vault signatures over an EIP-712
envelope (`ur:queuebit-sign-request` tx-type 2), so notes are recoverable from the Vault. Withdrawals have two modes:
the 0xbow relayer, or the **frame paymaster**: a fresh default-code EOA sender and PoolPayer, in the shape
`[only_verify(fresh EOA), pay(PoolPayer.verify), DEFAULT settle, DEFAULT refund()]`. PoolPayer checks the proof and the
shape read-only in `pay`, fronts the gas, is repaid from the withdrawal at cost (no margin), and refunds the rest.
Proofs come from `@queuebit/groth16` in the offscreen document. Reads go through Anon-RPC with a per-account isolation key
(a fresh one per withdrawal). Engineering rules from plan §40.7: no operated pool, no fees, PoolPayer handed off.

## 7. Watcher

`services/watcher` (and the extension's light mode, via `@queuebit/watcher-core`) follows the account's events and the
receipts of its frame transactions, `confirmations` blocks deep, with reorg handling. Some outcomes leave no log (an
over-cap hot batch reverts its SENDER frame), so the watcher also reads the blocks' transactions whose sender is a
watched account. Alerts (large payment, queued loosening, Guardian pause, Vault rotation, repeated blocked payments)
are delivered over an authenticated SSE stream, an HMAC-signed webhook or ntfy (title and body only).

## 8. Networks

| Network | Backend | Status |
|---|---|---|
| Local devnet, chain 1337 (`devnet/`) | frame-native | all flows, gate G1 |
| Public alt-mempool devnet (chain 1337) | frame-native | same images; no `EXPIRY_VERIFIER` code |
| Hegotá devnet (3151908) | frame-native | not yet wired |
| anvil 31337 (`devnet/deploy/up-4337.ts`) | 4337 + 7579 | all flows |
| Sepolia, mainnet | 4337 + 7579 | disabled until audited, recorded module addresses (`docs/release/CHECKLIST.md` §6) |
| Mainnet, frame-native | | after Hegotá activates on mainnet |
