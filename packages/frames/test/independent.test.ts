import { keccak256, numberToHex, toRlp, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import { encodeTx, getProfile, sigHash, type FrameTx } from "../src/index.js";
import { samples } from "./samples.js";

// An independent encoding of the eip8141-current vectors, written from the EIP text (ethereum/EIPs af5ea76,
// "Payload Encoding" and "Signature Hash") with viem's RLP and none of the codec's code, to check the profile we
// pinned ourselves (no client implements it yet, so there is no upstream vector).
const profile = getProfile("eip8141-current");

/** An RLP scalar: empty for zero, else minimal big-endian bytes. */
const ql = (n: bigint | number): Hex => {
  if (BigInt(n) === 0n) return "0x";
  const h = numberToHex(BigInt(n));
  return h.length % 2 ? (`0x0${h.slice(2)}` as Hex) : h;
};

function byHand(tx: FrameTx, elide: boolean): Hex {
  // [chain_id, nonce, sender, frames, signatures, fees, blob_versioned_hashes]
  // frames = [[mode, flags, target, [execution, state], value, data], ...]
  // signatures = [[scheme, signer, msg, signature], ...]; fees = [max_fee, max_priority_fee_per_gas]
  const payload = [
    ql(tx.chainId),
    ql(tx.nonceSeq),
    tx.sender,
    tx.frames.map((f) => [
      ql(f.mode),
      ql(f.flags),
      f.target ?? "0x",
      [ql(f.limits.execution), ql(f.limits.state)],
      ql(f.value),
      f.data,
    ]),
    tx.signatures.map((s) => [
      ql(s.scheme),
      s.signer,
      s.msg,
      elide && s.msg === "0x" ? ql((s.signature.length - 2) / 2) : s.signature,
    ]),
    [ql(tx.fees.maxFee!), ql(tx.fees.maxPriorityFeePerGas)],
    tx.blobVersionedHashes,
  ];
  return `0x06${toRlp(payload as never).slice(2)}`;
}

describe("eip8141-current against a hand encoding of the EIP text", async () => {
  for (const { name, tx } of await samples(profile)) {
    it(name, () => {
      expect(encodeTx(profile, tx)).toBe(byHand(tx, false));
      expect(sigHash(profile, tx)).toBe(keccak256(byHand(tx, true)));
    });
  }

  it("the sig hash commits to the witness length but not to its bytes", async () => {
    const all = await samples(profile);
    const tx = all.find((s) => s.name === "fixed-length witness and a payer")!.tx;
    const sameLength = {
      ...tx,
      signatures: [{ ...tx.signatures[0]!, signature: `0x${"77".repeat(40)}` as Hex }, tx.signatures[1]!],
    };
    const longer = {
      ...tx,
      signatures: [{ ...tx.signatures[0]!, signature: `0x${"77".repeat(41)}` as Hex }, tx.signatures[1]!],
    };
    expect(sigHash(profile, sameLength)).toBe(sigHash(profile, tx));
    expect(sigHash(profile, longer)).not.toBe(sigHash(profile, tx));
  });
});
