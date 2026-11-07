/// <reference lib="webworker" />
/**
 * The private balance's prover, in a Worker of its own (started by the engine worker on the first private send): the
 * MIT arkworks Groth16 engine (@queuebit/groth16, WASM inlined) over the circuit artifacts this app serves from
 * `/pp-circuits/` (copied at build time by scripts/copy-circuits.mjs). Each artifact is checked against its sha256 pin
 * before anything proves with it, and each proof is verified against the pinned key before it leaves this Worker.
 * Proving takes a few seconds of CPU and holds the note's secrets: it never runs on the page's thread.
 */
import { serveDefaultProver } from "@queuebit/groth16";
import { fetchArtifactLoader, type PortLike } from "@queuebit/privacy";

declare const self: DedicatedWorkerGlobalScope;

serveDefaultProver(self as unknown as PortLike, {
  loader: fetchArtifactLoader(new URL("/pp-circuits/", self.location.href).href),
});
