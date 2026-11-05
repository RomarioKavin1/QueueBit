import { describe, expect, it } from "vitest";
import { fromWire, getProfile, toWire, type FrameTx } from "../src/index.js";
import { firstSample, samples } from "./samples.js";

const tracer = getProfile("ethrex-eip8141-tracer");

describe("sidecar wire form", () => {
  it("round-trips every tracer sample", async () => {
    for (const { tx } of await samples(tracer)) {
      expect(fromWire(toWire(tx))).toEqual(tx);
      expect(fromWire(JSON.parse(JSON.stringify(toWire(tx))))).toEqual(tx);
    }
  });

  it("uses 0x-quantities and plain numbers for mode/flags/scheme (hegota-support's toWire)", async () => {
    const w = toWire(await firstSample(tracer));
    expect(w.chainId).toBe("0x539");
    expect(w.nonceSeq).toBe("0x7");
    expect(w.frames[0]).toEqual({
      mode: 1,
      flags: 3,
      target: null,
      limits: { execution: "0x7530", state: "0x0" },
      value: "0x0",
      data: "0x",
    });
    expect(w.fees).toEqual({ maxPriorityFeePerGas: "0x77359400", maxFeePerGas: "0x77359400", maxFeePerBlobGas: "0x0" });
    expect(w.signatures[0]!.scheme).toBe(1);
  });

  it("has no form for a total fee budget", async () => {
    const tx = await firstSample(getProfile("eip8141-current"));
    expect(() => toWire(tx)).toThrow(/no total fee budget/);
  });

  it("accepts numeric and hex mode/scheme and missing optional lists", () => {
    const tx: FrameTx = fromWire({
      chainId: "0x1",
      nonceKeys: ["0x0"],
      nonceSeq: "0x",
      sender: "0x00000000000000000000000000000000000000b1",
      frames: [
        {
          mode: "0x1" as never,
          flags: 3,
          target: null,
          limits: { execution: "0x1", state: "0x0" },
          value: "0x0",
          data: "0x",
        },
      ],
      signatures: [{ scheme: 1, signer: undefined as never, msg: "0x", signature: "0x" }],
      fees: { maxPriorityFeePerGas: "0x1", maxFeePerGas: "0x1", maxFeePerBlobGas: "0x0" },
      blobVersionedHashes: undefined as never,
      recentRootReferences: undefined as never,
    });
    expect(tx.frames[0]!.mode).toBe(1);
    expect(tx.nonceSeq).toBe(0n);
    expect(tx.signatures[0]!.signer).toBe("0x");
    expect(tx.blobVersionedHashes).toEqual([]);
    expect(tx.recentRootReferences).toEqual([]);
  });
});
