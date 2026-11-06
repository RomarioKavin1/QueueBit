# QueueBit: implementation plan (master)

**Date:** 2026-11-06. **Product:** a browser-extension wallet (Chromium MV3). It has a capped hot key that is safe to leak, stateless post-quantum vault and recovery keys on a separate device, and routing between the public and ERC-8421 alternative mempools.
**Inputs:**
- [`00-v4-design-decisions.md`](00-v4-design-decisions.md): the binding design;
- [`../research/01-QueueBit-critical-analysis.md`](../research/01-QueueBit-critical-analysis.md): why the design looks like this.

This document is the **index, integration layer and schedule**. The build specs are the four section files. Every implementation step in them carries a source tag, and engineers build from the sections:

| § | File | Scope | Size | Source tags after verification |
|---|---|---|---|---|
| 10 | [`sections/10-contracts.md`](sections/10-contracts.md) | Account (frame-native + 4337/7579), role signers, VERIFY logic, invariants, tests | ~650 lines | 155 VERIFIED · 8 UNVERIFIED |
| 20 | [`sections/20-pq-crypto-vault.md`](sections/20-pq-crypto-vault.md) | PQ scheme, on-chain verifier, signer library, vault companion, recovery, benchmark | ~500 lines | 81 · 12 |
| 30 | [`sections/30-extension.md`](sections/30-extension.md) | MV3 architecture, provider, frame engine, routing, vault flow, UX, tests | ~600 lines | 69 · 13 |
| 40 | [`sections/40-privacy-infra.md`](sections/40-privacy-infra.md) | Privacy Pools via Kohaku, PoolPayer, alt-mempool operations, BUDGET-010 PR, watcher, Anon-RPC, legal rules | ~650 lines | 51 · 13 |

## How this was verified

- **Writing:** each section was written by an independent agent, which had to cite a primary source for every implementation-critical fact: a spec line, a repo `file:line`, or a read-only RPC probe.
- **Checking:** a second independent pass re-opened the sources and corrected errors in place.

| Section | Claims checked | Confirmed | Corrected | Downgraded to [UNVERIFIED] |
|---|---|---|---|---|
| 10 + 20 | ~285 | 252 | 27 | 6 |
| 30 | 96 | 71 | 19 | 6 |
| 40 | 104 | 78 | 21 | 5 (+3 new risks) |

Each section ends with a **Verification log** (every change, old → new, with its source). **Anything still tagged [UNVERIFIED] has an explicit verification step. Do it before building on that item.**

---

## 1. What verification changed in the design

These override `00-v4-design-decisions.md` where they conflict:

| # | Design said | Reality (source in the section) | Resolution |
|---|---|---|---|
| 1 | Default scheme "SPHINCS- C13 (3.7 KB, 127k)" | The ethresear.ch "C13" is now named **C7**. The repo's current **C13** is h=22, d=2, a=19, k=7, w=8: **3,688 B sig**, 105k pure / 114.3k in-frame verify, **257,578 gas for a full 8141 tx** (measured on devnet), 2²² sig budget, Lean-proof-pinned (§20.1) | Default = current C13 from `nconsigny/SPHINCS-`. **It is not part of Kohaku's SDK** (Kohaku's pq-account is ZKNOX Falcon/ML-DSA) |
| 2 | SLH-DSA as the "standards fallback" | No Solidity verifier exists for any final FIPS 205 set (§20.1) | Time-boxed 128s port in the benchmark, not a product path |
| 3 | PORST r=256 optional | ~50M-keccak keygen, ~943k gas/tx (§20.1) | Benchmark only; the companion doesn't ship a PORST signer |
| 4 | Path A when the budget allows | C13 doesn't fit the live flat 100k (`validationPrefix.ts:10`). **leanSphincs-s fits:** 46,899 gas VERIFY frame, 288k tx, 4,164 B sig, no formal proof (§20.1) | Path B by default. Path A on a staked BUDGET-010 sidecar; **leanSphincs-s as a documented option** if Path A must ship under 100k |
| 5 | "Auto-select A/B from the mempool's advertised budget" | No sidecar advertises budgets (`skandha_config` probed) (§30.5) | A static table plus runtime `eth_estimateFrameTransactionGas`; the BUDGET-010 PR also adds `budgets` to `skandha_config` |
| 6 | Gas tank contract | A contract payer reading its own storage in a `pay` frame is inadmissible in the public mempool (§10.0.3) | **Gas tank = default-code EOA payer.** Hot tx shape `[only_verify(account, verifyFrame()), pay(tank EOA), SENDER(hotExecute)]`; optional `selfPay` |
| 7 | Freeze auto-expiry / timelocks checked in validation | `TIMESTAMP` is banned in VERIFY (§10.0.5) | VERIFY reads a `frozen` boolean; expiry via a permissionless `clearExpiredFreeze()` |
| 8 | ERC-8286 validator works anywhere | On third-party 7579 accounts, the validator's own policy storage is "outside `tx.sender`", so it's **alt-mempool-only** (§10.0.6) | Frame-native `QueueBitAccount` is unaffected. The 8286 route ships later and is gated on the ERC's TBDs |
| 9 | VERIFY entry via empty calldata | Solidity routes empty calldata to `receive()`, so VERIFY would never run (verification fix) | **Explicit `verifyFrame()` selector** on the account and the role signers |
| 10 | Role-signer admin `onlySelf` | Unreachable through the walker (verification fix) | Admin only via `executePQ`/`relay` with `target == this` |
| 11 | PoolPayer `[only_verify, pay]` withdraws in validation | VERIFY is static; `pre_verify` can't write pool slots (STORAGE-033) (§40.2.1) | **Verify-then-front:** proof + read-only checks in `pay`; `withdraw` (processooor = PoolPayer) in the body; `refund()` as the last frame |
| 12 | (new) PoolPayer pays for failed withdrawals | `APPROVE_PAYMENT` collects `max_cost` before the body runs; a reverted body is still included (EIP-8141 L777–782, L452, L1304) | 3 mandatory rules: non-reverting payout (pull fallback); `verify` requires `refund()` to be the last frame; state gas for a fresh recipient. ETH pool only in v1. **v1 sender = a fresh default-code EOA**, not the QueueBit account |
| 13 | "~20 invalidations/hour bans PoolPayer" | Throttle at **110** / ban at **510** excess never-included txs from a clean slate. Sustained-ban threshold I > 9T + 20.8 per hour. **Attacker cost ≈ 1.9 ETH to throttle, ≈ 8.9 ETH to ban** at 30 gwei (§40.2.8) | Documented. Mitigation: keyed nonces, prompt inclusion, a monitor |
| 14 | Fork the Kohaku/Ambire extension | Ambire is GPL-3.0, ~238k LOC, RN-web/webpack/ethers 6, userOp-shaped (§30.1) | **Build from scratch:** WXT + viem, MIT. Reuse Kohaku packages subject to item 15 |
| 15 | "Kohaku SDK is MIT" | **The repo has no LICENSE file and GitHub detects no license** (re-checked 2026-11-06). `@kohaku-eth/privacy-pools` declares MIT in `package.json`; `@kohaku-eth/plugins` declares none (§40 verification log) | **Gate:** get written license confirmation from the maintainers before shipping |
| 16 | Reuse the privacy-paymaster | `Robert-MacWha/privacy-paymaster` is `UNLICENSED` | Write PoolPayer from scratch; copy no code |
| 17 | QR scanning in an offscreen document | Offscreen documents have no visible surface (§30.6) | Camera/QR in a full-tab `app.html`. One shared `offscreen.html` hosts Anon-RPC + the prover |
| 18 | One frame codec | The latest EIP-8141 text differs from both devnets (2-item fees, sig-length commitment) (§30.4) | `@queuebit/frames`: a profile-driven codec with pinned vectors per network; viem PR #5165 still open |
| 19 | Same account address on both backends | Third-party 7579 hosts derive their own addresses (§30.8) | Different addresses per backend. The UI shows both; no claim of address parity |
| 20 | Stake 0.01 ETH | The draft is **~USD 1,000 per staked entity**, 1-day unstake | Budget stake per role signer and for PoolPayer |

---

## 2. Architecture

```
 ┌────────────────────────── Browser (Chromium MV3) ──────────────────────────┐
 │ inpage provider (EIP-1193 + 6963, world:MAIN) ⇄ content script ⇄ SW        │
 │ Service worker: keyring (hot key, tank key m/44'/60'/1'/0/k), router,     │
 │   FrameEngine (@queuebit/frames), 4337 engine (viem AA + permissionless),   │
 │   policy/typed-data classifier, watcher-light (alarms)                    │
 │ app.html (full tab): onboarding, vault QR display + camera scan           │
 │ offscreen.html: Anon-RPC harness + Privacy Pools prover (WASM)            │
 └──────────────┬──────────────────────────────┬─────────────────────────────┘
       public mempool (hot, path B)      ERC-8421 alt mempool (path A, PoolPayer)
                │                              │  (own staked sidecar + BUDGET-010 PR)
 ┌──────────────▼──────────────────────────────▼─────────────────────────────┐
 │ Frame-native (Hegotá devnets → mainnet after Hegotá)                       │
 │  QueueBitAccount (UUPS)  ◄─ msg.sender ─  VaultSigner / RecoverySigner      │
 │   hotExecute, RollingCap, allowlists,     (PQRoleSigner: own sender,      │
 │   scoped 1271 (7739 + registerHash),       own nonce, own stake)          │
 │   session policies, timelock, bunker,     GuardianSigner (freeze only)    │
 │   freeze, upgrade/migrate                 PoolPayer (privacy paymaster)   │
 │ Pre-Hegotá (mainnet/Sepolia now): ERC-4337 + 7579 modules                  │
 │  QueueBitHotValidator(1) · QueueBitPolicyHook(4) · QueueBitRoleExecutor(2)       │
 │  later: QueueBitFrameValidator (ERC-8286, type 11, TBD)                      │
 └────────────────────────────────────────────────────────────────────────────┘
        ▲ ur:queuebit-sign-request / ur:queuebit-signature (BC-UR, animated QR)
 ┌──────┴───────────── Vault companion (separate device) ─────────────────────┐
 │ PWA → native shell (Expo + uniffi). @queuebit/pq-signer (Rust→WASM, C13),    │
 │ recomputes sig hash itself, clear-signs decoded frames (ERC-7730 style),   │
 │ holds vault PQ key + path-B payer ECDSA key; recovery = offline ceremony   │
 └────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Repository layout (monorepo, pnpm)

| Package | Owner § | Contents |
|---|---|---|
| `contracts/` | 10 | Foundry. `QueueBitAccountImpl` + libs, `PQRoleSigner`, `GuardianSigner`, `AccountFactory`, 7579 modules, `QueueBitFrameValidator`, `C13Adapter` + vendored verifier, `PoolPayer` (40), `FrameSim` + Hegota mocks |
| `packages/frames` (`@queuebit/frames`) | 30 | Profile-driven 8141 codec, sig-hash, vectors (shared with the companion; pinned by hash) |
| `packages/pq-signer` (`@queuebit/pq-signer`) | 20 | Rust core → WASM + TS: `keygen`, `sign(secret, digest32) → 3,688 B`, `verify`, `SIG_LENGTH`, `SCHEME_ID`; KAT sets A/B/C |
| `packages/ur` | 20/30 | BC-UR types `queuebit-sign-request` (keys incl. 10 = profile-id, 11 = advisory intent, tx-type 2 = PP envelope), `queuebit-signature` |
| `packages/privacy` (`@queuebit/privacy`) | 40 | Kohaku host adapters, the `frame-paymaster` broadcaster, the vault `EnvelopeSigner` over QR |
| `apps/extension` | 30 | WXT + viem extension |
| `apps/companion` | 20 | Vault PWA, later the native shell |
| `services/watcher` | 40 | Self-hosted alerts (an in-extension light mode also exists) |
| `bench/` | 20 | PQ benchmark harness + published table |
| `upstream/` | 40 | Sidecar BUDGET-010 PR branch, write-ups (separate-sender pattern, PoolPayer, mass invalidation, epoch budget) |

---

## 4. Canonical cross-section interfaces (reconciled by verification; sections now agree)

```solidity
interface IPQVerifier {
  function schemeId() external pure returns (bytes32);
  function sigLength() external pure returns (uint256);          // 3688 for C13; 0 = variable
  function verifyGasEstimate() external pure returns (uint256);
  function verify(bytes32 pk, bytes32 digest, bytes calldata sig) external view returns (bool); // never reverts; pk = pkSeed‖pkRoot
}
// PQRoleSigner (instances VaultSigner, RecoverySigner); pk, verifier, sigLength immutable (rotation = new instance)
function verifyFrame(uint256 sigIndex) external payable;                              // VERIFY frame data
function executePQ(uint256 sigIndex, address target, bytes calldata data) external;   // Path B
function relay(address target, bytes calldata data) external;                         // Path A
// self-admin only via executePQ/relay with target == this:
//   setPayerKey, setPathA, setMaxFee, stake(uint32,uint256), unlockStake, withdrawStake
```
- **Signature entries:** entry 0 = ARBITRARY PQ witness (fixed `sigLength`, `msg` empty); entry 1 = SECP256K1 payer (Path B).
- **Hot tx:** `[only_verify(account, verifyFrame()), pay(tank EOA), SENDER(hotExecute)]`.
- **Account ABI and event names:** the canonical list is in §10.3.2 / §10.11. §30 §12 and §40 were aligned to it.
- **Open cross-section items** (tracked, not hidden):
  - (a) PoolPayer with the QueueBit account as sender is rejected by walker step 6 (§10.5.1); v1 uses a fresh EOA sender.
  - (b) Whether `isValidSignature` should accept a 36-byte marker for registered hashes (some dapp SDKs reject empty signatures).
  - (c) Event coverage: the registered-hash/empty-sig path and `OverCap` reverts emit no log, so the watcher must not rely on them.
  - (d) A typed-data UR type for the Privacy Pools `EnvelopeSigner` flow (§20 to add).

---

## 5. Schedule

### 5.1 Effort (from the sections' milestone tables)

| Workstream | Person-weeks | Notes |
|---|---|---|
| Contracts (§10.9, M1–M10) | ≈ 28 | Includes the 7579 backend (5) and the 8286 validator (1.5, gated) |
| PQ crypto + companion + benchmark (§20.7, M0–M5) | ≈ 23 | Includes the native companion shell (3) and recovery ceremony (3) |
| Extension (§30.10, M0–M7) | ≈ 25.5 | Assumes 2 engineers |
| Privacy + infra (§40.8, P1–P11) | ≈ 20.5 | |
| **Total engineering** | **≈ 97 pw ≈ 22–24 person-months** | |
| Audits (estimates, no public price lists) | — | Account + role signers + modules; PQ verifier/signer cryptanalysis review; extension + companion; PoolPayer. Order of magnitude $250k–600k. ZK circuits are **not** audited by us (we don't write any) |

> **Correction to the earlier analysis:** it estimated 10–16 person-months for v4. That figure excluded a production extension and a native companion app. With them, it's **~22–24 person-months**. With 4–5 engineers that's about **6–8 calendar months to a testnet-complete v1**. Mainnet for the frame-native backend is gated by Hegotá (Q2 2027 at the earliest, date unconfirmed). The 4337/7579 backend can reach mainnet before that, after audit.

### 5.2 Phases and gates

**Phase 0: unblock (weeks 1–2)**
1. Re-obtain `@forshtat/hegota-support` and the mempool-workshop libs. Fix `prototype/probe.mts` imports. Re-run the PORST probe and confirm opcode bytes on devnet 1337 and the Hegotá devnet (§20 M0, §10 M1). **Done for chain 1337 on 2026-11-06:** `devnet/` is a local fork of the public devnet (same ethrex build + sidecar), `@forshtat/hegota-support@0.0.1` is vendored (MIT; the workshop repo has no licence and is not copied), opcode bytes/ids are confirmed on both the local fork and the public devnet, and five plan corrections were applied — see [`50-devnet-review.md`](50-devnet-review.md). Still open: the Hegotá devnet (3151908) and the PORST re-run.
2. **External questions**, each of which can change scope:
   - **Kohaku maintainers (Nicolas Consigny):** written license terms for the `@kohaku-eth/*` packages; the scope of "spending policies for different signers"; interest in the module.
   - **Alex Forshtat (alt mempool):** BUDGET-010 plans and values; acceptance of a PR adding budgets to `skandha_config`.
   - **0xbow:** an ASP root history; whether a custom `processooor` works with their relayer path.
3. Measure C13 signing time on a target phone and laptop. It's [UNVERIFIED], and companion platform choice depends on it (§20).
4. Run the [UNVERIFIED] verification steps that gate Phase 1 (list in §6).

**Phase 1: core loop on devnet (≈ weeks 3–10)**
- Contracts M2–M4: account, role surface, `PQRoleSigner` with the C13 adapter.
- Crypto M1–M2: verifier vendored, Rust/WASM signer, KATs.
- Extension M0–M1: shell, keyring, `@queuebit/frames`, hot send on devnet.
- **Gate G1:** on the devnet, a hot tx and a path-B C13 vault tx are both mined by the public mempool; a forged vault sig moves nothing; an over-cap hot tx reverts and charges only the tank.

**Phase 2: usable wallet (≈ weeks 8–18)**
- Contracts M5–M7: scoped 1271, the tests suite, the 7579 backend.
- Extension M2–M5: 4337 backend on Sepolia, scoped 1271, vault QR flow, session policies.
- Crypto M4-A: companion PWA with clear signing.
- **Gate G2:** the dapp-compatibility matrix (Uniswap/Permit2, Aave, Seaport, SIWE, CoW, ENS, Safe) is recorded as works / works-with-vault / unsupported. Each "unsupported" has a documented reason.

**Phase 3: alt mempool, privacy, upstream (≈ weeks 14–24)**
- Infra P4, P6, P7: PoolPayer, the BUDGET-010 PR, our own staked sidecar.
- Contracts M10: Path A.
- Crypto M3: benchmark published.
- Privacy P1–P3, P5: Kohaku host, prover, Anon-RPC + Helios.
- **Gate G3:** a path-A vault tx is admitted by a staked sidecar, either upstream or ours. A Privacy Pools withdrawal pays gas via PoolPayer on our node. Mass-invalidation data is collected (P8).

**Phase 4: hardening and release (≈ weeks 20–30)**
- Audits plus remediation (contracts M9, crypto M5).
- Extension M7 (phishing protection, reproducible build, Web Store).
- Native companion M4-B.
- Watcher P9.
- Legal runbook P11.
- **Gate G4:** audits closed. 4337 backend released to mainnet. Frame-native backend on Hegotá testnets, waiting for the fork.

**Critical path:** Phase 0 questions → contracts M2–M4 + crypto M1 → extension M1 → G1. In parallel: **BUDGET-010 (an external dependency) → Path A + PoolPayer.** If BUDGET-010 never lands upstream, Path A and PoolPayer only run on our own sidecar, and the product still works on Path B.

---

## 6. [UNVERIFIED] items that gate work (do these first)

Full lists with verification steps are at the end of each section. The ones that block a phase:

| Item | Blocks | § |
|---|---|---|
| C13 signing time on phone/WASM | Companion platform (PWA vs native first) | 20 |
| Whether `verbatim` is usable in inline assembly / the `chiranjeev13/solidity` fork for 8141 opcodes | Second build path (v1 uses the Yul-helper pattern) | 10 |
| Hegotá devnet (chain 3151908) RPC endpoint, per-client spec revision | Devnet CI | 10, 30 |
| BC-UR fragment size vs webcam decode time; camera permission persistence on extension pages | Vault UX | 20, 30 |
| SIWE backends verifying ERC-7739-wrapped 1271 signatures | Login support claims | 30 |
| `module-sdk` 0.4.0 session enable accepting a contract (vault) signature (`@rhinestone/sdk` lacks `getEnableSessionDetails`) | Session policies on 4337 | 30 |
| Groth16 `WithdrawalVerifier` gas in-frame (~250k reported by a 4337 author) | PoolPayer budget fit | 40 |
| In-browser proving time for the 17 MiB zkey | Privacy UX | 40 |
| Kohaku package licenses (see §1 item 15) | Shipping anything that bundles them | 30, 40 |
| ERC-8286 module type id and callTypes (marked TBD in the ERC) | 8286 validator | 10 |

---

## 7. Top risks

1. **Hegotá timing / 8141 shape changes.** Mitigation: the profile-driven codec, an upgradeable account with a migrate primitive, and the 4337 backend for real users now.
2. **BUDGET-010 never lands.** Path A and PoolPayer then live only on our sidecar. Mitigation: Path B by default, and leanSphincs-s as the under-100k Path A option.
3. **Kohaku overlap and licensing.** Their roadmap includes per-signer spending limits. Mitigation: Phase 0 conversation; contribute the module rather than compete; written license confirmation.
4. **Companion UX:** QR throughput and phone signing time. Mitigation: measure in Phase 0; the native shell; the small C13 signature (3.7 KB vs PORST's 13 KB).
5. **PoolPayer economics and griefing** (pays for failed withdrawals; ~1.9 ETH to throttle). Mitigation: the three mandatory rules, monitoring, an at-cost operator hand-off; not run by us long-term.
6. **Regulatory exposure.** Engineering rules in §40.7: no operated pool, no fees, PoolPayer at-cost and handed off; not legal advice.
7. **Unaudited dependencies** (SPHINCS- verifier, Kohaku alpha packages, the hegota-support helpers). Mitigation: vendoring + pinning, KATs, a cryptanalysis review, audit scope in §10.8.
