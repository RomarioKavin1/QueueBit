import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import type { FrameTxReceipt } from "@queuebit/frames";
import {
  callsStatusCode,
  describeReceipt,
  ethAmount,
  feeAmount,
  intentTitle,
  type ActivityCall,
} from "../../src/background/activity";

const TO = "0xab12345678901234567890123456789012345cdE" as Address;
const TANK = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const pay = (wei: string, target = TO): ActivityCall => ({ target, value: wei, data: "0x" });

const receipt = (...s: Array<"success" | "reverted" | "skipped">): FrameTxReceipt => ({
  payer: TANK,
  cumulativeGasUsed: 0n,
  frameReceipts: s.map((status) => ({ status, gasUsed: { execution: 1n, state: 0n }, logs: [] })),
});

describe("activity mapping (ux-spec §3.12, E-06)", () => {
  it("formats amounts and titles", () => {
    expect(ethAmount(50_000_000_000_000_000n)).toBe("0.05 ETH");
    expect(ethAmount(10n ** 18n)).toBe("1 ETH");
    expect(feeAmount(123_456_789_000_000n)).toBe("~0.00012 ETH");
    expect(intentTitle([pay("50000000000000000")])).toBe("0.05 ETH to 0xab12…5cdE");
    const labels = { name: (a: Address) => (a === TANK ? "your fee tank" : undefined) };
    expect(intentTitle([pay("1000000000000000", TANK)], labels)).toBe("0.001 ETH to your fee tank");
    expect(intentTitle([pay("1000000000000000", TANK), pay("2000000000000000", TANK)], labels)).toBe(
      "2 payments of 0.003 ETH in total to your fee tank",
    );
  });

  it("a mined payment: 'Paid 0.05 ETH to 0xab…', steps done", () => {
    const e = { calls: [pay("50000000000000000")], declaredUsd: "150000000", kind: "payment" as const };
    const out = describeReceipt(e, receipt("success", "success", "success"), { feeWei: 100_000_000_000_000n });
    expect(out.status).toBe("confirmed");
    expect(out.headline).toBe("Paid 0.05 ETH to 0xab12…5cdE");
    expect(out.steps.map((s) => [s.label, s.status])).toEqual([
      ["Check approval", "done"],
      ["Pay network fee", "done"],
      ["Payment", "done"],
    ]);
    expect(callsStatusCode(out)).toBe(200);
  });

  it("an over-limit revert: blocked, nothing sent, the tank's fee named", () => {
    const e = { calls: [pay("50000000000000000")], declaredUsd: "150000000", kind: "payment" as const };
    const out = describeReceipt(e, receipt("success", "success", "reverted"), {
      feeWei: 100_000_000_000_000n,
      availableUsdAfter: 20_000_000n,
    });
    expect(out.status).toBe("failed");
    expect(out.headline).toBe("Blocked: over your daily limit, nothing was sent; fee tank paid ~0.0001 ETH");
    expect(out.steps[2]!.status).toBe("failed");
    expect(callsStatusCode(out)).toBe(500);
    const other = describeReceipt(e, receipt("success", "success", "reverted"), {
      feeWei: 1n,
      availableUsdAfter: 500_000_000n,
    });
    expect(other.headline).toMatch(/^Failed: your account refused this payment, nothing was sent/u);
  });

  it("a mined cancel and the 5792 codes for the other states", () => {
    const e = { calls: [pay("1")], declaredUsd: "0", kind: "cancel" as const };
    expect(describeReceipt(e, receipt("success", "success", "success"), { feeWei: 1n }).status).toBe("cancelled");
    expect(callsStatusCode({ status: "confirming", steps: [] })).toBe(100);
    expect(callsStatusCode({ status: "cancelled", steps: [] })).toBe(400);
    expect(
      callsStatusCode({
        status: "failed",
        steps: [
          { label: "", status: "done" },
          { label: "", status: "done" },
          { label: "", status: "done" },
          { label: "", status: "failed" },
        ],
      }),
    ).toBe(600);
  });
});
