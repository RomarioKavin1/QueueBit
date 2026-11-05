# @leaked/pq-signer

Post-quantum signer for the LEAKED vault and recovery keys: **SPHINCS- C13** (keccak256, FIPS 205
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
| `onchain/`, `scripts/onchain-crosscheck.sh` | runs the unmodified upstream verifier in a throwaway Foundry project against sets A and C |
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

Key formats: `pk = pkSeed(16) ‖ pkRoot(16)` (the `bytes32 pk` of `IPQVerifier`; the adapter
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
  and the shadow stack is cleared after keygen/sign. The TS wrapper passes copies, so the
  **caller must wipe its own `secretKey` / seed arrays**. JS strings and the JS heap cannot be
  wiped reliably: never hex-encode or log secrets.
- **Timing.** No secret-dependent branches or memory indices: chain lengths, tree indices and
  both grinding loops depend only on public values (digest, R, counters published in the
  signature). Keccak is constant-time.
- **Malleability.** Upstream finding C13-mal-f1 is narrower than its title: all 3,688 bytes are
  consumed (`negative.rs` flips every byte), but the tx hash of an EIP-8141 frame tx is still
  malleable at the protocol level. Track vault txs by `(sender, nonce, sigHash)`.
- **Error surface.** `verify` returns `false` where the raw Solidity verifier reverts
  (`sig.length != 3688`); the `C13Adapter` must do the same (`try/catch`).
- `#![deny(unsafe_code)]`; the only `unsafe` is the WASM allocator wrapper.

## Tests

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

`wasm/` and `dist/` are build outputs and are not committed.

## Provenance

Algorithm and byte formats from `nconsigny/SPHINCS-` (MIT, Nicolas Consigny):
`signers/signer-wasm/src/*` (signer) and `src/keccak/SPHINCs-C13Asm.sol` (verifier). The Rust
code is adapted from them (rewritten with streaming treehash, a single-block keccak fast path,
hedging and zeroization; adapted files carry an MIT attribution header); see `THIRD_PARTY.md`.

Possible speed-up not taken: the forced-zero FORS tree's revealed value is its full root (2¹⁹
leaves, ~1/7 of signing time), as upstream does. The verifier would accept any value there, but
changing it would break bit-compatibility with upstream signatures.
