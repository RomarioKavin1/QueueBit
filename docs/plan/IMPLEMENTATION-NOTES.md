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
- **The devnet does not charge the EIP-8141 text's floor exactly.** Every receipt (16 txs) is
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
- **BUDGET-010 sidecar (14340) blocks every SHA-2 SLH-DSA verifier, independent of budget.** With the account staked,
  a 931k SLH-DSA-SHA2-128s VERIFY prefix is rejected with `payer accesses un-deployed contract address 0x…02`: the
  ERC-7562 code-less-address rule treats the SHA-256 precompile as an undeployed contract. Keccak-based schemes are
  unaffected (C13 at 137k and PORST r=16 at 158k were admitted staked). Precompiles need an allow-list in that rule
  (input for the sidecar PR, §40 P6).
- **C7 VERIFY = 100,271 gas**, C13 111,140, leanSphincs-s ~43.6k: only leanSphincs-s passes the stock 100k sidecar in a
  VERIFY frame. Total tx gas is floor-bound for every hash-based scheme (C13 250,682, C7 251,706, leanSphincs-s
  281,146), so signature bytes decide fees and VERIFY gas decides admission, as §1.2 predicted.
- **SLH-DSA-SHA2-128s port (time-boxed, done):** `bench/contracts/src/SlhDsaSha2_128s.sol` accepts every noble 0.7.1
  signature and rejects one-bit changes; ~830–890k gas isolated, 831,679 in a VERIFY frame: fits only the staked 1M
  budget by gas, and is admission-blocked by the precompile rule above. Not audited; benchmark only.
- **Signing times are laptop numbers under load** (the amd64-emulated devnet running): the upstream C SLH-DSA-128-24
  signer took 7.5–8.6 min per call (it regenerates the 2²² tree; upstream quotes 1–3 min), C7's Python reference
  ~17 s. Treat both as reference-implementation figures, not product signers.
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
