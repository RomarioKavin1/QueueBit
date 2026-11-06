# Merge plan: LeanPool into QueueBit

Status: in progress on branch `feat/leanpool` (2026-11-06). Revised after a Fable adversarial review.

**Decisions taken** (the recommended defaults, recorded here so they can be revisited):
- D2 = **H**: the PQ everyday key through LeanPool; the Vault stays on Paths A/B.
- D3 = leanVM **`a39758d`** (lean-pq 0.7.0, 4,276-byte signatures): the running LeanPool nodes and all live evidence
  use it. Spike S1 passed: the WASM build derives the same keys and byte-identical signatures as native lean-pq.
- D5 = the LeanPool node runs as a service (`services/leanpool-node`); the user-facing product is the extension.
- D7 = (a): files are ported with provenance (THIRD_PARTY.md); LeanPool's history stays in its own repo.

Sources:
- QueueBit `main` @ `76b87f7` (RomarioKavin1/QueueBit)
- LeanPool `main` @ `53732b1` plus uncommitted work (LeoFranklin015/Queue-bit)

The target is the QueueBit repo. The product stays a browser extension.

## 0. Status (2026-11-06)

| Phase | State | Verified by |
|---|---|---|
| P1 spike: leanSPHINCS in WASM | done | byte-identical keys/signatures vs native lean-pq 0.7.0; reproducible WASM (CI job) |
| P2 shared code | done, one deviation | `lean-sphincs`, frames shape (refuses length-elision profiles), rpc client. The triple/witness/Merkle code stayed in the node (no separate `packages/leanpool-core`): the extension only needs the tx shape, which lives in frames. A signature counter enforces the 120K budget (falls back when spent). |
| P3 contracts | done, amended | `DepsRegistry`, `LeanPoolHotSigner` + factory, `hotExecuteFrom`; `vaultSetPQHotSigner`: **install/replace is queued (loosening), removal instant** (C4); Lockdown removes the signer. Forge: 33 + the 44-case parity suite; `lint-verify.sh` §5 covers the signer's VERIFY (self-tested). Deviations from C2: the aggregator and fee bound are clone args (no storage), the witness is the variable-length `(root, ring, proof[])` LeanPool already uses, no `getRoles` (the signer is bound to one account). |
| P4 node service | done | vitest 56 incl. real STARK proving; bounded pool/known/STARK memory (older STARKs served from disk); Dockerfile written (not built here: no docker) |
| P5 extension | done, partial on 7.3/7.4 | Security row (set up → queued Vault approval → Finish after the timelock), payments lane with safe fallback (never pays twice), activity steps, stuck flag, batch root/proof hash and the audit command in details. Not built: an in-extension STARK verifier (the node CLI verifies; the extension shows the hash). Lane choice lives in payments, not `lanes.ts`. |
| P6 companion | done | clear-signs `vaultSetPQHotSigner`; interop test with the extension's request |
| P7 live + docs | done | `contracts/devnet-tests/leanpool` PASS on chain 1337 with the queued install; the extension's own code on the public devnet up to the queued approval (`test/devnet/leanpool.public.test.ts`); THREAT-MODEL §8.1, ARCHITECTURE, research page |
| Not done | open | C6 (LeanAccount copy, `osaka` profile), L3 gas table in `bench/` and moving `DirectPQWallet`, N5 compose service + 7.6 Playwright case: BACKLOG |

The task tables below are the plan as written; option H's tasks are the ones built, with the amendments above.

## 1. What each project is

Both answer one question: how does an EIP-8141 account use a post-quantum key when a PQ signature doesn't fit the
mempool's 100k VERIFY budget?

| | QueueBit | LeanPool |
|---|---|---|
| Product | MV3 extension + Vault companion (PWA); hot key bounded by on-chain limits | contracts, node, SDKs; only a localhost test wallet UI |
| PQ key's job | Vault and Recovery roles, as separate sender contracts (`PQRoleSigner` clones). Everyday spending uses a bounded secp256k1 hot key. | every spend, and the admin actions of a keystore account |
| Scheme | SPHINCS- C13 (keccak, 3,688 B) by default; "leanSphincs-s" (keccak, 4,164 B; h=26, FORS k=13 a=12, WOTS+C) experimental. Both: Rust → committed WASM. | leanVM leanSPHINCS, **also keccak-based**, different parameters: 4,276 B at the lean-pq 0.7.0 rev (`a39758d`). lean-pq 0.9.0 (`ed7d2b9`) replaced it with a 7,740 B hypertree variant. Native napi only (no wasm32). |
| How PQ fits VERIFY | **Path B**: VERIFY checks an ECDSA payer key; `executePQ` verifies PQ in execution. A forgery needs the PQ key, and Q-day only enables fee griefing bounded by `maxFee`. **Path A**: PQ inside VERIFY. C13 costs 151,701 and needs BUDGET-010, which isn't upstream. lean-s costs 84,465 but is experimental. | verified off-chain by mempool nodes, batched, Merkle root posted into a per-wallet ring; VERIFY checks inclusion only (LeanAccount: 46–64k), no stake, 0 sig bytes on-chain; EIP-8288 wrappers + background STARKs |
| Trust | none beyond the chain (A); the PQ key still gates execution (B) | **the aggregator** the wallet named. The inclusion leaf `keccak(0x10‖SIG_HASH‖pk)` carries no signature, and `postRoot` is gated only by an ECDSA-sent bond. There is no on-chain slashing; the STARK can be audited after the fact. |
| Account | UUPS `QueueBitAccount` (rolling USD cap, allowlists, timelock, freeze, scoped 1271) + 7579 modules for 4337 | `LeanAccount` (ERC-8286 + 7579) + `KeystoreValidator` (PQ, passkey, P256 and ECDSA keys; weights; sessions), hook, recovery, factory |
| Maturity | ~766 vitest, ~533 forge, 12 Playwright suites, reproducible WASM and release builds, CI, threat model | 68 bun tests and 73 forge tests (29 account); live on the public devnet with recorded txs and gas; no CI |
| Toolchain | pnpm 10, Node ≥22.12, vitest, WXT, Foundry `cancun`, submodule libs | bun, Foundry `osaka`, remappings into `node_modules` |

## 2. Which method is better, part by part

| Concern | Better | Why |
|---|---|---|
| Product shell (extension, companion, QR/relay, onboarding, policy, CI, release) | **QueueBit** | LeanPool has no extension |
| Bounding the damage of a compromised signer | **QueueBit** | on-chain caps, timelock, role split |
| Trustless PQ security for high-value actions | **QueueBit** (A/B) | the PQ signature is checked on-chain. LeanPool replaces that check with aggregator trust. |
| Cheap, frequent PQ-signed txs under stock mempool rules | **LeanPool** | ~50–60k VERIFY, 0 signature bytes, unstaked, works today |
| EIP-8288 alignment | **LeanPool** | 8288 triples, wrappers and STARK already exist |
| Signing in a browser or phone | **QueueBit** | the WASM signer works. lean-pq has no wasm32 build, though one looks plausible (§4). |
| Multi-key modular account (passkeys, weighted multisig) | **LeanPool** | out of scope for this merge (D4) |

**The key insight from the review:** LeanPool's trust assumption (an honest aggregator) is safe only where a forged
approval is *bounded*. QueueBit already has such a place: the everyday key, whose spending the account caps
on-chain. It has no such place for the Vault. So the best of both worlds is a **post-quantum everyday key through
LeanPool, bounded by QueueBit's caps**, with the Vault left on its trustless Paths A/B. That is option H below.

## 3. Decisions (❓ = needs the owner)

- **D1 Base.** QueueBit's repo, layout, toolchain and CONTRIBUTING rules. LeanPool code is ported, not dropped in.
- **D2 Where LeanPool goes.** ❓ This changes the contracts.
  - **H (recommended): a PQ everyday key ("Path C, hot").** A new `PQHotSigner` sender contract follows the role-signer
    pattern. Its VERIFY checks LeanPool inclusion; its SENDER frame calls a new `account.hotExecuteFrom(...)`. That
    function applies exactly `hotExecute`'s rolling cap, allowlists, per-tx max and freeze in execution, with
    `msg.sender == hotSigner`.
    - Worst case: a dishonest aggregator, or a Q-day attacker who forges its ECDSA posting key, can spend what is left
      of today's allowance to allowed destinations. That is the same bound as a leaked hot key today, and the threat
      model already accepts it.
    - Gains: the everyday key becomes quantum-safe, and the extension's main flow becomes the alt-mempool showcase.
    - Costs: an account change (UUPS upgrade, new entry point, lint and policy parity tests). Everyday payments wait
      one batch plus the root's block, and route to the alt mempool, not the public one.
  - **V: Path C for the Vault.** Inclusion only; the PQ check is dropped from execution.
    - *Strictly weaker than Path B* (review B1). Before Q-day, the payer key plus a dishonest aggregator forge a Vault
      action with no PQ key at all. After Q-day, both ECDSA keys fall and nothing PQ remains.
    - It is acceptable only if (i) the aggregator posts from a PQ-authenticated sender (a QueueBit Path B role
      signer: about 150k per batch, amortised), **and** (ii) Vault trust in the aggregator is written into
      THREAT-MODEL.
    - Not recommended.
  - **V′: Path C as a pre-filter for the Vault.** Keep `executePQ` in execution, and use inclusion only so forged txs
    never reach a block. This saves no gas and adds nothing over Path B. Not worth it.
- **D3 Scheme and revision.** ❓
  - **Primary: leanVM leanSPHINCS at the 0.7.0 rev `a39758d` (4,276 B).**
    - LeanPool's live evidence and node carry over.
    - Its lifetime is bounded by kept height: b=12 gives 120K signatures (Lean-proved), so a usage counter is needed.
  - Or **0.9.0 `ed7d2b9` (7,740 B)**: this tracks leanVM main and so future 8288. But the node, signer and all
    evidence must move together, and there is no kept height.
  - Both fit the 16 KB relay cap and the 32 KB `MAX_WITNESS`.
  - **Fallback if spike S1 fails: QueueBit's keccak leanSphincs-s**, verified natively by the node in mode 0 only (no
    STARK). It has an existing on-chain verifier (39.5–43.5k), so a fraud game is possible, but only if the node
    publishes signatures for data availability. A wrong leaf can't be disproved without the signature.
- **D4 LeanAccount and KeystoreValidator are not wired in this pass.** They are copied to
  `contracts/src/leanpool/account/` with their tests and not deployed, as the later ERC-8286 frame-validator track.
  Their tests need an `osaka` Foundry profile: `WebAuthn.sol` calls P256VERIFY at `0x100` (EIP-7951), and
  `LeanAccount.t.sol` and `WebAuthnGas.t.sol` exercise the real precompile.
- **D5 The LeanPool node is a service**, `services/leanpool-node`, on bun (lean-pq is native; proving peaks at about
  1.7 GB). It is infrastructure like the Skandha sidecar; the user-facing product stays extension-only. ❓ Confirm.
- **D6 Dropped.** v1 (`BatchRegistry`, `LeanWallet`, the `lsk` fraud game, `ts/node`, `ts/sdk`), `LeanWallet8288`,
  and the bun test wallet (its UX ideas are ported). `DirectPQWallet` moves to `bench/` as the "PQ in EVM" baseline.
- **D7 Git history.** ❓
  - (a) Recommended: port in QueueBit commits that cite `LeanPool@53732b1`, and archive the LeanPool repo read-only.
  - (b) Alternative: `filter-repo` LeanPool into a subdirectory and merge unrelated histories, with `data/` and
    `logs/` filtered out.
- **D8 Naming.** All three schemes are keccak hash-based, so name them by parameter set:
  - "SPHINCS- C13"
  - "leanSphincs-s (QueueBit keccak, 4,164 B)"
  - "leanSPHINCS leanVM a39758d (4,276 B)", with scheme id `keccak256("leanSPHINCS/leanVM/a39758d/v1")`
  - Existing ids and derivation labels don't change. "LeanPool" names the aggregation service and the path.

## 4. Compatibility analysis (✅ verified · ⚠️ needs work · ❌ blocker)

| Area | | Evidence / action |
|---|---|---|
| Frame codec and sig hash | ✅ | LeanPool uses `getProfile("ethrex-eip8141-tracer")` (`ts/core/frameTx.ts:8`). QueueBit's profile is a copy of hegota-support `2377188` with the same elision (`codec.ts:104,297`). The node switches to `@queuebit/frames` behind a vector test (N2). |
| hegota-support version | ✅ | npm 0.0.1 `contracts/` is byte-identical to the QueueBit submodule pin `2377188`. Only a remap is needed. |
| Filling entries after signing | ✅ | Every entry with `msg == 0x` is elided, so the witness (entry 0) and any payer entry can be filled after SIG_HASH is fixed. |
| Ring slot as sender storage | ✅ structurally / ⚠️ live | `keccak(signer ‖ keccak(aggregator ‖ 2)) + i`, and the clone is `tx.sender`. It was proven live only for `LeanWallet8288` (block 362), so it must be re-proven for the new signer (C3/L2). The canonical mempool refuses it, so Path C always goes to the alt mempool. |
| `IPQVerifier` | ❌ doesn't fit | It forbids reading writable storage and never sees the sender (`IPQVerifier.sol:9-10,24`). A new sender contract is needed. |
| Fixed witness length | ⚠️ | `PQRoleSigner._checkWitnessEntry` / `RoleSignerFactory._sigLength` assume a fixed length. The inclusion witness varies (MerkleLib carries odd nodes up). Use a fixed `root‖ring‖proof[4]` with padding (batch ≤16) in the new signer. |
| Account binding | ⚠️ | The account binds signers by address only (`QueueBitAccountRoles.sol:533,545`). But bound-mode init predicts the address with PQRoleSigner's formula (`QueueBitAccountImpl.sol:184-192`), so new signers need unbound mode and the `getRoles`-based `_namesThis` check. `SameRoleKey` calls `pk()` (`0x58e14a45`) and silently passes on no answer, so the new signer must expose `pk()`. For H, `hotExecute` requires `msg.sender == this` (`QueueBitAccountImpl.sol:228`), so a new entry point is needed. |
| lint-verify | ⚠️ | It lints only `QueueBitVerify`, and bans `staticcall(` (`lint-verify.sh:17-30,52`). Role signers aren't covered today. The new signer must STATICCALL the registry, so it needs its own rule set. |
| Solidity / EVM | ⚠️ | 0.8.28 / via_ir in both. DepsRegistry and MerkleLib are fine under `cancun`. The account copy needs `osaka` (P256VERIFY), per D4. |
| JS runtime | ⚠️ | Bun-only APIs: `Bun.serve` (node server); `import.meta.dir` / `Bun.spawn` in config, demo and wallet scripts. The node stays bun as a pnpm member with its own CI job. Declare `@noble/curves` if any account SDK code is ported. |
| leanVM in wasm32 | ⚠️ plausible | The `signatures` crate depends only on primitives, parallel, rand and serde. There is no rayon or SIMD, `parallel` runs one thread on wasm, and `sign` is deterministic. `rand` 0.9 → `getrandom` needs the `wasm_js` cfg. Keygen at b=12 is about 950K permutations, so measure it on a phone. |
| Revision pinning | ❌ until D3 | 0.7.0 and 0.9.0 are different schemes. The signer, node and scheme id must pin one rev, with a CI cross-KAT. |
| Extension | ⚠️ | Add the node URL to `host_permissions` (`wxt.config.ts:36-40`). Use the offscreen document (`wasm-unsafe-eval`) if the WASM is heavy. |
| Aggregator | ⚠️ | It must `bond()` ≥ `minBond` before `postRoot` (`DepsRegistry.sol:61`), and needs gas: the first ring write is about 111,675. The public devnet has no faucet; genesis-key use needs explicit approval. |
| UR / relay sizes | ✅ | Add 4,276 (or 7,740) to `KNOWN_SIG_LENGTHS` (`packages/ur/src/schemas.ts:63-66`). This only matters if the phone signs (V); under H the extension signs. |

## 5. Target layout

```
contracts/src/leanpool/          DepsRegistry, MerkleLib
contracts/src/roles/             PQHotSigner (H)  |  LeanPoolRoleSigner (V)
contracts/src/account/           hotExecuteFrom (H only)
contracts/src/leanpool/account/  LeanAccount stack, copied, osaka profile, not deployed (D4)
packages/pq-signer/              + leanVM leanSPHINCS scheme (Rust @ pinned rev → reproducible WASM)
packages/leanpool-core/          8288 deps/triples, RLP wrapper, Merkle, leaf (pure TS, shared)
packages/frames/                 + Path C tx shape
packages/rpc/                    + LeanPoolClient
services/leanpool-node/          node, server, prover, Dockerfile, verify-batch CLI
apps/extension/                  lane C, signer, stage tracker, batch audit view, send pre-checks
apps/companion/                  only under V (sign the new scheme, clear-sign the Path C shape)
bench/                           DirectPQWallet baseline + gas comparison
docs/                            ARCHITECTURE, THREAT-MODEL (aggregator), research/leanpool.md
```

## 6. Task list (written for H; deltas for V are at the end)

Each task ends with the check that proves it is done. Phases are ordered; tasks within a phase may run in parallel.

### P0 Preparation
| # | Task | Done when |
|---|---|---|
| 0.1 | LeanPool: commit or discard the uncommitted GuardianRecovery epoch fix; `recovery-live.json` is stale | LeanPool `git status` is clean; tag `pre-merge` on both repos |
| 0.2 | QueueBit: branch `feat/leanpool` | CI is green on the untouched branch |
| 0.3 | Owner answers D2, D3, D5, D7; Linear parent issue + one issue per phase | answers recorded in this file; issues link here |

### P1 Spike (gate for D3)
| # | Task | Done when |
|---|---|---|
| S1 | Build leanVM `signatures` at the chosen rev for `wasm32-unknown-unknown` (getrandom `wasm_js`): keygen from seed, sign, verify | (a) cross-verify in both directions against native lean-pq; (b) same pk for the same seed; (c) keygen and sign time plus WASM size measured in a Chrome offscreen document. Failing (a)/(b) within 1 day means the D3 fallback. |

### P2 Shared code
| # | Task | Done when |
|---|---|---|
| 2.1 | `packages/pq-signer`: leanVM scheme implementing `PQScheme`; reproducible WASM job; usage counter (120K at b=12) | vitest cross-KATs with native; CI diff job green |
| 2.2 | `packages/leanpool-core`: port deps, wrapper, Merkle and leaf to vitest; fixed-length witness encoding | ported LeanPool tests pass; a leaf vector file is emitted for Forge |
| 2.3 | `packages/frames`: Path C hot shape `[VERIFY(hotSigner, verifyFrame(triple)), SENDER(hotSigner, hotExecuteFrom(...))]`, entry 0 = witness | vectors: SIG_HASH stable after filling the witness |
| 2.4 | `packages/rpc`: `LeanPoolClient` (send, getTx, status, getStark) | mock-transport tests including errors |

### P3 Contracts (after 2.2's leaf vector)
| # | Task | Done when |
|---|---|---|
| C1 | Port DepsRegistry and MerkleLib (cancun) | ported registry tests pass; the leaf matches 2.2's vector |
| C2 | `PQHotSigner` clone: args `account ‖ pk ‖ registry`; slot 0 `aggregator`, `maxFee`; VERIFY parses the triple (scheme 0x10, zero data_hash, vk == pk), leaf = keccak(0x10‖SIG_HASH‖pk), reads `rootAt(aggregator, self, ring)`, checks the fixed-length proof, walks frames (only `hotExecuteFrom`), checks the fee bound, then APPROVE; exposes `pk()` and `getRoles` | Forge on FrameSim: approves its own included triple; refuses a wrong pk, foreign data_hash, wrong root/ring, wrong length, foreign SENDER and an over-fee tx |
| C3 | Lint rule set for role/hot signers (allow one STATICCALL to the pinned registry, ban everything else); measure VERIFY | lint passes with a self-test; VERIFY < 100k (estimate 48–55k) |
| C4 | Account: `hotExecuteFrom(declaredUsd, calls)` with `msg.sender == hotSigner`, sharing `hotExecute`'s cap, allowlist, max, freeze and fee logic; Vault-set `hotSigner` (tightening instant, adding timelocked: built as specified after review); bunker and freeze disable it (bunker removes it) | Forge parity suite: every existing `hotExecute` test also run through `hotExecuteFrom`; a thief through the signer gets at most the remaining allowance; existing account tests stay green |
| C5 | Factory and deploy: `createPQHotSigner` / predict; `devnet/deploy` writes the addresses | Forge determinism; addresses file updated |
| C6 | Copy the LeanAccount stack under an `osaka` profile (D4) | its 29 tests pass in QueueBit CI under that profile |
| C7 | 4337 parity decision: H stays frame-native only; document it | THREAT-MODEL / ARCHITECTURE note |

### P4 Node service
| # | Task | Done when |
|---|---|---|
| N1 | Port the `ts/v2` node, server and prover to `services/leanpool-node` on `leanpool-core`; config by env | ported bun tests pass (slow ones with `LEANPOOL_SLOW=1`) |
| N2 | Codec → `@queuebit/frames` | identical SIG_HASH and raw bytes for LeanPool's recorded txs |
| N3 | Key binding: read pk and aggregator from the hot signer (clone args, slot 0) | mock-chain test: intake → batch → postRoot → witness → submit; a wrong pk is refused at intake |
| N4 | `leanpool_getTx(poolId)` → stage, final hash, root, postTx, starkHash | stage tests; an unknown id is not-found |
| N5 | Dockerfile; compose service next to Skandha; aggregator `bond()` and funding on startup | `./up.sh` brings a healthy node, bonded, peered with the sidecar |

### P5 Extension
| # | Task | Done when |
|---|---|---|
| 7.1 | Keyring: derive the PQ everyday key (leanVM WASM in offscreen); onboarding creates the hot signer; settings switch between ECDSA and PQ everyday key | unit tests; onboarding e2e |
| 7.2 | Lane C in `lanes.ts` / `chains.ts` (`leanpoolUrl`); falls back to the ECDSA hot path when the node is down, if the account still allows it | `lanes.test.ts` cases with reason IDs |
| 7.3 | Payment flow: build, sign, `sendTransaction` to the node, stage tracker (signed → in LeanPool → root posted → mined → STARK attached; stuck and reverted messages) | stage-reducer unit tests |
| 7.4 | Batch audit view (fetch the STARK by its on-chain hash, check the hash, show the claim); full verify stays in the node CLI | test against a recorded batch |
| 7.5 | Port `planSend` pre-checks the hot path lacks | `payments.test.ts` cases |
| 7.6 | e2e: a PQ everyday payment on the local devnet; an over-cap payment refused | new Playwright case green |

### P6 Live and docs
| # | Task | Done when |
|---|---|---|
| L1 | Deploy to public 1337; run a bonded aggregator | `addresses.public.json` updated; node healthy |
| L2 | A real PQ everyday payment from the extension: admitted unstaked, mined; the same tx refused by the canonical mempool; STARK attached | links in `docs/research/leanpool.md`; `verify-batch` passes |
| L3 | Gas table: hot ECDSA, hot PQ (C), Vault A/B | `bench/results` + ARCHITECTURE |
| L4 | Docs: ARCHITECTURE, THREAT-MODEL (aggregator trust bounded by the cap, censorship and liveness, ring eviction, ECDSA posting key), README, IMPLEMENTATION-NOTES, THIRD_PARTY (ported LeanPool code, leanVM git dep) | reviewed |
| L5 | Code review of the full diff; every task checked | findings fixed |

### If D2 = V instead
- Replace C2/C4 with `LeanPoolRoleSigner` (unbound mode, `pk()`, `getRoles`, `relay`) and no account change.
- Add a PQ-authenticated aggregator: it posts `postRoot` from a Path B role signer.
- Add companion tasks: the worker signs the new scheme with a usage counter; the registry clear-signs the Path C
  shape; add the length to `KNOWN_SIG_LENGTHS`.
- 7.x moves into `vault.ts`.
- THREAT-MODEL must state Vault trust in the aggregator.

## 7. Risks

| Risk | Mitigation |
|---|---|
| leanVM won't build for wasm32, or keygen is too slow | timebox S1; D3 fallback |
| Revision drift (0.7 vs 0.9) | one pinned rev; CI cross-KAT |
| Dishonest or offline aggregator | H bounds loss to the daily allowance; ECDSA fallback lane; documented |
| Ring of 8 evicts a pending root | the node re-batches; the tracker shows it |
| Public devnet resets or stalls (twice on 11-06) | CREATE2 redeploy; local devnet is primary for e2e |
| Path C tx sent to ethrex | lane C always submits through the node → sidecar |
| Account change regresses the hot path | C4 parity suite runs every existing hot test through both entry points |

## 8. Out of scope

Wiring LeanAccount, passkeys or multisig into the extension; on-chain STARK verification; frame mode 4; Path C on 4337;
Safe migration; mainnet.
