# Measured: post-quantum signatures inside EIP-8141 VERIFY frames, against the ERC-8421 budgets

*Draft for ethresear.ch. LEAKED project, 2026-11-06. Numbers from `bench/results/results.json`. Reproduce with
`pnpm --filter bench run all` on the local chain-1337 devnet.*

## TL;DR

- We ran eight post-quantum verifiers inside real EIP-8141 frame transactions on a local copy of the ERC-8421 workshop
  devnet (ethrex `eip8141-tracer` 9aa3645d + the Skandha sidecar). Every number below comes from a mined receipt or a
  node simulation.
- **Admission and fees are set by different things.** VERIFY-frame gas decides whether a transaction gets into the
  mempool. Signature bytes decide what it costs, because every hash-based scheme is floor-bound at 64 gas per byte.
- **Only leanSphincs-s fits today's flat 100k budget** in a VERIFY frame (about 43.6k). SPHINCS- C7 misses by
  271 gas (100,271), and SPHINCS- C13, the cheapest per transaction (250,682 total), needs 111k. That puts C13 and C7
  in the 250k class, the per-entity budget ERC-8421 BUDGET-010 proposes for staked entities.
- **Staking works as advertised.** With the account staked, a BUDGET-010 sidecar admitted, at a 1M budget, the
  VERIFY prefixes of C13, C7, both PORST sets, SLH-DSA-SHA2-128-24 and SLH-DSA-SHA2-128s, and all of them were mined.
  ETHFALCON (1.5M) was rejected by budget.
- **Precompiles must be allow-listed in the ERC-7562 code-less-address rule.** On the first run, before the devnet
  sidecar's `precompiles` list was configured (it defaults to empty), the staked SLH-DSA-SHA2-128s prefix was rejected
  with `payer accesses un-deployed contract address 0x…02 with opcode STATICCALL`. Every SHA-2 SLH-DSA verifier calls
  the SHA-256 precompile, so a sidecar shipped with the default config admits none of them at any budget.
- **A FIPS 205 final parameter set does run on the EVM: SLH-DSA-SHA2-128s** (7,856-byte signatures, 2^64 budget).
  The bench port verifies at 868k gas in a VERIFY frame (826–889k in Forge, depending on the digest), about 1.02M per
  transaction. That is 4x C13, with 2^42 times the signature budget.

## Setup

**Chain.** A local fork of the public alt-mempool devnet: chain 1337, ethrex
`v23.0.0-eip8141-tracer-9aa3645d`, Lighthouse, the `mempool-workshop-sidecar` (stock flat `MAX_VERIFY_GAS = 100,000`),
and a sidecar build with ERC-8421 BUDGET-010 per-entity budgets (100k unstaked, 1M staked). Same images, codec
profile and fork schedule as `altmempool.forshtat.com`.

**Account.** One minimal Yul 8141 sender per (scheme, key) (`bench/contracts/src/BenchAccount.yul`). It calls the
**unmodified upstream verifier** directly. The calldata is `selector ‖ key words ‖ TXPARAM(SIG_HASH) ‖ witness`, and
the witness is copied straight from the ARBITRARY signature entry with `SIGDATACOPY`. It reads no storage in VERIFY
and uses GAS only before STATICCALL. The VERIFY-frame number is therefore "verifier plus the least glue an account
can have". A production account (LEAKED's `PQRoleSigner`) adds its own policy on top.

**Two shapes per scheme.**

| | frame 0 (VERIFY, budgeted) | frame 1 (SENDER) | signatures |
|---|---|---|---|
| Path A | PQ verify over the sig hash, `APPROVE` | send 1 wei | ARBITRARY witness |
| Path B | check a SECP256K1 payer entry, `APPROVE` | PQ verify, then send 1 wei | ARBITRARY witness + SECP256K1 |

Path B is the "PQ in execution" shape. It has no VERIFY cap and is admissible today, but a forged payer key can grief
it (burn gas). It can't steal.

**Measured per transaction:** `ethrex_simulateFrameTransaction {trace:true}` before sending (canonical validity and
per-frame gas); admission at the stock sidecar, at the BUDGET-010 sidecar with the account staked, and at ethrex's
canonical mempool; the receipt (`frameReceipts[i].gasUsed`, `gasUsed`); and, as a cross-check, the isolated verifier
call in Forge with the same calldata.

**Gas formula check.** For every transaction we compute EIP-8141's `frame_tx_intrinsic_gas` and
`calldata_floor_gas` from the transaction bytes and compare them with the receipt. The devnet is consistently higher
than the EIP text, by `64 × len(rlp(nonce_keys) ‖ rlp(nonce_seq))`: its ethrex build also prices EIP-8250's nonce
calldata (3 bytes, so 192 gas, here). It also weights witness bytes 4/16 in the standard intrinsic, where the EIP
prices elided bytes uniformly. With those two terms (read in the ethrex source) the formula matches **every receipt
exactly**, both floor-bound and execution-bound transactions.

## Results

Gas is from the local devnet. "Verify" is the isolated Forge call (mean over vectors). "VERIFY frame" and "tx" are
Path A receipts.

| Scheme | Sig B | pk B | Verify | VERIFY frame | Tx (A) | Tx (B) | 100k | 250k | 1M | 2.5M | Stateless |
|---|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|:-:|:-:|
| SPHINCS- C13 | 3,688 | 32 | 107,050 | 111,140 | 250,682 | 258,922 | ✗ node | ✓ | ✓ node | ✓ | yes |
| SPHINCS- C7 | 3,704 | 32 | 96,194 | 100,271 | 251,706 | 259,946 | ✗ node | ✓ | ✓ node | ✓ | yes |
| leanSphincs-s | 4,164 | 32 | 39,480 | 43,529 | 281,146 | 289,386 | ✓ node | ✓ | ✓ | ✓ | yes |
| SLH-DSA-SHA2-128-24 | 3,856 | 32 | 147,364 | 146,252 | 261,434 | 269,674 | ✗ node | ✓ | ✓ node | ✓ | yes |
| SLH-DSA-SHA2-128s (FIPS 205) | 7,856 | 32 | 852,697 | 868,099 | 1,019,114 | 1,018,259 | ✗ node | ✗ | ✓ node | ✓ | yes |
| PORST r=16 | ~13,165 (var.) | 32 | 125,088 | 132,261 | 874,810 | 889,194 | ✗ node | ✓ | ✓ node | ✓ | no (16 sigs/key) |
| PORST r=256 | ~14,422 (var.) | 32 | 116,687 | 123,118 | 936,250 | 956,778 | ✗ node | ✓ | ✓ node | ✓ | no (256 sigs/key) |
| ETHFALCON (Falcon-512, keccak XOF) | 1,064 (+1,024 key) | 1,024 | 1,499,854 | 1,502,525 | 1,558,828 | 1,564,122 | ✗ node | ✗ | ✗ node | ✓ | yes |
| FORS+C (NiceTry) | 2,448 | 32 | not measured | — | — | — | — | — | — | — | no (one-time) |

"node" = the answer of a real sidecar with that budget (stock sidecar at 100k; BUDGET-010 sidecar with a staked
account at 1M). Unmarked = computed from the measured VERIFY gas plus the 1/64 reserve (no node runs 250k/2.5M).
FORS+C is listed from its
published figures (2,448-B signature, about 35k verify). Its repository has no licence, so we neither copied nor ran
its code.

The full table, with signing times, licences, audit status, per-transaction hashes and every node error string, is in
`bench/results/RESULTS.md`.

## What the numbers say

**1. The 100k wall is real, and narrow.** C7, the parameter set the original SPHINCS- post called "C13", misses it by
271 gas. C13 has 2^22 signatures per key, a Lean refinement proof of its verifier, and the smallest stateless
signature here, and it misses by 11%. Upstream notes 26–37k of loop optimisations that are pending on the
proof-pinned C13 verifier. If they land, C13 probably fits 100k. Until then the only stateless PQ scheme that fits a
flat 100k VERIFY budget is leanSphincs-s, which is unproven: its 2^26 lifetime is an estimate, and its Light-tier
key here is rated for 20K signatures.

**2. Fees follow bytes, not compute.** Every hash-based transaction is floor-bound. C13's tx gas (250,682) is
`12,000 + 2×475 + 100 + 64 × (3,688 witness + 22 frame-data bytes) + 192` (the nonce calldata): the verifier's 111k of execution is fully absorbed by the calldata
floor. A cheaper verifier therefore doesn't make the transaction cheaper. leanSphincs-s verifies at 40% of C13's
cost and still costs 12% more per transaction because its signature is 13% larger. ETHFALCON is the only lattice
row and the only execution-bound one. On the main-branch verifier, execution (1.5M) dominates everything.

**3. Path B costs exactly 8,240 gas more than Path A** for every hash-based scheme: the SECP256K1 entry's 2,800
intrinsic plus its 85 bytes (signer + signature) at 64 gas/byte. The SENDER frame then carries the PQ verify plus the
transfer (C13: 123,225 = about 111k + 12k), and that execution is again absorbed by the floor. The price of
"admissible under today's 100k" is about 3% per transaction, plus Path B's griefing caveat.

**4. Stateful schemes buy nothing on the floor.** PORST r=16's verifier is about as cheap as C13's (125k), but its
13 KB witness puts the transaction at 875k, 3.5x C13, and the key runs out after 16 signatures. PORST r=256 (first
measured row here: about 117k verify, a 14.4 KB witness, 936k per transaction) is worse. Under 64 gas/byte, witness size dominates, and
few-time Merkle schemes have large witnesses.

**5. FIPS 205 compliance costs about 4x.** SLH-DSA-SHA2-128s is the only fully standardised row. Its 868k VERIFY
frame fits a 1M staked budget, with little margin (the worst Forge digest was 889k), and at about 1.02M per
transaction it costs 4x C13. The SP 800-230 "128-24" set (same FIPS 205 algorithm, 2^24 usage cap) costs only 4% more
than C13 per transaction (261,434) and needs a 250k-class budget (146k VERIFY). If a wallet wants a standards fallback in the
recovery role, the gas is affordable for a rare transaction. The signer is not: the reference C signer for 128-24
needs minutes per signature because it rebuilds a 2^22 tree each time. noble signs 128s in about 1 s.

## Caveats

- One laptop and one local devnet. Gas numbers are deterministic up to the digest (hash-based verify gas varies by
  about 0.5% across digests: C13 107,049–107,052 in Forge; PORST ±3%). Signing times were measured while an emulated
  amd64 devnet was running and are indicative only. The Python and C reference signers are not product signers.
- The SLH-DSA-SHA2-128s verifier is a time-boxed port written for this benchmark. It agrees with noble on every
  vector and rejects tampered signatures, but it is not audited and not a product component.
- ETHFALCON is measured on its `main` verifier (1.5M). Upstream reports an experimental branch (`ZKNOX_falcon8`) at
  447k that would fit 1M; we did not measure it.
- PORST witnesses are unpadded and variable-length, which the chain-1337 sig hash allows because it elides witness
  bytes. A length-committing EIP-8141 sig hash needs a padding adapter, which adds bytes and therefore floor gas.
- 250k and 2.5M verdicts are computed, not node-checked: the BUDGET-010 sidecar we ran was configured 100k/1M.

## Asks

1. **ERC-8421 / sidecar.** Default the code-less-address rule's precompile allow-list to the chain's precompiles.
   With the shipped empty default, no SHA-2 SLH-DSA verifier (and no BN254/ecrecover-based one) can be admitted at
   any budget.
2. **BUDGET-010 values.** A staked budget of 250k admits the stateless SPHINCS- family (C13, C7) and
   SLH-DSA-SHA2-128-24. FIPS 205 128s needs about 1M (it just fits), and lattice verifiers on today's code need 1.6M+.
3. **EIP-8141 and devnet parity.** The devnet ethrex charges EIP-8250 nonce calldata in the floor. That is reasonable,
   but the EIP-8141 text should say so (or the devnet shouldn't), so wallets can compute fees from the spec.

## Credits

Verifiers and signers are by their authors. We only measured them: **Nicolas Consigny** (SPHINCS-: C13, C7, the
keccak leanSphincs-s port, SLH-DSA-SHA2-128-24 verifier and signers), **Tom Wambsgans** (leanSPHINCS parameters and
crate), **duncancmt** (PORST), **ZKNOX / Renaud Dubois and Simon Masson** (ETHFALCON), **Riva Labs** (NiceTry FORS+C,
published figures only), **Paul Miller** (noble-post-quantum), **Alex Forshtat** (the ERC-8421 sidecar, ethrex
EIP-8141 build and devnet). Errors are ours.
