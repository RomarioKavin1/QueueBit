import { describe, expect, it } from "vitest";
import { getAddress, type Abi, type Hex } from "viem";
import {
  DeadlineTracker,
  FOREVER,
  TargetIndex,
  WatcherCore,
  decodeLogs,
  frameAccountAbi,
  type WatchedEvent,
} from "../src/index.js";
import { fixture, makeLog, txh } from "./helpers.js";

const ACC = getAddress(fixture.account);
const targets = { chainId: 1337, accounts: [{ address: ACC, backend: "frame" as const }] };
const idx = new TargetIndex(targets);
const T0 = 1_800_000_000;
const H48 = 48 * 3600;

let n = 0;
const ev = (name: string, args: Record<string, unknown>, t = T0, tx?: Hex): WatchedEvent =>
  decodeLogs(
    [makeLog(frameAccountAbi as Abi, name, args, { address: ACC, tx: tx ?? txh(++n), timestamp: t })],
    idx,
  )[0]!;

describe("eta tracking", () => {
  it("schedules an alarm at the eta when the queue event is seen (light mode chrome.alarms)", () => {
    const core = new WatcherCore({ targets });
    const opId = txh(0x1);
    core.ingest([ev("Queued", { opId, kind: 1, eta: T0 + H48 })]);
    expect(core.nextDeadline()).toBe(T0 + H48);
    expect(core.alarms()).toEqual([
      { name: `queuebit-watch:1337:${ACC.toLowerCase()}:op:${opId}`, when: (T0 + H48) * 1000 },
    ]);
  });

  it("pending -> ready exactly at eta, once", () => {
    const core = new WatcherCore({ targets });
    const opId = txh(0x2);
    core.ingest([ev("Queued", { opId, kind: 1, eta: T0 + H48 })]);
    expect(core.tick(T0 + H48 - 1)).toEqual([]);
    const [a] = core.tick(T0 + H48);
    expect(a).toMatchObject({
      kind: "scheduled-ready",
      severity: "warning",
      title: "Waiting period over",
      at: T0 + H48,
      action: { deepLink: `#pending/${opId}` },
    });
    expect(core.tick(T0 + H48 + 60)).toEqual([]);
    expect(core.alarms()).toEqual([]); // fired
  });

  it("execution or cancellation before the eta clears the deadline", () => {
    const core = new WatcherCore({ targets });
    const a = txh(0x3);
    const b = txh(0x4);
    core.ingest([ev("Queued", { opId: a, kind: 0, eta: T0 + H48 }), ev("Queued", { opId: b, kind: 1, eta: T0 + H48 })]);
    core.ingest([ev("QueueCancelled", { opId: a, by: ACC }), ev("QueueExecuted", { opId: b })]);
    expect(core.tick(T0 + H48)).toEqual([]);
  });

  it("a finished Vault replacement voids ops the old Vault queued (expired), and the rotation becomes ready first", () => {
    const core = new WatcherCore({ targets });
    const opId = txh(0x5);
    const eta = T0 + 7 * 86400;
    core.ingest([
      ev("Queued", { opId, kind: 1, eta: T0 + 30 * 86400 }),
      ev("VaultRotationStarted", { newVaultSigner: "0x0000000000000000000000000000000000000abc", eta }),
    ]);
    expect(core.tick(eta).map((a) => a.kind)).toEqual(["vault-replacement-ready"]);
    const out = core.ingest([
      ev("VaultRotationFinalized", { newVaultSigner: "0x0000000000000000000000000000000000000abc" }, eta + 10),
    ]);
    expect(out.map((a) => [a.kind, a.title])).toEqual([
      ["vault-replaced", "Vault replaced"],
      ["scheduled-void", "Scheduled change expired"],
    ]);
    expect(core.nextDeadline()).toBeUndefined();
  });

  it("a timed pause expires at `until`; a Vault pause never does; resume clears it", () => {
    const core = new WatcherCore({ targets });
    core.ingest([ev("Frozen", { by: ACC, until: T0 + 72 * 3600 })]);
    expect(core.tick(T0 + 72 * 3600).map((a) => [a.kind, a.severity])).toEqual([["pause-ended", "info"]]);
    core.ingest([ev("Frozen", { by: ACC, until: FOREVER })]);
    expect(core.nextDeadline()).toBeUndefined();
    core.ingest([ev("Frozen", { by: ACC, until: T0 + 100 })]);
    core.ingest([ev("Unfrozen", { by: ACC })]);
    expect(core.tick(T0 + 200)).toEqual([]);
  });

  it("survives a snapshot/restore (service checkpoint, chrome.storage.session)", () => {
    const core = new WatcherCore({ targets });
    core.ingest([ev("Queued", { opId: txh(0x6), kind: 2, eta: T0 + H48 })]);
    const restored = new WatcherCore({ targets, state: JSON.parse(JSON.stringify(core.snapshot())) });
    expect(restored.tick(T0 + H48).map((a) => a.kind)).toEqual(["scheduled-ready"]);
  });

  it("DeadlineTracker orders deadlines and reports the next one", () => {
    const t = new DeadlineTracker();
    t.apply(ev("Queued", { opId: txh(7), kind: 0, eta: T0 + 500 }), T0);
    t.apply(ev("Queued", { opId: txh(8), kind: 0, eta: T0 + 100 }), T0);
    expect(t.nextAt()).toBe(T0 + 100);
    expect(t.list().map((d) => d.at)).toEqual([T0 + 100, T0 + 500]);
  });
});
