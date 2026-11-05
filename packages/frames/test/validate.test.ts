import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  MAX_FRAMES,
  expiryVerify,
  frame,
  getProfile,
  newTx,
  secp256k1Entry,
  selfVerify,
  senderFrame,
  validateTx,
  type FrameTx,
} from "../src/index.js";
import { OWNER, firstSample } from "./samples.js";

const tracer = getProfile("ethrex-eip8141-tracer");
const current = getProfile("eip8141-current");
const OTHER = "0x00000000000000000000000000000000000000ee" as const;

const base = (frames = [selfVerify(tracer, { execution: 1n })]): FrameTx =>
  newTx({
    chainId: 1337,
    sender: OWNER,
    nonceSeq: 0n,
    fees: { maxFeePerGas: 1n },
    signatures: [secp256k1Entry(tracer)],
    frames,
  });

describe("validateTx (EIP-8141 static constraints)", () => {
  it("accepts the samples and an unsigned transaction", async () => {
    expect(validateTx(tracer, await firstSample(tracer))).toEqual([]);
    expect(validateTx(tracer, base())).toEqual([]);
  });

  it("frame count", () => {
    expect(validateTx(tracer, base([]))).toContain("a transaction has 1 to 64 frames, this one has 0");
    expect(validateTx(tracer, base(Array(MAX_FRAMES + 1).fill(senderFrame(tracer, { execution: 1n }))))[0]).toMatch(
      /1 to 64/,
    );
  });

  it("modes, flags, targets and values", () => {
    const issues = validateTx(tracer, {
      ...base(),
      sender: "0x1234",
      nonceSeq: 2n ** 64n,
      frames: [
        { ...selfVerify(tracer, { execution: 1n }), mode: 7 },
        { ...senderFrame(tracer, { execution: 1n }), flags: 0x10 },
        { ...senderFrame(tracer, { execution: 1n }), target: "0x12" },
        { ...selfVerify(tracer, { execution: 1n }), value: 1n },
        selfVerify(tracer, { execution: 1n, target: OTHER }),
      ],
    });
    expect(issues).toEqual([
      "sender must be 20 bytes",
      "nonce must be below 2^64 - 1",
      "frame 0: unknown mode 7",
      "frame 1: unknown flag bits 0x10",
      "frame 2: target must be 20 bytes or empty",
      "frame 3: only SENDER frames carry value",
      "frame 4: approval of execution needs target empty or tx.sender",
    ]);
  });

  it("atomic batches", () => {
    const atomic = (mode: string, scope?: string) =>
      frame(tracer, mode, { execution: 1n, flags: 4, ...(scope ? { scope } : {}) });
    expect(validateTx(tracer, base([selfVerify(tracer, { execution: 1n }), atomic("SENDER")]))).toEqual([
      "frame 1: the atomic batch flag needs a following frame",
    ]);
    expect(validateTx(tracer, base([atomic("SENDER"), selfVerify(tracer, { execution: 1n })]))).toEqual([
      "frame 0: an atomic batch cannot contain a VERIFY frame",
      "frame 1: frames in an atomic batch cannot approve",
    ]);
    expect(validateTx(tracer, base([atomic("VERIFY"), senderFrame(tracer, { execution: 1n })]))).toEqual([
      "frame 0: VERIFY frames cannot be in an atomic batch",
    ]);
    expect(validateTx(tracer, base([atomic("SENDER", "PAYMENT"), senderFrame(tracer, { execution: 1n })]))).toEqual([
      "frame 0: frames in an atomic batch cannot approve",
    ]);
    expect(
      validateTx(tracer, base([atomic("SENDER"), frame(tracer, "SENDER", { execution: 1n, scope: "PAYMENT" })])),
    ).toEqual(["frame 1: frames in an atomic batch cannot approve"]);
  });

  it("expiry verifier frames", () => {
    const tx = (frames: FrameTx["frames"]): FrameTx => ({
      ...base(),
      fees: { maxPriorityFeePerGas: 1n, maxFeePerGas: 0n, maxFeePerBlobGas: 0n, maxFee: 1n },
      frames,
    });
    const e = expiryVerify(current, 100n, 1n);
    expect(validateTx(current, tx([e, selfVerify(current, { execution: 1n })]))).toEqual([]);
    expect(validateTx(current, tx([{ ...e, data: "0x01" }]))).toEqual([
      "frame 0: an expiry verifier frame needs flags 0, value 0, state limit 0 and 8 bytes of data",
    ]);
    expect(validateTx(current, tx([e, e]))).toEqual(["a transaction can contain at most one expiry verifier frame"]);
  });

  it("signature entries", () => {
    const sig = (s: Partial<FrameTx["signatures"][number]>) => ({ ...secp256k1Entry(tracer), ...s });
    const issues = validateTx(tracer, {
      ...base(),
      signatures: [
        sig({ scheme: 9 }),
        sig({ scheme: 0, signer: OWNER }),
        sig({ signer: "0x1234" }),
        sig({ msg: "0x12" }),
        sig({ msg: `0x${"00".repeat(32)}` as Hex }),
        sig({ signature: "0x1234" }),
        sig({ scheme: 2, signature: "0x1234" }),
        sig({ msg: `0x${"01".repeat(32)}` as Hex, signature: `0x${"00".repeat(65)}` as Hex }),
      ],
    });
    expect(issues).toEqual([
      "signature 0: unknown scheme 9",
      "signature 1: an ARBITRARY entry has an empty signer",
      "signature 2: signer must be empty or 20 bytes",
      "signature 3: msg must be empty or a non-zero 32-byte digest",
      "signature 4: msg must be empty or a non-zero 32-byte digest",
      "signature 5: a SECP256K1 signature is 65 bytes",
      "signature 6: a P256 signature is 128 bytes",
    ]);
  });
});
