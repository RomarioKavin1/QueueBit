import { describe, expect, it } from "vitest";
import {
  bodyOutcome,
  frameStatus,
  parseEthrexReceipt,
  parseSidecarReceipt,
  type FrameTxReceipt,
} from "../src/index.js";

describe("frame statuses", () => {
  it("maps EIP codes and the sidecar's words", () => {
    expect(frameStatus(1)).toBe("success");
    expect(frameStatus("0x0")).toBe("reverted");
    expect(frameStatus(2n)).toBe("skipped");
    expect(frameStatus("skipped")).toBe("skipped");
    expect(() => frameStatus(3)).toThrow(/Unknown frame status 3/);
    expect(() => frameStatus("weird")).toThrow(/Unknown frame status/);
  });
});

describe("receipt parsing", () => {
  it("parses a minimal ethrex receipt", () => {
    const r = parseEthrexReceipt({
      cumulativeGasUsed: "0x10",
      payer: "0x00000000000000000000000000000000000000c7",
      frameReceipts: [{ status: "0x2", gasUsed: "0x0", logs: [] }],
    });
    expect(r).toEqual({
      payer: "0x00000000000000000000000000000000000000c7",
      cumulativeGasUsed: 16n,
      frameReceipts: [{ status: "skipped", gasUsed: { execution: 0n, state: 0n }, logs: [] }],
    });
  });

  it("parses a minimal sidecar receipt", () => {
    const r = parseSidecarReceipt({
      payer: "0x00000000000000000000000000000000000000c7",
      cumulativeGasUsed: "0x",
      frameReceipts: [{ status: "reverted", gasUsed: { execution: "0x5", state: "0x6" }, logs: undefined as never }],
    });
    expect(r.frameReceipts).toEqual([{ status: "reverted", gasUsed: { execution: 5n, state: 6n }, logs: [] }]);
    expect(r.blockNumber).toBeUndefined();
  });
});

describe("bodyOutcome", () => {
  const rec = (...s: ("success" | "reverted" | "skipped")[]): FrameTxReceipt => ({
    payer: "0x00000000000000000000000000000000000000c7",
    cumulativeGasUsed: 0n,
    frameReceipts: s.map((status) => ({ status, gasUsed: { execution: 0n, state: 0n }, logs: [] })),
  });
  it("looks only at frames after the prefix", () => {
    expect(bodyOutcome(rec("success", "success", "success"), 1)).toBe("success");
    expect(bodyOutcome(rec("success", "success", "reverted", "success"), 1)).toBe("partial");
    expect(bodyOutcome(rec("success", "reverted", "skipped"), 0)).toBe("failed");
    expect(bodyOutcome(rec("success"), 0)).toBe("success");
  });
});
