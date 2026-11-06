/// <reference lib="webworker" />
import { serveDefaultProver } from "@leaked/groth16";
import { fetchArtifactLoader, type PortLike } from "@leaked/privacy";

/**
 * The withdraw prover (Worker inside the offscreen document): arkworks Groth16 engine (MIT, WASM inlined, compiled
 * under 'wasm-unsafe-eval'), the circuit's witness module run by this Worker's WebAssembly engine, and the pinned
 * artifacts shipped in the extension package (`pp-circuits/`, copied at build time; a hash mismatch refuses to prove).
 * Every proof is verified against the pinned vkey before it is returned.
 */
const base = new URL("/pp-circuits/", self.location.href).href;
serveDefaultProver(self as unknown as PortLike, { loader: fetchArtifactLoader(base) });
