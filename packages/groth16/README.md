# @queuebit/groth16

MIT Groth16 (BN254) prover for circom circuits: the default `@queuebit/privacy` engine, replacing snarkjs (GPL-3.0) in
the shipped extension. Proofs and public signals are snarkjs-shaped (`pi_a`/`pi_b`/`pi_c` decimal strings), so
`toSolProof`, PoolPayer and the 0xbow relayer take them unchanged. NOT AUDITED.

```ts
// Worker in the MV3 offscreen document
import { fetchArtifactLoader } from "@queuebit/privacy";
import { serveDefaultProver } from "@queuebit/groth16";
serveDefaultProver(self, { loader: fetchArtifactLoader(chrome.runtime.getURL("pp-circuits/")) });

// page side
const prover = createWorkerProver(worker); // from @queuebit/privacy
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
before returning it (`ConstraintUnsatisfiedError`). `@queuebit/privacy` then self-verifies again against the pinned
vkey through the engine's `verify`.

**Randomness.** The blinding scalars r, s come from 128 bytes of `crypto.getRandomValues` on the JS side (reduced
mod r from 64 uniform bytes each; zero is refused); the core has no RNG of its own and nothing in it is
deterministic. `engineOptions.entropy` overrides the source for tests only: two proofs of one witness must differ,
and `test/engine.test.ts` checks that they do with the default source.

**Secrets.** The witness is wiped where it was held: the circuit instance's memory is zeroed after extraction, the
witness buffer after proving, the entropy after the call, and the core's allocator zeroes every freed block (the
argument copies, the assignment, the QAP evaluations, r and s), so `test/engine.test.ts` finds no witness element
and no entropy in the core's linear memory after `prove()`. What remains is the caller's `input` object and the
proof. Nothing is constant-time (arkworks' MSMs and FFTs branch on the scalars, as in every Groth16 prover): run it
in a Worker of its own.

**The zkey is trusted after its pin.** Every point is checked on the curve (G1 has cofactor 1, so that is also the
subgroup check); the verifying key's three G2 points are subgroup-checked; the nVars B2 query points are not (tens
of seconds in WASM). The key reaches the engine only through `loadPinnedArtifacts` (sha256 pin), and a malicious
key could at worst make proofs that fail verification, since each one is verified against the key's own vkey. The
domain size is required to be the next power of two above constraints + public + 1, the domain the reduction uses.

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
pnpm --filter @queuebit/groth16 test            # snarkjs cross-check, forge on-chain check, negatives, privacy path
pnpm --filter @queuebit/groth16 test:rust       # cargo test --features native
pnpm --filter @queuebit/groth16 build:wasm      # rebuild wasm/ (wasm-bindgen-cli 0.2.117, rustc 1.94.1)
```

The on-chain check compiles a temp copy of `contracts/test/privacy/WithdrawalGroth16Verifier.sol` (MIT, same key
as the deployed verifier) with forge; it runs when `forge` is on PATH and is mandatory with
`GROTH16_REQUIRE_FORGE=1` (CI).
