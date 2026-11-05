// Adapted from @forshtat/hegota-support (MIT, Copyright (c) 2026 Alex Forshtat), src/tx/types.ts at 2377188.
// Added `FeeParams.maxFee` (the current EIP's total fee budget). See THIRD_PARTY.md.
import type { Address, Hex } from "viem";

export interface FrameLimits {
  execution: bigint;
  state: bigint;
}

export interface Frame {
  /** A value from the profile's `frameModes`. */
  mode: number;
  /** Bits 0-1: approval scope; other bits as in the profile's `flagBits`. */
  flags: number;
  /** `null` encodes as the empty string: the frame targets `tx.sender`. */
  target: Address | null;
  limits: FrameLimits;
  value: bigint;
  data: Hex;
}

export interface SignatureEntry {
  /** A value from the profile's `sigSchemes`. */
  scheme: number;
  /** `"0x"` for ARBITRARY and for "the sender" (SECP256K1/P256); otherwise a 20-byte address. */
  signer: Hex;
  /** `"0x"` means the signature covers the canonical signature hash; otherwise an explicit 32-byte digest. */
  msg: Hex;
  signature: Hex;
}

export interface FeeParams {
  maxPriorityFeePerGas: bigint;
  /** Per-gas fee cap of the devnet layouts. Profiles with a `feeBudget` require it to be 0. */
  maxFeePerGas: bigint;
  /** Profiles whose payload has no blob fee field require this to be 0. */
  maxFeePerBlobGas: bigint;
  /**
   * The current EIP's `max_fee`: the total wei the transaction may pay for execution, state and blob gas. Required by
   * profiles with a `feeBudget` field, and must be absent for the others.
   */
  maxFee?: bigint;
}

/** The early EIP-8272 payload field: a declared `(source_id, slot, root)` tuple. */
export interface RecentRootReference {
  sourceId: Hex;
  slot: bigint;
  root: Hex;
}

export interface FrameTx {
  chainId: bigint;
  /** EIP-8250 keyed nonces. `[0n]` is the sender's linear account nonce (the only option on a `nonce` profile). */
  nonceKeys: bigint[];
  /** The nonce sequence; on a profile with a linear `nonce`, the nonce itself. */
  nonceSeq: bigint;
  sender: Address;
  frames: Frame[];
  signatures: SignatureEntry[];
  fees: FeeParams;
  blobVersionedHashes: Hex[];
  recentRootReferences: RecentRootReference[];
}
