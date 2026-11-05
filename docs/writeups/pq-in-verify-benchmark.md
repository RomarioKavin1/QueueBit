# Measured: post-quantum signatures inside EIP-8141 VERIFY frames, against the ERC-8421 budgets

*Draft for ethresear.ch. LEAKED project, 2026-11-06. Numbers from `bench/results/results.json` (run of
2026-11-05). Reproduce with `pnpm --filter bench run all` on the local chain-1337 devnet; `pnpm --filter bench run ci`
re-runs the Forge verify and tamper checks on the committed vectors without a devnet.*

## TL;DR

- We ran eight post-quantum verifiers inside real EIP-8141 frame transactions on a local copy of the ERC-8421 workshop
  devnet (ethrex `eip8141-tracer` 9aa3645d + the Skandha sidecar). Every number below comes from a mined receipt or a
  node simulation.
- **Admission and fees are set by different things.** VERIFY-frame gas decides whether a transaction gets into the
  mempool. Signature bytes decide what it costs, because every hash-based scheme except SLH-DSA-SHA2-128s is
  floor-bound at 64 gas per byte.
- **Only leanSphincs-s fits today's flat 100k budget** in a VERIFY frame (about 43.6k). SPHINCS- C7 uses 100,271 in
  the frame, so it is over by itself, and by about 4k once the declared limit covers the 1/64 STATICCALL reserve (the
  node counts the declared limit plus 100, not gas used). SPHINCS- C13, the cheapest per transaction (250,682 total),
  uses 111k and needs a limit of about 115k. Both fit a 250k budget by the computed rule. 250k is the figure the
  workshop landing page shows for staked entities (marked TBD); the BUDGET-010 draft, and the sidecar we ran, use 1M.
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

| Scheme | Sig B | pk B | Verify | VERIFY frame | Tx (A) | Tx (B) | 100k | 250k | 1M | 2.5M | Stateless | Security (upstream claim) | Hash |
|---|---:|---:|---:|---:|---:|---:|:-:|:-:|:-:|:-:|:-:|---|---|
| SPHINCS- C13 | 3,688 | 32 | 107,050 | 111,140 | 250,682 | 258,922 | ✗ node | ✓ | ✓ node | ✓ | yes | 128-bit to 2^22 sigs/key | keccak256 |
| SPHINCS- C7 | 3,704 | 32 | 96,194 | 100,271 | 251,706 | 259,946 | ✗ node | ✓ | ✓ node | ✓ | yes | 128-bit to 2^24 sigs/key | keccak256 |
| leanSphincs-s | 4,164 | 32 | 39,480 | 43,529 | 281,146 | 289,386 | ✓ node | ✓ | ✓ | ✓ | yes | ~128-bit target; 2^26 lifetime is an estimate | keccak256 |
| SLH-DSA-SHA2-128-24 | 3,856 | 32 | 147,364 | 146,252 | 261,434 | 269,674 | ✗ node | ✓ | ✓ node | ✓ | yes | 128-bit to a 2^24 usage cap (SP 800-230 ipd set) | SHA-256 |
| SLH-DSA-SHA2-128s (FIPS 205) | 7,856 | 32 | 852,697 | 868,099 | 1,019,114 | 1,018,259 | ✗ node | ✗ | ✓ node | ✓ | yes | NIST category 1, 2^64 sigs/key | SHA-256 |
| PORST r=16 | ~13,165 (var.) | 32 | 125,088 | 132,261 | 874,810 | 889,194 | ✗ node | ✓ | ✓ node | ✓ | no (16 sigs/key) | 258-bit subset-cover bound at 16 sigs | keccak256 |
| PORST r=256 | ~14,422 (var.) | 32 | 116,687 | 123,118 | 936,250 | 956,778 | ✗ node | ✓ | ✓ node | ✓ | no (256 sigs/key) | 264-bit subset-cover bound at 256 sigs | keccak256 |
| ETHFALCON (Falcon-512, keccak XOF) | 1,064 (+1,024 key) | 1,024 | 1,499,854 | 1,502,525 | 1,558,828 | 1,564,122 | ✗ node | ✗ | ✗ node | ✓ | yes | Falcon-512 = NIST category 1; keccak hash-to-point, not FN-DSA | keccak |
| FORS+C (NiceTry) | 2,448 | 32 | not measured | — | — | — | — | — | — | — | no (one-time) | published: 104 bits at q=2, 70 at q=5 | keccak256 |

"node" = the answer of a real sidecar with that budget (stock sidecar at 100k; BUDGET-010 sidecar with a staked
account at 1M). Unmarked = computed from the measured VERIFY gas plus the 1/64 reserve (no node runs 250k/2.5M).
"Security" is each upstream's own claim at the pinned commit (its parameter table, header comment or README); we
quote it so the rows can be compared and did not assess any of it. The hash-based claims are classical bit-security
at a per-key signature cap; SLH-DSA-SHA2-128s is the only row with a NIST-standardised parameter set; ETHFALCON
swaps SHAKE for keccak in hash-to-point (upstream calls it "security equivalent"), so it is Falcon-512 but not FN-DSA;
PORST's figures are its header's subset-cover bound, not a hash-security figure. keccak256 versus SHA-256 changes gas
(native opcode versus precompile `0x02`), not the claimed level.
FORS+C is listed from its
published figures (2,448-B signature, about 35k verify). Its repository has no licence file, so we neither copied nor
ran its code.

The full table, with signing times, licences, audit status, per-transaction hashes and every node error string, is in
`bench/results/RESULTS.md`.

## What the numbers say

**1. The 100k wall is real, and narrow.** C7, the parameter set the original SPHINCS- post called "C13", uses 100,271
in the VERIFY frame; since the node counts the declared limit plus the 100-gas signature entry, and the limit must
cover the 1/64 the frame keeps back across STATICCALL, it needs about 104k. C13 has 2^22 signatures per key, a Lean
refinement proof of its verifier (with three residual assembly axioms upstream is still discharging), and the
smallest stateless signature here; it uses 111k and needs about 115k. Upstream reports that the October 2026 loop
optimisations took C7 and C12 down 22–24% (C7: 127k to 96k) and that the proof-pinned C13 verifier does not carry them
yet. If the same percentage applied to C13's 107k verify, it would land around 81–84k and fit 100k with room for the
glue, but that is a projection, not a measurement. Until then the only stateless PQ scheme that fits a flat 100k
VERIFY budget is leanSphincs-s, whose security argument is the least settled of the family: its 2^26 lifetime comes
from a cover estimate at 127 bits that upstream states is not proved, and its Light-tier key here is rated for 20K
signatures.

**2. Fees follow bytes, not compute.** Every hash-based transaction except SLH-DSA-SHA2-128s is floor-bound. C13's
tx gas (250,682) is `12,000 + 2×475 + 100 + 64 × (3,688 witness + 22 frame-data bytes) + 192` (the nonce
calldata): the verifier's 111k of execution is fully absorbed by the calldata floor. A cheaper verifier therefore
doesn't make the transaction cheaper. leanSphincs-s verifies at 37% of C13's cost and still costs 12% more per
transaction because its signature is 13% larger. Two rows are execution-bound: SLH-DSA-SHA2-128s (868k of execution
against a 517k floor) and ETHFALCON, the only lattice row, where on the main-branch verifier execution (1.5M)
dominates everything.

**3. Path B costs exactly 8,240 gas more than Path A** for the four fixed-length floor-bound schemes (C13, C7,
leanSphincs-s, SLH-DSA-SHA2-128-24): the SECP256K1 entry's 2,800 intrinsic plus its 85 bytes (signer + signature) at
64 gas/byte. The SENDER frame then carries the PQ verify plus the transfer (C13: 123,225 = about 111k + 12k), and that
execution is again absorbed by the floor. PORST's two transactions differ by more (14,384 and 20,528) only because its
witness length varies per signature (96 and 192 extra bytes at 64 gas/byte); for the execution-bound SLH-DSA-SHA2-128s,
Path B is 855 gas cheaper, since the floor never binds and the frame glue differs. The price of "admissible under
today's 100k" is about 3% per transaction, plus Path B's griefing caveat.

**4. Stateful schemes buy nothing on the floor.** PORST r=16's verifier is about as cheap as C13's (125k), but its
13 KB witness puts the transaction at 875k, 3.5x C13, and the key runs out after 16 signatures. PORST r=256 (first
measured row here: about 117k verify, a 14.4 KB witness, 936k per transaction) is worse. Under 64 gas/byte, witness size dominates, and
few-time Merkle schemes have large witnesses.

**5. FIPS 205 compliance costs about 4x.** SLH-DSA-SHA2-128s is the only fully standardised row. Its 868k VERIFY
frame fits a 1M staked budget, with little margin (the worst Forge digest was 889k), and at about 1.02M per
transaction it costs 4x C13. The "128-24" set from the SP 800-230 initial public draft (same FIPS 205 algorithm, but
not a FIPS 205 parameter set; 2^24 usage cap, carried by the FORS layer per upstream's analysis) costs only 4% more
than C13 per transaction (261,434) and needs a 250k-class budget (146k VERIFY). It also has a Verity refinement
proof upstream, like C13. If a wallet wants a standards fallback in the recovery role, the gas is affordable for a
rare transaction. The signer is not: the reference C signer for 128-24 needs minutes per signature because it
rebuilds a 2^22 tree each time. noble signs 128s in about 1 s.

## Caveats

- One laptop and one local devnet. Gas numbers are deterministic for a given signature but vary with the digest:
  C13 by 3 gas (107,049–107,052 in Forge), leanSphincs-s by under 1%, PORST by about ±3%, SLH-DSA-SHA2-128s by
  about ±4% (826–889k). The Forge and frame figures use different digests, so their difference mixes the account
  glue (about 4k for C13, C7 and leanSphincs-s) with digest variance; for SLH-DSA-SHA2-128-24, whose two Forge
  vectors (146,734 and 147,993) were both dearer than the mined one, the frame figure (146,252, glue included) is
  below the Forge mean. Signing times were measured while an emulated amd64 devnet was running and are indicative
  only. The Python and C reference signers are not product signers.
- The "fits" verdicts at 250k and 2.5M use the harness rule (used gas plus the 1/64 reserve plus 2k, rounded up to
  1k, plus 100) rather than a node; the 100k and 1M verdicts are node answers to the limits we declared, which were
  loose (C13 was sent at 137k, C7 and 128-24 at 231k), so a scheme marked "✗ node" at 100k was rejected at that
  declared limit. The used-gas numbers show none of them could have been declared under 100k anyway.
- Security levels are quoted from the upstream repositories and were not assessed here. None of the measured
  verifiers is audited; the C13 and SLH-DSA-SHA2-128-24 refinement proofs are upstream's, carry named residual
  axioms, and cover the verifier, not the signer or the parameters.
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
2. **BUDGET-010 values.** The draft's 1M staked budget admitted everything hash-based here, including FIPS 205
   128s (declared at 931k, 868k used). A staked budget of 250k, the landing page's TBD figure, would still admit the
   stateless SPHINCS- family (C13, C7) and SLH-DSA-SHA2-128-24 by the computed rule, but not 128s. Lattice verifiers
   on today's main-branch code need 1.6M+.
3. **EIP-8141 and devnet parity.** The devnet ethrex charges EIP-8250 nonce calldata in the floor. That is reasonable,
   but the EIP-8141 text should say so (or the devnet shouldn't), so wallets can compute fees from the spec.

## Credits

Verifiers and signers are by their authors. We only measured them: **Nicolas Consigny** (SPHINCS-: C13, C7, the
keccak leanSphincs-s port, SLH-DSA-SHA2-128-24 verifier and signers), **Tom Wambsgans** (leanSPHINCS parameters and
crate), **Duncan Townsend (duncancmt)** (PORST), **ZKNOX / Renaud Dubois** (ETHFALCON), **Riva Labs** (NiceTry
FORS+C, published figures only, no code used), **Paul Miller** (noble-post-quantum), **Alex Forshtat** (the ERC-8421
sidecar, ethrex EIP-8141 build and devnet). Licences: SPHINCS-, PORST, ETHFALCON and noble are MIT (texts in
`THIRD_PARTY.md`); the SLH-DSA-SHA2-128s port is ours, MIT. Errors are ours.
