import { encodeFunctionData, type Address, type Hex } from "viem";
import { POOL_ABI } from "./abi.js";
import type { Note } from "./notes.js";
import {
  ArtifactHashMismatchError,
  ProofSelfCheckError,
  sha256Hex,
  type ArtifactLoader,
  type Groth16Backend,
  type Groth16Proof,
  type WithdrawArtifacts,
} from "./prover.js";

/**
 * Public exit (ragequit, Privacy Pools v1 `PrivacyPool.ragequit`): the original depositor takes a note's full value
 * back to the depositing address, proving only that it knows the note's nullifier and secret (the `commitment`
 * circuit, CommitmentHasher). It needs no ASP approval and no state or ASP root, and it is public: the exit names the
 * deposit's label and goes to the depositor, so it unlinks nothing. Worker-safe like `prover.ts`.
 */

/** The `commitment` circuit's inputs (`commitment.circom`): public `value`, `label`; private `nullifier`, `secret`. */
export interface CommitmentCircuitInputs {
  value: bigint;
  label: bigint;
  nullifier: bigint;
  secret: bigint;
}

/** `ProofLib.RagequitProof` (pB in EIP-197 order). pubSignals: commitmentHash, nullifierHash, value, label. */
export interface RagequitSolProof {
  pA: readonly [bigint, bigint];
  pB: readonly [readonly [bigint, bigint], readonly [bigint, bigint]];
  pC: readonly [bigint, bigint];
  pubSignals: readonly [bigint, bigint, bigint, bigint];
}

export interface RagequitProveResult {
  proof: RagequitSolProof;
  raw: Groth16Proof;
  publicSignals: string[];
  ms: number;
}

export interface RagequitProver {
  proveRagequit(inputs: CommitmentCircuitInputs): Promise<RagequitProveResult>;
}

export type CommitmentArtifactName = "commitment.wasm" | "commitment.zkey" | "commitment.vkey";

/**
 * sha256 of the commitment-circuit artifacts in npm `@fatsolutions/privacy-pools-core-circuits@1.0.5` (Apache-2.0;
 * the vkey is the one `contracts/test/privacy/CommitmentVkey.sol` is generated from). A mismatch refuses to prove.
 */
export const COMMITMENT_ARTIFACT_PINS: Readonly<Record<CommitmentArtifactName, string>> = Object.freeze({
  "commitment.wasm": "254d2130607182fd6fd1aee67971526b13cfe178c88e360da96dce92663828d8",
  "commitment.zkey": "494ae92d64098fda2a5649690ddc5821fcd7449ca5fe8ef99ee7447544d7e1f3",
  "commitment.vkey": "7d48b4eb3dedc12fb774348287b587f0c18c3c7254cd60e9cf0f8b3636a570d8",
});

/** Loads the commitment circuit's three artifacts and checks each against its pin before anything uses it. */
export async function loadPinnedCommitmentArtifacts(
  load: ArtifactLoader,
  pins: Readonly<Record<CommitmentArtifactName, string>> = COMMITMENT_ARTIFACT_PINS,
): Promise<WithdrawArtifacts> {
  const names: CommitmentArtifactName[] = ["commitment.wasm", "commitment.zkey", "commitment.vkey"];
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

/** The circuit inputs of a note's public exit. */
export const ragequitInputs = (n: Pick<Note, "value" | "label" | "nullifier" | "salt">): CommitmentCircuitInputs => ({
  value: n.value,
  label: n.label,
  nullifier: n.nullifier,
  secret: n.salt,
});

export function toRagequitSolProof(raw: Groth16Proof, publicSignals: readonly string[]): RagequitSolProof {
  if (publicSignals.length !== 4) throw new Error(`ragequit proof has 4 public signals, got ${publicSignals.length}`);
  const b = (x: string | undefined) => {
    if (x === undefined) throw new Error("malformed proof");
    return BigInt(x);
  };
  const [b0, b1] = [raw.pi_b[0] ?? [], raw.pi_b[1] ?? []];
  return {
    pA: [b(raw.pi_a[0]), b(raw.pi_a[1])],
    pB: [
      [b(b0[1]), b(b0[0])],
      [b(b1[1]), b(b1[0])],
    ],
    pC: [b(raw.pi_c[0]), b(raw.pi_c[1])],
    pubSignals: publicSignals.map((s) => BigInt(s)) as unknown as RagequitSolProof["pubSignals"],
  };
}

/** A ragequit prover over a Groth16 engine and the pinned commitment artifacts (self-verified by default). */
export function createRagequitProver(o: {
  backend: Groth16Backend;
  artifacts: () => Promise<WithdrawArtifacts>;
  selfVerify?: boolean;
  now?: () => number;
}): RagequitProver {
  const selfVerify = o.selfVerify ?? true;
  if (selfVerify && typeof o.backend.verify !== "function") {
    throw new TypeError("createRagequitProver: the Groth16 engine has no verify(); pass selfVerify: false to opt out");
  }
  let loaded: Promise<WithdrawArtifacts> | undefined;
  const now = o.now ?? (() => Date.now());
  return {
    async proveRagequit(inputs) {
      loaded ??= o.artifacts().catch((e) => {
        loaded = undefined;
        throw e;
      });
      const a = await loaded;
      const t0 = now();
      const input = Object.fromEntries(Object.entries(inputs).map(([k, v]) => [k, (v as bigint).toString()]));
      const { proof, publicSignals } = await o.backend.fullProve(input, a.wasm, a.zkey);
      const ms = now() - t0;
      if (selfVerify && !(await o.backend.verify!(a.vkey, publicSignals, proof))) throw new ProofSelfCheckError();
      const sol = toRagequitSolProof(proof, publicSignals);
      if (sol.pubSignals[2] !== inputs.value || sol.pubSignals[3] !== inputs.label) throw new ProofSelfCheckError();
      return { proof: sol, raw: proof, publicSignals, ms };
    },
  };
}

/** `pool.ragequit(proof)`: must be sent by the original depositor (the account), which receives the value. */
export const buildRagequitTx = (pool: Address, proof: RagequitSolProof): { to: Address; data: Hex; value: bigint } => ({
  to: pool,
  data: encodeFunctionData({ abi: POOL_ABI, functionName: "ragequit", args: [proof] }),
  value: 0n,
});
