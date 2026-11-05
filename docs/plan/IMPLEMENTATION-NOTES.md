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
