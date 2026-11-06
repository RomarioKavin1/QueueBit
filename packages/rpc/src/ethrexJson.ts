import type { Address, Hex } from "viem";
import type { FrameTx } from "@queuebit/frames";

/**
 * A frame transaction as ethrex's `eth_getTransactionByHash` returns it (devnet 1337; observed 2026-11-06). Frames use
 * `to`/`gasLimit`/`stateLimit`, numbers are hex quantities, fees are flat, and an empty signer is `null`.
 */
export interface EthrexFrameTransactionRpc {
  type: Hex;
  hash: Hex;
  chainId: Hex;
  nonceKeys: Hex[];
  nonceSeq: Hex;
  sender: Address;
  from?: Address;
  blockHash?: Hex | null;
  blockNumber?: Hex | null;
  transactionIndex?: Hex | null;
  frames: { mode: Hex; flags: Hex; to: Address | null; gasLimit: Hex; stateLimit: Hex; value: Hex; data: Hex }[];
  signatures: { scheme: Hex; signer: Hex | null; msg: Hex; signature: Hex }[];
  maxPriorityFeePerGas: Hex;
  maxFeePerGas: Hex;
  maxFeePerBlobGas: Hex;
  blobVersionedHashes: Hex[];
  recentRootReferences: { sourceId: Hex; slot: Hex; root: Hex }[];
}

const big = (h: Hex): bigint => (h === "0x" ? 0n : BigInt(h));

/** The ethrex JSON form as a `FrameTx` (encode it with the `ethrex-eip8141-tracer` profile). */
export function frameTxFromEthrexJson(j: EthrexFrameTransactionRpc): FrameTx {
  return {
    chainId: big(j.chainId),
    nonceKeys: j.nonceKeys.map(big),
    nonceSeq: big(j.nonceSeq),
    sender: j.sender,
    frames: j.frames.map((f) => ({
      mode: Number(big(f.mode)),
      flags: Number(big(f.flags)),
      target: f.to,
      limits: { execution: big(f.gasLimit), state: big(f.stateLimit) },
      value: big(f.value),
      data: f.data,
    })),
    signatures: j.signatures.map((s) => ({
      scheme: Number(big(s.scheme)),
      signer: s.signer ?? "0x",
      msg: s.msg,
      signature: s.signature,
    })),
    fees: {
      maxPriorityFeePerGas: big(j.maxPriorityFeePerGas),
      maxFeePerGas: big(j.maxFeePerGas),
      maxFeePerBlobGas: big(j.maxFeePerBlobGas),
    },
    blobVersionedHashes: j.blobVersionedHashes,
    recentRootReferences: j.recentRootReferences.map((r) => ({
      sourceId: r.sourceId,
      slot: big(r.slot),
      root: r.root,
    })),
  };
}
