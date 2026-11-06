/**
 * @queuebit/groth16: the MIT Groth16 (BN254) engine for `@queuebit/privacy`, replacing snarkjs (GPL-3.0) in the
 * shipped extension. arkworks (MIT/Apache-2.0) in Rust/WASM for proving and verifying; the circom witness module runs
 * in the host's WebAssembly engine through our own glue. Proofs and public signals are snarkjs-shaped, so
 * `toSolProof` / PoolPayer / the 0xbow relayer take them unchanged.
 *
 * Default wiring (inside a Worker in the offscreen document):
 *
 *   serveDefaultProver(self, { loader: fetchArtifactLoader(chrome.runtime.getURL("pp-circuits/")) });
 *
 * and on the page side `createWorkerProver(worker)` from `@queuebit/privacy`.
 */
import {
  createGroth16Prover,
  createRagequitProver,
  loadPinnedArtifacts,
  loadPinnedCommitmentArtifacts,
  serveProver,
  type RagequitProver,
  type ArtifactLoader,
  type PortLike,
  type Prover,
  type WithdrawArtifacts,
} from "@queuebit/privacy";
import { createArkworksGroth16, type ArkworksGroth16, type ArkworksGroth16Options } from "./engine.js";

export {
  ConstraintUnsatisfiedError,
  Groth16EngineError,
  WASM_HASH,
  createArkworksGroth16,
  encodeProof,
  encodeVkey,
} from "./engine.js";
export type { ArkworksGroth16, ArkworksGroth16Options, SnarkjsVkey } from "./engine.js";
export { CIRCOM_ERRORS, WitnessError, calculateWitness, compileCircuit, fnv1a64 } from "./witness.js";
export type { CircuitInput } from "./witness.js";

export interface DefaultProverOptions {
  /** Loads the pinned withdraw artifacts (checked against `WITHDRAW_ARTIFACT_PINS`). */
  loader?: ArtifactLoader;
  /** Or supply already-pinned artifacts. */
  artifacts?: () => Promise<WithdrawArtifacts>;
  /** Default true: each proof is checked against the pinned vkey by the engine's `verify` before it is returned. */
  selfVerify?: boolean;
  engine?: ArkworksGroth16;
  engineOptions?: ArkworksGroth16Options;
}

/** The default `@queuebit/privacy` withdraw prover: arkworks engine + hash-pinned artifacts + self-verification. */
export function createDefaultProver(o: DefaultProverOptions): Prover {
  const artifacts = o.artifacts ?? (o.loader ? () => loadPinnedArtifacts(o.loader!) : undefined);
  if (!artifacts) throw new TypeError("createDefaultProver: pass `loader` or `artifacts`");
  return createGroth16Prover({
    backend: o.engine ?? createArkworksGroth16(o.engineOptions),
    artifacts,
    selfVerify: o.selfVerify ?? true,
  });
}

/**
 * The default public-exit (ragequit) prover: the same engine over the pinned `commitment` circuit artifacts
 * (`COMMITMENT_ARTIFACT_PINS`), loaded through the same `loader` on first use.
 */
export function createDefaultRagequitProver(o: DefaultProverOptions & { loader: ArtifactLoader }): RagequitProver {
  return createRagequitProver({
    backend: o.engine ?? createArkworksGroth16(o.engineOptions),
    artifacts: () => loadPinnedCommitmentArtifacts(o.loader),
    selfVerify: o.selfVerify ?? true,
  });
}

/**
 * Worker side: serves the default prover on `port` (a Worker's `self`, or a MessagePort); with a `loader`, the
 * public-exit prover too (its artifacts load only when a ragequit is first proved).
 */
export function serveDefaultProver(port: PortLike, o: DefaultProverOptions): Prover {
  const engine = o.engine ?? createArkworksGroth16(o.engineOptions);
  const p = createDefaultProver({ ...o, engine });
  serveProver(port, p, o.loader ? createDefaultRagequitProver({ ...o, engine, loader: o.loader }) : undefined);
  return p;
}
