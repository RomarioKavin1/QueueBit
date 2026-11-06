/**
 * Withdrawal proving. Everything here is worker-safe: no Node APIs, artifacts as bytes, hashing with WebCrypto, so
 * it runs in a `Worker` inside the extension's offscreen document (plan §1.3: an MV3 service worker cannot host a
 * 17 MiB zkey + snarkjs). The Groth16 engine is injected (`Groth16Backend`): snarkjs is GPL-3.0, so this package does
 * not import it; the extension decides how it ships a prover (THIRD_PARTY.md, IMPLEMENTATION-NOTES.md).
 */

/** The `withdraw` circuit's inputs (`withdraw.circom`, Withdraw(32)). */
export interface WithdrawCircuitInputs {
  withdrawnValue: bigint;
  stateRoot: bigint;
  stateTreeDepth: bigint;
  ASPRoot: bigint;
  ASPTreeDepth: bigint;
  context: bigint;
  label: bigint;
  existingValue: bigint;
  existingNullifier: bigint;
  existingSecret: bigint;
  newNullifier: bigint;
  newSecret: bigint;
  stateSiblings: bigint[];
  stateIndex: bigint;
  ASPSiblings: bigint[];
  ASPIndex: bigint;
}

/** snarkjs' proof JSON. */
export interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol?: string;
  curve?: string;
}

/** `ProofLib.WithdrawProof` (pB in EIP-197 order). pubSignals: newCommitmentHash, existingNullifierHash,
 * withdrawnValue, stateRoot, stateTreeDepth, ASPRoot, ASPTreeDepth, context. */
export interface SolProof {
  pA: readonly [bigint, bigint];
  pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  pC: readonly [bigint, bigint];
  pubSignals: readonly [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
}

export interface ProveResult {
  proof: SolProof;
  /** snarkjs form (the 0xbow relayer takes this). */
  raw: Groth16Proof;
  publicSignals: string[];
  ms: number;
}

export interface Prover {
  prove(inputs: WithdrawCircuitInputs): Promise<ProveResult>;
}

/** The Groth16 engine (snarkjs' `groth16` object satisfies it). Artifacts are passed as bytes, never paths. */
export interface Groth16Backend {
  fullProve(
    input: Record<string, unknown>,
    wasm: Uint8Array,
    zkey: Uint8Array,
  ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
  verify?(vkey: unknown, publicSignals: string[], proof: Groth16Proof): Promise<boolean>;
}

// ---------------------------------------------------------------------------------------------------------------
// Artifacts, hash-pinned
// ---------------------------------------------------------------------------------------------------------------

export type ArtifactName = "withdraw.wasm" | "withdraw.zkey" | "withdraw.vkey";

/**
 * sha256 of the withdraw-circuit artifacts in npm `@fatsolutions/privacy-pools-core-circuits@1.0.5` (Apache-2.0).
 * The zkey and vkey are byte-identical to 0xbow `privacy-pools-core` @ df4bf73 `trusted-setup/final-keys/` (the
 * same pins as THIRD_PARTY.md and `contracts/devnet-tests/privacy`). The extension ships these files in the CRX and
 * loads them from `chrome.runtime.getURL(...)`; nothing is fetched remotely, and a mismatch refuses to prove.
 */
export const WITHDRAW_ARTIFACT_PINS: Readonly<Record<ArtifactName, string>> = Object.freeze({
  "withdraw.wasm": "36cda22791def3d520a55c0fc808369cd5849532a75fab65686e666ed3d55c10",
  "withdraw.zkey": "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677",
  "withdraw.vkey": "666bd0983b20c1611543b04f7712e067fbe8cad69f07ada8a310837ff398d21e",
});

export class ArtifactHashMismatchError extends Error {
  constructor(
    readonly artifact: string,
    readonly got: string,
    readonly pinned: string,
  ) {
    super(`${artifact}: sha256 ${got} does not match the pinned ${pinned}; refusing to prove with it`);
    this.name = "ArtifactHashMismatchError";
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface WithdrawArtifacts {
  wasm: Uint8Array;
  zkey: Uint8Array;
  vkey: unknown;
}

export type ArtifactLoader = (name: ArtifactName) => Promise<Uint8Array>;

/** Loads the three artifacts and checks each against its pin before anything uses it. */
export async function loadPinnedArtifacts(
  load: ArtifactLoader,
  pins: Readonly<Record<ArtifactName, string>> = WITHDRAW_ARTIFACT_PINS,
): Promise<WithdrawArtifacts> {
  const names: ArtifactName[] = ["withdraw.wasm", "withdraw.zkey", "withdraw.vkey"];
  const [wasm, zkey, vkey] = await Promise.all(
    names.map(async (n) => {
      const bytes = await load(n);
      const got = await sha256Hex(bytes);
      if (got !== pins[n]) throw new ArtifactHashMismatchError(n, got, pins[n]);
      return bytes;
    }),
  );
  return { wasm: wasm!, zkey: zkey!, vkey: JSON.parse(new TextDecoder().decode(vkey!)) };
}

/** Loads artifacts over a fetch from `baseUrl` (e.g. `chrome.runtime.getURL("pp-circuits/")`). */
export function fetchArtifactLoader(baseUrl: string, f: typeof fetch = globalThis.fetch): ArtifactLoader {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return async (name) => {
    const res = await f(base + name);
    if (!res.ok) throw new Error(`artifact ${name}: HTTP ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The Groth16 prover
// ---------------------------------------------------------------------------------------------------------------

export function toSolProof(raw: Groth16Proof, publicSignals: readonly string[]): SolProof {
  if (publicSignals.length !== 8) throw new Error(`withdraw proof has 8 public signals, got ${publicSignals.length}`);
  const b = (x: string | undefined) => {
    if (x === undefined) throw new Error("malformed proof");
    return BigInt(x);
  };
  const a = raw.pi_a;
  const c = raw.pi_c;
  const [b0, b1] = [raw.pi_b[0] ?? [], raw.pi_b[1] ?? []];
  return {
    pA: [b(a[0]), b(a[1])],
    // EIP-197 order (x_imag, x_real), as snarkjs' exportSolidityCallData swaps the G2 coordinates.
    pB: [
      [b(b0[1]), b(b0[0])],
      [b(b1[1]), b(b1[0])],
    ],
    pC: [b(c[0]), b(c[1])],
    pubSignals: publicSignals.map((s) => BigInt(s)) as unknown as SolProof["pubSignals"],
  };
}

const stringify = (i: WithdrawCircuitInputs): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(i).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => x.toString()) : (v as bigint).toString()]),
  );

export class ProofSelfCheckError extends Error {
  constructor() {
    super("the prover's proof does not verify against the pinned verification key");
    this.name = "ProofSelfCheckError";
  }
}

/**
 * A `Prover` over a Groth16 engine and pinned artifacts. `artifacts` is loaded lazily, once (a promise is cached and
 * dropped again on failure). With `selfVerify` (default) the proof is checked against the pinned vkey before it
 * leaves the prover, so a corrupted engine never produces a broadcastable-but-invalid withdrawal.
 */
export function createGroth16Prover(o: {
  backend: Groth16Backend;
  artifacts: () => Promise<WithdrawArtifacts>;
  selfVerify?: boolean;
  now?: () => number;
}): Prover {
  const selfVerify = o.selfVerify ?? true;
  // A self-check that cannot run must not be skipped silently: an engine without `verify` is refused unless the
  // caller turned the self-check off explicitly (privacy review).
  if (selfVerify && typeof o.backend.verify !== "function") {
    throw new TypeError("createGroth16Prover: the Groth16 engine has no verify(); pass selfVerify: false to opt out");
  }
  let loaded: Promise<WithdrawArtifacts> | undefined;
  const now = o.now ?? (() => Date.now());
  return {
    async prove(inputs) {
      loaded ??= o.artifacts().catch((e) => {
        loaded = undefined;
        throw e;
      });
      const a = await loaded;
      const t0 = now();
      const { proof, publicSignals } = await o.backend.fullProve(stringify(inputs), a.wasm, a.zkey);
      const ms = now() - t0;
      if (selfVerify && !(await o.backend.verify!(a.vkey, publicSignals, proof))) {
        throw new ProofSelfCheckError();
      }
      return { proof: toSolProof(proof, publicSignals), raw: proof, publicSignals, ms };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Worker RPC: the extension runs `serveProver` inside a Worker in its offscreen document and talks to it with
// `createWorkerProver(worker)`. Any `postMessage`/`onmessage` endpoint works (Worker, MessagePort).
// ---------------------------------------------------------------------------------------------------------------

export interface PortLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

type ProveRequest = { kind: "pp-prove"; id: number; inputs: WithdrawCircuitInputs };
type ProveResponse =
  | { kind: "pp-proved"; id: number; result: ProveResult }
  | { kind: "pp-prove-failed"; id: number; error: { name: string; message: string } };

/** Worker side. Requests are proved one at a time (a second proof would only compete for the same cores). */
export function serveProver(port: PortLike, prover: Prover): void {
  let queue: Promise<void> = Promise.resolve();
  port.onmessage = (ev) => {
    const m = ev.data as ProveRequest;
    if (!m || m.kind !== "pp-prove" || typeof m.id !== "number") return;
    queue = queue.then(async () => {
      let res: ProveResponse;
      try {
        res = { kind: "pp-proved", id: m.id, result: await prover.prove(m.inputs) };
      } catch (e) {
        const err = e as Error;
        res = { kind: "pp-prove-failed", id: m.id, error: { name: err.name, message: err.message } };
      }
      port.postMessage(res);
    });
  };
}

export class ProverTimeoutError extends Error {
  constructor(ms: number) {
    super(`proof not ready after ${ms} ms`);
    this.name = "ProverTimeoutError";
  }
}

/** Page side: a `Prover` whose work happens behind `port`. */
export function createWorkerProver(port: PortLike, o: { timeoutMs?: number } = {}): Prover & { close(): void } {
  const pending = new Map<number, { resolve: (r: ProveResult) => void; reject: (e: Error) => void }>();
  let nextId = 1;
  port.onmessage = (ev) => {
    const m = ev.data as ProveResponse;
    const p = m && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.kind === "pp-proved") p.resolve(m.result);
    else {
      const e = new Error(m.error.message);
      e.name = m.error.name;
      p.reject(e);
    }
  };
  return {
    prove(inputs) {
      const id = nextId++;
      return new Promise<ProveResult>((resolve, reject) => {
        const timeoutMs = o.timeoutMs ?? 300_000;
        const timer = setTimeout(() => {
          if (pending.delete(id)) reject(new ProverTimeoutError(timeoutMs));
        }, timeoutMs);
        pending.set(id, {
          resolve: (r) => (clearTimeout(timer), resolve(r)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        port.postMessage({ kind: "pp-prove", id, inputs } satisfies ProveRequest);
      });
    },
    close() {
      port.onmessage = null;
      for (const p of pending.values()) p.reject(new Error("prover closed"));
      pending.clear();
    },
  };
}
