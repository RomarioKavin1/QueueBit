# @leaked/pq-signer benchmarks

Measured 2026-11-06. Plan section 20 §3.6 marks phone/WASM signing time `[UNVERIFIED]`; this file
records what has been measured so far. Only laptop numbers exist yet: phone rows are still
**unmeasured**.

Machine: Apple M3 (8 cores), macOS, single thread. Rust 1.94 release (`lto`, `codegen-units=1`),
Node v26.0.0. Commands:

```
cd rust && cargo run --release --bin leaked-pq -- bench 20     # native
node bench/wasm-bench.mjs 20                                     # WASM (the inlined build, Node)
```

## Results (n = 20 each, fresh random key and digest per run)

| Operation | Native median | Native p95 | WASM (Node) median | WASM p95 |
|---|---|---|---|---|
| keygen (top XMSS subtree, 2¹¹ WOTS+C leaves) | 115 ms | 121 ms | 128 ms | 135 ms |
| sign (incl. post-sign self-verify) | **2.28 s** | 2.85 s | **2.61 s** | 3.71 s |
| verify | 0.05 ms | 0.06 ms | 0.1 ms | 0.1 ms |

- Signing cost is ~13 M keccak-f calls: 7 FORS trees of 2¹⁹ leaves (~11 M, rebuilt per
  signature because the FORS instance depends on the message), the R grind (geometric, mean 2¹⁹
  tries of 2 hashes), two XMSS subtrees and two WOTS+C counter grinds. The spread (p95 / median
  ≈ 1.25–1.4) comes from the R grind.
- WASM is only ~15 % slower than native: keccak-f1600 is 64-bit integer work that wasm32 runs
  well. No SIMD, no threads in either build.
- Upstream `signer-c13` (same machine, same commit 4c76aaf): 2.9 s per signature. The
  difference is the single-block keccak fast path and streaming treehash (O(h) memory instead of
  ~32 MiB per FORS tree).
- On-chain verify (unmodified `SphincsC13Asm`, Foundry, external call, 32 KAT C vectors):
  **min 107,672 / mean 107,750 / max 110,172 gas** (the max includes the cold account access of
  the first call). Upstream reports ~107 K verifier execution (`signers/signer-wasm/README.md:32`)
  and 114,300 gas for the whole VERIFY frame (`docs/deployments.md:59`).

Compared with the plan's estimates (§3.6, `[EST]`): native laptop 0.05–0.2 s was optimistic
(measured 2.3 s single-threaded); WASM laptop 0.2–1 s likewise (measured 2.6 s). Upstream's
"20 ms powerful CPU" is a model at 512 M keccak-f/s, about 90× what one M3 core does through
this code (~5.7 M keccak-f/s).

## leanSphincs-s (experimental), measured 2026-11-06

Same machine and toolchain. Light-tier keys (kept subtree 2¹³), no node cache: keygen and every signature rebuild
the 2¹³-leaf subtree. Commands:

```
cd rust && cargo run --release --bin leaked-pq -- bench-lean 20     # native
node bench/wasm-bench.mjs 20 leanSphincsS                             # WASM (the inlined build, Node)
```

| Operation (n = 20, fresh random key and digest per run) | Native median | Native p95 | WASM (Node) median | WASM p95 |
|---|---|---|---|---|
| keygen (2¹³ WOTS+C leaves + 13 surrogates, ~1.85 M keccak calls) | 391 ms | 420 ms | 435 ms | 474 ms |
| sign (incl. post-sign self-verify) | **425 ms** | 446 ms | **474 ms** | 504 ms |
| verify | 0.05 ms | 0.06 ms | 0.1 ms | 0.1 ms |

- Signing is ~2.0 M keccak calls: the subtree rebuild for the auth path (2¹³ · 225 + 2¹³ − 1 ≈ 1.85 M, upstream's
  "none" cache plan), the 13 FORS trees of 2¹² leaves (13 · 10,238 ≈ 133 K), the randomizer grind into the kept
  subtree (mean 2¹³ one-block digests) and the WOTS+C counter grind (mean ~14.7 K one-permutation tries from a
  midstate). Spread is small (p95/median ≈ 1.05) because the subtree rebuild dominates and is constant.
- **5.5× faster than C13 in WASM** (474 ms vs 2.61 s), and well under the plan's 1 s UI threshold on a laptop.
  Upstream `lssk sign-key` with a Light key file (16 KiB node cache, 8 threads) takes 10–30 ms (bench `signMs`); a
  cached plan would cut ours by ~12× at the cost of a 16 KiB stateful-looking key file. Not done: the cache is
  derivable from the seed, but keeping the secret key a fixed 64 bytes keeps the API identical to C13.
- The devnet run (`contracts/devnet-tests/pq/lean-path-a.ts`, bun, same laptop with the amd64-emulated devnet
  running) measured keygen 617 ms and sign 873 ms.
- On-chain: unmodified `LeanSphincsSAsm` external call over KAT C min 39,911 / mean 40,140 / max 42,552 gas
  (`scripts/onchain-crosscheck.sh`); the `LeanSphincsSVerifier` adapter min 42,085 / mean 42,314 / max 44,726
  (`contracts/test/pq`), 44,846 cold. In a VaultSigner clone's Path A VERIFY frame on the devnet: **84,465 gas**
  (verifier call 41,159), under the stock 100 K budget (IMPLEMENTATION-NOTES.md).

## Not yet measured

| Target | Status |
|---|---|
| Chrome / Safari desktop (WASM) | not run; expected close to the Node number (same V8 / JSC tier-up) `[EST]` |
| Android mid-range, Chrome (WASM) | **unmeasured** `[UNVERIFIED]`; 3–5× slower cores than an M3 → roughly 8–13 s per signature `[EST]` |
| iPhone, Safari (WASM) | **unmeasured** `[UNVERIFIED]`; roughly 3–5 s `[EST]` |
| native `uniffi` build on phones | not built |

leanSphincs-s phones: unmeasured; at the same 3–5× core ratio roughly 1.5–2.5 s per signature `[EST]`.

Consequences for the companion UI: show a progress indicator for signing (p95 is well above the
plan's 1 s threshold on every platform) and run `sign` in a Worker. Options if phones are too
slow: parallelise the 7 FORS trees (threads natively; Web Workers + SharedArrayBuffer in WASM,
~4–6× on multi-core phones `[EST]`), or a different scheme row from the benchmark (§6).
