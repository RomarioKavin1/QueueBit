# @leaked/groth16

MIT Groth16 (BN254) prover for circom circuits: the default `@leaked/privacy` engine, replacing snarkjs (GPL-3.0) in
the shipped extension. Proofs and public signals are snarkjs-shaped (`pi_a`/`pi_b`/`pi_c` decimal strings), so
`toSolProof`, PoolPayer and the 0xbow relayer take them unchanged. NOT AUDITED.

```ts
// Worker in the MV3 offscreen document
import { fetchArtifactLoader } from "@leaked/privacy";
import { serveDefaultProver } from "@leaked/groth16";
serveDefaultProver(self, { loader: fetchArtifactLoader(chrome.runtime.getURL("pp-circuits/")) });

// page side
const prover = createWorkerProver(worker); // from @leaked/privacy
```

`createArkworksGroth16()` implements `Groth16Backend` (`fullProve` + `verify`); `createDefaultProver` wraps it in
`createGroth16Prover` with hash-pinned artifacts and self-verification on.

## Design

| Piece | Where | What |
|---|---|---|
| zkey reader | `rust/src/zkey.rs` | snarkjs binfile → ark-groth16 `ProvingKey` + A/B matrices (written from the format) |
| QAP reduction | `rust/src/prove.rs` (`CircomReduction`) | circom's: A·B − C on the odd 2n-th-root coset, matching zkey section 9 |
| prove / verify | `rust/src/prove.rs` | `ark-groth16` `create_proof_with_reduction_and_matrices` / `verify_proof` |
| WASM surface | `rust/src/wasm.rs` → `wasm/` | wasm-bindgen 0.2.117, committed, reproducible (CI `groth16-wasm`) |
| witness (browser) | `src/witness.ts` | our glue over the circom module's exports, run by the host's WebAssembly |
| witness (native) | `rust/src/witness.rs` | the same glue on wasmi (CLI, Rust tests, native bench) |

**Never a bogus proof.** The circuit's own `===` assertions fail witness generation (`WitnessError`, circom code 4);
a witness that slips past them is caught because the core verifies every proof against the zkey's verifying key
before returning it (`ConstraintUnsatisfiedError`). `@leaked/privacy` then self-verifies again against the pinned
vkey through the engine's `verify`.

**Why not circom's `witness_calculator.js`.** It lives in `iden3/circom` (GPL-3.0, no separate license). Our glue
is written from the module's import/export interface (FNV-1a signal hashes, shared-RW-memory words), and is
cross-checked element by element against snarkjs' calculator in `test/witness.test.ts`.

**Why not ark-circom.** It pulls wasmer and more; the zkey reader and reduction are ~300 lines here, and the WASM
core stays small (663 KB) and free of a nested WASM runtime.

**CSP.** The core is inlined as base64 and instantiated lazily with `WebAssembly.instantiate`; the circuit module is
compiled with `WebAssembly.compile`. MV3 needs only `'wasm-unsafe-eval'`; no `eval`, `new Function` or fetch.
Proving is synchronous inside WASM for ~2.4 s (BENCH.md): run it in a Worker, never on a UI thread.

## Build and test

```sh
pnpm install                                  # artifacts (dev dep) + snarkjs (test-only oracle)
pnpm --filter @leaked/groth16 test            # snarkjs cross-check, forge on-chain check, negatives, privacy path
pnpm --filter @leaked/groth16 test:rust       # cargo test --features native
pnpm --filter @leaked/groth16 build:wasm      # rebuild wasm/ (wasm-bindgen-cli 0.2.117, rustc 1.94.1)
```

The on-chain check compiles a temp copy of `contracts/test/privacy/WithdrawalGroth16Verifier.sol` (MIT, same key
as the deployed verifier) with forge; it runs when `forge` is on PATH and is mandatory with
`GROTH16_REQUIRE_FORGE=1` (CI).
