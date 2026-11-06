import { encodeAbiParameters, keccak256, pad, type Address, type Hex } from "viem";

/** Key kinds in the keystore (KeystoreValidator.KIND_*). Only PQ keys are quantum-safe. */
export const KIND = {
  /** leanVM leanSPHINCS, approved through LeanPool: `a` is the 32-byte public key (EIP-8288 vk). */
  PQ: 1,
  /** WebAuthn P256, verified in the EVM with P256VERIFY: `a`, `b` are the public key's x, y. */
  PASSKEY: 2,
  /** A protocol-verified P256 signature entry: `a` is the 20-byte signer address. */
  P256: 3,
  /** A protocol-verified secp256k1 signature entry: `a` is the 20-byte signer address. */
  ECDSA: 4,
  /** A browser wallet (MetaMask) signing EIP-712 typed data `LeanAccountTx(sigHash, calls)`: `a` is its address. */
  EIP712: 5,
} as const;
export type KeyKind = (typeof KIND)[keyof typeof KIND];

/** Key roles (bit flags). */
export const ROLE = {
  /** Changes keys, policy, modules, upgrades: needs adminThreshold of ADMIN weight (and a PQ admin under requirePQ). */
  ADMIN: 1,
  /** Spends: spendThreshold of SPEND weight. */
  SPEND: 2,
  /** Alone, spends only to its allowlist within its caps (per-tx in the keystore, daily in SpendingLimitHook). */
  SESSION: 4,
} as const;

export interface Policy {
  adminThreshold: number;
  spendThreshold: number;
  requirePQ: boolean;
  /** The LeanPool aggregator whose roots the account accepts for its PQ keys. */
  aggregator: Address;
}

export interface KeyInit {
  kind: KeyKind;
  weight: number;
  roles: number;
  /** Unix seconds; 0 = permanent. Expiry is enforced in execution (the hook), not in VERIFY. */
  validUntil?: number;
  /** SESSION keys: the most ETH per transaction (wei). */
  perTxCap?: bigint;
  a: Hex;
  b?: Hex;
  /** SESSION keys: the targets it may call. */
  sessionTargets?: Address[];
}

const ZERO32 = pad("0x", { size: 32 });

/** `KeystoreValidator.keyIdOf`: keccak256(abi.encode(uint8 kind, bytes32 a, bytes32 b)). */
export const keyIdOf = (kind: number, a: Hex, b: Hex = ZERO32): Hex =>
  keccak256(encodeAbiParameters([{ type: "uint8" }, { type: "bytes32" }, { type: "bytes32" }], [kind, a, b]));

/** A 20-byte address as a key's `a` field (P256, ECDSA, EIP712 keys). */
export const addrKey = (a: Address): Hex => pad(a, { size: 32 });

/** The key id of an address-held key (ECDSA, P256, EIP712). */
export const addressKeyId = (kind: typeof KIND.ECDSA | typeof KIND.P256 | typeof KIND.EIP712, a: Address): Hex =>
  keyIdOf(kind, addrKey(a));

export const KEY_INIT_TUPLE = {
  type: "tuple",
  components: [
    { name: "kind", type: "uint8" },
    { name: "weight", type: "uint8" },
    { name: "roles", type: "uint8" },
    { name: "validUntil", type: "uint48" },
    { name: "perTxCap", type: "uint128" },
    { name: "a", type: "bytes32" },
    { name: "b", type: "bytes32" },
    { name: "sessionTargets", type: "address[]" },
  ],
} as const;

export const POLICY_TUPLE = {
  type: "tuple",
  components: [
    { name: "adminThreshold", type: "uint16" },
    { name: "spendThreshold", type: "uint16" },
    { name: "requirePQ", type: "bool" },
    { name: "aggregator", type: "address" },
  ],
} as const;

/** A KeyInit as the ABI tuple. */
export const keyTuple = (k: KeyInit) => ({
  kind: k.kind,
  weight: k.weight,
  roles: k.roles,
  validUntil: k.validUntil ?? 0,
  perTxCap: k.perTxCap ?? 0n,
  a: k.a,
  b: k.b ?? ZERO32,
  sessionTargets: k.sessionTargets ?? [],
});

/** The keystore's install data: abi.encode(Policy, KeyInit[]). */
export const encodeValidatorInit = (p: Policy, keys: KeyInit[]): Hex =>
  encodeAbiParameters(
    [POLICY_TUPLE, { type: "tuple[]", components: KEY_INIT_TUPLE.components }],
    [p, keys.map(keyTuple)],
  );
