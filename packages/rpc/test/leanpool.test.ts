import { describe, expect, it } from "vitest";
import { RpcError, createLeanPoolClient, isFinalLeanPoolStage, type Transport } from "../src/index.js";

function fake(
  handler: (method: string, params: readonly unknown[]) => unknown,
): Transport & { calls: [string, readonly unknown[]][] } {
  const calls: [string, readonly unknown[]][] = [];
  return {
    url: "http://leanpool.test",
    calls,
    async request<T>(method: string, params: readonly unknown[] = []) {
      calls.push([method, params]);
      return handler(method, params) as T;
    },
  };
}

describe("LeanPoolClient", () => {
  it("sends {raw, sigs} and follows a tx by its LeanPool id", async () => {
    const t = fake((m) => (m === "leanpool_sendTransaction" ? { txHash: "0xaa" } : { stage: "mined", txHash: "0xbb" }));
    const c = createLeanPoolClient(t);
    expect(await c.sendTransaction("0x06ff", ["0x01"])).toEqual({ txHash: "0xaa" });
    expect(t.calls[0]).toEqual(["leanpool_sendTransaction", [{ raw: "0x06ff", sigs: ["0x01"] }]]);
    expect(await c.getTx("0xaa")).toEqual({ stage: "mined", txHash: "0xbb" });
    expect(t.calls[1]).toEqual(["leanpool_getTx", ["0xaa"]]);
  });

  it("passes node errors through (an invalid signature is the node's -32000)", async () => {
    const c = createLeanPoolClient(
      fake(() => {
        throw new RpcError(
          -32000,
          "leanSPHINCS signature 0 does not verify",
          "http://leanpool.test",
          "leanpool_sendTransaction",
        );
      }),
    );
    await expect(c.sendTransaction("0x06", ["0x00"])).rejects.toThrow(/does not verify/);
  });

  it("knows the final stages", () => {
    expect(["mined", "reverted", "refused"].every((s) => isFinalLeanPoolStage(s as never))).toBe(true);
    expect(["pooled", "posted", "submitted"].some((s) => isFinalLeanPoolStage(s as never))).toBe(false);
  });
});
