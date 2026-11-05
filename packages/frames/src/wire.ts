// `toWire` is adapted from @forshtat/hegota-support (MIT, Copyright (c) 2026 Alex Forshtat), src/rpc/wire.ts at
// 2377188. `fromWire` and the type are new. See THIRD_PARTY.md.
import { hexToBigInt, type Address, type Hex } from "viem";
import { FrameCodecError } from "./tx/codec.js";
import type { FrameTx } from "./tx/types.js";

/** The JSON form of a frame transaction that the Skandha sidecar takes (`eth_sendFrameTransaction`). */
export interface WireFrameTx {
  chainId: Hex;
  nonceKeys: Hex[];
  nonceSeq: Hex;
  sender: Address;
  frames: {
    mode: number;
    flags: number;
    target: Address | null;
    limits: { execution: Hex; state: Hex };
    value: Hex;
    data: Hex;
  }[];
  signatures: { scheme: number; signer: Hex; msg: Hex; signature: Hex }[];
  fees: { maxPriorityFeePerGas: Hex; maxFeePerGas: Hex; maxFeePerBlobGas: Hex };
  blobVersionedHashes: Hex[];
  recentRootReferences: { sourceId: Hex; slot: Hex; root: Hex }[];
}

const hex = (n: bigint): Hex => `0x${n.toString(16)}`;
const big = (h: Hex | string | number): bigint =>
  typeof h === "number" ? BigInt(h) : h === "0x" ? 0n : hexToBigInt(h as Hex);

/**
 * The sidecar's JSON form: bigints as 0x-quantities. The sidecar speaks the devnet layout (per-gas fees, keyed
 * nonces), so a transaction with a total fee budget (`fees.maxFee`) has no wire form and throws.
 */
export function toWire(tx: FrameTx): WireFrameTx {
  if (tx.fees.maxFee !== undefined) {
    throw new FrameCodecError("The sidecar wire format has no total fee budget (fees.maxFee)");
  }
  return {
    chainId: hex(tx.chainId),
    nonceKeys: tx.nonceKeys.map(hex),
    nonceSeq: hex(tx.nonceSeq),
    sender: tx.sender,
    frames: tx.frames.map((f) => ({
      mode: f.mode,
      flags: f.flags,
      target: f.target,
      limits: { execution: hex(f.limits.execution), state: hex(f.limits.state) },
      value: hex(f.value),
      data: f.data,
    })),
    signatures: tx.signatures.map((s) => ({ scheme: s.scheme, signer: s.signer, msg: s.msg, signature: s.signature })),
    fees: {
      maxPriorityFeePerGas: hex(tx.fees.maxPriorityFeePerGas),
      maxFeePerGas: hex(tx.fees.maxFeePerGas),
      maxFeePerBlobGas: hex(tx.fees.maxFeePerBlobGas),
    },
    blobVersionedHashes: tx.blobVersionedHashes,
    recentRootReferences: tx.recentRootReferences.map((r) => ({
      sourceId: r.sourceId,
      slot: hex(r.slot),
      root: r.root,
    })),
  };
}

/** Inverse of `toWire`. Numeric fields may be numbers or 0x-quantities. */
export function fromWire(w: WireFrameTx): FrameTx {
  return {
    chainId: big(w.chainId),
    nonceKeys: w.nonceKeys.map(big),
    nonceSeq: big(w.nonceSeq),
    sender: w.sender,
    frames: w.frames.map((f) => ({
      mode: Number(big(f.mode)),
      flags: Number(big(f.flags)),
      target: f.target ?? null,
      limits: { execution: big(f.limits.execution), state: big(f.limits.state) },
      value: big(f.value),
      data: f.data,
    })),
    signatures: w.signatures.map((s) => ({
      scheme: Number(big(s.scheme)),
      signer: s.signer ?? "0x",
      msg: s.msg,
      signature: s.signature,
    })),
    fees: {
      maxPriorityFeePerGas: big(w.fees.maxPriorityFeePerGas),
      maxFeePerGas: big(w.fees.maxFeePerGas),
      maxFeePerBlobGas: big(w.fees.maxFeePerBlobGas),
    },
    blobVersionedHashes: w.blobVersionedHashes ?? [],
    recentRootReferences: (w.recentRootReferences ?? []).map((r) => ({
      sourceId: r.sourceId,
      slot: big(r.slot),
      root: r.root,
    })),
  };
}
