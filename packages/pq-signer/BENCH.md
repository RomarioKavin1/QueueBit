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

## Not yet measured

| Target | Status |
|---|---|
| Chrome / Safari desktop (WASM) | not run; expected close to the Node number (same V8 / JSC tier-up) `[EST]` |
| Android mid-range, Chrome (WASM) | **unmeasured** `[UNVERIFIED]`; 3–5× slower cores than an M3 → roughly 8–13 s per signature `[EST]` |
| iPhone, Safari (WASM) | **unmeasured** `[UNVERIFIED]`; roughly 3–5 s `[EST]` |
| native `uniffi` build on phones | not built |

Consequences for the companion UI: show a progress indicator for signing (p95 is well above the
plan's 1 s threshold on every platform) and run `sign` in a Worker. Options if phones are too
slow: parallelise the 7 FORS trees (threads natively; Web Workers + SharedArrayBuffer in WASM,
~4–6× on multi-core phones `[EST]`), or a different scheme row from the benchmark (§6).
