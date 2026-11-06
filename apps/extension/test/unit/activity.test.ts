import type { Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  ActivityStore,
  callsStatusCode,
  ethAmount,
  feeAmount,
  intentTitle,
  stageCopy,
  type ActivityCall,
  type ActivityEntry,
} from "../../src/background/activity";
import { MemoryKV } from "../../src/shared/kv";

const TO = "0xab12345678901234567890123456789012345cdE" as Address;
const pay = (wei: string, target = TO): ActivityCall => ({ target, value: wei, data: "0x" });

describe("activity copy (ux-spec §3.12)", () => {
  it("formats amounts and titles", () => {
    expect(ethAmount(50_000_000_000_000_000n)).toBe("0.05 ETH");
    expect(ethAmount(10n ** 18n)).toBe("1 ETH");
    expect(feeAmount(123_456_789_000_000n)).toBe("~0.00012 ETH");
    expect(intentTitle([pay("50000000000000000")])).toBe("0.05 ETH to 0xab12…5cdE");
    expect(intentTitle([{ target: TO, value: "0", data: "0x1234" }])).toBe("Call to 0xab12…5cdE");
    expect(intentTitle([pay("1"), pay("2")])).toMatch(/^2 steps moving .* to 0xab12…5cdE$/u);
  });

  it("LeanPool stages map to plain words and a status; the banned words never appear", () => {
    const stages = ["pooled", "posted", "submitted", "mined", "reverted", "refused"] as const;
    expect(stages.map((s) => stageCopy(s).status)).toEqual([
      "confirming",
      "confirming",
      "confirming",
      "confirmed",
      "failed",
      "failed",
    ]);
    for (const s of stages) expect(stageCopy(s).text).not.toMatch(/mempool|hash|nonce|gas|frame/iu);
  });

  it("EIP-5792 status codes", () => {
    expect(callsStatusCode({ status: "confirming" })).toBe(100);
    expect(callsStatusCode({ status: "confirmed" })).toBe(200);
    expect(callsStatusCode({ status: "failed" })).toBe(500);
  });
});

describe("activity store", () => {
  it("finds an owner payment by its LeanPool id and by the mined transaction's hash", async () => {
    const store = new ActivityStore(new MemoryKV(), () => 5);
    const e: ActivityEntry = {
      id: "a",
      chainId: 1337,
      kind: "payment",
      signer: "owner",
      via: "leanpool",
      account: TO,
      calls: [pay("1")],
      status: "confirming",
      hash: `0x${"11".repeat(32)}`,
      headline: "x",
      createdAt: 1,
      updatedAt: 1,
    };
    await store.add(e);
    expect(await store.pending()).toHaveLength(1);
    await store.update("a", { status: "confirmed", txHash: `0x${"22".repeat(32)}` });
    expect((await store.findByHash(`0x${"22".repeat(32)}`))?.id).toBe("a");
    expect((await store.findByHash(`0x${"11".repeat(32)}`))?.id).toBe("a");
    expect(await store.pending()).toHaveLength(0);
  });
});
