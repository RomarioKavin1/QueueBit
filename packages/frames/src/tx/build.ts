// `frame`, `newTx`, `secp256k1Placeholder` and the lookups are adapted from @forshtat/hegota-support (MIT,
// Copyright (c) 2026 Alex Forshtat), src/tx/build.ts at 2377188; changed to size placeholders on length-committing
// profiles and to accept a fee budget. The named frame builders and signature entries are new. See THIRD_PARTY.md.
import { numberToHex, type Address, type Hex } from "viem";
import type { Profile } from "../profiles/types.js";
import { FrameCodecError, SECP256K1_SIGNATURE_LENGTH } from "./codec.js";
import type { FeeParams, Frame, FrameTx, SignatureEntry } from "./types.js";

function lookup(table: Readonly<Record<string, number>>, name: string, what: string, profile: Profile): number {
  const value = table[name];
  if (value === undefined) {
    throw new FrameCodecError(
      `Profile "${profile.id}" has no ${what} "${name}". It has: ${Object.keys(table).join(", ") || "(none)"}`,
    );
  }
  return value;
}

export const frameMode = (profile: Profile, name: string): number =>
  lookup(profile.frameModes, name, "frame mode", profile);
export const approveScope = (profile: Profile, name: string): number =>
  lookup(profile.approveScopes, name, "approve scope", profile);
export const sigScheme = (profile: Profile, name: string): number =>
  lookup(profile.sigSchemes, name, "signature scheme", profile);
export const flagBit = (profile: Profile, name: string): number => lookup(profile.flagBits, name, "flag bit", profile);

export interface FrameInit {
  /** `null` (the default) targets the transaction's sender. */
  target?: Address | null;
  execution: bigint;
  state?: bigint;
  value?: bigint;
  data?: Hex;
  /** Raw flag bits, ORed with any `scope`. */
  flags?: number;
  /** An approve scope name from the profile, e.g. `"EXECUTION_AND_PAYMENT"`. */
  scope?: string;
}

/** A frame of the named mode (`"VERIFY"`, `"SENDER"`, `"POST_TX"`, ...). Throws when the profile has no such mode. */
export function frame(profile: Profile, mode: string, init: FrameInit): Frame {
  const scope = init.scope === undefined ? 0 : approveScope(profile, init.scope);
  return {
    mode: frameMode(profile, mode),
    flags: (init.flags ?? 0) | scope,
    target: init.target ?? null,
    limits: { execution: init.execution, state: init.state ?? 0n },
    value: init.value ?? 0n,
    data: init.data ?? "0x",
  };
}

// --------------------------------------------------------------------------------------------------------------
// Named frames: EIP-8141 "Mode Subclassifications" (self_verify, deploy, only_verify, pay, expiry_verify, user_op,
// post_op). VERIFY frames carry no value and no state limit in these builders; pass `frame()` for anything else.
// --------------------------------------------------------------------------------------------------------------

export interface VerifyInit {
  /** `null` (the default) targets the sender. */
  target?: Address | null;
  execution: bigint;
  data?: Hex;
}

/** `self_verify`: VERIFY with flags 0x3; the sender approves execution and pays. */
export const selfVerify = (profile: Profile, init: VerifyInit): Frame =>
  frame(profile, "VERIFY", { ...init, scope: "EXECUTION_AND_PAYMENT" });

/** `only_verify`: VERIFY with flags 0x2; the sender approves execution only. Must target the sender. */
export const onlyVerify = (profile: Profile, init: VerifyInit): Frame =>
  frame(profile, "VERIFY", { ...init, scope: "EXECUTION" });

/** `pay`: VERIFY with flags 0x1 on the payer (a paymaster contract, or a default-code EOA with `data` empty). */
export const pay = (profile: Profile, init: VerifyInit & { target: Address }): Frame =>
  frame(profile, "VERIFY", { ...init, scope: "PAYMENT" });

export interface CallInit {
  target?: Address | null;
  execution: bigint;
  state?: bigint;
  value?: bigint;
  data?: Hex;
  /** Sets ATOMIC_BATCH: this frame and the next one succeed or revert together. */
  atomic?: boolean;
}

function callFrame(profile: Profile, mode: string, init: CallInit): Frame {
  const { atomic, ...rest } = init;
  return frame(profile, mode, { ...rest, flags: atomic ? flagBit(profile, "ATOMIC_BATCH") : 0 });
}

/** `user_op`: a SENDER frame, executed as `tx.sender` once the sender is approved. */
export const senderFrame = (profile: Profile, init: CallInit): Frame => callFrame(profile, "SENDER", init);

/** `deploy` / `post_op`: a DEFAULT frame, executed as ENTRY_POINT. */
export const defaultFrame = (profile: Profile, init: CallInit): Frame => callFrame(profile, "DEFAULT", init);

/** Byte length of an expiry verifier frame's data: an 8-byte big-endian timestamp (EIP-8141 EXPIRY_DATA_LENGTH). */
export const EXPIRY_DATA_LENGTH = 8;

/**
 * `expiry_verify`: a VERIFY frame with flags 0 on the profile's EXPIRY_VERIFIER, valid while
 * `block.timestamp <= expiry`. Throws on a profile whose network has no known expiry verifier.
 */
export function expiryVerify(profile: Profile, expiry: bigint, execution: bigint): Frame {
  const target = profile.predeploys.EXPIRY_VERIFIER;
  if (!target) throw new FrameCodecError(`Profile "${profile.id}" has no EXPIRY_VERIFIER predeploy`);
  if (expiry < 0n || expiry >= 2n ** 64n) throw new FrameCodecError("expiry must fit in 8 bytes");
  return frame(profile, "VERIFY", { target, execution, data: numberToHex(expiry, { size: EXPIRY_DATA_LENGTH }) });
}

// --------------------------------------------------------------------------------------------------------------
// Signature entries.
// --------------------------------------------------------------------------------------------------------------

const zeros = (n: number): Hex => `0x${"00".repeat(n)}`;

/**
 * A SECP256K1 entry over the sig hash; `signTx` fills in `signature`. `signer` `"0x"` means `tx.sender`.
 * On a profile whose sig hash commits to signature lengths the placeholder is 65 zero bytes, so the hash is the
 * same before and after signing; elsewhere it is empty (as in hegota-support).
 */
export function secp256k1Placeholder(profile: Profile, signer: Hex = "0x"): SignatureEntry {
  const signature = profile.sigHashElision === "length" ? zeros(SECP256K1_SIGNATURE_LENGTH) : "0x";
  return { scheme: sigScheme(profile, "SECP256K1"), signer, msg: "0x", signature };
}

/** Alias of `secp256k1Placeholder`. */
export const secp256k1Entry = secp256k1Placeholder;

/**
 * An ARBITRARY entry over the sig hash whose witness has a length fixed in advance (`length` bytes), as a
 * zero-filled placeholder. Fill it with `setSignature` (which keeps the length); the sig hash does not change.
 */
export function arbitraryEntry(profile: Profile, length: number): SignatureEntry {
  if (!Number.isInteger(length) || length < 0) throw new FrameCodecError(`Invalid ARBITRARY length ${length}`);
  return { scheme: sigScheme(profile, "ARBITRARY"), signer: "0x", msg: "0x", signature: zeros(length) };
}

// --------------------------------------------------------------------------------------------------------------
// Transactions.
// --------------------------------------------------------------------------------------------------------------

export interface TxInit {
  chainId: bigint | number;
  sender: Address;
  frames: Frame[];
  signatures: SignatureEntry[];
  nonceSeq: bigint;
  /** Defaults to `[0n]`, the sender's linear account nonce. */
  nonceKeys?: bigint[];
  /**
   * Per-gas fees (devnet profiles): `maxFeePerGas`, with `maxPriorityFeePerGas` defaulting to it. Or a total budget
   * (`eip8141-current`): `maxFee` and `maxPriorityFeePerGas`.
   */
  fees: Partial<FeeParams> & ({ maxFeePerGas: bigint } | { maxFee: bigint; maxPriorityFeePerGas: bigint });
}

/** A transaction with the optional fields defaulted. */
export function newTx(init: TxInit): FrameTx {
  const f = init.fees;
  const fees: FeeParams = {
    maxPriorityFeePerGas: f.maxPriorityFeePerGas ?? f.maxFeePerGas ?? 0n,
    maxFeePerGas: f.maxFeePerGas ?? 0n,
    maxFeePerBlobGas: f.maxFeePerBlobGas ?? 0n,
  };
  if (f.maxFee !== undefined) fees.maxFee = f.maxFee;
  return {
    chainId: BigInt(init.chainId),
    nonceKeys: init.nonceKeys ?? [0n],
    nonceSeq: init.nonceSeq,
    sender: init.sender,
    frames: init.frames,
    signatures: init.signatures,
    fees,
    blobVersionedHashes: [],
    recentRootReferences: [],
  };
}
