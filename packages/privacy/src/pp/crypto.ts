import { poseidon1 } from "poseidon-lite/poseidon1";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { poseidon3 } from "poseidon-lite/poseidon3";
import { LeanIMT } from "@zk-kit/lean-imt";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  getAddress,
  keccak256,
  type Address,
  type Hex,
} from "viem";

/**
 * Privacy Pools v1 formulas, as the circuit and contracts define them (adapted from the repo's own
 * `contracts/devnet-tests/privacy/src/pp.ts`):
 *   nullifierHash = Poseidon(nullifier); precommitment = Poseidon(nullifier, salt)
 *   commitment    = Poseidon(value, label, precommitment); label = keccak(scope ‖ nonce) % F
 *   scope         = keccak(pool ‖ chainId ‖ asset) % F;    context = keccak(abi.encode(withdrawal, scope)) % F
 */

export const SNARK_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const NATIVE_ASSET: Address = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";
export const MAX_TREE_DEPTH = 32;
export const ROOT_HISTORY_SIZE = 64;

export const scopeOf = (pool: Address, chainId: bigint, asset: Address = NATIVE_ASSET): bigint =>
  BigInt(keccak256(encodePacked(["address", "uint256", "address"], [pool, chainId, asset]))) % SNARK_FIELD;
export const labelOf = (scope: bigint, nonce: bigint): bigint =>
  BigInt(keccak256(encodePacked(["uint256", "uint256"], [scope, nonce]))) % SNARK_FIELD;

export const precommitmentOf = (nullifier: bigint, salt: bigint): bigint => poseidon2([nullifier, salt]);
export const nullifierHashOf = (nullifier: bigint): bigint => poseidon1([nullifier]);
export const commitmentOf = (value: bigint, label: bigint, precommitment: bigint): bigint =>
  poseidon3([value, label, precommitment]);

export interface Withdrawal {
  processooor: Address;
  data: Hex;
}

const WITHDRAWAL_TUPLE = {
  type: "tuple",
  components: [
    { name: "processooor", type: "address" },
    { name: "data", type: "bytes" },
  ],
} as const;

export const contextOf = (w: Withdrawal, scope: bigint): bigint =>
  BigInt(keccak256(encodeAbiParameters([WITHDRAWAL_TUPLE, { type: "uint256" }], [w, scope]))) % SNARK_FIELD;

/** PoolPayer / Kohaku `encodeFeeData`: `withdrawal.data` when `processooor = PoolPayer`. */
export interface FeeData {
  recipient: Address;
  feeRecipient: Address;
  fee: bigint;
  /** `0x0` means the recipient. */
  refundRecipient: Address;
}
const FEE_TUPLE = {
  type: "tuple",
  components: [
    { name: "recipient", type: "address" },
    { name: "feeRecipient", type: "address" },
    { name: "fee", type: "uint256" },
    { name: "refundRecipient", type: "address" },
  ],
} as const;
export const encodeFeeData = (f: FeeData): Hex => encodeAbiParameters([FEE_TUPLE], [f]);
export function decodeFeeData(data: Hex): FeeData {
  const [f] = decodeAbiParameters([FEE_TUPLE], data);
  return {
    recipient: getAddress(f.recipient),
    feeRecipient: getAddress(f.feeRecipient),
    fee: f.fee,
    refundRecipient: getAddress(f.refundRecipient),
  };
}

/** `IEntrypoint.RelayData`: `withdrawal.data` when `processooor = Entrypoint` (0xbow relayer mode). */
export interface RelayData {
  recipient: Address;
  feeRecipient: Address;
  relayFeeBPS: bigint;
}
const RELAY_TUPLE = {
  type: "tuple",
  components: [
    { name: "recipient", type: "address" },
    { name: "feeRecipient", type: "address" },
    { name: "relayFeeBPS", type: "uint256" },
  ],
} as const;
export const encodeRelayData = (r: RelayData): Hex => encodeAbiParameters([RELAY_TUPLE], [r]);
export function decodeRelayData(data: Hex): RelayData {
  const [r] = decodeAbiParameters([RELAY_TUPLE], data);
  return { recipient: getAddress(r.recipient), feeRecipient: getAddress(r.feeRecipient), relayFeeBPS: r.relayFeeBPS };
}

// ---------------------------------------------------------------------------------------------------------------
// LeanIMT (the pool's state tree and the ASP tree): Poseidon(2), depth = ceil(log2(n)).
// ---------------------------------------------------------------------------------------------------------------

export const newTree = (leaves: readonly bigint[] = []): LeanIMT<bigint> => {
  const t = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  if (leaves.length) t.insertMany([...leaves]);
  return t;
};

/** A LeanIMT root of `leaves` (0 for an empty tree, as the contracts report). */
export const rootOf = (leaves: readonly bigint[]): bigint => (leaves.length ? newTree(leaves).root : 0n);

export interface MerklePath {
  index: bigint;
  /** Padded with zeros to `MAX_TREE_DEPTH`. */
  siblings: bigint[];
  depth: bigint;
  root: bigint;
}

export function merklePath(leaves: readonly bigint[], leaf: bigint): MerklePath {
  const t = newTree(leaves);
  const i = t.indexOf(leaf);
  if (i < 0) throw new Error("leaf not in tree");
  const p = t.generateProof(i);
  return {
    // A one-leaf tree has an empty path, for which @zk-kit/lean-imt reports index NaN.
    index: p.siblings.length === 0 ? 0n : BigInt(p.index),
    siblings: [...p.siblings, ...Array<bigint>(MAX_TREE_DEPTH - p.siblings.length).fill(0n)],
    depth: BigInt(t.depth),
    root: t.root,
  };
}
