# @leaked/pq-signer

Post-quantum signers for the LEAKED vault and recovery keys. Two schemes, one API shape:

| Scheme | Status | Sig | VERIFY frame (Path A) | Fits stock 100k mempool | Formal proof |
|---|---|---|---|---|---|
| **SPHINCS- C13** (`schemes.c13`, and the top-level exports) | default | 3,688 B | ~151.7k (G1) | no (Path B, or Path A on BUDGET-010) | Lean refinement proof of the verifier (3 residual axioms) |
| **leanSphincs-s** (`schemes.leanSphincsS`) | **experimental** (feature flag) | 4,164 B | **84,465** (devnet, below) | **yes** | **none** |

The rest of this section is C13. leanSphincs-s has its own section below
([leanSphincs-s (experimental)](#leansphincs-s-experimental)).

**SPHINCS- C13** (keccak256, FIPS 205
uncompressed ADRS, WOTS+C / FORS+C, h=22 d=2 a=19 k=7 w=8 l=43, 3,688-byte signatures), exactly
as verified on chain by `SphincsC13Asm` from
[`nconsigny/SPHINCS-`](https://github.com/nconsigny/SPHINCS-) at commit
`4c76aaf113d326df9adede63d015f3b394ab84f4` (`src/keccak/SPHINCs-C13Asm.sol`). Plan:
`docs/plan/sections/20-pq-crypto-vault.md` §1, §3, §7.

> **Not audited.** Upstream marks the scheme and verifier "not audited, not production-safe"
> (`docs/SECURITY-REVIEW-2026-10.md:3-8`), and the C13 few-time bound in the public-grindable-R
> model is unproven (review C13-X-f2/f3). No real funds until plan §7.3 items 1–3 are done.

"C13" here is the **repo** definition (3,688 B, 2²² signatures per key), not the ethresear.ch
post's "C13" (3,704 B), which upstream now calls C7 (plan §1.1).

## Layout

| Path | What |
|---|---|
| `rust/` | crate `leaked-pq`: keygen / sign / verify, derivation, WASM exports (`--features wasm`), CLI `leaked-pq` |
| `src/index.ts` | TS API over the WASM build (WASM inlined as base64, sync init) |
| `vectors/c13.json` | KAT set C: 32 positive vectors + negative recipes for the Solidity tests |
| `rust/tests/fixtures/upstream_c13.json` | KAT set A: vectors produced by the upstream Rust and Python signers |
| `rust/src/lean_s/` | leanSphincs-s (experimental): params, hash/tweak, keygen/sign/verify |
| `vectors/leansphincs-s.json`, `vectors/leansphincs-s-upstream.json` | leanSphincs-s KAT sets C and A (A = upstream fixture, verbatim) |
| `onchain/`, `scripts/onchain-crosscheck.sh` | runs the unmodified upstream verifiers (C13, leanSphincs-s) in a throwaway Foundry project against sets A and C |
| `BENCH.md` | native and WASM timings |

## API

```ts
import { keygen, sign, verify, SIG_LENGTH, SCHEME_ID } from "@leaked/pq-signer";

// seed: the 64-byte BIP-39 seed (mnemonic + passphrase -> PBKDF2, done by the caller, e.g. @scure/bip39)
const { publicKey, secretKey } = keygen(seed, { role: "vault" });   // role: "vault" | "recovery"
const sig = sign(secretKey, digest32);        // Uint8Array(3688); digest32 = compute_sig_hash(tx)
verify(publicKey, digest32, sig);              // boolean, never throws
secretKey.fill(0);
```

| Export | Notes |
|---|---|
| `keygen(seed, { role?, chainScope? })` | `seed` 32..64 bytes. Returns `{ publicKey: 32 B, secretKey: 64 B }`. ~0.1–0.4 s |
| `keygenFromSeedParts(skSeed32, pkSeed16)` | upstream-compatible keygen, for KATs |
| `sign(secretKey, digest32, { entropy?, deterministic? })` | hedged by default (`crypto.getRandomValues`); seconds, see BENCH.md: **run in a Worker** |
| `verify(pk, digest32, sig)` | `IPQVerifier.verify` semantics: `false` for wrong lengths / any rejection |
| `publicKeyOf(secretKey)`, `verifierArgs(pk)` | pk = last 32 B of sk; `verifierArgs` gives the two top-aligned `bytes32` words for `SphincsC13Asm.verify(pkSeed, pkRoot, message, sig)` |
| `SIG_LENGTH` = 3688, `PK_LENGTH` = 32, `SK_LENGTH` = 64 | |
| `SCHEME_ID` | `keccak256("SPHINCS-C13/keccak/fips-adrs/v1")` = `0xb2062c48…9aa054`, the `IPQVerifier.schemeId()` of the C13 adapter |
| `SIGNATURE_BUDGET` = 2²² | per key, summed over every device holding the seed |
| `WASM_HASH` | sha256 of the embedded WASM; pin it in the companion build |

### Scheme-parametrised API

The top-level exports above are C13 and are unchanged (they are the same functions as `schemes.c13`). Every scheme
is a `PQScheme`:

```ts
import { schemes, schemeById, type PQScheme } from "@leaked/pq-signer";

const S: PQScheme = schemes.leanSphincsS;      // or schemes.c13
if (S.experimental) showWarning(S.warning);    // "Experimental: no formal proof yet; enables quantum-safe approvals on any mempool"
const { publicKey, secretKey } = S.keygen(seed, { role: "vault" });
const sig = S.sign(secretKey, digest32);       // Uint8Array(S.SIG_LENGTH)
S.verify(publicKey, digest32, sig);            // boolean, never throws
schemeById(await verifier.read.schemeId());    // the scheme behind an on-chain IPQVerifier, or undefined
```

| Field | `schemes.c13` | `schemes.leanSphincsS` |
|---|---|---|
| `name` | `"SPHINCS- C13"` | `"leanSphincs-s"` |
| `SCHEME_ID` | `0xb2062c48…9aa054` = keccak256(`"SPHINCS-C13/keccak/fips-adrs/v1"`) | `0x5f6989ca…29daed` = keccak256(`"leanSphincs-s/keccak/v1"`) |
| `SIG_LENGTH` / `PK_LENGTH` / `SK_LENGTH` | 3688 / 32 / 64 | 4164 / 32 / 64 |
| `SIGNATURE_BUDGET` | 2²² | 20,000 (upstream's Light-tier rating; an estimate) |
| `budgetStatus(used)` | `{ used, budget, remaining, fraction, level }` | the same plus `estimatedSecurityBits` (upstream's cover estimate; see [Usage counter](#usage-counter-and-key-rotation)) |
| `experimental` / `warning` | `false` / – | **`true`** / `LEAN_SPHINCS_S_WARNING` |
| extras | `keygenFromSeedParts` (top level) | `keygenFromSeed(seed32)` (= `lssk keygen --tier light`), `KEPT_SUBTREE_HEIGHT = 13` |
| keygen / sign (WASM, M3) | 128 ms / 2.6 s | 435 ms / 474 ms |

`schemes`, both scheme objects and their fields are frozen. The adapters are `contracts/src/pq/C13Verifier.sol` and
`contracts/src/pq/LeanSphincsSVerifier.sol` (`IPQVerifier`, never revert, length-checked); a role-signer clone binds
one verifier and its `sigLength` immutably, so the scheme of a vault is chosen when its VaultSigner is created.

C13 key formats: `pk = pkSeed(16) ‖ pkRoot(16)` (the `bytes32 pk` of `IPQVerifier`; the adapter
splits it into two top-aligned words); `sk = skSeed(32) ‖ pk(32)`.

## Key derivation

```
role_key = HMAC-SHA512(key = "leaked/v1/" ‖ schemeId(32 raw bytes) ‖ "/" ‖ role ‖ "/" ‖ chainScope,
                       msg = BIP-39 seed)
skSeed   = role_key[0:32]      pkSeed = role_key[32:48]      pkRoot = top XMSS subtree root
```

`role ∈ {vault, recovery}`, `chainScope = "any"` in v1. Scheme id and role are in the HMAC key
because nothing in the C13 hash inputs names the parameter set (upstream `CLAUDE.md:22`: "never
reuse a seed across variants"), so every (scheme, role, scope) gets an independent key. This is
deliberately not upstream's `HMAC-SHA512("sphincs-c13-v1", seed)`. The plan's `sk.seed ‖ sk.prf`
is the single 32-byte `skSeed`: upstream keys all three PRFs (WOTS secrets, FORS secrets, R) with
one 32-byte value, and keeping that is what lets the upstream KATs reproduce. The recovery key
should come from a **different mnemonic** (plan §5); the role label only guarantees independence
if one mnemonic is reused by mistake.

**Why a seed backup is safe.** C13 is stateless: the FORS instance and hypertree leaf used for a
signature are selected from `H_msg(R, pk, M)`, not from a counter. A restored or cloned seed
signs from the same distribution as the original, and there is no state whose loss or rollback
enables forgery (unlike XMSS/LMS or PORST, where restoring a backup re-uses one-time keys; see
`draft-ietf-pquip-hbs-state`). The only limit is the total number of signatures per key, 2²² at
128-bit security, counted across all copies: the companion keeps a best-effort counter and warns
at 2²⁰.

## Security notes

- **Hedged R.** `R = keccak(skSeed ‖ "R_hedge" ‖ rnd32 ‖ digest ‖ nonce)[:16]`, ground until the
  last FORS index is zero. It stays secret-keyed (upstream's fix for C13-X-f2), and fresh entropy
  makes it unpredictable even when the message is known in advance; a broken RNG degrades to the
  deterministic construction, never below it. `{ deterministic: true }` reproduces upstream's
  `R_grind` exactly and exists for KATs.
- **Self-check.** Every signature is verified by the Rust verifier before it is returned; a
  corrupted secret key or a fault yields an error, not a 258 K-gas failed transaction.
- **Zeroization.** `SecretKey` is `ZeroizeOnDrop`; PRF preimages and sponge states over secrets
  are wiped. In WASM, secrets cross the boundary as owned buffers that are wiped, a zero-on-free
  global allocator wipes every freed block (including the copies the wasm-bindgen glue makes),
  and the shadow stack is cleared after keygen/sign. The TS wrapper hands the caller's arrays
  straight to the glue (which copies them into WASM memory and never mutates or retains them) and
  makes no JS-side copies of its own, so the **caller must wipe its own `secretKey` / seed
  arrays**. JS strings and the JS heap cannot be wiped reliably: never hex-encode or log secrets.
- **Timing.** No secret-dependent branches or memory indices: chain lengths, tree indices and
  both grinding loops depend only on public values (digest, R, counters published in the
  signature). Keccak is constant-time.
- **Malleability.** Upstream finding C13-mal-f1 is narrower than its title: all 3,688 bytes are
  consumed (`negative.rs` flips every byte), but the tx hash of an EIP-8141 frame tx is still
  malleable at the protocol level. Track vault txs by `(sender, nonce, sigHash)`.
- **Error surface.** `verify` returns `false` where the raw Solidity verifier reverts
  (`sig.length != 3688`); the `C13Adapter` must do the same (`try/catch`).
- `#![deny(unsafe_code)]`; the only `unsafe` is the WASM allocator wrapper.

## leanSphincs-s (experimental)

**Feature flag.** `schemes.leanSphincsS.experimental === true`. Wallet UIs must keep it behind a flag (off by
default) and show `schemes.leanSphincsS.warning` before a user picks it:

> Experimental: no formal proof yet; enables quantum-safe approvals on any mempool

It exists because its VERIFY frame fits the stock 100k public-mempool budget, so a vault signer on it can use
**Path A** (PQ verify inside VERIFY: no payer ECDSA key, nothing to grief) on any mempool. Plan decision: "Path A
scheme options after the M3 benchmark" (`docs/plan/IMPLEMENTATION-NOTES.md`). C13 stays the default.

**What it is.** leanSphincs-s over keccak256 exactly as verified on chain by `LeanSphincsSAsm`
([`nconsigny/SPHINCS-`](https://github.com/nconsigny/SPHINCS-) @ `4c76aaf`, `src/keccak/LeanSphincs-SAsm.sol`;
spec `docs/leanSphincs-S-keccak.md`): one XMSS layer h=26, FORS k=13 a=12 with no root hash (the WOTS+C encoding
absorbs the 26 FORS tops), WOTS+C w=4 v=64 T=128, n=16, 4,164-byte signatures. Parameters by T. Wambsgans
(leanSPHINCS) / sphincs.art; keccak port, verifier and reference signer `lssk` by N. Consigny. Rust code:
`rust/src/lean_s/` (byte-compatible re-implementation of upstream `signers/leansphincs-s-keccak`).

**Keys.** LEAKED keys are upstream's **Light tier** (spec §14): a kept subtree of height b = 13 under 13
pseudorandom surrogate siblings, which the verifier cannot tell from a full key. `pk = P(16) ‖ root(16)` (the
verifier's `(pkSeed, pkRoot)` order; upstream's own byte form is `root ‖ P`), `sk = S(32) ‖ pk`. Signing rebuilds
the 2¹³-leaf subtree each time (upstream's "none" cache plan: no key file, no node cache, no state), so a signature
costs ~2 M keccak calls instead of the cached ~160 K. `sign` refuses a 64-byte key whose `P` is not `S`'s (a C13
secret key is refused in one hash) and self-verifies every signature. Hedged by default like C13:
`R_0 = Th(P, address(RANDOMIZER), S ‖ digest ‖ rnd32)` (upstream: `S ‖ digest`), then upstream's grind
`ρ = R_0 + i` until the leaf lands in the kept subtree; `{ deterministic: true }` is upstream's signer byte for byte.

**Key derivation and no key reuse across schemes.** Both schemes derive through one function,
`role_key(schemeId, master, role, chainScope) = HMAC-SHA512(key = "leaked/v1/" ‖ schemeId ‖ "/" ‖ role ‖ "/" ‖
chainScope, msg = BIP-39 seed)`; leanSphincs-s takes `S = role_key[0:32]` with its own `schemeId`. Distinct scheme
ids give distinct HMAC keys, hence independent outputs. This is what upstream requires ("one seed is one key of one
variant", README; spec §9, §14 "Operational rules": nothing in a hash input names the parameter set, and two keys
from one seed would sign two encodings with one one-time key). Tests: `rust/tests/lean_derive.rs` (known answer
recomputed with `hmac`; C13 vs leanSphincs-s seeds differ, and no 16-byte window of either appears in the other's
64-byte role key, for 2 masters × 2 roles × 3 scopes), `test/lean.test.ts` (same through WASM). The kept-subtree
height b = 13 is part of this scheme id: a different tier from the same seed would be the "two `b`, one seed"
misuse of spec §14 and must get a new scheme id / derivation label.

### Security note: what is and isn't proven (leanSphincs-s vs C13)

| | SPHINCS- C13 | leanSphincs-s |
|---|---|---|
| Verifier correctness | **Proved**: Lean 4 / Verity model of `SPHINCs-C13Asm.sol` refines a functional spec (`c13_refines_spec`), resting on three named residual assembly axioms (upstream `verity/README.md` "Scope", `SphincsMinusVerifiers/AXIOMS.md`). The model is hand-transcribed, so the bytecode-to-model step is reviewed, not proved | **Not proved**: upstream's Verity scope lists only C13 and SLH-DSA-SHA2-128-24 (`verity/README.md:8-18`); it names C7 and C9 as code that "should be treated as unverified" and does not mention leanSphincs-s at all, which has no model either. Evidence here is testing only: KATs from upstream's Rust and its independent spec-literal Python verifier, our independent Rust verifier, fuzzing |
| Per-key lifetime at ~128 bit | 2²² signatures from upstream's parameter table (`docs/variants.md:50-51`); the few-time bound in the grindable-R model is open (review C13-X-f2/f3) | **Estimate, not proved**: Light tier rated 20,000 signatures; the cover estimate (43,715 at 127 bits) "is an estimate and is not proved" (spec §14 "Lifetime"); for the original leanSphincs parameters the Lean-proved lifetimes are 4–17% below that estimate, widest at small b (same section). Upstream README: "-S and -f are rated … (sphincs-art estimates …, not proved)" (`README.md:52-53`) |
| Nothing enforces the lifetime | counter in the companion | same: "Nothing enforces it: not the signature, not the verifier, and not the signer" (spec §14). Budget 20,000 summed over all devices holding the seed; warn well before it |
| Audit | none ("not audited", upstream `README.md:4`); two AI-agent-assisted upstream reviews | none; no upstream security review of leanSphincs-s (`docs/SECURITY-REVIEW-*` cover the C-series and SLH-DSA) |
| Stateless | yes | yes (randomized leaf choice; the Light tier's kept subtree is not signing state). Restoring a seed is safe; reusing it at another b or for another variant is not (above) |
| Hash | keccak256, 128-bit truncation | keccak256, 128-bit truncation (16-byte tweak, not a FIPS 205 ADRS) |

Also: hedged signing means re-signing the same digest uses a fresh leaf and counts again against the budget;
`verify` returns `false` where `LeanSphincsSAsm` reverts (length ≠ 4164, non-canonical key words), and
`LeanSphincsSVerifier` does the same (`try`/`catch` self-call, as C13). **No real funds** on either scheme until
plan §7.3 items 1–3 are done; for leanSphincs-s additionally an independent review of the lifetime argument at
b = 13 (decision entry above).

### Usage counter and key rotation

Why the Light tier: b = 13 is the only tier whose keygen and (cache-less) signing fit a WASM signer without key
state (~0.5 s each; Standard b = 20 is ~128× that). Its price is the small budget. The budget is **soft**: past it,
security degrades gradually by upstream's cover estimate (spec §14; not proved): ~136 bits at 20,000 signatures,
127 at 43,715, ~116 at 100,000, ~105 at 200,000, roughly 10 bits per doubling. There is no one-time-key cliff as
in stateful XMSS/LMS (WOTS leaves are reused from the first few thousand signatures by design; the FORS few-time
layer absorbs that), so a counter that drives a warning and a rotation is an adequate guard, and a missed count
by a few signatures is not a compromise. The same holds for C13 at its 2²² budget.

The guard the companion must implement (`budgetStatus(used)` is the API part):

1. Keep a counter per key, i.e. per (scheme, role, chainScope) public key, in companion storage. Increment it for
   **every `sign` call that returns** (hedged signing: a fee bump, a retry or a never-broadcast signature each
   open a fresh leaf), before the signature is used.
2. Sum over devices: the counter travels with the key (export it with the key metadata). A seed restored from
   the mnemonic has an **unknown** count: treat it as `"exceeded"` and rotate, do not start from 0.
3. Act on `budgetStatus(count).level`: `"warn"` (≥ 50%) shows a "rotate soon" notice; `"rotate"` (≥ 90%) asks
   for a rotation before further approvals; `"exceeded"` refuses new approvals with this key except the rotation
   itself. `estimatedSecurityBits` (leanSphincs-s) can be shown, labelled as an estimate.
4. Rotation = a new key, never the same seed at another tier: derive with a fresh `chainScope` label (e.g.
   `any-2`; v1 derivation has no key index and `chainScope` is its only free label, part of the HMAC key, so
   the new key is independent of the old one), create a new VaultSigner clone
   bound to the new `pk` and point the account's role at it, then retire the old clone. Signing with the old key
   remains valid on chain; only the companion stops using it.

### Tests (leanSphincs-s)

- **KAT A**: (1) upstream `test/fixtures/leansphincs-s-keccak-kat.json` @ `4c76aaf`, verbatim in
  `vectors/leansphincs-s-upstream.json` (6 vectors, b = 6/10/12, made by `lssk kat` and confirmed by upstream's
  independent Python verifier); (2) upstream crate's `known_answer` (b = 11: pk, keccak256(sig), counter 14,828);
  (3) the bench's vectors (`bench/vectors/leansphincs-s.json`, upstream `lssk sign-key` with a Light-tier key file,
  b = 13). Keygen and deterministic signing reproduce all of them **bit for bit** (`rust/tests/lean_kat_upstream.rs`;
  (1) and (3) also through WASM, `test/lean.test.ts`).
- **KAT C**: `vectors/leansphincs-s.json` (32 vectors: 4 BIP-39 mnemonics × 2 roles × 4 hedged signatures with fixed
  entropy, plus negative recipes), regenerated with `pnpm vectors:lean`; all 32 are also accepted by upstream's
  Python verifier (`script/leansphincs_s_signer.py --verify`) and by the unmodified upstream Solidity verifier
  (`scripts/onchain-crosscheck.sh`, which also checks that the vendored copies in `contracts/` and `bench/` are the
  upstream file byte for byte).
- **Negative**: every byte of a signature bit-flipped, digest/pk mutations, swapped pk halves, counter +1..+64,
  wrong lengths (incl. 3,688), all-zero/all-FF, C13 keys and signatures, corrupted secret keys
  (`rust/tests/lean_negative.rs`, `test/lean.test.ts`, `contracts/test/pq/LeanSphincsSVerifier.t.sol`).
- **On chain**: `contracts/test/pq/LeanSphincsSVerifier.t.sol` (sets A and C, recipes, fuzz),
  `contracts/test/pq/LeanSphincsSPathA.t.sol` (VaultSigner clone, Path A/B under FrameSim),
  `contracts/devnet-tests/pq/lean-path-a.ts` (local devnet, stock sidecar; result in IMPLEMENTATION-NOTES.md).

## Tests (C13)

```
cd rust && cargo test --release     # KAT A, PRF parity with upstream Python, negatives, proptest, derivation
pnpm build:wasm && npx vitest run    # KAT B (sets A and C through WASM), negatives, property, API
scripts/onchain-crosscheck.sh <sphincs-minus checkout @4c76aaf>   # upstream Solidity verifier accepts sets A and C
```

- **KAT A**: 5 vectors from upstream `signer-c13` (built from 4c76aaf; the `deadbeef` vector also
  from `script/signer.py`, byte-identical). Our deterministic mode reproduces all of them bit for
  bit, and PRF outputs match values computed by upstream's Python functions (the parity oracle
  upstream's `cross_validate.rs` was meant to be; findings C13-S-f1/f2).
- **KAT B**: the same set A vectors plus set C through the WASM build in Node.
- **KAT C**: `vectors/c13.json`, regenerated with `pnpm vectors`.

## Building

Needs Rust with `wasm32-unknown-unknown` and `wasm-bindgen-cli` **0.2.117** (must equal the
`wasm-bindgen` crate pin):

```
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.117 --locked
pnpm build        # scripts/build-wasm.sh, then tsc -> dist/
```

`dist/` is a build output. `wasm/` is committed (one WASM module with both schemes): CI rebuilds it from `rust/` and
diffs it (`.github/workflows/ci.yml`, job `pq-signer-wasm`). `rust/rust-toolchain.toml` pins the rustc that, with
wasm-bindgen-cli 0.2.117, reproduces `leaked_pq_bg.wasm` byte for byte (`WASM_HASH`); bump both together.

Runtime notes: the module initialises synchronously at import (`initSync`, 118 KB with both schemes; well under
Chrome's 8 MB main-thread synchronous-compile limit), so there is no top-level `await` and it
loads in an MV3 service worker. An extension manifest must allow WASM:
`"content_security_policy": { "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'" }`.
Hedged signing draws from `crypto.getRandomValues` (`getrandom/js`), available in browsers,
workers and Node >= 19.

## Provenance

Algorithm and byte formats from `nconsigny/SPHINCS-` (MIT, Nicolas Consigny):
`signers/signer-wasm/src/*` (signer) and `src/keccak/SPHINCs-C13Asm.sol` (verifier). leanSphincs-s
(`rust/src/lean_s/`): `signers/leansphincs-s-keccak/src/*` (MIT; adapted by N. Consigny from
TomWambsgans/leanXMSS-leanSPHINCS-candidates `crates/sphincs` branch `keccak`, MIT OR Apache-2.0, used under MIT,
itself from leanEthereum/leanVM), `docs/leanSphincs-S-keccak.md` and `src/keccak/LeanSphincs-SAsm.sol`. The Rust
code is adapted from them (rewritten with streaming treehash, a single-block keccak fast path,
hedging and zeroization; adapted files carry an MIT attribution header); see `THIRD_PARTY.md`.

Possible speed-up not taken: the forced-zero FORS tree's revealed value is its full root (2¹⁹
leaves, ~1/7 of signing time), as upstream does. The verifier would accept any value there, but
changing it would break bit-compatibility with upstream signatures.
