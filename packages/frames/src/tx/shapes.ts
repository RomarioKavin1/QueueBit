import { encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import type { Profile } from "../profiles/types.js";
import {
  arbitraryEntry,
  newTx,
  onlyVerify,
  pay,
  secp256k1Entry,
  selfVerify,
  senderFrame,
  type TxInit,
} from "./build.js";
import type { FrameTx } from "./types.js";

/**
 * The QueueBit transaction shapes (plan `10-contracts.md` §10.2.2, `30-extension.md` §4.2). The contracts own them;
 * these builders produce exactly what the account's and the role signers' VERIFY frame-walkers admit. SENDER calldata
 * (`hotExecute`, `executePQ`, `relay`) is passed in encoded, since those ABIs belong to the contracts.
 */

/** VERIFY-frame entry points: an explicit selector, because empty calldata would reach `receive()` (§10.3.2). */
export const QUEUEBIT_VERIFY_ABI = parseAbi(["function verifyFrame()", "function verifyFrame(uint256 sigIndex)"]);

/** `verifyFrame()`: the account's VERIFY frame data. */
export const accountVerifyData = (): Hex =>
  encodeFunctionData({ abi: QUEUEBIT_VERIFY_ABI, functionName: "verifyFrame", args: [] });

/** `verifyFrame(uint256 sigIndex)`: a PQRoleSigner's VERIFY frame data (entry `sigIndex` holds the PQ witness). */
export const roleSignerVerifyData = (sigIndex: bigint): Hex =>
  encodeFunctionData({ abi: QUEUEBIT_VERIFY_ABI, functionName: "verifyFrame", args: [sigIndex] });

interface Common {
  chainId: bigint | number;
  nonceSeq: bigint;
  fees: TxInit["fees"];
}

interface Body {
  /** SENDER calldata, e.g. `hotExecute(declaredUsd, calls)` or `executePQ(0, account, data)`. */
  data: Hex;
  execution: bigint;
  state?: bigint;
}

export interface HotSpendInit extends Common {
  account: Address;
  /** The hot key's address: SECP256K1 entry 0. */
  hotKey: Address;
  /** The gas tank: a default-code EOA that pays (SECP256K1 entry 1, as default code requires for a pay-only frame). */
  tank: Address;
  /** VERIFY execution limit of the account (a per-version constant, never estimated; §30.4.4). */
  verifyGas: bigint;
  /** The tank frame's limit: default code only pays the target's access charge. */
  tankGas: bigint;
  body: Body;
}

/**
 * Hot spend, public mempool: `[only_verify(account, verifyFrame()), pay(tank), SENDER(account, hotExecute)]` with
 * signatures `[SECP256K1 hotKey, SECP256K1 tank]` (§10.2.2 row 1).
 */
export function hotSpendTx(profile: Profile, init: HotSpendInit): FrameTx {
  return newTx({
    chainId: init.chainId,
    sender: init.account,
    nonceSeq: init.nonceSeq,
    fees: init.fees,
    frames: [
      onlyVerify(profile, { execution: init.verifyGas, data: accountVerifyData() }),
      pay(profile, { target: init.tank, execution: init.tankGas }),
      senderFrame(profile, { target: init.account, ...init.body }),
    ],
    signatures: [secp256k1Entry(profile, init.hotKey), secp256k1Entry(profile, init.tank)],
  });
}

export interface SelfPaidHotInit extends Common {
  account: Address;
  hotKey: Address;
  verifyGas: bigint;
  body: Body;
}

/** Hot spend paid by the account itself: `[self_verify(account, verifyFrame()), SENDER(account, hotExecute)]`. */
export function selfPaidHotTx(profile: Profile, init: SelfPaidHotInit): FrameTx {
  return newTx({
    chainId: init.chainId,
    sender: init.account,
    nonceSeq: init.nonceSeq,
    fees: init.fees,
    frames: [
      selfVerify(profile, { execution: init.verifyGas, data: accountVerifyData() }),
      senderFrame(profile, { target: init.account, ...init.body }),
    ],
    signatures: [secp256k1Entry(profile, init.hotKey)],
  });
}

export interface RoleSignerInit extends Common {
  /** The PQRoleSigner instance (VaultSigner / RecoverySigner): its own 8141 sender. */
  roleSigner: Address;
  /** `IPQVerifier.sigLength()` of the signer's scheme: the PQ witness length, fixed in advance (3,688 for C13). */
  sigLength: number;
  verifyGas: bigint;
  /** `executePQ(0, target, data)` for Path B, `relay(target, data)` for Path A. */
  body: Body;
}

/**
 * Vault / recovery, Path B (public mempool): `[VERIFY 0x3 (roleSigner, verifyFrame(0)), SENDER(roleSigner,
 * executePQ(...))]` with `[ARBITRARY PQ witness (sigLength bytes, placeholder), SECP256K1 payerKey]`.
 */
export function roleSignerPathBTx(profile: Profile, init: RoleSignerInit & { payerKey: Address }): FrameTx {
  return newTx({
    chainId: init.chainId,
    sender: init.roleSigner,
    nonceSeq: init.nonceSeq,
    fees: init.fees,
    frames: [
      selfVerify(profile, { execution: init.verifyGas, data: roleSignerVerifyData(0n) }),
      senderFrame(profile, { target: init.roleSigner, ...init.body }),
    ],
    signatures: [arbitraryEntry(profile, init.sigLength), secp256k1Entry(profile, init.payerKey)],
  });
}

/**
 * Vault / recovery, Path A (alt mempool, staked role signer): `[VERIFY 0x3 (roleSigner, verifyFrame(0)),
 * SENDER(roleSigner, relay(...))]` with `[ARBITRARY PQ witness]`; the PQ signature is verified inside VERIFY.
 */
export function roleSignerPathATx(profile: Profile, init: RoleSignerInit): FrameTx {
  return newTx({
    chainId: init.chainId,
    sender: init.roleSigner,
    nonceSeq: init.nonceSeq,
    fees: init.fees,
    frames: [
      selfVerify(profile, { execution: init.verifyGas, data: roleSignerVerifyData(0n) }),
      senderFrame(profile, { target: init.roleSigner, ...init.body }),
    ],
    signatures: [arbitraryEntry(profile, init.sigLength)],
  });
}

// ---------------------------------------------------------------------------------------- LeanPool ----------------

/** EIP-8288 `LEANSPHINCS_SCHEME`: the scheme byte of a leanSPHINCS dependency triple. */
export const LEANSPHINCS_SCHEME = 0x10;

/**
 * The 96-byte EIP-8288 dependency triple `(LEANSPHINCS_SCHEME, data_hash = 0, vk)`: "a leanSPHINCS signature by `vk`
 * over this transaction's signature hash exists" (a zero data_hash stands for the containing tx's own sig hash). It is
 * carried in the sender's VERIFY frame data (LeanAccount: inside the keystore's LEANPOOL_DEPS envelope), covered by
 * the sig hash; the LeanPool node reads it from there.
 */
export const leanPoolTriple = (vk: Hex): Hex =>
  encodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }],
    [BigInt(LEANSPHINCS_SCHEME), `0x${"00".repeat(32)}`, vk],
  );

/** The witness a LeanPool node puts in entry 0 once the batch is posted: `abi.encode(root, ringPosition, proof)`. */
export const leanPoolWitness = (root: Hex, ring: number, proof: Hex[]): Hex =>
  encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[]" }], [root, ring, proof]);
