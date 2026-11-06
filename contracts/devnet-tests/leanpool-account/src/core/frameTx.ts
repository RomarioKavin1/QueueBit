import type { Address, Hex } from "viem";
import { devnet } from "./config.ts";
import { getProfile } from "@forshtat/hegota-support/profiles";
import * as lib from "@forshtat/hegota-support/tx";
import { toWire } from "@forshtat/hegota-support/rpc";

export const profile = getProfile("ethrex-eip8141-tracer");
export type FrameTx = lib.FrameTx;

export interface Call {
  to: Address;
  value?: bigint;
  data?: Hex;
  /** Execution gas of the SENDER frame. */
  gas?: bigint;
  /** State gas: non-zero when the call may create an account or new storage. */
  state?: bigint;
}

/** An ARBITRARY entry: the protocol checks nothing (signer must be empty), the account reads the bytes. With an
 * empty `msg` its bytes are elided from the signature hash, so they can be filled in after signing. */
export const arbitraryEntry = (signature: Hex = "0x"): lib.SignatureEntry => ({ scheme: 0, signer: "0x", msg: "0x", signature });

/**
 * `[VERIFY(wallet), SENDER(call)]` with signature entry 0 = ARBITRARY, for the DirectPQWallet baseline: the key signs
 * `sigHash(tx)` while the entry is empty, then the entry gets the 5,684-byte signature itself (`withWitness`), which
 * the wallet verifies in the EVM.
 */
export function buildDirectTx(a: { wallet: Address; nonceKey: bigint; nonceSeq: bigint; call: Call; verifyGas?: bigint }): FrameTx {
  return lib.newTx({
    chainId: devnet.chainId,
    sender: a.wallet,
    nonceKeys: [a.nonceKey],
    nonceSeq: a.nonceSeq,
    signatures: [arbitraryEntry()],
    fees: { maxFeePerGas: devnet.maxFeePerGas, maxPriorityFeePerGas: devnet.maxFeePerGas },
    frames: [
      lib.frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", target: null, execution: a.verifyGas ?? 99_000n }),
      lib.frame(profile, "SENDER", {
        target: a.call.to,
        execution: a.call.gas ?? 60_000n,
        state: a.call.state ?? 200_000n,
        value: a.call.value ?? 0n,
        data: a.call.data ?? "0x",
      }),
    ],
  });
}

/** Same tx with signature entry 0's bytes replaced. The signature hash does not change. */
export function withWitness(tx: FrameTx, signature: Hex): FrameTx {
  return { ...tx, signatures: tx.signatures.map((s, i) => (i === 0 ? { ...s, signature } : s)) };
}

export const sigHash = (tx: FrameTx): Hex => lib.sigHash(profile, tx);
export const txHash = (tx: FrameTx): Hex => lib.txHash(profile, tx);
export const encodeRaw = (tx: FrameTx): Hex => lib.encodeTx(profile, tx);
export const decodeRaw = (raw: Hex): FrameTx => lib.decodeTx(profile, raw);
export { toWire };

/** A frame tx as ethrex's eth_getBlockByNumber(…, true) returns it (there is no raw-tx RPC). */
export function fromRpcTx(t: any): FrameTx {
  return {
    chainId: BigInt(t.chainId),
    nonceKeys: t.nonceKeys.map(BigInt),
    nonceSeq: BigInt(t.nonceSeq),
    sender: t.sender,
    frames: t.frames.map((f: any) => ({
      mode: Number(f.mode),
      flags: Number(f.flags),
      target: f.to ?? null,
      limits: { execution: BigInt(f.gasLimit), state: BigInt(f.stateLimit) },
      value: BigInt(f.value),
      data: f.data,
    })),
    signatures: t.signatures.map((s: any) => ({ scheme: Number(s.scheme), signer: s.signer ?? "0x", msg: s.msg, signature: s.signature })),
    fees: { maxPriorityFeePerGas: BigInt(t.maxPriorityFeePerGas), maxFeePerGas: BigInt(t.maxFeePerGas), maxFeePerBlobGas: BigInt(t.maxFeePerBlobGas ?? 0) },
    blobVersionedHashes: t.blobVersionedHashes ?? [],
    recentRootReferences: (t.recentRootReferences ?? []).map((r: any) => ({ sourceId: r.sourceId, slot: BigInt(r.slot), root: r.root })),
  };
}
