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
