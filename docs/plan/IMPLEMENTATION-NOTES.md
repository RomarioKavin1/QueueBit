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
