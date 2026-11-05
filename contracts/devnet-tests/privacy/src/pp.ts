// Privacy Pools v1 withdrawal proofs, from scratch: commitments, the two LeanIMTs (state, ASP), the context hash and a
// real Groth16 proof of the published `withdraw` circuit (snarkjs + the circuit artifacts of
// @fatsolutions/privacy-pools-core-circuits@1.0.5, whose withdraw.zkey/.vkey are byte-identical to
// 0xbow-io/privacy-pools-core @ df4bf73 trusted-setup/final-keys). Formulas follow the circuit and contracts:
//   nullifierHash = Poseidon(nullifier); precommitment = Poseidon(nullifier, secret)
//   commitment = Poseidon(value, label, precommitment); label = keccak(scope ‖ nonce) % F (PrivacyPool.deposit)
//   scope = keccak(pool ‖ chainId ‖ asset) % F (State constructor); context = keccak(abi.encode(w, scope)) % F
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { LeanIMT } from "@zk-kit/lean-imt";
import { encodeAbiParameters, encodePacked, keccak256, type Address, type Hex } from "viem";

const require = createRequire(import.meta.url);
// snarkjs is GPL-3.0: used as a tool at test time, never vendored or distributed.
const snarkjs = require("snarkjs");

export const F = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const NATIVE_ASSET: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

const ART = new URL("../node_modules/@fatsolutions/privacy-pools-core-circuits/artifacts/", import.meta.url).pathname;
export const WASM = ART + "withdraw.wasm";
export const ZKEY = ART + "withdraw.zkey";
export const VKEY = ART + "withdraw.vkey";
export const ZKEY_SHA256 = "2a893b42174c813566e5c40c715a8b90cd49fc4ecf384e3a6024158c3d6de677";

export function checkArtifacts() {
  const sha = createHash("sha256").update(readFileSync(ZKEY)).digest("hex");
  if (sha !== ZKEY_SHA256) throw new Error(`withdraw.zkey sha256 ${sha} != pinned ${ZKEY_SHA256}`);
}

export const scopeOf = (pool: Address, chainId: bigint) =>
  BigInt(keccak256(encodePacked(["address", "uint256", "address"], [pool, chainId, NATIVE_ASSET]))) % F;
export const labelOf = (scope: bigint, nonce: bigint) =>
  BigInt(keccak256(encodePacked(["uint256", "uint256"], [scope, nonce]))) % F;

export type Note = { value: bigint; label: bigint; nullifier: bigint; secret: bigint };
export const precommitmentOf = (nullifier: bigint, secret: bigint) => poseidon2([nullifier, secret]);
export const commitmentOf = (n: Note) => poseidon3([n.value, n.label, precommitmentOf(n.nullifier, n.secret)]);
export const nullifierHashOf = (nullifier: bigint) => poseidon1([nullifier]);

/** Deterministic secrets for tests (the SDK derives them from a mnemonic; here: keccak of a tag, reduced). */
export const secretFrom = (tag: string) => BigInt(keccak256(new TextEncoder().encode(tag))) % F;

export type FeeData = { recipient: Address; feeRecipient: Address; fee: bigint; refundRecipient: Address };
export const encodeFeeData = (f: FeeData): Hex =>
  encodeAbiParameters(
    [{ type: "tuple", components: [
      { name: "recipient", type: "address" }, { name: "feeRecipient", type: "address" },
      { name: "fee", type: "uint256" }, { name: "refundRecipient", type: "address" }] }],
    [f],
  );

export type Withdrawal = { processooor: Address; data: Hex };
export const contextOf = (w: Withdrawal, scope: bigint) =>
  BigInt(keccak256(encodeAbiParameters(
    [{ type: "tuple", components: [{ name: "processooor", type: "address" }, { name: "data", type: "bytes" }] }, { type: "uint256" }],
    [w, scope],
  ))) % F;

export function tree(leaves: bigint[]) {
  const t = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  t.insertMany(leaves);
  return t;
}

function merkleProof(t: LeanIMT<bigint>, leaf: bigint) {
  const index = t.indexOf(leaf);
  if (index < 0) throw new Error("leaf not in tree");
  const p = t.generateProof(index);
  const siblings = [...p.siblings, ...Array(32 - p.siblings.length).fill(0n)];
  return { index: BigInt(p.index), siblings };
}

export type SolProof = {
  pA: [bigint, bigint]; pB: [[bigint, bigint], [bigint, bigint]]; pC: [bigint, bigint];
  pubSignals: [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];
};

/** Proves `withdrawn` out of `note` (which must be in `stateLeaves`; its label in `aspLabels`). */
export async function proveWithdrawal(args: {
  note: Note; withdrawn: bigint; stateLeaves: bigint[]; aspLabels: bigint[]; context: bigint;
  newNullifier: bigint; newSecret: bigint;
}): Promise<{ proof: SolProof; stateRoot: bigint; aspRoot: bigint; ms: number }> {
  const st = tree(args.stateLeaves);
  const asp = tree(args.aspLabels);
  const sp = merkleProof(st, commitmentOf(args.note));
  const ap = merkleProof(asp, args.note.label);
  const input = {
    withdrawnValue: args.withdrawn, stateRoot: st.root, stateTreeDepth: BigInt(st.depth),
    ASPRoot: asp.root, ASPTreeDepth: BigInt(asp.depth), context: args.context,
    label: args.note.label, existingValue: args.note.value, existingNullifier: args.note.nullifier,
    existingSecret: args.note.secret, newNullifier: args.newNullifier, newSecret: args.newSecret,
    stateSiblings: sp.siblings, stateIndex: sp.index, ASPSiblings: ap.siblings, ASPIndex: ap.index,
  };
  const t0 = Date.now();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(input, WASM, ZKEY);
  const ms = Date.now() - t0;
  const vkey = JSON.parse(readFileSync(VKEY, "utf8"));
  if (!(await snarkjs.groth16.verify(vkey, publicSignals, proof))) throw new Error("snarkjs rejected its own proof");
  const b = (x: string) => BigInt(x);
  return {
    proof: {
      pA: [b(proof.pi_a[0]), b(proof.pi_a[1])],
      // EIP-197 order (x_imag, x_real): snarkjs' exportSolidityCallData swaps the G2 coordinates the same way.
      pB: [[b(proof.pi_b[0][1]), b(proof.pi_b[0][0])], [b(proof.pi_b[1][1]), b(proof.pi_b[1][0])]],
      pC: [b(proof.pi_c[0]), b(proof.pi_c[1])],
      pubSignals: publicSignals.map(b) as SolProof["pubSignals"],
    },
    stateRoot: st.root, aspRoot: asp.root, ms,
  };
}

export async function terminate() {
  // snarkjs keeps ffjavascript worker threads alive.
  const curve = (globalThis as any).curve_bn128;
  if (curve?.terminate) await curve.terminate();
}
