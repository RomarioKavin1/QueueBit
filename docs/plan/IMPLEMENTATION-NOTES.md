# Implementation notes

Where the build differs from, or settles, something in the plan. Newest last. Each note names its evidence.

## Phase 0 foundations (contracts toolchain, `@leaked/frames`, `@leaked/rpc`)

### Toolchain

- **TypeScript 6.0.3, not 7.** typescript-eslint 8.72.1 (latest) declares `typescript >=4.8.4 <6.1.0`.
- **hegota-support as a git submodule** (`contracts/lib/hegota-support` @ `2377188`), as §10.1.2 asks. Its
  helpers are pre-generated creation code (paris, optimizer off), so compiling `HegotaSupport.sol` under our
  `cancun` + via-IR settings does not change the helper bytes.
- **via-IR and `block.timestamp` in tests.** Under via-IR the optimizer may reuse one `block.timestamp` read across
  `vm.warp` calls inside a single test function; Foundry tests read time with `vm.getBlockTimestamp()`.

### `FrameSim` (contracts/test/frame)

- Frame gas limits are **not enforced by default**: the mocks cost far more than the opcodes they stand for (a model
  call per read; storage writes per APPROVE), so a realistic 80k VERIFY limit runs out of gas in the mock. Opt in with
  `simEnforceGasLimits(true)`. Gas accounting stays a devnet concern (§10.1.5).
- VERIFY frames run as a normal call under state-diff recording; any write, value transfer, CREATE or SELFDESTRUCT
  outside the model is reported as a static violation (EIP-8141: VERIFY executes as STATICCALL).
- Not modelled (revert `FrameSimUnsupported`): P256 signatures, EIP-8250 keyed-nonce TXPARAMs 0x0D–0x10, EIP-7906
  opcodes. The sig hash in the simulator is opaque (set by the test or a stand-in hash); real hashes come from
  `@leaked/frames`.
- **What passes FrameSim but fails on the devnet (review 2026-11-06).** A LOG in VERIFY is now a static violation
  and BALANCE (of another account) or a CALL*/EXTCODE* to a code-less address are reported in
  `FrameOutcome.bannedAccesses`, but the simulator still cannot see: the other banned opcodes (SELFBALANCE, TIMESTAMP, NUMBER,
  GAS outside `*CALL`, GASPRICE, BASEFEE, BLOCKHASH, ...; any `block.*`/`gasleft()` in VERIFY-reachable code),
  TSTORE/TLOAD (reverts in VERIFY on chain and is discarded between frames; here it persists), gas (helper reads cost
  a model call, not 2 gas; halts revert with data instead of burning the helper's gas), 2929 warm/cold accounting,
  and the sidecar's `MAX_VERIFY_GAS = 100_000` prefix budget. `TXPARAM(MAX_FEE)` is whatever `simSetFees` sets; on
  the devnet it is `maxFeePerGas`. Rule for implementers: VERIFY-reachable code must not emit events, read
  `block.*`, `tx.gasprice`, balances or `gasleft()`, or touch transient storage; `RollingCap` (TIMESTAMP) stays on
  the execution side. Conformance hook to add with M6: deploy the account on the local `devnet/`, build the same
  shapes with `@leaked/frames` (`hotSpendTx`, `roleSignerPath*Tx`), and assert `ethrex_simulateFrameTransaction
  {trace: true}` reports `canonicalMempoolValid` with per-frame `gasUsed` under the 80k VERIFY budget.

### `@leaked/frames`

- **Devnet 1337 confirmed from a mined transaction.** `debug_getRawTransaction` of tx
  `0x38753a56…41e84` (block `0x4d25b`) decodes and re-encodes to the same bytes, its keccak is the node's hash, and its
  SECP256K1 entry recovers to the declared signer over our sig hash. This settles that the devnet sig hash elides
  empty-`msg` signatures to the **empty string** (not to their length) and that the 9-item `ethrex-eip8141-tracer`
  layout is what ethrex accepts. Fixture: `packages/frames/test/fixtures/devnet-1337/`.
- **`eth_getRawTransactionByHash` does not exist on the devnet** (`-32601 Method not found`); ethrex answers
  `debug_getRawTransaction` instead.
- **The `eip8141-current` profile follows ethereum/EIPs `af5ea76` (2026-11-05)**, one commit newer than the plan's
  snapshot `dc5d5fa6`; the payload, fee and sig-hash sections the profile depends on are as the plan quotes them.
  It has no network, so `profileForChain` never returns it implicitly: unknown chain ids throw unless a fallback is
  named (a wallet must not sign with a guessed codec).
- **ox 1.8.13 `TxEnvelopeEip8141` is not a usable cross-check** (resolves the plan's [UNVERIFIED] in §30.4.1). Its
  payload is `[chain_id, nonce_keys?, nonce, sender, frames, signatures, fees(3), blob_versioned_hashes]` and its sig
  hash elides signatures to `0x`: neither the current EIP (2-item fees, length commitment) nor the devnet (9 items with
  `recent_root_references`). The `eip8141-current` vectors are instead checked against an independent hand encoding of
  the EIP text (`independent.test.ts`).
- On a length-committing profile the SECP256K1 placeholder is 65 zero bytes (so the sig hash is the same before and
  after signing) and `signTx`/`setSignature` refuse to change the length of an empty-`msg` entry. On the devnet
  profiles the placeholder stays `0x`, as in hegota-support, so its pinned vectors are reproduced byte for byte.
- `decodeTx` is stricter than hegota-support's: it rejects non-canonical RLP (re-encode check), wrong item counts in
  frames/signatures/fees, and senders or frame targets that are not 20 bytes.
- Receipts: ethrex's `eth_getTransactionReceipt` reports `frameReceipts[i].gasUsed` as one quantity plus
  `stateGasUsed` and adds a transaction-level `status` the EIP receipt does not have; the sidecar's
  `eth_getFrameTransactionReceipt` reports `gasUsed: {execution, state}` and status words (`"success"`). Both parse to
  one `FrameTxReceipt`; the transaction-level status is kept only as `reportedStatus`.

### `@leaked/rpc`

- **`ethrex_simulateFrameTransaction` field names differ from the sidecar docs.** The live node (2026-11-06) answers
  `canonicalMempoolValid` / `canonicalMempoolViolation`; `rpc-methods.md` (and plan §30.4.4) say `valid` /
  `violation`. Following the running code, the client reads the live names first, falls back to the documented
  ones, and exposes both as `valid` / `violation`. Example (the mined tx re-simulated):
  `{canonicalMempoolValid: false, canonicalMempoolViolation: "Invalid Transaction: Nonce mismatch: expected 10, got 8",
  prefixShape: "SelfVerify", maxCost: "0x644f6a61fa800", …}`.
- `eth_estimateFrameTransactionGas` simulates the VERIFY frames, so an unsigned partial transaction for a wallet that
  checks signatures fails with `-32500 validation frame 0: reverted`; a fee-less one with
  `-32500 … Insufficient max fee per gas`. The extension must estimate with placeholder signatures its VERIFY code
  accepts (or with fees and real signatures), not with the bare `{sender, frames}` the docs call sufficient.
- Not-found conventions, as probed: `skandha_frameTransactionStatus` and `skandha_explorer_getTransaction` answer
  `-32600 Frame transaction not found`; `eth_getFrameTransactionReceipt` answers `-32000 transaction receipt not
  found`; `eth_getFrameTransactionByHash` answers `null` (also for a mined tx no longer in the mempool). The client maps
  the first three to `null` and rethrows any other error.
- Live tests are opt-in (`LIVE_DEVNET=1 pnpm test`) and read-only: chain ids, the fixture tx's raw bytes and JSON,
  both receipts, a dry-run simulate, an estimate error, gas price, config, explorer info.

## `@leaked/pq-signer` (section 20 §3, M2)

- **Not vendored, re-implemented.** Upstream `signers/signer-wasm` (crate `sphincs-c13-signer`) materialises whole
  trees (~32 MiB per 2¹⁹-leaf FORS tree), takes mnemonics across the JS boundary and has no zeroization, so
  `packages/pq-signer/rust` (crate `leaked-pq`) is an adapted rewrite: streaming treehash (O(h) memory), single-block
  keccak fast path, hedged R, `ZeroizeOnDrop` secrets, zero-on-free WASM allocator, post-sign self-verification. Its
  deterministic mode reproduces upstream signatures **bit for bit** (KAT set A: 5 vectors from upstream `signer-c13`
  built at `4c76aaf`; the `deadbeef` one also from `script/signer.py`, byte-identical to the Rust output).
- **Upstream already fixed C13-S-f1/f2 and C13-X-f2 at `4c76aaf`.** `cross_validate.rs` compiles and its pinned
  `PY_FORS_SECRET_0_0` matches the ht_idx-folding PRF (re-checked against `script/signer.py`); R is secret-keyed
  (`R_grind`). Our parity oracle pins six PRF values computed by the upstream Python functions
  (`rust/tests/kat_upstream.rs`). The remaining plan item, hedging, is ours: `R = keccak(skSeed ‖ "R_hedge" ‖ rnd32 ‖
  digest ‖ nonce)[:16]` (135-byte preimage, one keccak block; distinct tag and length from upstream's 103-byte
  `R_grind` preimage).
- **Key layout settles §3.3's `sk.seed/sk.prf` split:** upstream keys every PRF with one 32-byte `sk_seed`, so
  `skSeed = role_key[0:32]`, `pkSeed = role_key[32:48]`. Secret key bytes = `skSeed ‖ pkSeed ‖ pkRoot` (64 B); public
  key = `pkSeed ‖ pkRoot` (32 B, the `IPQVerifier` `bytes32 pk`). The HMAC key carries `SCHEME_ID` as 32 raw bytes.
- **SCHEME_ID** = `keccak256("SPHINCS-C13/keccak/fips-adrs/v1")` =
  `0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054` (asserted in Rust, TS and the vectors).
- **On-chain verify gas, measured:** the unmodified `SphincsC13Asm` (Foundry, via-IR, solc 0.8.30) accepts all 32 KAT C
  and 5 KAT A vectors; external-call gas min 107,672 / mean 107,750 / max 110,172 (max = first, cold call). Raw verifier
  reverts `"Invalid sig length"` on length ≠ 3688: the C13 adapter must map that to `false`.
- **Signing time, measured (resolves the laptop half of §3.6's [UNVERIFIED]):** Apple M3, single thread, sign median
  2.28 s native / 2.61 s WASM in Node 26 (p95 2.85 / 3.71 s); keygen 115 / 128 ms; verify 0.05 / 0.1 ms. The plan's
  laptop estimates (0.05–0.2 s native, 0.2–1 s WASM) were 10× too optimistic. Phones remain unmeasured. `BENCH.md`.
- **All 3,688 bytes are load-bearing:** flipping any single bit of a valid signature is rejected by both the Rust
  verifier and the Solidity verifier (exhaustive over every byte), consistent with upstream C13-mal-f3.
- **Build:** `wasm-bindgen` crate pinned `=0.2.117` and `wasm-bindgen-cli 0.2.117` (installed with `cargo install`;
  no wasm-pack). The WASM (~86 KB) is inlined as base64 so one ESM module works in browsers, extension workers and
  Node. `wasm/` and `dist/` are build outputs and not committed: consumers run `pnpm --filter @leaked/pq-signer build`
  (needs Rust + `wasm32-unknown-unknown`).

## Contracts M4: PQ role signers and the C13 verifier adapter (§10.3.6–10.3.8, §10.5.2, §10.6)

Code: `contracts/src/pq/C13Verifier.sol`, `contracts/src/roles/{PQRoleSigner,GuardianSigner,RoleSignerFactory}.sol`,
`contracts/src/interfaces/{IPQVerifier,IStakingRegistry,ILeakedAccountRoles}.sol`; vendored upstream in
`contracts/src/pq/vendor/` (`SphincsC13Asm` and `SphincsFrameVerify.yul` @ `4c76aaf`, MIT, THIRD_PARTY.md). Tests:
`contracts/test/{pq,roles}` (Foundry/FrameSim), `contracts/devnet-tests/pq` (bun; `bun run test`).

- **`C13Verifier` is the upstream verifier plus the adapter in one deployment.** It inherits the unmodified
  `SphincsC13Asm` (so the raw `verify(pkSeed,pkRoot,msg,sig)` selector `0x2bf6eda8` stays available for upstream's
  Yul module) and adds `IPQVerifier.verify(pk,digest,sig)`: length check first (`false`, the case upstream reverts on),
  `pk` split into top-aligned `pkSeed`/`pkRoot` (so upstream's non-canonical-key revert is unreachable), upstream run
  through a warm self-STATICCALL (it clobbers memory and exits with `return`), any residual revert (OOG) → `false`.
  `SCHEME_ID` = the `@leaked/pq-signer` constant (asserted against `vectors/c13.json`). Foundry gas over KAT C:
  min 109,752 / mean 109,830 / max 112,252 (≈ +2.1k over the raw verifier); `verifyGasEstimate()` = 120,000. On the
  devnet the adapter call measured 108,710 (callTracer). Tests: all 32 KAT C vectors (both ABIs), every negative
  recipe on every vector, every byte of one vector bit-flipped, wrong lengths 0..8000 fuzzed, OOG → false.
- **The vendored Yul frame module is reference only.** It hard-codes the chain-1337 opcode bytes (plan §20 §2.2);
  `PQRoleSigner` reads the witness through the per-`Devnet` hegota-support helpers in both paths, so the opcode set is a
  constructor argument, not a constant.
- **`maxFee` bounds a configurable TXPARAM.** On the `ethrex-eip8141-tracer` profile `TXPARAM(0x04)` is per-gas
  (devnet review F5), so the signers take `feeParam` at construction: `MAX_FEE` (EIP master, total budget) or
  `MAX_COST` (0x06, ethrex's max cost in wei; used on the devnet). Same in `GuardianSigner`.
- **Walker details beyond §10.5.2:** exactly one frame after `cur` (SENDER, `RESOLVED_TARGET == this`, `VALUE == 0`);
  Path B additionally requires `executePQ`'s `sigIndex` argument to equal the VERIFY `sigIndex`; the payer entry is
  `1 - sigIndex`; scheme checks come before `RESOLVED_SIGNER` / `SIGNATURE_LENGTH` (short-circuit), so a mis-ordered
  entry list reverts with a custom error instead of halting. `_forward` admits the account (any selector) or `this` with
  only the six self-admin selectors (no nested `executePQ`/`relay`). `pathAEnabled` is informational, not enforced.
- **`GuardianSigner` is ECDSA-only** (immutable key, freeze-only walker: one SENDER frame to the account, data exactly
  `guardianFreeze()`). P256 is not implemented: FrameSim does not model P256 entries and nothing on chain 1337
  exercises them yet.
- **Deployment = `RoleSignerFactory`** (CREATE2, salt bound to every argument, chain settings as immutables, signature
  of plan §10.3.1's `createRoleSigner`). Cost on the devnet (Amsterdam+ state gas): factory 15,991,507; one signer
  instance via the factory 11,265,863 (its constructor CREATEs 7 opcode helpers); `C13Verifier` 2,932,364. A role
  rotation is a new ~11M-gas instance: an EIP-1167-style clone with immutable args sharing one helper set would cut
  this to well under 1M; not done (open item).
- **Opcode lint.** `contracts/devnet-tests/pq/lint-verify-opcodes.py` over the runtime code: `C13Verifier` and
  `GuardianSigner` contain no banned opcode, no `GAS` outside `GAS;*CALL`, no TLOAD/TSTORE (only solc's trailing
  `INVALID` separator); `PQRoleSigner`'s only hits are the 3 execution-side SSTOREs of the admin setters. The devnet
  ERC-7562 trace of frame 0 (Path A and B) shows no banned opcode, no transient storage, no writes, and SLOADs only
  on the signer (slots 0/1: `payerKey`, `maxFee`) — `ethrex_simulateFrameTransaction {trace:true}`, `usedOpcodes` is
  keyed by the decimal opcode byte.

### Devnet results (local fork, 2026-11-06; funding key anvil #2; `contracts/devnet-tests/pq/run.ts`)

Deployed: `C13Verifier` `0xe8bbb5f2…a9fc` (tx `0x907d9fdc…a511`), `MockLeakedAccount` `0x050499eb…ae74`,
`RoleSignerFactory` `0x5f1e91d5…113a` (tx `0xebe59ad1…4e79`), VaultSigner `0x4dA67f61F1d54111030F4aA62760e3445Fa9726f`
(tx `0xb7290045…db9c`). Real C13 signatures from `@leaked/pq-signer` over the codec sig hash (signing 3.7 s in bun).

| Tx | Hash | Result | Frame gas (execution / state) |
|---|---|---|---|
| Path B, `executePQ → mock.vaultExecute` (0.001 ETH out), ethrex `eth_sendRawTransaction` | `0x3f02a933a04de0f8ad1324f7139945e9536969dcba7063515d817e9b4143bde4` (block 497) | mined, both frames success, ETH moved; simulate `canonicalMempoolValid: true` | VERIFY **34,754**; SENDER 156,897 / 281,520 (of which the PQ verify call 108,710); tx 568,218 |
| Path B, `executePQ → self.stake(86400, 0.012 ETH)`, sidecar `eth_sendFrameTransaction` | `0x23cb0481f39443f2cf98440c36a578993064498734e5b5d952cecfb6815c7f67` (block 500) | mined; `getDepositInfo = (0.012 ETH, 86400, 0)` | VERIFY 34,754; SENDER 164,252 / 195,840 |
| Path B, forged PQ witness (one bit), ethrex | `0xa8970740f916ddd05fdb2c4fbbbd216cb13d1f23d27e313a04ba1face3b5427b` | admitted (payer key valid), SENDER frame **reverted**, nothing moved, signer nonce 10 → 11; **286,698 gas burned** (0.000573 ETH at 2 gwei) | VERIFY 34,754; SENDER 56,235 (verifier rejected after 42,758) |
| Path A, `relay → mock.vaultExecute` | `0x572775b0951c74ddf09527733b60df585cce40ff02e694c99232a658a72883b1` (block 504) | stock sidecar: `validation prefix execution gas sum 400000 + signature-verification cost 100 = 400100 exceeds MAX_VERIFY_GAS 100000`; ethrex `eth_sendRawTransaction`: `Frame transaction prefix gas budget … exceeds MAX_VERIFY_GAS`; then **mined via `ethrex_submitPrivilegedFrameTransaction`**, ETH moved | VERIFY **148,098** (PQ verify inside: 108,710); SENDER 35,712; tx 276,410 |

- **Path B VERIFY fits the canonical budget with room**: 34,754 + 2,900 signature cost ≪ 100,000. **Path A VERIFY
  needs 148,098 + 100** → admissible only with a staked budget ≥ ~150k (BUDGET-010); Path A tx total (276k) is about half
  of Path B's (568k) because Path B pays the ECDSA entry, the payer check and the PQ verify in a second frame and its
  body here created the recipient account (state gas).
- **Privileged-submit quirk (corrected by the M4 review, 2026-11-06):** an ethrex `eth_sendRawTransaction` rejection
  poisons the **(sender, nonce) lane**: a later `ethrex_submitPrivilegedFrameTransaction` with that nonce is accepted
  (hash returned) but never mined, whatever the witness or tx hash (re-signing does not reliably help; the review's
  re-run timed out exactly there). Isolated with `contracts/devnet-tests/pq/probe-patha.ts`-style runs on one signer:
  direct privileged submission mined in the next block; after a sidecar `eth_sendFrameTransaction` rejection it mined
  in the next block (the sidecar rejects before reaching ethrex); after an ethrex `eth_sendRawTransaction` rejection
  it never mined. `run.ts` therefore takes ethrex's stock verdict from `ethrex_simulateFrameTransaction`
  (`canonicalMempoolValid: false`, MAX_VERIFY_GAS violation) instead of offering the tx to `eth_sendRawTransaction`,
  and keeps a re-sign fallback. Path A went through the privileged RPC, not a source-patched sidecar (no
  `devnet/patched-sidecar/` was built; the README recipe stays the route for BUDGET-010 work).
- **Setup gas that bit:** a mock `setRoles` writing 3 fresh slots ran out at 200,000 (state gas); the script uses 3M.

## P6: BUDGET-010 sidecar PR + patched sidecar (2026-11-06)

**Source.** `upstream/skandha-budget-010/` holds the PR against `forshtat/mempool-workshop-sidecar`. Its base is
`2e22ff0a`, the commit the devnet image `skandha/v4.1.1-` is built from; both scratchpad clones matched it. The PR is
stored as a 5-patch `git am` series plus `apply.sh`, which clones it into the git-ignored `sidecar/`. `PR.md` covers
the motivation, the diff and the ethrex-side change. Nothing is vendored.

**Semantics.**
- Budgets are per entity address. The sender is `tx.sender`, the payer is the `pay`/`self_verify` target, and the
  factory is the `deploy` target.
- `pre_verify` counts toward its approving entity. The signature cost counts toward the sender.
- `expiry_verify` counts toward no entity (ERC Definitions 4) and is held to 100k on its own. This is a maintainer
  call, flagged in `PR.md`.
- Limits are 100k unstaked and 1M staked. Staked means `ReputationService.checkStake` passes and the entity is not a
  default-code account.
- The check is explorer rule `BUDGET-010`, after `structure` and before simulation. Stake is looked up only above 100k.
- The prefix-wide `MAX_VERIFY_STATE_GAS` stays. The ERC's "no state cap" is left as a separate follow-up.
- Budgets are configurable: `maxVerifyGasPerEntity` / `maxVerifyGasStakedEntity`, or `SKANDHA_MAX_VERIFY_GAS_*`.
- `skandha_config.budgets` advertises them.
- Unit tests (`bunx vitest run` in `packages/executor`): 416 pass (master 386). The 5 suites under `test/unit/` were
  already broken on master.

**Relay path.** The sidecar submits only via `ethrex_submitPrivilegedFrameTransaction`, unauthenticated and
devnet/builder-only, which skips ethrex's combined `MAX_VERIFY_GAS`. ethrex's `eth_sendRawTransaction` and simulate
still apply it. Simulate still returns `erc7562Trace` when the budget is exceeded, so admission works with no ethrex
change. `PR.md` describes the alt-mempool admission mode ethrex would need upstream.

**Running it.** `devnet/patched-sidecar/up-patched.sh` builds `leaked/sidecar:budget-010` (native arch) and starts it
via `compose.override.yml`:
- endpoint **`http://localhost:14340/rpc`**, container IP `172.28.0.40`, in-network `skandha-budget:14337`;
- next to the stock sidecar on `:14337`;
- `up.sh` is untouched.

Port 14338 / `.7` were taken by the privacy workstream's flat-1M sidecar. The bench should use 14340 for BUDGET-010
semantics.

**E2E** (`devnet/patched-sidecar/tests/budget010.e2e.ts`, anvil #9, all checks PASS). Fresh VerifyBisect wallet
`0xa15bb661…e468`, deployed in tx `0xab7e2745…d831`.

| Step | Result |
|---|---|
| `skandha_config.budgets` | `{rule: BUDGET-010, 100000, 1000000, sender, maxVerifyStateGas 500000}`; the stock sidecar advertises none |
| unstaked, VERIFY limit 150k | patched: `BUDGET-010: sender+payer 0xA15B… verification gas 152800 (… + signature-verification cost 2800) exceeds MAX_VERIFY_GAS_PER_ENTITY 100000 for an unstaked entity …`; stock: `… exceeds MAX_VERIFY_GAS 100000`; ethrex raw: rejected; simulate: `canonicalMempoolValid false` but traced |
| stake 0.012 ETH / 86400 via the patched sidecar | `0xb830e574…c653` OnChain; `getDepositInfo = (0.012 ETH, 86400, 0)` |
| staked, same 150k shape | ethrex raw still rejects; the patched sidecar admits `0x1007c4db…0f40`, OnChain in block 782 via the privileged route, both frames success (VERIFY used 5,455) |
| staked, VERIFY limit 1.1M | `BUDGET-010: … 1102800 … exceeds MAX_VERIFY_GAS_STAKED_ENTITY 1000000, the limit even for a staked entity` |
| explorer | `BUDGET-010` fail / pass `sender+payer 62800/100000` / pass `sender+payer 152800/1000000 (staked)` / fail |

- The PQ "poisoned lane" quirk did not reproduce here. An ethrex `eth_sendRawTransaction` rejection (gas cap) of
  nonce N was followed by a privileged submission of a different tx at the same nonce, and it mined in both runs.
- PoolPayer, from the privacy run's preliminary simulate (`contracts/devnet-tests/privacy/results/e2e-run.log`): the
  `pay` frame used 303,334 gas, the sender 100 + 2,800. Exactly the shape BUDGET-010 admits once the payer is staked.

## PQ benchmark harness (`bench/`, section 20 §6, M3)

- **Standalone.** `bench/contracts` is its own Foundry project (solc 0.8.34, Osaka for PORST's CLZ; SPHINCS-
  verifiers via-IR/200 as upstream, PORST and ETHFALCON under their own upstream optimizer settings through
  `compilation_restrictions`). `BenchAccount.yul` is a minimal 8141 sender written for the bench: it calls each
  unmodified upstream verifier directly (no adapter hop except ETHFALCON's flat-witness wrapper), so its VERIFY gas is
  verifier + the minimum glue. `pnpm --filter bench run all` reproduces everything; `run ci` is Forge-only.
- **The devnet does not charge the EIP-8141 text's floor exactly.** Every receipt (16 Path A/B txs + 3 probes) is
  `EIP formula + 64 × len(rlp(nonce_keys) ‖ rlp(nonce_seq))`: ethrex `9aa3645d`
  (`crates/common/types/transaction.rs` `calldata_tokens`/`data_cost`) also prices EIP-8250's nonce calldata (3 bytes =
  192 gas for a fresh account), and its standard intrinsic weights witness bytes 4/16 instead of pricing elided bytes
  uniformly. `bench/src/floor.ts` has both (`pricing: "eip8141" | "ethrex-1337"`); the devnet variant matches all
  receipts to the gas, including the non-floor-bound ETHFALCON and SLH-DSA-128s ones.
- **`ethrex_simulateFrameTransaction` executes over-budget prefixes.** It reports `canonicalMempoolValid: false`
  (`prefix gas budget exceeded: 137100 > 100000 (MAX_VERIFY_GAS)`) but still returns per-frame `gasUsed`, so it is a
  usable gas oracle for Path A shapes the public mempool would reject.
- **`ethrex_submitPrivilegedFrameTransaction` is one-shot.** It tries a tx in exactly one payload build and silently
  drops it otherwise (source comment: "never retried"); a plain call returned success and the tx never landed. Pass
  the optional `targetBlock` (head + 2) and retry; the bench does, and uses it only for txs no sidecar admits
  (ETHFALCON at 1.55M; SLH-DSA, see next).
- **BUDGET-010 sidecar (14340) and precompiles.** On the first run the staked SLH-DSA-SHA2-128s prefix (931k limit)
  was rejected with `payer accesses un-deployed contract address 0x…02 with opcode STATICCALL`: the ERC-7562
  code-less-address rule's `precompiles` list defaults to empty (also recorded in `upstream/skandha-budget-010/PR.md`).
  After the patched sidecar's config listed `0x01`–`0x11`, the re-run was admitted and mined, as was
  SLH-DSA-SHA2-128-24 (231k). With the account staked, every scheme up to 1M was admitted (C13, C7, both PORST sets,
  both SLH-DSA sets); ETHFALCON (1.55M) was rejected by budget and mined through the builder hook.
- **C7 VERIFY = 100,271 gas**, C13 111,140, leanSphincs-s ~43.6k: only leanSphincs-s passes the stock 100k sidecar in a
  VERIFY frame. Total tx gas is floor-bound for every hash-based scheme (C13 250,682, C7 251,706, leanSphincs-s
  281,146), so signature bytes decide fees and VERIFY gas decides admission, as §1.2 predicted.
- **SLH-DSA-SHA2-128s port (time-boxed, done):** `bench/contracts/src/SlhDsaSha2_128s.sol` accepts every noble 0.7.1
  signature and rejects one-bit changes. Gas: 826–889k isolated (the spread is digest-dependent), 868,099 in the
  measured VERIFY frame (831,679 on the first run), about 1.02M per tx. Fits only the staked 1M budget, with ~10%
  margin at the worst observed digest. Not audited; benchmark only.
- **Signing times are laptop numbers under load** (the amd64-emulated devnet running): the upstream C SLH-DSA-128-24
  signer took 7.5–8.6 min per call (it regenerates the 2²² tree; upstream quotes 1–3 min), C7's Python reference
  16–23 s. Treat both as reference-implementation figures, not product signers.
- **NiceTry FORS+C is listed with published numbers only** (no licence in the repo; nothing copied or run).
- **Lockfile not committed by the bench**: `pnpm-lock.yaml` also carries other workstreams' uncommitted importers
  (companion), so the `bench` importer and `@noble/post-quantum@0.7.1` entries should land with the next lockfile
  commit (`pnpm install`).

## PoolPayer (privacy milestone P4, plan 40 §2, §8.1)

Code: `contracts/src/privacy/PoolPayer.sol` (+ `IPrivacyPools.sol`), FrameSim tests `contracts/test/privacy/`
(36 tests, real withdraw-circuit proofs in `fixtures/PoolPayerFixtures.sol`), devnet scripts
`contracts/devnet-tests/privacy/` (`node src/e2e.ts`, `node src/mass-invalidation.ts`; node, not bun: bun 1.3.9 crashes
in snarkjs' worker threads). Funding: anvil #5 only.

### Design decisions settled in code

- **Verify-then-front exactly as §2.2–2.4**, with these additions found while building it:
  - `verify` also requires **minimum execution *and state* gas on the settle and refund frames** and `FLAGS == 0`
    (no atomic batch) on both. Without them a user can starve `settle` (out of gas / state gas → PoolPayer pays the
    prefix and the note stays unspent: the same free, repeatable griefing as a reverting payout) or starve `refund`
    (PoolPayer keeps the overcharge: breaks at-cost). Settle's state budget must also cover a `claimable` slot and
    a fresh-recipient account creation, or the pull fallback itself would halt.
  - **The pool, its scope and its verifier are immutables** (v1 = one native-ETH pool; `PrivacyPool.WITHDRAWAL_VERIFIER`
    is immutable, so caching is exact). Checked in the constructor (`ASSET == native`, `pool.ENTRYPOINT`,
    `scopeToPool(SCOPE) == pool`). This took the VERIFY frame from 303,334 to **298,460 gas** (target ≤ 300k).
  - `settle(i)` reads its arguments from frame i with FRAMEDATACOPY and binds to it (target, MODE VERIFY, STATUS 1,
    selector). One settle per tx (`lastSettled = sigHash`); the refund is keyed on `pendingSig`.
  - **No slot is ever zeroed or restored** (`pendingSig := ~sigHash` when refunded): an SSTORE refund would lower the
    protocol's charge below the estimate and let PoolPayer profit.
  - **At cost, enforced**: no fee/BPS/margin field; the refund estimator's parameters are immutables capped at the
    EIP values (`MAX_INTRINSIC_GAS 21000`, `MAX_PER_FRAME_GAS 475`, `MAX_GAS_PER_DATA_BYTE 4` = the zero-byte cost,
    `MAX_REFUND_FRAME_GAS 60000`); `withdrawFloat` can never touch `totalClaimable`. The estimate is a lower bound, so
    PoolPayer can only lose the slack, never gain.
  - Fee quoting uses `TXPARAM(MAX_COST 0x06)` on this devnet (MAX_FEE is per gas here, F5), configurable like
    `GuardianSigner`. The client sets `fee` = the max cost of the **worst-case (all-nonzero) encoding** + 1 %: a
    placeholder proof with zero bytes under-quotes (first devnet attempt failed `FeeBelowQuote`: 7.806e15 < 7.816e15).
  - FeeData layout = Kohaku's `encodeFeeData` (`recipient, feeRecipient, fee, refundRecipient`); `refundRecipient 0`
    means the recipient (never "no refund").
- **Test deployment**: the real 0xbow contracts are vendored under `contracts/test/privacy/vendor/` (THIRD_PARTY.md).
  0xbow's `WithdrawalVerifier.sol` is GPL-3.0 (snarkjs template), so a from-scratch MIT `WithdrawalGroth16Verifier`
  with the same published key is used; it accepts the real proofs (and rejects tampered ones). Proofs come from
  snarkjs 0.7.5 + `@fatsolutions/privacy-pools-core-circuits@1.0.5` (zkey sha256 = 0xbow's `final-keys/withdraw.zkey`);
  **~2.0–3.3 s per proof** on an M3 (node 26).

### Devnet facts found

- **Deploying PoseidonT3 (29 KB runtime) needs ~47M gas** (state gas for code); a legacy tx is capped at the block
  limit (~112M then 60M as the CL lowered it), and >block-limit is `Transaction gas limit exceeded`. The scripts
  estimate and add 25 %.
- **`ethrex_submitPrivilegedFrameTransaction` only targets the next payload build**; a missed build drops the tx
  silently (no receipt, nothing in `txpool_content`). The first PoolPayer submission was lost this way; the e2e now
  resubmits each block (w2 needed 2 attempts), as the sidecar's BundlingService does.
- **The sidecar rejects any VERIFY-frame call to a precompile** unless `config.precompiles` lists it, and the default
  list is **empty**: `payer accesses un-deployed contract address 0x…06 with opcode STATICCALL` (`frameTx.js`
  CODE_ACCESS). ERC-8421 CALLING-040 allows 0x01–0x11. PoolPayer's Groth16 check (0x06/0x07/0x08) is rejected by the
  stock sidecar *and* by the BUDGET-010 sidecar on 14340 (its BUDGET-010 check passed; this rule fires after it).
  Fix = config only: `"precompiles": ["0x…01" … "0x…11"]` in `devnet/patched-sidecar/config.json` (owned by the
  sidecar workstream; also belongs in the BUDGET-010 PR's defaults).
- APPROVE's fresh-sender creation charged **0 state gas** on this build (frame 1 `stateGasUsed 0`), unlike the EIP
  text; the pay frame still carries 250k state as the rule requires.

### E2E on the local devnet (2026-11-06, `results/` is git-ignored; hashes below)

Pool deployment (run `e2e-1793917985943`): Entrypoint proxy `0x2e0ccfd6…0e94` (tx `0xd9810ba2…9e23`), pool
`0x384286d2…b37c` (`0xc52df9bb…ffff`), verifier `0xe2c632c2…0c03`, deposit `0xf879822b…c992`, ASP root
`0x0a730dad…511b`. PoolPayer A (estimator 0) `0xbc45ca09…be03`, deploy `0x9e30e064…21ce` (17.2M gas), stake
0.012 ETH / 86400 s `0xb2c89af3…b3b0`; PoolPayer B (calibrated) `0x14004fbc…3f93`, stake `0x4330a580…5451`.

Shape `[VERIFY only_verify(fresh EOA) 30k, VERIFY pay(PoolPayer.verify) 500k/250k state, DEFAULT settle(1)
1.2M/1.5M, DEFAULT refund() 150k/250k]`, 1,139 tx bytes, 876 frame-data bytes, maxFeePerGas 2 gwei.

| | w1 (A, privileged) | w2 (B, privileged) | w3 (B, patched sidecar) |
|---|---|---|---|
| tx | `0x6341e8e6…7d14` blk 803 | `0x194121be…398b` blk 810 | `0xcb8eac86…b84e` blk 813, sidecar `OnChain` |
| total gasUsed | 1,266,904 | 1,338,221 | 1,181,253 |
| frames exec (state) | 100 · **298,460** · 523,254 (391,680) · 25,378 | 100 · 298,460 · 496,663 (489,600) · 25,378 | 100 · 298,460 · 535,523 (293,760) · 25,378 |
| intrinsic (gasUsed − Σ frames) | 28,032 | 28,020 | 28,032 |
| fee pre-paid / refunded | 7.896e15 / 6.683e15 | 7.896e15 / 6.564e15 | 7.896e15 / 6.721e15 |
| PoolPayer net | −53,410 gas (−5.34e13 wei) | **−5,516 gas** | −5,528 gas |
| recipient got | = withdrawn − fee + refund (exact) | exact | exact |

PoolPayer's net equals `costEstimate − charge` to the wei in all three: the estimator is a lower bound and nothing
else moves its balance. Calibration from w1: intrinsic 28,032 = 876 × 4 + 24,528 (→ capped 21,000), refund frame
25,378 (→ 23,378 with a 2k margin). Residual per withdrawal ≈ 5.5k gas (≈ 1.1e13 wei at 2 gwei), PoolPayer-funded.

Admission: `ethrex_simulateFrameTransaction` → `canonicalMempoolValid: false`, `prefix gas budget exceeded: 532800 >
100000 (MAX_VERIFY_GAS)`, `executionStatus: success`; stock sidecar: `validation prefix execution gas sum 530000 +
signature-verification cost 2800 = 532800 exceeds MAX_VERIFY_GAS 100000`; ethrex `eth_sendRawTransaction`: `Frame
transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS`. Admitted and mined via the privileged
submit (w1, w2) and via a private sidecar (w3: same image, `MAX_VERIFY_GAS` 1M + `precompiles` 0x01–0x11,
`scripts/patched-sidecar.sh`, port 14338). Re-run against the canonical **BUDGET-010 sidecar (14340)**
(`e2e-1793918166811`: w1 `0xc89a23c8…68d5`, w2 `0x80f5372b…8c82`, same gas): w3 **rejected** with the precompile
rule above. The private sidecar is a stopgap and has been stopped; retire the script once 14340 lists precompiles.

### Mass invalidation (§8.1; `mass-1793918385874`, private sidecar in `bundlingMode manual`)

10 deposits, PoolPayer `0xc15af1ca…5b39` (stake `0xec9038ca…0955`), 10 PoolPayer withdrawals from 10 fresh EOAs all
admitted (`New`). Reputation of PoolPayer: before `seen 0 / included 0`; with 10 pending `seen 10 / included 0`,
`status ok`. One `Entrypoint.updateRoot` (`0x85cb5500…d13b`, block 880) → at block 881 **all 10 `Cancelled`**,
`revalidation failed as of block 881: validation frame 1: reverted with data 0x8f2b1368` (= `StaleASPRoot()`).
Reputation after: `seen 10 / included 0`, `status ok` — the predicted delta (+10 seen, +0 included; 10 // 10 = 1 ≤
0 + 10, so not throttled; throttling needs ≥ 110 such txs from a clean slate, §2.8). No cancellation-specific penalty
beyond the unreturned `seen`.

## `@leaked/ur` and the vault companion PWA (section 20 §4, M4-A)

### UR vocabulary (`packages/ur`)

- **Strict CBOR.** Every payload is CBOR Core Deterministic Encoding (cbor2 `cde`), integer-keyed maps; decoders
  reject unknown keys, wrong types/sizes, non-canonical bytes (checked twice: decoder options and a byte-exact
  re-encode), and text with control or bidi characters. `request-id` is tag 37 (16-byte UUID).
- **`ur:leaked-sign-request` key 4** is the frame tx in `@leaked/frames` wire form (`encodeTx`) with every empty-`msg`
  entry holding its placeholder (PQ entry: `sigLength` zero bytes). §20 §4.2's "the preimage of compute_sig_hash" is
  ambiguous on length-committing profiles; the wire form is unambiguous and `sigHash(decodeTx(...))` gives the digest.
  The companion requires the PQ slot to be all-zero and 3,688 bytes (or empty on `empty`-elision profiles).
- **Additions beyond §20/§30:** key 11 intent gained structured fields (4 recipient, 5 amount, 6 token) so the mismatch
  check can name *what* differs; **key 12 `policy`** (advisory: account, cap, per-tx max, timelock delay/threshold,
  pinned token prices, max fee, max hot frames) is how the browser reports the Vault-pinned prices and current limits
  the phone cannot read; **key 13 `payer`** for **tx-type 2** (EIP-712 typed data in key 4 as UTF-8 JSON: the Privacy
  Pools `PrivacyPoolNote` envelope). `ur:leaked-signature` gained key 5 `typed-sig` (`r‖s‖v`, v 27/28); key 4
  `payer-sig` is in `@leaked/frames` entry form `v‖r‖s` (v 0/1) so it drops into entry 1 with `setSignature`.
- **`ur:leaked-pq-key`** (the pairing UR §30 noted as undefined): `{1 scheme-id, 2 pk, 3 role, 4 payer?}`.
- **`ur:leaked-recovery-test`** (ux-spec PLAN CHANGE 9.3): `{1 request-id, 2 scheme-id, 3 recovery-pk, 4 witness,
  5 ok=true}`; the witness signs `keccak256("LEAKED recovery test v1" ‖ schemeId ‖ pk ‖ requestId)`
  (`recoveryTestChallenge`, pinned and cross-checked with `cast keccak`). It is a full C13 signature, so the
  "small QR" of the spec is ~10 animated parts.
- **bc-ur:** `@ngraveio/bc-ur` 2.0.0-beta.9 (MIT, the plan's pin; npm `latest` 1.1.13 lacks the fountain API).
  Its ESM build imports the bare directory `"buffer/"`, which Node's ESM loader refuses: vitest inlines it
  (`server.deps.inline`) and bundlers resolve it. Its `@bacons/text-decoder` dependency (React Native entry only)
  pulls ~190 react-native packages through an auto-installed peer; `pnpm-workspace.yaml` removes it via `overrides`.
  The receiver checks part headers (≤ 1,024 parts, ≤ 128 KiB) before the library allocates; parts longer than a v40
  QR (4,400 chars) are refused at both ends.
- Measured: a C13 `ur:leaked-signature` at 400-byte fragments is 10 parts; with 30% random loss the median receiver
  completes after < 2.2 displayed frames per part, p95 < 3.5 (100 trials per fragment size, `transport.test.ts`).

### Companion (`apps/companion`)

- **Network:** CSP `connect-src 'none'` (meta in the HTML, header in `_headers` and `vite preview`). The signing
  worker is built inline (a `blob:` URL), so it inherits the page policy; e2e checks fetch (cross- and same-origin),
  XHR, WebSocket, sendBeacon and a blob worker are all blocked, and records zero requests while decoding, signing and
  showing a signature. `sw.js` gets its own policy (`connect-src 'self'`) because it must fetch the build once at
  install; with one combined policy it cannot install. At runtime it answers only from its precache
  (`ignoreVary`: `vite preview` sends `Vary: Origin`).
- **Clear signing** is data-driven from `src/registry/leaked.descriptors.json`. Its `abis`/`selectors` sections are
  **generated from `contracts/out`** (`pnpm --filter @leaked/companion abi:sync`, `--check` for CI);
  `test/registry.test.ts` checks every selector against the Solidity sources (no forge needed), that every
  `vault*`/`recovery*` entry point has a display format, and (when built) against the artifacts. Now synced to the
  landed account: no `vaultSetDomain`; `vaultSetFeePolicy`, `vaultSetValueVerifier`, `vaultSetTrustedVerifier`,
  `recoveryFinalizeVaultRotation`, `registerPermit`; queue kinds 0–3 named; `vaultSetToken` prices are
  **`usdPerToken` (USD-6 per whole token)**, not the plan's `usdPer1e18` (UR key 12 renamed to match).
  `vaultExecute`'s `usdValue` is not displayed (the account measures outflow and does not trust it).
- **Advisory data:** key 11 is never rendered; a mismatch names the fields that differ and demotes Approve to
  "Approve anyway". Key 12 fills "from" values and USD estimates only when the phone has no snapshot of its own, and
  the UI says so ("as your browser reported"); once the phone has signed for an account, its own snapshot wins and a
  disagreement raises E-74. Snapshot values are recorded only for instantly-effective changes.
- **Digest:** the UI decodes and recomputes the sig hash for display; the worker independently decodes the same bytes,
  recomputes it and refuses unless it equals the displayed one (and refuses unrecognised steps unless the user did
  the long-press + typed "SIGN UNKNOWN"). Every witness is verified before it leaves the worker.
- **Keys:** the seed (BIP-39 entropy + optional passphrase) is AES-256-GCM sealed under scrypt (N=2^17, r=8, p=1;
  the plan says Argon2id: scrypt is audited pure JS in `@noble/hashes`, no second WASM), AAD-bound to the vault pk.
  **Deviation from ux-spec §4.2:** there is no unlocked session. The passphrase is asked at Approve (as §4.4 says for
  the PWA) and the key exists only inside one worker call, so "auto-lock" and "zeroise on background" hold trivially.
  Payer key: BIP-32 `m/44'/60'/8141'/0/0`, RFC 6979 via `@noble/curves`.
- **Health:** per the product decision, no signature counter: "unlimited safe signatures", with the 2²² design budget
  explained in small print. **No pending queue on the phone** (the request carries none; ux-spec §9.5 left open).
- Measured in headless Chromium on an M-series laptop: create (scrypt + keygen) ≈ 1.5 s; sign incl. unlock ≈ 4 s.
- **Not covered / open:** camera scanning is exercised only with Chromium's fake device (the paste fallback is what
  e2e drives); the recovery ceremony's middle step (Vault approval of `vaultSetRecoverySigner`) happens after the
  test-ok QR, as ux-spec §4.6 orders it; 4337 requests (tx-type 1) are refused (E-76). The root `vitest` config only
  lists `packages/*`, so the companion's unit tests run via `pnpm --filter @leaked/companion test`.

## Contracts M7: ERC-4337 / ERC-7579 backend (§10.4, §10.9 M7)

Code: `contracts/src/modules/{LeakedHotValidator,LeakedPolicyHook,LeakedRoleExecutor}.sol`, `interfaces/`, `lib/
LeakedExecDecoder.sol`. Tests: `contracts/test/modules` (130 tests: 40-41 per host on the reference MSA, Safe7579 and
Kernel v3.3; real-C13 test; ERC-7562 storage test; invariants). E2e: `contracts/devnet-tests/4337` (`bun run e2e.ts`,
anvil). Pins and licenses: THIRD_PARTY.md.

**EntryPoint: v0.8.0, as §10.4.3 pins.** Verified 2026-11-06: `0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108` =
CREATE2(`0x4e59b448…956C`, salt `0x0a59dbff790c23c976a548690c27297883cc66b4c67024f9117b0238995e35e9`, initcode of
`account-abstraction@v0.8.0` `deployments/ethereum/EntryPoint.json`); that initcode is byte-identical to the input of
mainnet tx `0xae4eafd1…3129`, and `cast code` at the address on mainnet and Sepolia equals the artifact's runtime up to
immutables. The v0.7 address (`0x0000000071727De2…a032`, plan [UNVERIFIED]) has code on Sepolia. Tests and the e2e
deploy that exact initcode through the CREATE2 deployer, so they run the mainnet bytecode at the canonical address.

**Design as built.**
- `LeakedPolicyHook` is the policy store and the only stateful hot-side module: hot key, freeze/bunker, per-tx and fee
  bounds, rolling bucket (`src/lib/RollingCap`), prices, allowlist, sessions, registered hashes, trusted/denied 1271
  verifiers. `LeakedHotValidator` is stateless and reads it. `LeakedRoleExecutor` holds the PQ roles (verifier, vault
  and recovery pk, separate nonce lanes, timelock queue, vault instant bucket, guardians, rotation) and is the **only**
  writer of hook policy (`onlyExecutor`; loosening needs the executor's transient queued context).
- A vault batch (`vaultExec`/`vaultQueue`) mixes spends (through `executeFromExecutor`, single mode, per call) and config
  calls made directly to the hook's setters or the executor's role setters, with `account` as first argument (checked).
  Calls targeting the account itself (module install/uninstall) are queued-only. Digests are EIP-712 in the executor's
  domain (`VaultExec(address account,uint256 nonce,bytes32 callsHash,uint256 usdValue)` per §10.11, plus `VaultQueue`,
  `VaultCancel`, `RecoveryCancel`, `RecoveryRotate`, `RecoveryCancelRotation`); `callsHash = keccak256(abi.encode(calls))`.
- The hook exempts calls whose `msgSender` is the executor and everything nested in them (transient depth counter,
  e.g. the MSA's own `withHook` on the `uninstallModule` self-call); the executor refuses to run during a hot batch.
- Audit fixes of the frame-native account mirrored (coordinator, commits `e43dfea..21400db`): C1 `registerPermit`
  (on-chain ERC-2612 digest, value debited, consumable by the token alone; opaque `registerHash` hashes never validate
  for tokens/Permit2/untrusted contracts), H1 hot verifier rule (hot 1271 only for code-less callers or vault-trusted
  verifiers via `setTrustedVerifier`, queued), M2 (approval-selector sessions need an allowlisted token). L1 is
  frame-only. PoC tests: `test_C1_poc_selfDeclaredPermitDoesNotDrain`, `test_7739_personalSign_hotVerifierRule`,
  `test_session_approvalNeedsAllowlistedToken`.

**Deviations from the frame-native semantics (deliberate).**
- No `declaredUsd`: ERC-7579 `execute` has no field for it. Validation computes the batch's static USD value (ETH
  sends, ERC-20 transfers, registered hashes) and refuses it above `perTxMaxUsd` or the daily cap (M-b). The rolling
  bucket needs the clock, so a batch that fits statically but not the bucket is included and reverts in `postCheck`
  (the account pays that op's gas, bounded by `maxFeeWei`; e2e: 272,743 gas). Same exposure as the frame-native tank.
- Sessions: a hook sees only batch-level balance deltas, so every session called in a batch is charged the batch's
  whole residual outflow (max(0, delta − static debits)); with `approve` + `swap` both sessions are charged, which fails
  closed. Session expiry is checked in execution only ([OP-011] bans TIMESTAMP in validation).
- Modules are not upgradeable: no queued upgrade/migrate; migration is a (queued) vault spend, module changes are queued
  vault ops. An uninstalled hook marks the account `retired` and refuses reinstall (a revived allowlist would be
  stale).
- Only `execute(single|batch, default exec)` is hot-reachable; TRY/DELEGATECALL/STATIC, mode selectors and payloads are
  refused, and the calldata must be canonically ABI-encoded (the validator parses what the host parses again).

**Hosts (plan §10.4.3, R-6).**
- **R-6 resolved for Kernel v3.3** (`cd697c7`): its `IHook` is the standard 3-argument ERC-7579 form
  (`kernel/src/interfaces/IERC7579Modules.sol:72-77` at v3.3); the 4-argument `preCheck(bytes32 id, …)` the plan
  cites is Kernel master (`c960b42`, v4 beta). Hooks are bound per validator and per executor: installing the
  executor with the hook (`installModule(2, executor, hook ‖ abi.encode(executorData, hookData))`) makes executor
  calls hit it (tested). A validator with a hook forces userOps through `executeUserOp` (`Kernel.sol:269`), so the
  validator accepts `executeUserOp.selector ‖ execute(…)`. **Kernel 1271 is unsupported**: Kernel passes the validator
  `hashTypedData(Kernel(bytes32 hash))` in its own domain (`ValidationManager._toWrappedHash`), so registered hashes and
  ERC-7739 never match; the tests assert that.
- The reference MSA (`99cbd34`) and Safe7579 (`9f507f3`) hard-code the **v0.7** EntryPoint (`AccountBase.sol:26`,
  `AccessControl.sol:36`); tests use subclasses that override `entryPoint()`. A production v0.8 deployment needs host
  builds that accept v0.8 [UNVERIFIED: whether Rhinestone publishes one]; Kernel takes the EntryPoint as a constructor
  argument.
- Safe7579: the Safe's owner path bypasses 7579 hooks, so the Safe must have one owner nobody holds a key for
  (`0xdead` in tests); an empty 1271 signature goes to the Safe's `signedMessages`, so registered hashes need the
  36-byte marker (`validator ‖ REGISTERED_MARKER ‖ hash`); its module calls go through
  `execTransactionFromModuleReturnData`, so revert data is not bubbled.
- MSA/Safe7579 select the validator from the nonce key's top 20 bytes; Kernel's root validator is key 0. 1271 data is
  `validator(20) ‖ sig` (MSA, Safe7579) or `0x00 ‖ sig` (Kernel root); the 7739 sentinel therefore needs that prefix.

**ERC-7562.** Validation reads only hook slots associated with the account (`_policies[account]` offsets 0-5;
nested mappings keyed account-last) — asserted on all three hosts with `vm.startMappingRecording` (every slot
`keccak256(account ‖ x) + n`, n <= 128); the validator and executor storage are untouched. Caveat [STO-022]: a first
userOp with `initCode` reads associated storage of a non-entity contract, which needs a staked factory; the e2e
creates the account by a plain transaction instead. Opcode rules ([OP-011] etc.) are by construction (no
`block.*`/`BALANCE`/`TLOAD` on the validation path) and not traced: anvil has no bundler collector tracer.

**Gas (measured).** Anvil e2e (`last-run.json`): hot ETH userOp `actualGasUsed` 331,016 (handleOps tx 220,844);
over-cap op that reverts in `postCheck` 272,743; vault exec relayed by a SimpleAccount userOp **460,444** (tx 408,404;
4,260 B calldata, 3,688 B C13 witness; PQ sign 3.8 s in bun); account creation 648,062. Foundry: direct `vaultExec`
228,923 (C13 verify ≈ 110k inside); relayed userOp 456,530; hot ETH userOp 388k (MSA) / 412k (Kernel) / 417k (Safe7579).
The PQ check runs in **execution**, so the relayer's validation is plain ECDSA (`verificationGasLimit` 100k was
enough): the public-bundler verification-gas caps the plan marks [UNVERIFIED] do not apply to this path. What remains
unverified is a public bundler's handling of a 4.2 KB-calldata op (preVerificationGas pricing) — try on Sepolia.

**Bundler.** The e2e uses a minimal submitter (eth_call simulation of `handleOps`, then a `handleOps` tx), not Alto:
Alto's safe mode needs a tracer anvil does not provide, and unsafe mode would add nothing over the submitter here.

**Build notes.** Safe v1.4.1 does not compile under via-IR (stack too deep), so `foundry.toml` adds a
`legacy-pipeline` compiler profile restricted to `lib/safe-smart-account/**`; Safe7579 and the MSA compile in that job
(`test/modules/hosts/HostArtifacts.sol`), Kernel in its own file under via-IR (24,488 B; 29,767 B under the legacy
pipeline, over EIP-170). With two profiles forge 1.3.5's name-based `vm.getCode("File.sol:Name")` finds nothing, so
the harness deploys hosts from artifact paths (`out/...json`; `fs_permissions` read on `out`). The privacy suite's
`test/privacy/vendor/.../Entrypoint.sol` and `EntryPoint.sol` collide in `out/` on case-insensitive macOS — another
reason the EntryPoint is deployed from its canonical JSON instead of compiled. `forge build --sizes` still fails on
the privacy vendor's `PoseidonT3`/`PoseidonT4` (not M7). Safe7579 needs `erc7579-implementation@16138d1` (its lockfile
pin, context-remapped) and a file-level remapping for its `src/lib/ModeLib.sol` import.

**For later (shared refactoring, not done: `src/account` and `src/lib` are under review).** The token config / price
quote (`mulDiv` ceil), monitored-asset snapshot and outflow, I-6 approval check and tighten/loosen classification are
duplicated between `LeakedAccountBase`/`LeakedAccountRoles` and `LeakedPolicyHook`/`LeakedRoleExecutor`. Proposal: a
`src/lib/LeakedPolicyLib.sol` (pure/view helpers over a `TokenCfg` + balances interface) used by both, and the types in
one `ILeakedPolicyTypes`.

## Decision (2026-11-06): Path A scheme options after the M3 benchmark
`bench/results/RESULTS.md` measured on the local devnet: **leanSphincs-s has a 43,529-gas VERIFY frame and fits the stock 100k budget**. That makes PQ-in-VERIFY (Path A, no payer ECDSA, no griefing) possible on today's public mempool, with no BUDGET-010. The cost is a 4,164 B sig, ~281k tx, and no formal proof (C13 is Lean-proof-pinned).
**Decision:**
- C13 stays the default vault scheme, on Path B now and Path A on staked BUDGET-010 sidecars.
- leanSphincs-s becomes a **second registered `IPQVerifier`** that users can choose as "Path A on any mempool", pending an independent review of its security argument.
- The extension's router picks Path A whenever the vault signer's scheme VERIFY gas plus overhead fits the target mempool's budget.
Follow-up: a leanSphincs-s adapter + signer in `@leaked/pq-signer`, behind a feature flag until reviewed.

## Contracts follow-ups and gate G1 (2026-11-06)

Code: `contracts/src/roles/{PQRoleSigner,RoleSignerFactory,FeeProfile,GuardianSigner}.sol`,
`contracts/src/interfaces/ILeakedAccountRoles.sol`, `contracts/script/CheckFeeProfile.s.sol`; tests `contracts/test/roles`;
devnet run `contracts/devnet-tests/g1` (`bun run test`, funding anvil #0 → one derived deployer key; results in
`last-run.json`). `src/account` untouched.

- **Role signers are clones.** `RoleSignerFactory` (same constructor and `createRoleSigner`/`predictRoleSigner` ABI;
  `devnet/deploy/deploy.ts` and `devnet-tests/pq` need no change) deploys one `PQRoleSigner` implementation (opcode
  helpers, `feeParam`, `stakingRegistry`) and Solady ERC-1167-with-args clones. Args `account ‖ verifier ‖ pk ‖ sigLength
  ‖ role` (105 B) are read with **EXTCODECOPY on `ADDRESS`**, not CODECOPY: under DELEGATECALL, CODECOPY copies the
  implementation. VERIFY thus reads one storage slot (`payerKey` + `uint96 maxFee`, packed). `initialize` is factory-only
  and runs in the creating call. The salt binds every argument plus `defaultMaxFee`. The implementation refuses to act
  (`NotClone`). The companion's role-signer ABI lines (`verifyFrame`, `executePQ`, `relay`, setters) are unchanged.
- **Account ↔ vault-signer CREATE2 cycle (found here).** The account's address commits to `vaultSigner` (in `initData`),
  and a bound signer's address commits to `account`. So a vault signer and its account cannot both be counterfactual,
  and the real account could not be wired to a bound VaultSigner at all. Vault rotation is the only other route, and it
  takes 7 days. Fix: `account = address(0)` deploys an **unbound** signer. `_forward` then admits a target only if its
  `getRoles()` names the signer in its role (`vaultSigner`/`pendingVaultSigner` for role 1, `recoverySigner` for role 2).
  That check runs in execution only; VERIFY is unchanged. G1 uses an unbound VaultSigner and a bound RecoverySigner. The
  recovery signer is installed after the account exists (`vaultSetRecoverySigner` is instant from none).
- **Instance cost: the < 300k target holds only without state gas.** Foundry measures 222,645 gas. On the Amsterdam+
  devnet a clone costs **575,718** (vs 11,265,863 for the old constructor-deployed signer, ~20×). The floor for any
  150-byte contract there is 452,187 (`eth_estimateGas` of a bare CREATE; an empty CREATE costs 211,189, so code
  deposit is ~1.6k gas/byte). The 45-byte proxy plus new account alone is over 280k, so no clone design reaches 300k on
  this chain. The remaining ~124k are the factory call, `initialize` (one fresh slot) and two events. Factory deploy
  (including the implementation) 15,243,341.
- **Fee-profile assertion.** `FeeProfile.check(devnet, feeParam)` runs in the `PQRoleSigner` implementation and
  `GuardianSigner` constructors. It refuses MAX_FEE on `ERC8421_WORKSHOP` (0x04 is per-gas there), so a mismatched
  factory fails to deploy. It also refuses any non-fee TXPARAM. `EIP7906_WORKSHOP` is unprobed, so both are accepted
  there. `script/CheckFeeProfile.s.sol` (read-only `forge script --rpc-url`) checks a deployed factory, its
  implementation and the given signers/guardians against the chain id. The G1 run passes it (5 contracts). It cannot
  cover `LeakedAccountImpl`: `PER_GAS_MAX_FEE` has no getter.
- **Lint on the clone path.** Clone runtime = the 45-byte Solady proxy (`CALLDATACOPY … GAS DELEGATECALL …`, GAS
  directly before DELEGATECALL) to the implementation, checked byte-for-byte on chain. Implementation bytecode pre-filter:
  only the 4 execution-side SSTOREs (`initialize` and 3 setters) and solc's trailing INVALID. Dynamic trace of every
  role-signer VERIFY: no banned opcode, no LOG, no transient storage, no writes, and SLOADs only on the clone. DELEGATECALL
  callees are the implementation and the APPROVE helper. That chain (clone → implementation → helper) is how **APPROVE
  acts on the clone (= tx.sender)**, as demonstrated by every mined role tx.
- **Interfaces/docs.** `ILeakedAccountRoles` gains `vaultSetTrustedVerifier`, `executeQueued`/`executeUpgrade`/
  `executeMigrate` and the role views `getRoles`/`getVaultBucket`/`isQueued`/`isValueVerifier`/`isTrustedVerifier`, with
  selector parity tested. §10.3.1/§10.3.2/§10.3.6 of `10-contracts.md` were synced with the built account and the clones.

### G1 results (local devnet, 2026-11-06; every tx simulated first with `{trace:true}` and gated on frame 0)

Deployed: account `0x553d9CB1…7721` (AccountFactory, tx `0x4994bd22…21d5`), VaultSigner clone `0x7fcBC2B8…734f`
(unbound), RecoverySigner clone `0x6C09aD55…94a9` (bound), GuardianSigner `0xd05e3236…eff9` (5,353,231 gas), C13 keys from
`@leaked/pq-signer` (signing 3.7–5.2 s in bun, 12 signatures).

| Gate item | Tx | Result | Frame gas (VERIFY / SENDER exec / SENDER state) |
|---|---|---|---|
| setup: vault installs RecoverySigner, enables GuardianSigner (Path B) | `0x7871ec80…6d8c`, `0xec668e44…c5e5` | mined | 36,213 / 160,708 / 97,920 |
| (a) hot payment $3, ethrex `eth_sendRawTransaction` | `0xfd695417d82b2b1ac34e8591005309ad0a771f5def373d230452df5abdda0892` | mined | **45,750** / 53,213 (tank 3,000) |
| (b1) Path B `vaultSetCap` $10 → $6 (instant tightening) | `0x207875c04334fa94cb329e7514454baae188846c429fd34a9f59ee39ec3a0260` | mined, cap 6 | **36,213** / 195,297 |
| (b2) Path B `vaultExecute` 0.01 ETH ($30 ≤ $100 instant allowance) | `0xaf1290c6a9a3fdddedddbbe1222ba1487c8dd8cd77d22d8b27556488ca3bc290` | mined, ETH arrived | 36,213 / 200,469 / 183,600 |
| (c) forged PQ witness, Path B | `0xc94bb3bad7bfaf287880b7a69755f2affbdac24914fb7a7f7f1b35d8698b18ad` | mined, SENDER **reverted**; balances, cap, vault allowance unchanged; signer paid 286,698 gas, nonce +1 | 36,213 / 56,857 |
| (c) forged PQ witness, Path A | simulated only | VERIFY reverts (`InvalidPQSignature`); never submitted | – |
| (d) over-cap hot tx ($7.50 ≤ perTx $8, > $6 bucket) | `0xa5fe6c0f846d05eb568d017c9ab67cf388a787363c7dcde38b747add76c7d45f` | mined, SENDER reverted, account unchanged, **tank paid 112,867 gas** | 45,750 / 40,788 |
| (e1) vault queues loosening (cap → $20, `KIND_LOOSEN`) | `0x052a4d8c40263095135efab0226246bbadf4843cf76bf5dcc56ca0bd512d237a` | op `0xfb415188…9e71` PENDING | 36,213 / 193,411 / 293,760 |
| (e2) RecoverySigner `recoveryCancel(op)` (Path B, bound clone) | `0xcde0c8ea619966e11b530b3c708a87518b46029216ddd4aa951e5481746939ef` | op CANCELLED, cap still $6 | 36,213 / 159,353 |
| (f1) GuardianSigner freeze (frame tx, public mempool) | `0xd24af2081106a3074f68fcb7f04c5f5c1d2318e5b225def09533111c9127e7b8` | frozen 72 h | 25,942 / 51,840 / 97,920 |
| (f2) hot payment while frozen | simulated only | VERIFY reverts (`FrozenOnlyClear`); not submitted (poisoned-lane rule) | – |
| (f3) Path B `vaultUnfreeze` | `0xa098bbb3c255278754166afd6b070679187bd0d8cc50622ee06fb007cceca908` | unfrozen | 36,213 / 174,073 |
| (f4) Path B `vaultExtendFreeze(now + 40 s)` (short-expiry freeze) | `0xd32ed7081ea3d7d18280e1ad1c713012a449b2622fa3685c1804e57825393a8b` | frozen; a hot payment simulates as rejected | 36,213 / 175,008 |
| (f6) hot `clearExpiredFreeze()` after expiry | `0xb3d2adc3a5917fbcdcf97c5fafa34a65dce2a73e34da0f2ee671a14135483e7c` | mined, unfrozen | 44,852 / 26,478 |
| (f7) hot payment after clear | `0x81d6b95c778d80cc7707fce7423c67377e31a48c23cd27b3aa77a476874250c3` | mined | 45,750 / 53,213 |
| (g1) VaultSigner stakes 0.012 ETH (Path B `executePQ → self.stake`) | `0x2abdeaef7bcf5b1e0753d4495b5f3196ceb7caba912a51137f38be56e2ea978c` | `getDepositInfo = (0.012 ETH, 86400, 0)` | 36,213 / 165,030 / 195,840 |
| (g2) Path A `relay → vaultSetCap` $6 → $5, BUDGET-010 sidecar :14340 | `0x7af8a2955794bf0c5fcabd883b969cd88a2f8d3cc3b973161ce60cca30f1356b` (block 1103) | stock sidecar: `300100 exceeds MAX_VERIFY_GAS 100000`; ethrex simulate: `prefix gas budget exceeded`; **patched sidecar admitted, mined**, cap 5 | **151,701** (PQ verify inside) / 74,087 |

- G1 as worded (§5.2) holds: a hot tx and a Path-B C13 vault tx are both mined from the public mempool; a forged vault
  signature moves nothing; an over-cap hot tx reverts and charges only the tank.
- The clone hop costs ~1.5k gas in VERIFY: Path B 36,213 vs 34,754, Path A 151,701 vs 148,098 (M4 run).
- `clearExpiredFreeze` could not be shown for a guardian freeze: it is fixed at 72 h and there is no time travel on the
  devnet. It was shown with the vault's `vaultExtendFreeze` short freeze instead. It is the same `frozenUntil` path.

## PoolPayer after the security review (2026-11-06; supersedes the earlier P4 gas table)
- Review fixes `a8ce107`, `b2cd1dd` cover unmetered charges (blobs, oversized data, witnesses, value frames), stranded refunds, and self-recipient. 45/45 Foundry tests pass.
- Current devnet numbers (e2e-1793920665037, sidecar :14340): **VERIFY frame 306,006 gas** (was 298,460 before the extra introspection reads), refund frame 25,796, payer net −5,540 gas (the configured estimator slack).
- **Decision (v1): no user tail frames.** A PoolPayer withdrawal is exactly `[pay(PoolPayer), DEFAULT(settle), DEFAULT(refund)]`. User calls after the withdrawal (and their EIP-3529 refund effects, which PoolPayer can't observe) are out of scope for v1. The wallet sends a separate tx from the recipient if needed. Follow-up: enforce it in `verify`, and update `@leaked/privacy`'s broadcaster.
- Operator calibration before mainnet: `MIN_SETTLE_GAS` for a depth-32 LeanIMT insert; `MAX_INTRINSIC_GAS` vs the EIP-text intrinsic; make `setOperator` two-step.

## Extension M1: native account, FrameEngine, routing, Send and dapp payments (2026-11-06)

Code: `apps/extension/src/background/{account,engine,routing,policy,payments,activity,signing}.ts`, pages under
`src/pages/{popup,approve,app}`; deployment tooling `devnet/deploy/`. Local devnet, funding key anvil #7.

- **Deployment is CREATE2 through the Arachnid deployer** (`devnet/deploy/deploy.ts`, fixed salt): every address is a
  function of the init code, so the script is idempotent and a rebuilt artifact (e.g. an audit fix) simply lands at a
  new address. `addresses.local.json` records each contract's init-code hash; the extension's drift test fails when the
  recorded deployment or `src/generated/contracts.ts` (ABI from `contracts/out`, never hand-copied) is stale. It fired
  once during this work (RoleSignerFactory rebuilt by the contracts workstream) and was fixed by re-running both.
- **The Vault signer is a stand-in until M4.** `initialize` requires a non-zero `vaultSigner` and the account address
  is a CREATE2 function of the whole `InitConfig`, while a `PQRoleSigner` binds to its account (circular), and there
  is no pairing yet. M1 therefore uses a public, deterministic devnet key (`keccak("leaked/devnet/test-vault-stand-in/v1")`,
  `testVault` in addresses.local.json) as `vaultSigner`, only in the local-devnet build, and the UI says so ("a shared
  test key stands in for the Vault"). Accounts created this way can never get a real Vault (no setter; recovery is
  unset): M4 must compute the address after pairing, i.e. change the onboarding order or the factory.
- **The account address is frozen at first use.** The plan (salt `keccak(hotKey, vault, recovery, version, chainId)`,
  init data, impl, factory) is stored per chain; limits changed later do not move the address. The extension computes
  the address locally and the devnet test checks it against `AccountFactory.predictAccount`.
- **Activation is a legacy tx from the fee-tank key** to the permissionless factory (2.37M gas measured, 3.5M limit).
  A deploy frame in the first hot tx is not possible here: the walker admits DEFAULT frames before VERIFY, but the
  tank must pay and it is empty on a fresh install, and self-pay is off by design. UX: "add ETH to your fee tank →
  Activate"; the tank also pays every later everyday fee.
- **Hot recipients are only what the Vault allowed.** `InitConfig` has no target list; at activation only the fee tank
  is allowed, so in M1 the everyday path is "top up the fee tank" (and batches of that), and any other recipient is
  routed "needs your phone" (TARGET-NOT-ALLOWED). Adding a target is a loosening (queued ≥ 1 h), so the e2e cannot
  allowlist one within a run.
- **Gas**: VERIFY limit 80k (measured 45,750), tank 10k (3,000), body = simulated use × 1.25 + 20k (53,213 → 86,516)
  with 200k state gas; a hot top-up costs ~125k gas ≈ 0.000125 ETH at the devnet's 1 gwei tip. Fees: tip 1 gwei
  (≤ the account's `maxPriorityFeePerGas` 2 gwei), `maxFeePerGas = 2 × base + tip`; the H3 bound is checked on the
  simulated `maxCost` (TXPARAM(MAX_COST)) against `maxFeeWeiPerTx` before anything is sent.
- **Simulate-first is enforced in the engine**: it measures with a signed probe, rebuilds and re-signs, simulates the
  exact bytes, and refuses to submit unless `canonicalMempoolValid`, frame-0 gas < 80k and MAX_COST within bound.
  The routing engine adds a failing body frame in the simulation as `SIM-REJECTED`. The devnet test asserts that
  over-limit and not-allowed payments never reach `eth_sendRawTransaction`.
- **Simulation `frames[i]` reports `{gasUsed, succeeded}`** on this ethrex build; the parser also accepts
  `executionGasUsed` / `status`.
- **Per-origin chain**: a connected site keeps the chain it connected on; `wallet_switchEthereumChain` moves only that
  site (events to that origin only); the popup's network pill no longer moves connected sites.
- **Signatures (account audit)**: `personal_sign`/SIWE and zero-value typed data → sign-in (7739, M3); ERC-2612
  `Permit` → `registerPermit(token, spender, value, deadline)` in a hot batch (M3; counts against the limit); Permit2 and
  other value-bearing or unknown typed data → `4100` with `leakedRule` (`SIG-PERMIT2`, `SIG-VALUE-BEARING`,
  `SIG-UNKNOWN-SCHEMA`) now.
- **Results** (local devnet): unit 89 pass; devnet contract-in-the-loop test pass (activate → hot top-up mined, all three
  frames `success` → per-payment and not-allowed classified, nothing sent); Playwright e2e 8/8 including the whole M1
  flow (onboarding → activate → fund → hot send mined and in Activity → over-limit "needs your phone" before submission
  → dapp `eth_sendTransaction` via the approval window → `wallet_sendCalls` batch, `wallet_getCallsStatus` 200) in ~40 s.

## Watcher / alerts (privacy-infra milestone P9, plan 40 §5, §8.1) (2026-11-06)

- **Layout.** `packages/watcher-core` (`@leaked/watcher-core`, pure TS, no I/O: what the extension light mode will
  import) and `services/watcher` (`@leaked/watcher`, Node service, Dockerfile, README). Funding key for the devnet
  test: anvil #9 only.
- **Event ABI from the artifacts.** `packages/watcher-core/scripts/gen-abi.mjs` writes `src/generated/abi.ts` from
  `contracts/out` (account impl + roles module, policy hook + role executor, `IEntryPoint`'s two userOp events,
  `PQRoleSigner`) plus the `KIND_*` values read from `LeakedAccountBase.sol`; `test/abi-drift.test.ts` fails when it is
  stale (skips without `forge build`). Regenerate with `pnpm --filter @leaked/watcher-core gen:abi`.
- **Things that leave no log** (ILeakedAccount "Paths that cannot log"): an over-limit hot batch reverts its SENDER
  frame, so the service also reads each block's transactions whose `sender` is a watched frame account, and a
  `hotExecute` SENDER frame with receipt status `0x0` becomes `hotBlocked`. The reason is fixed with `getBucket()` at
  the parent block refilled to the block time: `hotExecute` debits at most the declared USD, so `declared > available`
  ⇒ over the limit, else "another rule". No trace API is needed (ethrex `debug_traceTransaction` refuses blocks beyond
  its re-execution window; `ethrex_simulateFrameTransaction` at an old block fails with "state root missing"). The
  4337 backend does log it: EntryPoint `UserOperationRevertReason` with `OverCap`. Registered-hash/7739 1271 accepts
  are views and invisible; that is documented, not worked around.
- **Rules.** Only on-chain facts. Account creation (`initialize`: everyday key set from zero without
  `BunkerDisabled`) is silent; one alert per action (a Recovery-started replacement folds its pause; Lockdown folds its
  key wipe; an executed scheduled change folds the setters it ran). A queued loosening/update/move the watcher cannot
  attribute is **urgent** (the extension passes `initiated()` to downgrade its own); a large payment is a warning;
  3 blocked payments in an hour ⇒ urgent "Repeated blocked payments". Guardian vs Vault pause comes from roles when
  known, else from the `until` shape (Vault = `uint48` max).
- **Deadlines.** Ops/rotation: `pending → ready` at eta; timed pause: `expired` at `until`; a finalised Vault
  replacement voids the old Vault's ops (`scheduled-void`). `WatcherCore.alarms()` gives the light mode its
  `chrome.alarms.create(name, {when})` list.
- **Copy** follows ux-spec §1.2; a test checks every alert kind for amounts, addresses and the banned words. ntfy push
  carries title/body only; the SSE stream and webhook carry the structured `ref` to authenticated clients.
- **HMAC** (WebCrypto, works in the MV3 worker; format as of `fc88238`, superseding the first version): webhook
  `x-leaked-signature: t=…,n=…,v2=…` plus `x-leaked-delivery` (stable across retries, for dedupe; 5 min skew),
  stream envelopes v2 `{v,t,type,seq,alert,sig}` with all of `t,type,seq,alert` signed by the caller's key (v1 refused:
  `type`/`seq` were unsigned), request auth `LEAKED-HMAC id,t,n,sig` with a per-key nonce cache for the skew window;
  EventSource uses a single-use 60 s token from a signed `POST /v1/stream-token` (no signature in the URL);
  `trustProxy` opt-in for rate-limit keys. Pairing QR:
  `{url, topic, keyId, hmacKey}` (`parsePairing`; ux-spec §3.10 lists `{url, topic, hmacKey}`; `keyId` added so one
  watcher can serve several devices).
- **Reorgs.** Blocks are processed `confirmations` deep; the last `reorgWindow` hashes and per-block core snapshots
  are kept; a mismatch rewinds to the common ancestor, reprocesses, and publishes `retract` for alerts whose tx did not
  return. Alert ids = hash(chain, account, kind, tx hash, position), so re-inclusion in another block is not a
  duplicate.
- **Results.** core 71 tests (decoding against the real devnet logs/receipts of the account run, synthesized 4337 /
  EntryPoint / role-signer logs from the generated ABI, rules, eta, HMAC incl. RFC 4231, drift); service 21 tests
  (mock chain: confirmations, paging/halving, reorg retract/re-include, checkpoints in file and SQLite; HTTP 401 for
  missing/malformed/unknown/wrong/stale keys, SSE replay + live + retract, stream cap, 429; webhook verified by a
  receiver; ntfy has no addresses); **live devnet** (`LIVE_DEVNET=1 pnpm --filter @leaked/watcher test`, ~67 s, reused
  the `devnet/deploy` CREATE2 deployment): over-limit attempt (block 1298, SENDER `0x0`, no logs) → "Over the limit:
  payment blocked" with reason over-limit; Vault-queued loosening → urgent "Limit change scheduled"; Guardian pause →
  "Paused by your Guardian"; all within 6 blocks, every SSE envelope and webhook body verified. Docker image builds
  (`docker build -f services/watcher/Dockerfile .`, uses `services/watcher/Dockerfile.dockerignore`) and serves
  `/healthz` against the devnet.
- **Open.** The root `vitest.config.ts` lists `projects: ["packages/*", "apps/*"]`, so a root `pnpm test` does not run
  `services/watcher`; add `"services/*"` there (outside this milestone's paths). Not built yet: the sidecar
  `skandha_subscribe` feed for pending (pre-chain) vault actions, Telegram/email channels, Privacy Pools
  `RootUpdated`/`Withdrawn` for the user's labels, and the extension light-mode wiring (the extension workstream).

## 7579 modules after the security review (2026-11-06; supersedes the M7 "Kernel 1271 unsupported" and "Safe keyless owner" prose)
- Fixes `e232ab7`, `9784a02`:
  - **A1 (critical):** Safe7579 `emergencyUninstallHook` reached via a hot-registered digest or via 7739 in the Safe's own domain. Fixed: opaque hashes are only for `sender == 0` or vault-trusted verifiers, and 7739 is refused in the host's domain.
  - **A2:** the validator now fails closed with `HookNotInstalled` when the hook isn't bound.
  - **A3:** hot 1271 is off on Kernel, enforced at install.
  - **A5:** Safe owners must all be `0xdEaD`, enforced at install (`HostOwnerNotKeyless`).
- Host matrix:
  - **MSA:** yes; needs a v0.8 EntryPoint build.
  - **Safe7579:** yes, single owner `0xdEaD`; emergency exit is vault-only.
  - **Kernel v3.3:** yes, hot 1271 off.
- **To mirror the next account change** (Open recipient mode by default, vault bound in initialize): `LeakedPolicyHook` gains the same `RecipientMode`; `LeakedRoleExecutor` derives role signers the same way. Tracked as a follow-up once the account change is reviewed.

## `@leaked/privacy` (privacy P1–P3 + P7 core, plan 40 §1, §2.12, §6, §7, §8.1; 2026-11-06)

Code: `packages/privacy` (no UI). It has 70 unit tests (`pnpm --filter @leaked/privacy test`) and one local-devnet e2e
(`LOCAL_DEVNET=1`, `test/e2e.devnet.test.ts`).

- **License gate (plan §1 row 15): no Kohaku dependency.** `@kohaku-eth/privacy-pools` declares MIT but pulls in
  `@kohaku-eth/plugins` (no license) and `@saga-sync/client` (GPL-3.0-only). The Host is our own structural type
  (`src/host/types.ts`, Kohaku member names). The PP v1 client (sync, notes, deposit, withdraw) is written here.
  Details are in THIRD_PARTY.md.
- **Host adapters.**
  - `EncryptedStorage`: AES-256-GCM per value, the full key as AAD (a swapped ciphertext fails), fail-closed on any
    decrypt error, and `lock()`/`unlock()`. The backend is injectable (`chromeStorageBackend`).
  - `anonNetwork`: every request carries `anonOptions.isolationKey` and a caller cannot override it. It has an audit hook.
    Keys come from `isolationKeyFor(addr, chainId)` = sha256, or `freshIsolationKey()` for one withdrawal.
  - `VaultKeystore` throws for every path, including Kohaku's `m/28784'/1'/0'`, unless a vault flow delegated it.
  - `createHostProvider` sends `call`/`getBalance`/`getStorageAt`/`getCode` through an optional `VerifiedReads` hook.
    `heliosVerifiedReads(heliosProvider)` wraps an injected `@a16z/helios` provider, which is not a dependency
    (WASM, beacon API, no beacon chain on the 8141 devnet). Logs always use raw RPC. `readsVerified` drives the badge.
- **Vault EnvelopeSigner over QR.**
  - `createNoteSignRequest` emits a `ur:leaked-sign-request` tx-type 2 in the companion's exact JSON shape (domain
    keys, decimal uint64s).
  - `acceptNoteSignature` checks the request id and that the signature recovers to the payer over the digest.
  - The secrets are `trunc31(keccak(tag ‖ r ‖ lowS(s)))`. Tests show that the software signer, vault-over-QR, high-s,
    v 0/1 vs 27/28 and ERC-2098 compact signatures all give identical notes.
  - The secret manager runs a determinism double-sign (one extra scan per session) and caches signatures in
    `EncryptedStorage`. The PoolPayer sender key is derived from the change note's signature (tag `signer`), so a
    stranded withdrawal can be recovered from the vault.
- **Sync fails closed.**
  - Paged `eth_getLogs` (5,000 blocks, a refused page is split in two).
  - Contiguous `LeafInserted` sizes; note that `_index` is the **size after insert**, 1-based.
  - Each event's root is recomputed. Every deposit and change commitment must be a leaf.
  - Finally `currentRoot()`/`currentTreeSize()` at `toBlock` through the verified-reads path.
  - Tests cover dropped, injected, duplicate, foreign and lying-root logs, and a leaf substituted with self-consistent
    forged roots (caught only by the on-chain root).
  - The ASP labels must hash to `latestRoot()` exactly. `NoRootsAvailable()` means nothing is approved yet.
- **Prover.**
  - `Prover` interface; `createGroth16Prover` takes an injected engine (snarkjs is GPL) and artifacts as bytes, with
    sha256 pins and a self-verify against the vkey.
  - `serveProver`/`createWorkerProver` form a postMessage RPC for the offscreen-document Worker.
  - A real proof from in-memory artifacts passes in about 2 s.
  - `@zk-kit/lean-imt` reports `index` NaN for a one-leaf tree, so it is mapped to 0.
- **Withdraw modes:**
  - (a) the 0xbow relayer client (`/relayer/quote`, `/relayer/request`). The committed RelayData must pay us, and its
    BPS must equal the quoted value and be ≤ the on-chain `maxRelayFeeBPS`.
  - (b) `FramePaymasterBroadcaster`. Default sidecar `http://localhost:14340/rpc`.
- **Follows the PoolPayer security review (a8ce107, b2cd1dd).** The v1 shape is exactly `[only_verify(fresh EOA),
  pay(verify), DEFAULT settle(1), DEFAULT refund()]`, with no tail and no expiry frame. `checkPoolPayerTx` mirrors
  `verify`:
  - BLOB_COUNT 0, an 836-byte pay frame, ≤ 2,048 unpriced bytes, ≤ 4 signatures, no value frames;
  - recipients ≠ PoolPayer, plus the min-gas, context, scope and fee checks;
  - the constants are checked against `PoolPayer.sol` and the selectors against `contracts/out`.
  - Refund limit 180k (MIN 150k).
- **Fee: exactly at cost, no margin.** The quote simulates the shape with a worst-case placeholder: all-nonzero proof
  words and fee = `type(uint96).max`. Then `fee := maxCost`. That is an upper bound, so the devnet e2e's +1 % is not
  needed: PoolPayer accepted `fee == placeholder maxCost`. `build` re-simulates and asserts `maxCost ≤ fee ≤ quote`.
- **Guardrails (§7).** Modes are exactly `relayer | frame-paymaster` (`assertWithdrawMode`), and the package exports
  no server. `rejectFeeOptions` refuses `fee/feeBps/margin/markup/operatorFee/feeRecipient`. Tests cover all of these.
- **Local devnet e2e (2026-11-06).**
  - Funding: sub-account `0xFf8F0cfC…bf5B` (key `keccak("leaked/privacy-package-e2e/v1")`), topped up from anvil #5
    (`0xb0316251…076a`), then its own nonce stream.
  - Fresh PP v1: Entrypoint `0x2386a554…e1b5`, pool `0xa5c0d741…ba60`, PoolPayer `0x0bc0b30d…3f93` (staked 0.012 ETH).
  - Vault-QR deposit `0xad18ebc2…70e5` (2 scans), then `updateRoot` `0x056ca60c…8800`.
  - Withdrawal `0xcf4e4e3a…4517` through **14340**: `New → Submitted → OnChain`. Frames 100 / **306,006** /
    472,169 (+587,520 state) / 25,796.
  - Fee 7.878e15 wei, refund 6.465e15. The fresh sender received 48,586,700,990,106,907 wei, which is exactly
    `amount − fee + refund`. The re-sync finds the change note `(0, 1)` = 0.05 ETH.
- **Open items.**
  - The ASP source is static (devnet). The 0xbow IPFS/API format is still to be implemented.
  - `externalSyncProvider` (saga CDN) is typed but not wired.
  - The extension must decide on GPL snarkjs vs another Groth16 engine.
  - The LEAKED-account-as-sender case is still the §10 open item.
  - No change is needed in `contracts/src/privacy`.

## Decision (2026-11-06): the Groth16 engine in the shipped extension
`@leaked/privacy` takes the Groth16 engine as an injected interface. snarkjs is GPL-3.0, and bundling it would make the extension bundle GPL. **The extension stays MIT:**
- The production prover is an **arkworks-based engine** (ark-groth16 + a circom witness loader, MIT/Apache) compiled to WASM, and runs in the offscreen document.
- snarkjs stays a test-only dev dependency, used as the cross-check oracle: the same zkey and inputs must give a proof that verifies on-chain.
- Before adopting a witness-generation component, check its license (circom's generated witness code and any wasm runtime).
Kohaku packages are not dependencies: `@kohaku-eth/plugins` has no license, and `@saga-sync/client` is GPL-3.0-only. Revisit when Kohaku publishes a LICENSE.

## Account: Open recipient mode and bound role signers (2026-11-06)

Code: `contracts/src/account/{ILeakedAccount,LeakedAccountImpl,LeakedAccountRoles,LeakedAccountStorage}.sol`,
`contracts/src/interfaces/{IRoleSignerFactory,ILeakedAccountRoles}.sol`; tests `contracts/test/account` (new
`BoundRoleSigners.t.sol`), `script/lint-verify.sh` step 4; devnet `devnet-tests/{account,g1}`, `devnet/deploy`. Spec:
§10.3.2 of `10-contracts.md` (as-built bullets, I-1/I-2/I-8, access matrix). Supersedes, in the extension M1 section,
**"The Vault signer is a stand-in until M4"** and **"Hot recipients are only what the Vault allowed"**, and in the G1
section the unbound-VaultSigner workaround of **"Account ↔ vault-signer CREATE2 cycle"**.

- **Recipient mode.** `RecipientMode { Open, Strict }`; Open is the initialize default (`InitConfig.recipientMode`).
  Open: a plain ETH send (empty data, value > 0) or an allowlisted, priced token's `transfer` may go to anyone but
  `address(0)`, within the bucket, `perTxMaxUsd` and `declaredUsd`. Unchanged in both modes: the token must be
  allowlisted (every outflow priced and debited); approve / permit / transferFrom / increaseAllowance, any other
  selector, ETH with calldata, and a zero-value empty call (it would run an arbitrary fallback) need a session (or the
  allowlist); I-6. Strict = the old recipient allowlist. `vaultSetRecipientMode`: Open → Strict instant, Strict → Open
  queued; vault only, not the guardian (its power stays a bounded, self-expiring pause; Strict is an open-ended change
  only a queued vault op can undo, so a guardian could impose a timelocked outage of everyday payments and gain
  nothing against a leaked key that freeze does not give).
- **The mode is not in a VERIFY slot.** The walker never decodes the batch, so it needs neither the recipient nor the
  mode. `bool recipientsOpen` is appended after `registeredFor` (inverted so a zero slot after an upgrade fails closed
  to Strict). I-2 proof: `Audit.t.sol` `test_I2_*` in Open and Strict (`AuditStrictTest` re-runs every C1/H1/M1/M2/L1
  PoC in Strict, `AuditTest` runs them in Open); `lint-verify.sh` adds a source rule (no `recipientsOpen` /
  `RecipientMode` / `targets` / role signers in `LeakedVerify.sol`), a layout rule and that test. Invariants: I-1 now
  records the measured outflow of each batch (any recipient); new `invariant_recipientPolicy` (Open-mode abuse, Strict
  violations, an arbitrary contract's fallback never runs) and mode loosening by a non-queued path counts as a
  violation.
- **Bound signers derived at initialize.** `InitConfig` gains `roleSignerFactory`, `vault` and `recovery`
  (`RoleSignerParams {salt, pk, verifier, payerKey}`) and `recipientMode`; `vaultSigner`/`recoverySigner` stay for
  explicit mode and must be 0 when the matching `pk` is given. `initialize` derives
  `predictRoleSigner(salt, role, address(this), pk, verifier, payerKey)` (refusing a codeless factory or a verifier
  without a fixed `sigLength`) and emits `RoleSignerDerived(role, signer, factory, salt, pk, verifier, payerKey)`, so
  anyone can deploy the clone later from the log alone. No cycle: the proxy address commits to the pk (init data), the
  clone to the proxy. A fresh account now needs the Vault pk before its address exists; no stand-in key.
  `BoundRoleSigners.t.sol` drives a real C13 Path B through a derived, lazily deployed clone (FrameSim); a clone with
  the same pk bound elsewhere gets `TargetNotAllowed`.
- **Cost.** `initialize` with two derived signers: account creation 2,504,524 gas on the devnet (G1; 2,258,493 before:
  +246k for two `predictRoleSigner` calls, the `sigLength` probes, events and the mode slot). Implementation 19.5 KB
  (was 18.2), roles module 18.0 KB. VERIFY unchanged: hot 45,750, Path B 36,213, Path A 151,701.
- **Devnet** (`devnet/deploy`, idempotent re-run checked): new `LeakedAccountRoles` `0x4B24758f…6b89`,
  `LeakedAccountImpl` `0xa23d5438…C520`; AccountFactory, C13Verifier, RoleSignerFactory unchanged. `testVault` stays in
  `addresses.local.json` (marked legacy; the generator reads it). Account devnet test: Open payment to a fresh address
  `0x8fdf8a78…6cff6` mined; after an instant Strict switch the same tx simulates VERIFY-valid with a failing SENDER
  (not sent); Strict → Open directly `MustQueue`; a bound account's stored vault equals `predictRoleSigner`.
- **G1 re-run (local devnet, anvil #0, sidecar :14340): all of (a)–(g) PASS.** Account `0x0E66eD21…728F`; VaultSigner
  `0x5D0B5660…8152` and RecoverySigner `0xf6008A58…ef9F` derived by initialize (no code before), deployed lazily by the
  G1 deployer key (575,946 / 575,984 gas) at those addresses; (a) Open-mode $3 to never-allowlisted
  `0xF91a2918…66e4`: `0x3eba3a36ec68d8687926f43ebf8b1aac85eb6d52d694d66b944c1a6144f4338f`; (b1) Path B tightening
  `0x0e240d30…04e`; the RecoverySigner cancel in (e) and the Path A tightening in (g) now run through bound clones
  derived at initialize. `last-run.json` has every hash.
- **What the extension must change** (only `src/generated/contracts.ts` was regenerated; `test/unit/account.test.ts`
  now fails in `encodeInitialize` until this lands): (1) the `InitConfig` shape above: bound mode with
  `roleSignerFactory = localDeployment.roleSignerFactory`, `vault = {salt, pk: vaultPk, verifier: c13Verifier,
  payerKey}` from pairing, so onboarding pairs the Vault before computing the account address (the plan's salt
  `keccak(hotKey, vault, recovery, version, chainId)` should hash the vault pk, not a signer address); the stand-in is
  explicit mode only; (2) deploy the VaultSigner clone (`createRoleSigner` with the same args, from the tank or the
  companion) before the first vault action, e.g. in the activation tx batch; (3) routing: in Open mode (read
  `recipientMode()`) an ETH send or an allowlisted-token `transfer` to any non-zero address within the cap and
  per-payment max is an everyday (hot) payment, not TARGET-NOT-ALLOWED; Strict keeps today's routing; everything else
  (approvals, other selectors, unallowlisted tokens) routes exactly as before; (4) "New recipient" stays a UI badge
  (ux-spec §3), not a policy result.
- **What the 7579 modules must mirror** (`contracts/src/modules`, not touched here): `LeakedPolicyHook` needs the
  same `RecipientMode` (Open default; ETH send / allowlisted-token `transfer` to any non-zero recipient; zero-value
  empty calls, ETH with calldata and every non-transfer selector still need a session; Open → Strict instant, Strict →
  Open queued; vault only), its storage zero value failing closed, and the same I-8 tests; the role executor's vault
  identity should be derivable from the pk the same way if its install data commits to a signer address.
- **Watcher** (`services/watcher`, `packages/watcher-core`): no existing event signature changed. New:
  `RecipientModeSet(uint8 mode)` (at initialize and on every change; Strict → Open only via `QueueExecuted`, so the
  queued-loosening alert already fires first) and `RoleSignerDerived(uint8 indexed role, address indexed signer,
  address indexed factory, bytes32 salt, bytes32 pk, address verifier, address payerKey)` (initialize only).
  `services/watcher/test/devnet.live.test.ts` encodes the old `InitConfig` and must add `roleSignerFactory: 0`,
  zeroed `vault`/`recovery` params and `recipientMode` (explicit mode keeps its EOA vault).

## leanSphincs-s as a second, experimental PQ scheme: Path A under the stock 100k budget (2026-11-06)

Follow-up of the decision "Path A scheme options after the M3 benchmark". Code: `packages/pq-signer` (`rust/src/lean_s/`,
`schemes.leanSphincsS` in `src/index.ts`, KATs in `vectors/leansphincs-s{,-upstream}.json`), `contracts/src/pq/
{LeanSphincsSVerifier.sol,vendor/LeanSphincs-SAsm.sol}`, tests `contracts/test/pq/LeanSphincsS*`, devnet run
`contracts/devnet-tests/pq/lean-path-a.ts` (`bun run lean-path-a`; result in `last-run-lean.json`, git-ignored).

- **Signer.** Byte-compatible Rust re-implementation of upstream `lssk` (SPHINCS- @ `4c76aaf`), Light tier (kept subtree
  b = 13, rated 20,000 sigs/key, an estimate). KAT A bit for bit: upstream's fixture (6 vectors, b = 6/10/12), the
  crate's `known_answer` (b = 11) and the bench's `lssk sign-key` vectors (b = 13). KAT C (32 vectors) also passes
  upstream's independent Python verifier and the unmodified upstream Solidity verifier. Hedged `R_0` by default;
  `{deterministic: true}` = upstream. No node cache: the 64-byte secret key stays the C13 shape and every signature
  rebuilds the subtree (WASM sign 474 ms median vs C13 2.61 s; BENCH.md).
- **No key reuse across schemes.** Derivation is one function for both schemes, `HMAC-SHA512(key = "leaked/v1/" ‖
  schemeId ‖ "/" ‖ role ‖ "/" ‖ scope, msg = seed)`; leanSphincs-s has `schemeId = keccak256("leanSphincs-s/keccak/v1")`
  = `0x5f6989ca…29daed` (tests: `rust/tests/lean_derive.rs`, `test/lean.test.ts`). b = 13 is fixed by that id.
- **API / flag.** The C13 top-level exports are unchanged; `schemes.c13` / `schemes.leanSphincsS` share the
  `PQScheme` shape, `schemeById(id)` maps an on-chain `IPQVerifier.schemeId()`. `schemes.leanSphincsS.experimental ===
  true`, `warning` = "Experimental: no formal proof yet; enables quantum-safe approvals on any mempool". The package
  README has the proven / not-proven comparison with C13. `wasm/` rebuilt (118 KB, sha256 `88b83ac0…6f4f`), reproduced
  byte for byte from a clean target.
- **Adapter.** `LeanSphincsSVerifier` = upstream `LeanSphincsSAsm` (vendored byte-identical, the same code as the
  bench's copy; `scripts/onchain-crosscheck.sh` checks both against upstream) + the `C13Verifier` adapter shape: length
  check first, `pk = P ‖ root` split into high-aligned words, self-STATICCALL, revert → false. Foundry over KAT C: min
  42,085 / mean 42,314 / max 44,726 gas (44,846 cold); `VERIFY_GAS_ESTIMATE` 50,000. Bytecode pre-filter: only solc's
  trailing INVALID.
- **FrameSim** (`test/pq/LeanSphincsSPathA.t.sol`): a `RoleSignerFactory` clone with this verifier takes
  `sigLength = 4164`, Path A and Path B succeed, forged / other-digest / C13 witnesses are rejected (no nonce burnt on
  Path A). FrameSim's mocked opcodes make its frame gas indicative only (2.2M); the devnet figure below is the
  measurement.

### Path A on the local devnet through the STOCK sidecar (no stake, no BUDGET-010)

VaultSigner clone `0x26110757cc6C48Ac25dD94C4e7840BAbA48f7eb0` (PQRoleSigner implementation `0xE90a0a30…4a61`, factory
`0x1c0aeba1…496c`, payer key none: Path A only) bound to a MockLeakedAccount `0xb225fe48…b806`, verifier
`LeanSphincsSVerifier` `0xfa9707fb…bf6f` (deploy 7,055,152 gas); funded from anvil #2. Tx `[VERIFY(self,
verifyFrame(0)) limit 99,900, SENDER(self, relay(mock, vaultExecute(0.001 ETH)))]`, one ARBITRARY 4,164-B witness:

| | Result |
|---|---|
| `ethrex_simulateFrameTransaction {trace:true}` | `canonicalMempoolValid: true`; VERIFY trace clean (no banned opcode, no write, no transient, storage only the clone's slot 0 read through its implementation) |
| Stock sidecar `:14337` `eth_sendFrameTransaction` | **accepted**, mined: `0x39ae1b005efcda92d9e765ece9dafbddfd4a630f53cf8164fff3a77e8309ba9e`, block 1461 |
| **VERIFY frame gas (PQ verify inside, incl. PQRoleSigner overhead)** | **84,465** (receipt `frameReceipts[0]`); verifier call 41,159, so the role-signer glue (clone hop, args via EXTCODECOPY, SIGPARAM/FRAMEPARAM walk, SIGDATACOPY of 4,164 B, slot-0 read, APPROVE) is 43,306 |
| SENDER frame | 36,353 execution + 281,520 state (fresh recipient account and the mock's writes, Amsterdam+ state gas) |
| Receipt gasUsed | 588,394 (the bench's self-send shape is 281,146; the difference is the state gas above) |
| Forged witness (WOTS+C counter flipped) | simulated only: VERIFY reverts (`validation prefix frame reverted`); not submitted (poisoned-lane rule) |

- **Path A fits 100k with 15.4k to spare** at the declared limit (99,900 + 100 ARBITRARY = 100,000). C13 in the same
  shape is 151,701 (G1 g2). So a leanSphincs-s VaultSigner gets PQ-in-VERIFY on any stock mempool, with no payer ECDSA
  key and no griefing surface; the router rule of the decision entry (scheme VERIFY gas + overhead ≤ budget) selects it.
- The shared trace gate in `devnet-tests/pq/lib.ts` now takes the set of "own" addresses (sender + implementation),
  as G1's does: a clone's slot-0 SLOAD is reported under the implementation's code address. `run.ts` still passes the
  sender only (unchanged behaviour).
- Open before any real funds: an independent review of the leanSphincs-s lifetime argument at b = 13 (upstream:
  estimate, not proved) and of the verifier (no formal proof, unlike C13); the UI keeps the scheme behind its
  experimental flag.

## @leaked/groth16: the arkworks Groth16 engine (2026-11-06)
Implements the "Groth16 engine" decision above. `packages/groth16`, MIT; `@leaked/privacy` is unchanged.
- **Shape.** Rust crate `leaked-groth16` (arkworks 0.6: ark-groth16, ark-bn254) → wasm-bindgen 0.2.117 → committed,
  reproducible `wasm/` (663 KB, inlined base64; CI job `groth16-wasm` rebuilds and diffs, as `pq-signer-wasm` does;
  panic paths are remapped so the bytes do not depend on the build machine). TS: `createArkworksGroth16()`
  implements `Groth16Backend` (`fullProve` **and** `verify`, so `createGroth16Prover`'s self-check always runs: the
  privacy review's point; `test/privacy-integration.test.ts` asserts the call). `createDefaultProver` /
  `serveDefaultProver` are the default wiring for the offscreen-document Worker.
- **Own code, not ark-circom.** A zkey reader (snarkjs binfile; coefficients are double-Montgomery, points
  single-Montgomery; the public-input rows are dropped and re-added by the reduction) and circom's R1CS-to-QAP
  reduction (A·B − C on the odd 2n-th-root coset, no division by Z), plugged into ark-groth16's
  `create_proof_with_reduction_and_matrices`. ark-circom would pull wasmer into the WASM build.
- **Witness generation.** circom's `witness_calculator.js` is GPL-3.0 (iden3/circom `COPYING`), so it is not used.
  Our glue is written from the witness module's interface and runs the circuit in the host's WebAssembly engine (V8:
  33 ms; CSP needs only `'wasm-unsafe-eval'`). The same glue on wasmi (MIT/Apache) serves the native CLI and Rust
  tests (161 ms). Cross-checked element for element against snarkjs' calculator.
- **No bogus proofs.** Circuit assertion failures surface as `WitnessError` (circom code 4); any witness that gets
  past them is refused by the core, which verifies each proof against the zkey's own vk before returning it
  (`ConstraintUnsatisfiedError`).
- **Verified.** Same zkey + inputs: our proof verifies with snarkjs and with a forge-compiled temp copy of
  `WithdrawalGroth16Verifier` (the MIT verifier with the deployed key); snarkjs' proof verifies with ours; tampered
  proofs/signals are rejected by both. Native Rust tests check the zkey's vk equals the pinned `withdraw.vkey`.
- **Times (M3, withdraw circuit).** WASM in Node 2.39 s full prove (single-threaded) vs snarkjs 1.65 s
  (multi-threaded); native 0.79 s (1 thread) / 0.20 s (rayon). Threaded WASM needs a cross-origin-isolated offscreen
  document (SharedArrayBuffer); deferred. BENCH.md.
- **License exceptions needed.** Two hard transitive arkworks deps are permissive but not MIT/Apache: `subtle`
  (BSD-3-Clause, via RustCrypto `digest`; notice reproduced in THIRD_PARTY.md) and `foldhash` (Zlib, via
  `ark-relations` 0.6). Everything else in the WASM is MIT and/or Apache-2.0. **Decide:** accept both (recommended;
  no copyleft), or move to arkworks 0.5 to drop `foldhash` (`subtle` remains under any RustCrypto-based stack).
- **Open.** `withdraw.wasm` is circom output with circom's runtime arithmetic embedded; whether circom's GPL reaches
  it is a legal question about the pinned artifact (not this engine). Not audited.

## Decision (2026-11-06): license exceptions for `@leaked/groth16`
- **Accepted:** `subtle` (BSD-3-Clause; notice reproduced in THIRD_PARTY.md) and `foldhash` (Zlib). Both are permissive with no copyleft, and both are required by arkworks. The shipped extension stays MIT-compatible.
- **Open (legal review, not engineering):** `withdraw.wasm` is circom compiler output embedding circom's field-arithmetic runtime, and circom itself is GPL-3.0. Whether the generated artifact is covered depends on the artifact's own license (see the circuits package license above) and on circom's position on generated code. Ask a lawyer or 0xbow before a store release.

## 7579 modules: Open recipient mode and the bound vault identity (2026-11-06)

Mirrors "Account: Open recipient mode and bound role signers" in `contracts/src/modules`; the "7579 modules after
the security review" fixes (A1 to A5) and host matrix are unchanged. Commits `9dbb5a7` (modules + tests), `fd2573c`
(anvil e2e), `d24cc3d` (watcher-core ABI regenerated).

- **`LeakedPolicyHook` recipient mode.** `ILeakedModules.RecipientMode { Open, Strict }`. `HookInit.recipientMode`
  is appended, so a zero-filled install gets Open (the default). It is stored as `bool recipientsOpen` in policy
  slot 0, which the validator already reads, so ERC-7562 needs no new slot. The flag is inverted so that a slot that
  was never written, or was cleared by `onUninstall`, reads Strict: `recipientMode(account)` is Strict for an unknown
  account. `_checkCalls` follows the account's classification:
  - In Open, `d.length == 0 && value > 0` to any target and an allowlisted priced token's `transfer` to any `to != 0`
    count as payments, within `perTxMaxUsd` (static, in validation) and the bucket (in `postCheck`).
  - In both modes these still need a session or the allowlist: a zero-value empty call, ETH with calldata,
    `approve`, `transferFrom`, `increaseAllowance`, an unallowlisted token, a `transfer` to 0, and any call to the
    account, the hook or the executor.
  - `setRecipientMode(account, mode)` is executor-only. Open → Strict is instant. Strict → Open goes through
    `_authLoosen`, so it must be queued. The executor's `_checkShape` admits the selector in vault batches only, so
    guardians can still only freeze. Event: `RecipientModeSet(account, mode)`, emitted at install and on every change.
- **`LeakedRoleExecutor` binding.** In 4337 the PQ check already runs in execution (`vaultExec` and the others), and
  the role identity was already `(verifier, vaultPk/recoveryPk)` stored per account. There is no signer address to
  derive, so nothing like `predictRoleSigner` is needed. Minimal change:
  - `onInstall` probes `verifier.sigLength()` with `RoleSignerFactory`'s rule (1..65535) and refuses a
    variable-length verifier (`BadConfig`).
  - It stores the length (`sigLengthOf`) and emits `VaultBound(account, vaultPk, verifier, sigLength)`.
  - `_verify` refuses a witness of any other length before it calls the verifier.
- **Tests (323 module tests, all green; `6dc76dd` adds the Open-payee reentry PoC of the account review).**
  - Every host suite (MSA, Safe7579, Kernel) runs in Open, plus a `*StrictTest` re-run of each.
  - The audit PoCs A1 to A7 run in both modes (`LeakedModulesAudit*StrictTest`).
  - New recipient-mode tests: `test_recipientMode_*` and `test_executor_bindsVaultPkVerifierSigLength`. The ERC-7562
    test validates an Open payment to a never-allowlisted recipient.
  - Invariants run in Open and Strict and add `invariant_recipientPolicy`: no Strict payment to a non-allowlisted
    address, a fallback probe never runs from a hot non-payment, and the mode changes only on vault paths. Instant
    Strict → Open counts as an unauthorized write.
  - Mutation check: treating Strict as Open fails the Strict invariant and tests. Admitting zero-value calls in Open
    fails the probe and `nonPaymentsNeedSession`.
  - The C13 fixture was regenerated because the MSA address moved with the init data.
- **Anvil e2e** (`devnet-tests/4337`, `bun run e2e`, `last-run.json`). A new step 3a' sends $30 in Open mode to
  `0x…0f2e55` (`isTarget` false): mined in tx `0x8dbb75f6…109c`, 300,262 gas, bucket debited to $670. The rest is
  unchanged:
  - over-perTx is refused in simulation;
  - over-cap fails in execution with `OverCap(300, 220)`;
  - the C13 vault exec is relayed by a SimpleAccount (sigLength 3688).

  Account creation costs 676,372 gas (was 649,136).
- **Watcher.** The live devnet test already builds `InitConfig` from the artifact (`20bfcd8`). It was re-run with
  `LIVE_DEVNET=1` on the local devnet with anvil #9 and passes 26/26 (account `0xA69aBD84…CDcD`). The watcher-core
  ABI now includes the modules' `RecipientModeSet` and `VaultBound`. `RecipientModeSet` decodes by name into a
  settings change, so the frame and 4337 backends alert the same way. No rule reads `VaultBound` yet.

## Account hardening: independent role keys and self-defeating hot recipients (2026-11-06)

Follow-up of the delta review (`9b918a3`). Execution side only: `LeakedVerify` is unchanged, `script/lint-verify.sh`
passes, and the G1 re-run (all 7 items pass) records the same VERIFY gas as the previous run for every tx (for
example hot 45,750, Path B 36,213, Path A 151,701).

- **Role independence** (`SameRoleKey()`, `BadAddress`).
  - `initialize` refuses a recovery holding the vault's PQ public key. The keys come from `InitConfig.vault.pk` /
    `recovery.pk`. For an explicit signer the account reads `pk()` from the deployed `PQRoleSigner` (gas-bounded
    staticcall). A code-less or non-PQ signer reports no key and is checked by address only. PoC: with the same pk
    the two derived addresses differ (the role is in the clone's args), so the old address check let it through.
  - The vault and recovery signers must also differ from the hot key (and, as before, from each other, the account
    and the tank).
  - The same rule applies on every later install: `vaultSetRecoverySigner` (first install and queued change; the new
    signer also differs from the hot key, the tank and a pending vault) and `recoveryStartVaultRotation` (the new
    vault differs from the hot key and the tank, and holds no recovery key). `vaultSetHotKey` and
    `vaultSetFeePolicy` (tank) refuse the vault, recovery and pending-vault signers.
  - Limit: a counterfactual signer (bound, not yet deployed) passed by address to a later install has no readable
    key. Only `initialize` sees both keys as parameters. `InitConfig` is unchanged.
- **Hot recipients** (`ForbiddenRecipient(address)`, `_checkRecipient`).
  - In both modes an ETH send or `transfer` never pays the account itself, the vault or recovery signer, or the token
    being moved (`to == token`). This check runs before the allowlist and mirrors H2 (`_checkPolicyTarget`), so a
    recipient that was allowlisted before a role change (for example made the vault by a rotation) is refused too.
    A pending vault is not checked: the rotation freezes the hot tier until it finalizes.
  - In Open mode, a recipient that is not allowlisted is also refused when it is the tank, an enabled guardian or an
    allowlisted token contract. The tank's top-up path is its allowlist entry from `initialize`, which still works in
    both modes. A tank re-pinned by `vaultSetFeePolicy` needs `vaultSetTarget`, as before. Strict reports these as
    `NotAllowed`.
  - address(0) is still `NotAllowed`. Hot SENDER cost rises by about 4.5k gas per payment leg (G1 hot payment
    314,037 → 323,033 gas).
- **Tests.** `test/account/AccountHardening.t.sol` holds 17 units/PoCs, run in Open and Strict
  (`AccountHardeningStrictTest`). The `HotExecute` Open fuzz now excludes role signers and the guardian. The full forge
  suite is green (761 pass, 3 skip at this commit).
- **Extension ABI.** The two new errors were added to `apps/extension/src/generated/contracts.ts` by running
  `scripts/gen-contracts.mjs`. No `InitConfig` change.
- **Modules: what they should copy** (`src/modules`, not touched here):
  - `LeakedRoleExecutor.onInstall` should refuse `recoveryPk == vaultPk` (same verifier or not), and so should any
    later recovery-key or vault-key rotation.
  - `LeakedPolicyHook._checkCalls` in Open should refuse a payment `to` the account, the hook, the executor, the
    token itself (`to == token`), an enabled guardian, the tank, or an allowlisted token, unless it is allowlisted.
    The account, the hook, the executor and `to == token` should be refused in both modes.

## Extension M3 + M4: Vault-first onboarding, the Vault flow, scoped 1271 (2026-11-06)

Code: `apps/extension/src/background/{account,vault,vaultActions,lanes,signin,wallet,payments,policy,engine}.ts`,
pages `src/pages/app/{Onboarding,VaultHandoff,Pending,Limits,Security}.tsx`, `src/pages/approve/SignatureBody.tsx`,
`src/ui/QrHandoff.tsx`; tests `test/unit/{vault-interop,lanes,policy-open,signin}.test.ts`, e2e `e2e/vault.e2e.ts`
with the simulated phone `e2e/support/companion-sim.ts`. Local devnet, funding key anvil #7.

- **Onboarding order** (task brief; ux-spec §3.1 differs only in putting the limit before Recovery): create →
  pair the Vault (`ur:leaked-pq-key`, camera or paste, the 8-character check, "This matches") → Recovery ceremony
  (scan the Recovery key's pq-key code, then its `ur:leaked-recovery-test` code, verified in the service worker
  against `recoveryTestChallenge`; E-23 on a different key) or "Set up later" with the risk sheet → optional Guardian
  (stored; added with one Vault approval after activation, `InitConfig` has no guardian field) → daily limit and
  "who can you pay" (Open default, Strict explained) → network → the address is computed (`account:computePlan`)
  → fund the tank → Activate. There is no "skip the Vault" any more. The M1 test-vault stand-in is gone from every
  path (`testVault` stays in addresses.local.json for explicit-mode tests of other workstreams only).
- **InitConfig** is the bound shape: `vault = {salt, pk, C13Verifier, payerKey}` from pairing, `recovery = {salt,
  pk, C13Verifier, payerKey: 0}` when the ceremony finished (the companion pairs no payer for Recovery), Open
  recipients. Account salt = `keccak(hotKey, vaultPk, recoveryPk, "leaked.account.2", chainId)`; the role salt is
  derived from it. Signer addresses come from `RoleSignerFactory.predictRoleSigner` (eth_call) and are checked
  against `getRoles()` in the e2e.
- **Plan-frozen mismatch fixed**: `Payments.plan()` no longer computes anything; the plan is built only by
  `computePlan` at the end of onboarding, from the limits the user just set, and may be recomputed only while the
  address has no code, no balance and no activation (else `frozen`).
- **Activation** = two legacy txs from the tank: `createAccount` and `createRoleSigner(vault)` with a 0.02 ETH float
  (the signer pays its own fees, ~0.001 ETH per approval). A missing signer is also deployed lazily before the
  first Vault request (`VaultFlow.ensureSigner`); the Recovery signer (0.03 ETH float) on its first use.
- **Vault requests** (`VaultFlow.create`): action → account calldata (`vaultActions.ts`: tighten = direct setter,
  loosen = `vaultQueue([setter], KIND_LOOSEN)`, sends above the Vault's instant allowance = `vaultQueue(calls,
  KIND_SPEND)` with the calls kept for `executeQueued`) → path (`lanes.ts`) → `roleSignerPathBTx` / `PathATx`
  (Path B VERIFY 90k; body 700k execution / 400k state; fees 2 × base + 1 gwei) → `ur:leaked-sign-request` keys
  1–12 (11 intent with action/recipient/amount/token, 12 the current limits and pinned prices; role 1 or 2).
  `vault-interop.test.ts` decodes every action with `apps/companion`'s `reviewRequestBytes` and signs with its
  worker `handle()`: same digest, no mismatch, clear-signed, except `vaultSetRecipientMode`, which the companion's
  registry does not know yet (shown as an unknown step: BACKLOG).
- **Pre-verification before anything is sent** (`VaultFlow.submit`): request id (E-61), expiry (E-60, 10 min), scheme
  id, the witness against the signer's on-chain `pk()` with `@leaked/pq-signer` (`schemeById`), on Path B the payer
  signature recovered against `payerKey()`, then `ethrex_simulateFrameTransaction` of the exact bytes (valid, SENDER
  frame ok, MAX_COST ≤ the signer's `maxFee`, signer balance), then submit (ethrex, or the staked sidecar). A failed
  check leaves the request waiting (scan again). The WASM verifier runs in the MV3 service worker: CSP
  `script-src 'self' 'wasm-unsafe-eval'` (nothing else changed), `initSync` from the embedded bytes; the e2e asserts
  the SW instantiated it and that no `.wasm` was fetched.
- **Path A / B** (`choosePath`): Path A when the scheme's `verifyGasEstimate()` + 45k role-signer overhead + 100
  fits the lane: the stock 100k (leanSphincs-s: limit 99,900) or a BUDGET-010 sidecar's `skandha_config.budgets`
  staked budget when the signer is staked in the registry (C13). Else Path B if the signer has a payer key. Else
  "no lane" with the reason. Network table gains `stakedSidecarUrl` (local: `:14340`).
- **Recovery bootstrap gap (found here, needs a contracts or companion decision):** a Recovery signer has no payer
  key (the companion's recovery pq-key has none and its recovery mode refuses 2-signature txs, E-78), so it can only
  send Path A, which for C13 needs the staked lane; staking is `executePQ/relay(self, stake)`, i.e. a transaction the
  unstaked signer must send itself. On the public lanes that loop has no way out. The e2e plays the operator: it
  deploys the derived clone from the account's `RoleSignerDerived` log and mines `relay(self, stake(86400, 0.012))`
  through ethrex's private builder hook (`ethrex_submitPrivilegedFrameTransaction`, local devnet only); after that
  the extension's own Recovery cancel goes Path A through the BUDGET-010 sidecar. Fix options: stake in
  `RoleSignerFactory.createRoleSigner` from `msg.value`, or a Recovery payer key in the companion.
- **Hot body gas (bug found by the M4 e2e):** an Open payment to a fresh address ran out of gas: the frame's
  `gasUsed` is execution only, and the ~205k state gas of a new account is taken from the execution limit on this
  ethrex build. The engine now sizes the body from the transaction's `gasUsed` minus the prefix frames (× 1.25 +
  20k), state 300k. `parseSimFrames`: a frame without any outcome now counts as failed (BACKLOG decision: fail closed).
- **M3**: `personal_sign` / zero-value typed data → approval window "Sign in" (SIWE fields, domain must equal the
  origin host or E-50 blocks it, first-sign-in warning with an in-extension "always allow" list = ux-spec §9.1
  option a) → ERC-7739 PersonalSign / TypedDataSign by the everyday key in the account's domain ("LEAKED", "1").
  The e2e checks the SIWE signature with an `isValidSignature` eth_call (code-less caller) → `0x1626ba7e`. ERC-2612
  `Permit` → "Pre-approve": a hot batch `registerPermit(token, spender, value, deadline)` (routed and priced like a
  token payment, counts against the limit), waits for it to be mined, checks `registeredHashExpiry(digest)` and
  returns `REGISTERED_MARKER ‖ digest`. Permit2 / Seaport / orders / unknown value-bearing → `4100` with
  `leakedRule` and a plain remedy (the Vault can't help: its PQ key never signs for sites). The e2e's permit stops
  at the honest "token isn't on your allowed list" (a fresh account has no allowed tokens: `InitConfig` has no token
  list and adding one waits ≥ 1 h), with nothing sent.
- **Dapp payments over the limit** stay pending while the phone approves (`approval:toVault`); the site gets the
  Vault transaction's hash when it is sent.
- **Privacy of capabilities**: `wallet_getCapabilities` now returns `leaked: {backend, activated}` only (no limit or
  remaining amount). **Embedded frames**: the content script sends `location.ancestorOrigins`' top entry; the
  approval window names the page the frame is in.
- **Not done / open**: guardian freeze deep link; Vault-signer top-up UI; hot-key rotation is wired (keyring index,
  adopted once `vaultSetHotKey` confirms) but not e2e-tested; Pending lists `Queued` from a `fromBlock: 0` log scan
  (fine on the devnet, needs a cursor for mainnet); watcher alerts and the privacy tab remain (BACKLOG).

## Account: initial tokens, recovery payer key, module mirrors (2026-11-06)

Commits `0f7a63b` (account), `d160c2d` (modules), `c4a03b3` (G1), `2bba64d` (deploy + generated ABIs). Execution side
only: `LeakedVerify` untouched, `lint-verify.sh` OK (step 4 now also runs the init-token I-2 test), VERIFY gas unchanged
on the devnet (hot 45,750, Path B 36,213, Path A 151,701). Forge: 884 pass, 3 skip.

- **New `InitConfig` field (appended, last): `tokens: TokenInit[]`, `TokenInit {address token; uint8 decimals;
  uint256 usdPerToken}`** (USD-6 per whole token, as `vaultSetToken`). Set atomically at initialize, one
  `TokenConfigured(token, true, decimals, usdPerToken)` each (same event as the setter), appended to `getTokenList()`.
  Refused: more than 16 (`TooManyTokens`), a repeat (`DuplicateToken(address)`, new error), a token that is zero,
  code-less, the account, a role signer, the hot key or the tank (`BadAddress`), `usdPerToken == 0` or `decimals > 36`
  (`BadConfig`). ETH stays `ethUsdPrice`. After initialize the list is ordinary vault state (removal/raise instant,
  add/lower queued). I-2: the token slots are execution-only; `InitTokensAndPayers.t.sol` checks VERIFY reads none of
  what initialize wrote and costs the same gas with or without a list, in Open and Strict. Account creation on the
  devnet (empty list) 2,508,090 gas (2,504,524 before).
- **Role payer keys** (no new field: `RoleSignerParams.payerKey` already exists and is already in the derivation,
  `predictRoleSigner(..., payerKey)`). New initialize checks: a non-zero `vault.payerKey` / `recovery.payerKey` is never
  the hot key or the tank, and the two differ (`BadAddress(payer)`). `recovery.payerKey = 0` stays allowed (Path A only).
  FrameSim test: a derived RecoverySigner with a payer runs `recoveryCancel` on Path B with a real C13 signature; with
  payer 0 the same tx fails VERIFY (`PathBDisabled`). G1 (e) now asserts the on-chain `payerKey`, no stake, the
  signer paying its own fee, public mempool (`0x36cef15d…cdad`, all of (a)–(g) PASS, `g1/last-run.json`).
- **For the extension** (`src/generated/contracts.ts` regenerated; `encodeInitialize` must add `tokens`, `[]` keeps
  today's behaviour): pass `recovery.payerKey` from the companion's recovery pairing (it must differ from the vault
  payer, the hot key and the tank, else creation reverts); Path B is then a lane for Recovery, which removes the
  bootstrap gap of the M4 notes (no stake, no private builder hook). Optionally pass `tokens` (≤ 16 priced ERC-20s,
  e.g. the devnet test tokens) so a fresh account can pay and `registerPermit` without a ≥ 1 h queued `vaultSetToken`;
  each listed token is also a value verifier for hot 1271 (the hot verifier rule), as with the setter.
- **For the companion**: a Recovery key needs its own SECP256K1 payer key held on the recovery device (Path B entry 1,
  signed over the same sig hash as the vault's), exported with the recovery pq-key so the extension can put it in
  `InitConfig.recovery.payerKey`; recovery mode must accept the 2-signature Path B shape (E-78 refuses it today).
  `abi:sync --check` reports no drift (no registry function changed).
- **7579 modules (mirrors).** `LeakedRoleExecutor`: `SameRoleKey()` (new error) at install, on `setRecoveryKey` (vault
  or pending vault key) and on a rotation to the recovery's key (was `BadConfig`); `isGuardian(account, who)`.
  `LeakedPolicyHook`: the hot key is never the account, the hook or the executor; in Open a recipient that is not
  allowlisted is never an allowlisted token (validation) or an enabled guardian (execution only: the guardian set is
  not an account-associated slot, so the userOp passes validation and reverts in `preCheck`), as `NotAllowed`;
  `HookInit.tokens`: ≤ 16, `DuplicateToken`, a contract other than the hot key. Tests `LeakedModulesMirrors.t.sol`
  (3 hosts × 2 modes), invariants `rolesIndependent` and forbidden recipients; anvil 4337 e2e green.
- **Watcher**: `packages/watcher-core/src/generated/abi.ts` regenerated (new errors only; no event changed).
  `services/watcher/test/devnet.live.test.ts` encodes `InitConfig` and must add `tokens: []`.

## Companion follow-ups: Recovery fee key, leanSphincs-s guard, updates, log, navigation (2026-11-06)

Commits `538f22a` (registry), `5cd9faf` (`@leaked/ur`), `16a8c71` (companion). Unit 161, e2e 14 (the 7 earlier ones
plus `e2e/followups.e2e.ts`) on the built PWA; screenshots `apps/companion/docs/screenshots/` retaken (new: 02b, 02c,
13b, 17–21).

- **Registry.** `vaultSetRecipientMode` is clear-signed: Open = "Let your everyday key pay any address" (loosening;
  queued, else the direct-loosening warning), Strict = "Only pay approved addresses" (instant). `looserWhen`/`derived`
  accept an enum value. The drift test now also scans `LeakedAccountRoles.sol` (the function was in the roles module but
  not in `ILeakedAccountRoles`, so the old check missed it). **Extension:** `test/unit/vault-interop.test.ts` still
  expects `phoneKnows: false` (unknown step) for "Strict recipients" and now fails on `review.unknown`; flip it.
  `InitConfig.tokens`: the phone never signs `initialize` (the tank sends `createAccount`), so there is nothing to
  decode there; no `initialize` descriptor was added on purpose (it would make an unsignable call look signable).
- **`@leaked/ur` (backward compatible).** A pq-key may carry key 4 `payer` for role 2. `ur:leaked-recovery-test` gains
  optional key 6 `payer`; with it the witness signs `keccak256("LEAKED recovery test v2" ‖ schemeId ‖ pk ‖ requestId ‖
  payer)` (cross-checked with `cast keccak`); without it v1 is unchanged. Verify with `recoveryTestChallengeOf(test)`
  (the extension did so in `0f2caf5`). `KNOWN_SIG_LENGTHS` gains leanSphincs-s (4,164).
- **Recovery fee key.** BIP-32 `m/44'/60'/8141'/1'/0'` of the Recovery words (hardened, apart from the Vault's
  `m/44'/60'/8141'/0/0`: independent even if one mnemonic were reused). Shown in the ceremony's pq-key (with the pk),
  carried in every recovery-test code, held in the worker's recovery session and wiped with it. Recovery mode signs
  entry 1 of a Path-B tx over the same sig hash (`v‖r‖s`), exactly as the Vault does; E-78 only refuses a fee slot that
  names another key. `test/recovery-interop.test.ts` builds the request with the extension's own `signRequest` over
  `roleSignerPathBTx` (the G1 (e) shape) and checks the answer the way the extension pre-verifies it.
- **leanSphincs-s** (Settings › Experimental, off by default; the choice and the pq-signer warning text with an
  "I understand" box at create and restore). Counter per key (per pk) in `VaultRecord.usage`: sealed with the seed's
  AES key (AAD `leaked-companion/usage/v1/<pk>`) plus a plaintext hint for the screens; the worker enforces
  `max(sealed, hint)`, refuses an unopenable counter, increments on every signature it returns (retries count; a
  failed self-check returns nothing and is not counted), and the UI stores the new count before it shows the QR.
  Restored = unknown = exceeded. Levels from `budgetStatus`: warn ≥ 50 % (Home banner, approve-sheet note), ≥ 90 %
  approvals need a prepared replacement, ≥ 100 % refused (E-73), in the UI gate and again in the worker.
  `estimatedSecurityBits` is shown on Key health, labelled an estimate. Rotation (Key health › Replace the key): key
  #n+1 = `chainScope "any-n"` from the same words (nothing new to back up), its pairing code, then the browser's
  Replace the Vault + Recovery approval (7 days). A request naming the new pk signs with it and promotes it (old pk
  retired; the seed stays AAD-bound to the first pk via `sealedFor`). Restore asks for the key number. Not done:
  exporting the count with the key metadata (no import path exists; a restore counts as exceeded instead).
- **Updates (trust model).** No `skipWaiting` at install, no `clients.claim`. `sw.js` carries the SHA-256 of every
  precached file (taken in `writeBundle`, from the files as written) and the build id = hash over them; install fails
  on any mismatch (e2e: a tampered digest never installs). The worker serves the build the user last approved (a
  record in a meta cache) even after the browser activates a newer worker, until "Update now" (sheet shows build X →
  Y, commit · file hash). Limits: the origin is trusted for code, as for any web app: a malicious `sw.js` can ignore all
  of this; what the user gets is no silent swap and a build id to compare with a published one. The first new-style
  worker over an old cached build keeps serving the old one ("previous") until approved.
- **Passphrase.** zxcvbn-ts 4.2.0 (MIT, `@zxcvbn-ts/core` + `language-common` 4.1.3 + `language-en` 4.1.1, lazily
  loaded chunk, ~850 KB gzip, precached): score ≤ 1 blocked, 2 warned. Passphrase fields use `autocomplete="off"` plus
  the 1Password/LastPass/Bitwarden/Dashlane opt-outs: `new-password` invites a generated-and-synced copy, and a cloud
  copy plus this phone's storage opens the key; there is no username field for save heuristics.
- **Activity log.** Sealed box per entry (X25519 + HKDF-SHA256 + AES-GCM) to a log key whose secret is wrapped like the
  seed (`logkey` blob); entries are appended without the passphrase, read in the worker after it (Settings ›
  Activity). Older plaintext logs are re-sealed at the first unlock; Vaults made earlier get a log key at their next
  signature. Without a Vault (Recovery tools only) nothing is logged. Visible without the passphrase: the count.
- **Navigation.** `src/navGuard.ts`, imported first: cancels cross-origin navigations of the window (Navigation API)
  and replaces `window.open`. A speed bump, not a boundary (no CSP directive covers navigation since `navigate-to` was
  dropped; DNS prefetch and other side channels remain); the boundary is still that secrets live only in the worker.

## Extension M2: the 4337 backend, InitConfig tokens and the recovery payer (2026-11-06)

Code: `apps/extension/src/background/aa/{config,userop,payments,executor,vault}.ts` (wired into `Payments` and
`VaultFlow` by `plan.backend === "4337"`), onboarding step "Tokens you'll spend", `pair:recoveryChallenge`; tests
`test/unit/{aa,recovery-challenge}.test.ts`, the hash-mismatch case in `vault-interop.test.ts`, contract-in-the-loop
`test/devnet/aa.devnet.test.ts` (`LOCAL_4337=1`), e2e `e2e/aa.e2e.ts`; local chain `devnet/deploy/{deploy-4337,
bundler,up-4337,smoke-4337}.ts` (`c96eb23`); UR additions `d0ae1b2`.

- **Host: the reference MSA (`MSAAdvanced` + the v0.8 EntryPoint shim `MSAAdvancedEP`), created by `MSAFactory` with
  `Bootstrap.initMSA(validator, executor, hook)`.** Against Safe7579: no keyless `0xdEaD` owner to get right (A5),
  module reverts bubble (the route copy and the activity name `OverCap`, `NotAllowed`), ~29k less gas per hot op
  (388k vs 417k, M7); against Kernel v3.3: hot ERC-1271 must be off there (A3), so no sign-in and no permits. Cost:
  Rhinestone publishes no v0.8 MSA build, so LEAKED deploys its own shim on every chain (CREATE2, deterministic).
- **Account = CREATE2 of the whole init code** (`MSAFactory.getAddress(salt, initCode)` by eth_call), salt
  `keccak(hotKey, vaultPk, recoveryPk, "leaked.account.4337.1", chainId)`. `HookInit`: limits, `maxFeeWei` 0.01 ETH
  (the per-op prefund bound, the tank's `maxFeeWeiPerTx` on the native account), the chosen tokens, the fee tank as the
  one allowlisted target, Open. `ExecutorInit`: C13Verifier, Vault pk, Recovery pk (when tested), 48 h, $1,000.
  Activation is a plain `createAccount` tx from the tank (826,665 gas; ERC-7562 [STO-022] rules out initCode in a
  first userOp without a staked factory). No role-signer clones on this backend.
- **Everyday userOps** (viem `account-abstraction`: v0.8 EIP-712 userOpHash, `toPackedUserOperation`,
  `formatUserOperationRequest`; permissionless.js is not needed). `execute(single)` for one call, `execute(batch,
  abi.encode(Execution[]))` for `wallet_sendCalls` (atomic). Nonce key = validator << 32. Fees: tip ≤ min(1 gwei, the
  hook's max), `maxFeePerGas = 2 × base + tip`. Before sending, three checks, fail closed: an `eth_call` of the
  account's `execute` from the EntryPoint (hook preCheck/postCheck: the bucket, guardians), the bundler's
  `eth_estimateUserOperationGas` (stub signature), the prefund ≤ `maxFeeWei`, then the signed op simulated as
  `handleOps([op])` by `eth_call` (validation: the validator's policy and fee checks). The account pays its own fee
  (bounded per op); the activity says "from your account". The bundler's returned hash is compared with ours; a
  different one is kept in `replaced` and polled too. Measured on anvil: hot ETH userOp 273,819 actualGasUsed.
- **Provider mapping** (plan §30 §3.2 U): `eth_sendTransaction` → userOpHash; `eth_getTransactionReceipt(userOpHash)`
  → the bundle tx receipt with `transactionHash` = the userOpHash; `wallet_sendCalls` → one batch userOp, id = the
  app's or the userOpHash; `wallet_getCallsStatus` → status from `eth_getUserOperationReceipt`, `receipts` = the
  bundle tx receipt; `wallet_getCapabilities` → `atomic: supported`, `leaked: {backend: "4337", activated}`. SIWE /
  zero-value typed data: ERC-7739 in LeakedHotValidator's domain (`"LeakedHotValidator"`, `"1"`, no salt for
  PersonalSign, `salt = 0` in the nested TypedDataSign), prefixed with the validator address (the MSA routes 1271 by
  it). ERC-2612: `hook.registerPermit` in a userOp; the marker is `validator ‖ 0xdc6b87c9 ‖ digest`.
- **Vault on 4337** = `LeakedRoleExecutor` calls relayed by the fee tank as plain transactions (the PQ check runs in
  execution; no payer key, no lanes). `buildAaVaultAction` reuses the native account's tighten/loosen and
  instant/queued framing and emits `vaultExec(account, calls, usdValue, nonce, "")` (hook / executor setters with the
  account first, or spends), `vaultQueue(…, KIND_SPEND|KIND_LOOSEN, …)`, `vaultCancel` / `recoveryCancel`; Recovery
  linking is `executor.setRecoveryKey(pk)`. The request is `ur:leaked-sign-request` **tx-type 3** (new, `d0ae1b2`):
  key 4 = that calldata with an empty `pqSig`, key 14 = the executor. The extension recomputes the EIP-712 digest
  from the calldata and refuses unless it equals the executor's own `hash*` view; at scan-back it verifies the
  witness against `getRoles(account).vaultPk/recoveryPk` with `@leaked/pq-signer`, `eth_estimateGas`es the signed call
  from the tank (a revert = SIM-REJECTED), then sends it. **The companion does not sign tx-type 3 yet (E-76): the
  e2e's phone is a stand-in that implements the spec (`executorRequestDigest`), BACKLOG "Companion".**
- **Network selector**: devnet 1337 (native) and "Local 4337 test chain" 31337 (anvil :8546 + bundler :4337, local
  builds only); Sepolia and Ethereum are listed with their USDC/DAI presets but `enabled: false` until module
  addresses are recorded. `wallet_switchEthereumChain` still accepts a known disabled chain (reads only; 4902 for
  chains not in the table).
- **Tokens at creation** ("Tokens you'll spend", after the network): presets per network (the devnet/deploy USDC =
  `PermitToken1271("USDC")`, DAI = `MockToken`, both 18 decimals, on 1337 and 31337 at the same CREATE2 addresses);
  each ticked token shows "LEAKED counts USDC as $1.00 toward your daily limit" with an editable price; the SW checks
  `decimals()` on-chain before storing and again when the address is computed. The e2e proves the ERC-2612 pre-approval
  on both backends: mined, `registeredHashExpiry > 0`, and then `USDC.permit(…, marker)` sent by a third party sets the
  allowance (the token's ERC-1271 call is the one consumer).
- **Recovery payer key**: the v2 recovery test's key 6 (signed by the Recovery PQ key) is stored and goes into
  `InitConfig.recovery.payerKey` (and `vaultSetRecoverySigner`'s clone params); checked ≠ hot key, ≠ tank, ≠ Vault payer
  before an address is shown (`payerConflict`). The 1337 e2e now cancels with the Recovery key on **Path B** from the
  public mempool: no stake, no `ethrex_submitPrivilegedFrameTransaction` (the devnet stand-in is gone from the test).
- **Recovery test request id**: extension-chosen (`ur:leaked-recovery-challenge`, single use, 30 min, serialized
  issuance; reused while unused so a double page request cannot split it). A test with any other id is E-61. The
  companion's `Recovery.tsx` still picks its own id: BACKLOG.
- **hash-mismatch after broadcast**: the request goes to `sending` tracked by the hash of the bytes we sent, with
  `nodeHash` and a recoverable error shown on the hand-off ("Sent, but the network's answer didn't match"); either
  hash's receipt settles it; none within 15 minutes → `failed` with "start again" (a re-run cannot double-spend: the
  nonce is used once). Same on 4337 for a bundler hash.
- **Contracts moved during this work** (`6324659`, typed Permit2/EIP-3009; redeployed in `848567e`): the extension's
  generated ABIs follow, and the drift test now also covers `addresses.anvil4337.json`.
- **Results**: unit 149 pass (+ contract-in-the-loop 4337 pass); Playwright e2e 10/10 (both backends: onboarding →
  activation → Open-mode instant send → over-limit through the Vault → dapp `wallet_sendCalls` + status; plus 4337
  SIWE and permit).

## Contracts: typed Permit2 / EIP-3009 registrations, PoolPayer v1 shape, threat model (2026-11-06)

Commits `6324659` (account + modules), `00199c0` (PoolPayer), `848567e` (deploy + watcher ABI). Docs:
`docs/security/THREAT-MODEL.md` (new), `10-contracts.md` §10.12.

- **Typed registrations.** `registerPermit2` (Permit2 `PermitSingle`), `registerPermit2Transfer` (`PermitTransferFrom`),
  `registerTransferAuthorization` (EIP-3009, `receiveAuth` selects `ReceiveWithAuthorization`), in the account and
  mirrored in `LeakedPolicyHook`. Shared `src/lib/TypedPermits.sol`; `registerPermit` now uses it too. The Permit2
  domain is computed (name "Permit2", no version, canonical address), not read; the type hashes equal the published
  `PermitHash.sol` constants (checked against the canonical source on `main` and pinned as hex in
  `TypedPermits.t.sol`). The nonce comes from Permit2 (`allowance(...).nonce`) or must be unspent (`nonceBitmap`,
  `authorizationState`: `NonceUsed`). Each hash is bound to one 1271 caller (Permit2 or the token) through the
  existing `registeredFor`; `isValidSignature` is unchanged.
  - **Spender rule** ("allowlisted or session-bound"): `targets[spender]`, or a live session `(spender,
    sessionSelector)` with allowance > 0. The caller names the selector because sessions are keyed by
    `keccak(target, selector)`. Open mode does not widen spenders (the spender chooses the destination). The 3009
    recipient follows `_checkRecipient` (it can do no more than a hot `transfer`).
  - **Bounds:** debit = typed amount, once, at registration (bucket + `perTxMaxUsd`; an "infinite" uint160 permit
    cannot fit); hash expiry min(deadline, now + 30 d); Permit2 `expiration` in (now, now + 30 d] (0 = "this block"
    is refused). The vault must approve Permit2 on the token; the hot key cannot (I-6).
  - **7579:** the validation-time debit reads (token, amount) per selector: registerHash (1, 2; 132 B),
    registerPermit (0, 2; 132 B), Permit2 ×2 (0, 1; 196 B), 3009 (0, 1; 228 B). The hook's transfer-recipient check
    moved to `_checkTransferRecipient`, shared with 3009.
  - **Sizes:** LeakedAccountImpl 23,662 B (914 B margin), LeakedPolicyHook 23,690 B (886 B). The next account feature
    will need code moved to `LeakedAccountRoles` or a library.
  - VERIFY unchanged: `lint-verify.sh` OK, plus a new I-2 test that the three registrations write no VERIFY slot.
  - Tests: `test/account/TypedPermits.t.sol` (13 × Open/Strict) with a Permit2 mock transcribed from the canonical
    source and etched at the canonical address, a USDC-style 3009 token (`bytes signature`, SignatureChecker);
    `LeakedModulesHosts.t.sol` +6 per host × MSA/Safe7579/Kernel × Open/Strict. `forge test`: 940 passed, 0 failed,
    3 skipped.
- **PoolPayer.** `verify` now requires `FRAME_COUNT == i + 3` and MODE VERIFY for every frame before the pay frame.
  The tail-call branch and `TailCallsNeedRecipientSender` are removed. `setOperator` is replaced by
  `proposeOperator` (0 cancels) + `acceptOperator`. Privacy e2e re-run (`e2e-1793931494098`, funder = the sub-account
  `0xF465…fC5C` of anvil #5 via the new `FUNDER_LABEL`, top-up `0x60977904…63d2`): w1 `0x5eec231c…2a97` (privileged,
  blk 3043), w2 `0x0bada4f4…02ff` (privileged, blk 3052), w3 `0x5a5f7b7e…f798` via the BUDGET-010 sidecar :14340
  (`OnChain`, blk 3053; 14340 now lists the precompiles). **VERIFY frame 306,754 gas** (+748 for the VERIFY-mode
  loop), refund frame 25,818; payer net −5,528 / −5,552 gas (calibrated B). A top-up of a fresh account needs more
  than 21,000 gas on this devnet (state gas): the first run's transfer reverted at 21k.
- **Deploy.** LeakedAccountImpl `0x4306F6A3…e8fb` (local devnet); the 7579 modules re-deployed on anvil :8546. The
  watcher ABI was regenerated (NonceUsed). The companion registry matches the artifacts (`abi:sync --check`). It has
  per-function formats (`account.registerPermit`, role "any") but no hot-path section, so the new functions are a
  companion backlog item. The extension's `src/generated/contracts.ts` is regenerated in the working tree; the
  extension agent commits it with its generator changes.

## Extension M6: the private balance, the offscreen prover and the watcher light mode (2026-11-06)

Commits `9ccfd58` (`@leaked/privacy`), `d74b8d8` (extension). Plan §30 §10 M6, §40 §1, §5, §6; ux-spec §3.10, §3.11,
§3.13. E2E `apps/extension/e2e/privacy.e2e.ts` (local devnet); screenshots `app-privacy-*`, `app-alerts`,
`app-settings-privacy`.

- **Offscreen document** (`src/entrypoints/offscreen/`, `src/offscreen/`): the extension's one `offscreen.html`
  (reason `WORKERS`), created on demand by the service worker (`background/offscreen.ts`, one `createDocument` for
  concurrent first calls). It hosts the withdraw prover in a module Worker: `@leaked/groth16`'s
  `serveDefaultProver` (arkworks WASM inlined, `initSync` from bytes) with the circuit artifacts packaged in the CRX
  under `pp-circuits/` (copied from `@fatsolutions/privacy-pools-core-circuits@1.0.5` by a `build:publicAssets` hook,
  sha256-pinned, 20.4 MB of the 23.75 MB package). Protocol `shared/offscreen.ts`: `{target: "leaked-offscreen", id,
  kind, payload}`, kinds `ping | prove | anon:status`, bigints tagged `{"$n"}` on the wire, errors keep their name.
  CSP: still `script-src 'self' 'wasm-unsafe-eval'`; `connect-src` gained `'self'` (the Worker fetches the packaged
  artifacts). Permissions gained `offscreen`, `notifications`, and an optional host permission requested only when
  a self-hosted watcher is paired.
- **Anon-RPC: not bundled (decided, not feasible for M6).** `@anon-rpc/browser-extension-harness@0.4.0` exists (MIT),
  but it needs the sandbox pages, a mainnet specifier bootstrap and a live worker network to test; the devnet has no
  specifier at all. `anon:status` answers "unavailable" with the reason; Settings shows the toggle disabled with it;
  the privacy page labels its connection "off on this network". The seams are in place: `withdrawalClients({
  anonFetch })` builds a withdrawal's node and sidecar clients on a fresh isolation key when a fetch is given.
- **Private balance** (`background/privacy/`, `#privacy`). Every operation is a persisted state machine
  (`machine.ts`, pure): shield `preparing → phone → paying → done`, unshield `preparing → phone → proving → submitted
  → done`, any → `failed` with a plain reason and `retry` where safe. `run()` re-derives everything from storage and
  the chain, so a service-worker restart resumes (a sent withdrawal is polled by its hash; a restart while proving
  proves again).
  - **The phone signs note keys without holding the SW open**: `phoneSigner` throws `NeedsPhoneError`; the op stores
    the `ur:leaked-sign-request` (tx-type 2, the companion's typed-data flow, payer = the paired Vault's fee key); the
    page shows the QR and scans the answer; `acceptPhoneAnswer` checks request id + payer recovery. **Corrected by
    `5c006bf` (review, critical):** a note signature _is_ the note's spend key, so answers live only in
    `chrome.storage.session` (`NoteAnswers`, memory, never on disk) while the operation that needs them runs, and are
    cleared when it finishes, on cancel and on lock; there is no secret-manager cache. (The first M6 version kept them
    as `ans:<d>:<k>:<attempt>` in the seed-keyed store: the everyday seed plus a copy of `storage.local` could
    withdraw.) The determinism double-sign happens once per Vault payer (`deterministicPayer` persisted).
  - **Store key**: HKDF-SHA256 of the seed with label `privacy-pools:<chainId>` (`KeyringController.deriveStorageKey`),
    dropped on lock. Since `5c006bf`/`0909216` it encrypts only **public** data: the op state machine and a public note
    ledger (`ledger:<pool>`: precommitment, nullifier hash, label, value, commitment, status; no nullifier, no secret),
    refreshed against the synced pool without the phone. So plan §1.4 item 2 (the pool key is released by a Vault
    approval) holds: the balance is readable after a normal unlock because it needs no key, and every spend asks the
    phone twice (the note's key, checked against the pool, then the change note's key). The earlier "deviation" text
    here described the pre-review build and no longer applies.
  - No discovery scan: a deposit is prepared by index (`prepareDeposit(value, {depositIndex})`) and its public entry
    recorded when the payment lands; a withdrawal records its change note's public data.
  - **Deposit** = a payment from the account (`payments.preview` → hot, else a Vault `send`). The Entrypoint is not an
    allowed app, so it is a Vault approval in practice; the request carries a body gas hint (`body`, bounded by
    `MAX_ROLE_BODY` 4M/3M; the first attempt failed at the stock 700k: a deposit is ~1.05M on the devnet) and a label
    ("Deposit 0.1 ETH into your private balance"). The hand-off page returns to `#privacy` (`?back=privacy`).
  - **Withdrawal**: one note per withdrawal (the smallest approved note that covers the amount), to the fresh sender
    derived from the change note's signature, through `FramePaymasterBroadcaster` on `withdrawalClients` (its own
    circuit; on the devnet direct and labelled), sidecar from the config (default the staked lane :14340). The UI has
    no fee field anywhere; it says the fee comes out of the withdrawal at cost and is refunded, and shows the fee paid
    (amount − received) after.
  - **ASP on the devnet**: `pool-order` (the longest prefix of the pool's deposit labels whose root equals
    `latestRoot()`; `verifiedAspLabels` re-checks exactly, so a wrong guess fails closed). 0xbow's IPFS list is not
    implemented; mainnet/Sepolia have no privacy config (Settings shows the fixed table; a local-devnet build lets the
    devnet pool be entered, checked on chain before it is saved).
  - Honest proving estimate: none before the first measured proof on this computer, then the median of the last five
    (`proofMs`).
- **Watcher light mode** (`background/watcher/`): `chrome.alarms` `leaked:watcher` every 60 s (plus a `when` alarm at
  the next deadline from `WatcherCore.nextDeadline()`), `eth_getLogs` over `TargetIndex.logAddresses()` from the
  account's deployment block (`deployBlock.ts`: the activation receipt, else a binary search over `eth_getCode` at a
  block; cached), then a persisted cursor, 1 confirmation. `initiated()` = this browser's Vault requests (opId, hash)
  and payments (hash) → its own actions are `info` ("you did this"); everything else unknown → `urgent` for
  loosenings. New alerts → `chrome.notifications` (urgent: `requireInteraction`; info: silent), the toolbar badge
  (unread count, colour of the worst), and the `#alerts` list; a notification click opens its deep link. The same
  deploy-block lookup fixed Pending's `Queued` scan (frame account and 4337 executor), which read from block 0.
  Not in light mode: blocked everyday payments (no log; the self-hosted watcher reads blocks for that) and reorgs
  deeper than the confirmation.
- **Pairing** (Security › Alerts › Pair a watcher): the code `{url, topic, keyId, hmacKey}` (`parsePairing`), Chrome's
  permission for that one origin, then `GET /v1/alerts?since=<seq>` with `LEAKED-HMAC` request auth on each poll;
  only envelopes whose HMAC verifies are kept (a forged "all clear" is counted and ignored), retractions marked.
- **`@leaked/privacy` changes (integration-driven, with tests)**: `EncryptedStorage.onLock`, and the secret manager
  subscribes so `lock()` forgets the in-memory signatures; `FramePaymasterQuote` no longer holds `senderKey` (a
  `FrameSenderSigner` handle signs, `localFrameSigner(key)` keeps the key in a closure; `quote({senderKey})` is
  refused); `FramePaymasterOptions.circuit` is required and `accountIsolationKeys` refuses a withdrawal circuit on an
  account's key (`withdrawalClients` builds node + sidecar on one fresh key); `createGroth16Prover` throws when the
  engine has no `verify` unless `selfVerify: false`; `client.notes({maxDeposits})`; `withdrawViaPoolPayer({sender,
  onBuilt})`.
- **Results (local devnet, 2026-11-06).** Pool (cached in `node_modules/.cache/leaked-extension-e2e/privacy-pool.json`,
  reused while on chain): Entrypoint `0x03b483f6…95a9`, pool `0xd3b99068…287f` (block 3574), PoolPayer
  `0xe28556e8…7886` (staked 0.012 ETH), deployed by the sub-account `keccak("leaked/extension-e2e-privacy/v1")` of
  anvil #5, which is also the reviewer. Withdrawal `0xea89e94b…14ba` via :14340 `OnChain`: 0.05 ETH out, 0.0488286 ETH
  arrived at the fresh `0x27887Afd…40d0` (fee bound 0.0158 ETH at 2× gas price, refunded down to ~0.0012 ETH actually paid),
  proof 2.53 s in the offscreen Worker (single-threaded WASM). The change note (0.05 ETH) is rediscovered from the
  kept signature with no scan. The whole M6 e2e (onboarding, activation, shield, review, withdraw, a queued
  loosening → "Limit change scheduled" in the list, badge and a notification, deep link to the highlighted Pending
  op) takes ~1.4 min.
- **Companion gap found**: the phone has no `Entrypoint.deposit(uint256)` format and no devnet Entrypoint, so the
  deposit's Vault approval shows "Unrecognised call" (the e2e stand-in confirms it like the user would). Backlog.

## Extension follow-ups: fee top-up, Permit2, key rotation e2e, public exit (2026-11-06)

Commits `410c02f` (companion), `8545f18` (privacy, groth16, devnet-test verifier), `52b1107`, `1c4581e`, `9b760dc`
(extension). E2E on the local devnet (anvil #7; privacy: anvil #5's sub-account): `e2e/followups.e2e.ts` (1.1 min),
`e2e/privacy.e2e.ts` (2.4 min, now with the public exit).

- **Fee balance top-up.** The account can't pay a role signer (`ForbiddenRecipient` in both modes), and a Vault
  approval to fund the Vault's fees would be paid from the balance that is low. So Security › Fee balance › Top up
  is an everyday payment account → fee tank (allowlisted at initialize) and then a plain tank → signer transfer
  (`VaultFlow.fundSigner`, receipt awaited); the sheet shows the route first (over the limit: the route copy, no
  button). 4337: the tank relays approvals, so the top-up stops at the tank.
- **Permit2.** `classifyTypedData` accepts `PermitSingle` / `PermitTransferFrom` only with the canonical domain
  (name "Permit2", no version, canonical address) and exactly the canonical struct fields; pre-checks before any
  window: chain, expiration in (now, now + 30 d], deadlines, Permit2's `allowance().nonce` / `nonceBitmap`. The
  spender's `sessionSelector` comes from the live allowances (`0x00000000` for an allowed app); `classifyCalls` prices
  the typed amount and requires `targets[spender]` or a live session (Open mode doesn't widen spenders). After mining,
  `registeredHashExpiry(typedDigest)` must be set, as for ERC-2612. The e2e deploys the canonical Permit2 (mainnet
  creation code, keccak pinned in `companion-sim.ts`, CREATE2 through 0x4e59…956c with the mainnet salt; ~15M gas
  here, code deposit is state gas) and uses the fee tank as the spender (the one target allowlisted at creation;
  anything else is a queued `vaultSetTarget`). `Permit2.permit` consumed the PermitSingle marker (allowance set);
  the PermitTransferFrom digest was registered (expiry = its deadline). An `eth_call` "from Permit2" is refused by
  ethrex (EIP-3607), so the e2e reads `registeredHashExpiry` instead.
- **Key rotation e2e.** The old everyday key (decrypted from a copy of `storage.local` + the session DEK, as a thief
  would) builds and simulates a payment with the extension's own `FrameEngine`: admitted before the rotation,
  refused after; `getHotConfig().hotKey` is index 1 and the keyring adopted it; Send pays with the new key.
- **Public exit.** The commitment circuit artifacts (3.3 MB) ship in the CRX next to the withdraw ones, pinned by
  `COMMITMENT_ARTIFACT_PINS`; the proof is self-verified and its signals checked against the note. The devnet e2e
  pool deploys `CommitmentGroth16Verifier` (after the Entrypoint, so the Entrypoint keeps nonce 4 on a fresh devnet)
  as `RAGEQUIT_VERIFIER`; the cached pool is redeployed when it has none. On this devnet: Entrypoint `0xd3d84149…ae96`,
  pool `0xaec49428…e5f0`, verifier `0x125a051c…abe0`. The op is `exit`: phone (note key) → proving → paying (Vault
  `send` of `pool.ragequit`, usd 0, body gas from an estimate) → done; the full 0.05 ETH came back to the account
  (the Vault signer paid the fee). Verifier gas on a real proof: 241k (forge).

