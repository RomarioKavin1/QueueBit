import { encodeAbiParameters, keccak256, toHex } from "viem";
import type { Address, Hex } from "viem";
import { arbitraryEntry, frame, leanPoolTriple, newTx, selfVerify } from "@queuebit/frames";
import { profile } from "./frameTx.js";
import type { FrameTx } from "./frameTx.js";

/** A single-dependency sender's tx, as LeanPool's `buildTx8288` made it: `[VERIFY 0x3 (sender, one triple),
 * SENDER(call)]`, entry 0 ARBITRARY and empty. QueueBit's `LeanPoolHotSigner` uses the same layout
 * (`@queuebit/frames` `leanPoolHotTx`). Used by tests and scripts. */
export function buildTx8288(a: {
  wallet: Address;
  vk: Hex;
  nonceKey: bigint;
  nonceSeq: bigint;
  call: { to: Address; value?: bigint; data?: Hex; gas?: bigint; state?: bigint };
  verifyGas?: bigint;
  chainId?: number;
  maxFeePerGas?: bigint;
}): FrameTx {
  const fee = a.maxFeePerGas ?? 2_000_000_000n;
  return newTx({
    chainId: a.chainId ?? 1337,
    sender: a.wallet,
    nonceKeys: [a.nonceKey],
    nonceSeq: a.nonceSeq,
    fees: { maxFeePerGas: fee, maxPriorityFeePerGas: fee },
    frames: [
      selfVerify(profile, { execution: a.verifyGas ?? 80_000n, data: leanPoolTriple(a.vk) }),
      frame(profile, "SENDER", {
        target: a.call.to,
        execution: a.call.gas ?? 60_000n,
        state: a.call.state ?? 200_000n,
        value: a.call.value ?? 0n,
        data: a.call.data ?? "0x",
      }),
    ],
    signatures: [arbitraryEntry(profile, 0)],
  });
}

/** The witness in signature entry 0 of a single-dependency sender: the batch root, the ring position the aggregator
 * wrote it to, and the Merkle proof of the tx's dependency leaf. */
export const encodeWitness8288 = (root: Hex, ring: number, proof: Hex[]): Hex =>
  encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[]" }], [root, ring, proof]);

/** An ERC-8286 keystore's witness (LeanPool's LeanAccount): the root, the ring position, and one Merkle proof per
 * dependency triple, in the order the triples appear in the tx. */
export const encodeWitnessMulti = (root: Hex, ring: number, proofs: Hex[][]): Hex =>
  encodeAbiParameters([{ type: "bytes32" }, { type: "uint8" }, { type: "bytes32[][]" }], [root, ring, proofs]);

/** The tag that opens a keystore validator's data (LeanPool `KeystoreValidator.LEANPOOL_DEPS`). */
export const LEANPOOL_DEPS = keccak256(toHex("LEANPOOL_DEPS_V1"));
