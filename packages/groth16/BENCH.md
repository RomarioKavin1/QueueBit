# @leaked/groth16 benchmarks

Privacy Pools v1 `withdraw` circuit (Withdraw(32); nVars 36,901, 8 public signals, domain 2^16), pinned artifacts of
npm `@fatsolutions/privacy-pools-core-circuits@1.0.5` (zkey sha256 `2a893b42…de677`), input
`fixtures/withdraw-input.json`. Medians of 5 runs. Apple M3 (8 cores), Node v26.0.0, rustc 1.94.1, 2026-11-06.

| Engine | Witness | Prove | Full prove | Verify |
|---|---:|---:|---:|---:|
| **WASM in Node** (`pnpm bench`): arkworks core single-threaded, witness in Node's WebAssembly | 33 ms | 2,348 ms | **2,390 ms** | 5 ms |
| WASM, first call (core init + zkey parse + circuit compile + prove) | | | 2,597 ms | |
| **Native**, 1 thread (`pnpm bench:native`; witness through wasmi) | 161 ms | **789 ms** | | |
| Native, rayon (8 threads) | 165 ms | **197 ms** | | |
| snarkjs 0.7.5 in Node (reference only, multi-threaded WASM, GPL; not shipped) | | | 1,653 ms | |

zkey parse (17.8 MB, every point checked on-curve): 12–23 ms native. The WASM core is 663 KB (inlined as base64).

Notes
- The shipped engine is single-threaded: ~1.45× snarkjs' multi-threaded time on this machine. Multi-threading the
  WASM core (wasm-bindgen-rayon) needs SharedArrayBuffer, i.e. a cross-origin-isolated offscreen document; left for
  later. Native rayon shows the headroom (4×).
- Witness generation is ~5× faster in the host WebAssembly engine (V8) than in the wasmi interpreter, which is why
  the browser path uses the host engine and wasmi is native-only (CLI, Rust tests).
- Reproduce: `pnpm --filter "@leaked/groth16..." build && pnpm --filter @leaked/groth16 bench` and
  `pnpm --filter @leaked/groth16 bench:native`.
