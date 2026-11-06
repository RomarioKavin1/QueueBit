// The frame-transaction codec for the node, over @queuebit/frames (QueueBit's port of hegota-support's codec, the one
// LeanPool used: test/codec-parity.test.ts proves identical bytes and hashes on LeanPool-shaped txs).
import {
  decodeTx,
  encodeTx,
  getProfile,
  setSignature,
  sigHash as sigHashOf,
  toWire,
  txHash as txHashOf,
} from "@queuebit/frames";
import type { FrameTx } from "@queuebit/frames";
import type { Hex } from "viem";

export type { FrameTx };
/** The public alt-mempool devnet's profile (chain 1337): type 0x06, keyed nonces, empty-msg signature elision. */
export const profile = getProfile("ethrex-eip8141-tracer");

export const sigHash = (tx: FrameTx): Hex => sigHashOf(profile, tx);
export const txHash = (tx: FrameTx): Hex => txHashOf(profile, tx);
export const encodeRaw = (tx: FrameTx): Hex => encodeTx(profile, tx);
export const decodeRaw = (raw: Hex): FrameTx => decodeTx(profile, raw);
/** Same tx with signature entry 0's bytes replaced. The signature hash does not change (entry 0 has an empty msg). */
export const withWitness = (tx: FrameTx, signature: Hex): FrameTx => setSignature(profile, tx, 0, signature);
export { toWire };
