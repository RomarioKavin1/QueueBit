import { describe, expect, it } from "vitest";
import type { Address } from "viem";
import { DeadlineTracker, type WatchedEvent } from "../src/index.js";
import { txh } from "./helpers.js";

const ACC: Address = "0x00000000000000000000000000000000000000aa";
const ev = (event: WatchedEvent["event"]): WatchedEvent => ({
  chainId: 1337,
  account: ACC,
  backend: "frame",
  emitter: ACC,
  blockHash: txh(2),
  txHash: txh(1),
  blockNumber: 1n,
  logIndex: 0,
  event,
});

describe("DeadlineTracker (guardian recovery)", () => {
  const id = txh(7);
  it("opens on the approval that reaches the threshold, fires once at readyAt, survives a snapshot", () => {
    const t = new DeadlineTracker();
    t.apply(ev({ type: "recoveryApproved", id, guardian: ACC, approvals: 1, readyAt: 0 }));
    expect(t.nextAt()).toBeUndefined();
    t.apply(ev({ type: "recoveryApproved", id, guardian: ACC, approvals: 2, readyAt: 500 }));
    expect(t.nextAt()).toBe(500);
    expect(t.alarms()).toEqual([{ name: expect.stringContaining(`recovery:${id}`), when: 500_000 }]);
    const restored = new DeadlineTracker(t.snapshot());
    expect(restored.tick(499)).toEqual([]);
    expect(restored.tick(500).map((x) => x.deadline.recoveryId)).toEqual([id]);
    expect(restored.tick(600)).toEqual([]);
    expect(restored.nextAt()).toBeUndefined();
  });
  it("closes on Recovered or Cancelled; drops old (Vault-model) kinds from a snapshot", () => {
    const t = new DeadlineTracker([
      { key: "unlock:1", chainId: 1337, account: ACC, backend: "frame", kind: "unlock" as never, at: 1 },
    ]);
    expect(t.list()).toEqual([]);
    t.apply(ev({ type: "recoveryApproved", id, guardian: ACC, approvals: 2, readyAt: 500 }));
    t.apply(ev({ type: "recoveryCancelled", id }));
    expect(t.tick(1000)).toEqual([]);
  });
});
