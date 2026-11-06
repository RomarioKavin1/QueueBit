import { describe, expect, it } from "vitest";
import { getAddress, type Abi, type Address, type Hex } from "viem";
import {
  FOREVER,
  TargetIndex,
  WatcherCore,
  copyFor,
  decodeLogs,
  formatDuration,
  frameAccountAbi,
  type AlertKind,
  type WatchedEvent,
} from "../src/index.js";
import { ADDR_RE, AMOUNT_RE, fixture, makeLog, txh } from "./helpers.js";

const ACC = getAddress(fixture.account);
const VAULT: Address = "0x3C1b54ae1638CD6e3c0790335F2146AAF8F8C120";
const GUARDIAN: Address = "0x6424536c7aE201C84C56cdA9cc3676D4Bd51Accc";
const RECOVERY: Address = "0xF75639785F2D259bD8f17eC823FA87472c3D5FEe";
const targets = { chainId: 1337, accounts: [{ address: ACC, backend: "frame" as const }] };
const idx = new TargetIndex(targets);
const T0 = 1_800_000_000;

let n = 0;
/** One decoded event of the frame account in its own tx (or `tx`). */
function ev(
  name: string,
  args: Record<string, unknown>,
  o: { tx?: Hex; t?: number; logIndex?: number } = {},
): WatchedEvent {
  const log = makeLog(frameAccountAbi as Abi, name, args, {
    address: ACC,
    tx: o.tx ?? txh(++n),
    timestamp: o.t ?? T0,
    logIndex: o.logIndex ?? 0,
  });
  return decodeLogs([log], idx)[0]!;
}

const H48 = 48 * 3600;

describe("rules", () => {
  it("vault-queued loosening the watcher cannot attribute -> urgent, with a Pending deep link", () => {
    const core = new WatcherCore({ targets });
    const opId = txh(0x10);
    const [a] = core.ingest([ev("Queued", { opId, kind: 1, eta: T0 + H48 })]);
    expect(a).toMatchObject({
      kind: "change-scheduled",
      severity: "urgent",
      title: "Limit change scheduled",
      action: { deepLink: `#pending/${opId}` },
      ref: { opId, queueKind: "loosen", eta: T0 + H48 },
    });
    expect(a!.body).toContain("in 48 h");
    expect(a!.body).toContain("Didn't ask for this?");
  });

  it("a loosening the user started (extension knows) -> info; one they did not -> urgent", () => {
    const opId = txh(0x11);
    const mine = new WatcherCore({ targets, initiated: (_a, r) => r.opId === opId });
    expect(mine.ingest([ev("Queued", { opId, kind: 1, eta: T0 + H48 })])[0]!.severity).toBe("info");
    const notMine = new WatcherCore({ targets, initiated: () => false });
    expect(notMine.ingest([ev("Queued", { opId: txh(0x12), kind: 0, eta: T0 + H48 })])[0]).toMatchObject({
      kind: "payment-scheduled",
      severity: "urgent",
    });
  });

  it("a large payment of unknown origin is a warning, not urgent", () => {
    const core = new WatcherCore({ targets });
    expect(core.ingest([ev("Queued", { opId: txh(0x13), kind: 0, eta: T0 + H48 })])[0]!.severity).toBe("warning");
  });

  it("Recovery-started Vault replacement -> one urgent alert (its pause is folded in)", () => {
    const core = new WatcherCore({ targets });
    const tx = txh(0x20);
    const eta = T0 + 7 * 86400;
    const alerts = core.ingest([
      ev("VaultRotationStarted", { newVaultSigner: "0x0000000000000000000000000000000000000abc", eta }, { tx }),
      ev("Frozen", { by: RECOVERY, until: eta }, { tx, logIndex: 1 }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      kind: "vault-replacement-started",
      severity: "urgent",
      title: "Replacing the Vault",
    });
    expect(alerts[0]!.body).toContain("finishes in 7 d");
  });

  it("pauses: Guardian (by roles or by the 72 h shape), Vault (until forever); resume", () => {
    const withRoles = new WatcherCore({ targets, roles: () => ({ vault: VAULT, guardians: [GUARDIAN] }) });
    expect(withRoles.ingest([ev("Frozen", { by: GUARDIAN, until: T0 + 72 * 3600 })])[0]).toMatchObject({
      kind: "paused",
      severity: "warning",
      title: "Paused by your Guardian",
      ref: { until: T0 + 72 * 3600 },
    });
    expect(withRoles.ingest([ev("Frozen", { by: VAULT, until: FOREVER })])[0]!.title).toBe("Paused by your Vault");
    const noRoles = new WatcherCore({ targets });
    expect(noRoles.ingest([ev("Frozen", { by: GUARDIAN, until: T0 + 72 * 3600 })])[0]!.title).toBe(
      "Paused by your Guardian",
    );
    expect(noRoles.ingest([ev("Unfrozen", { by: VAULT })])[0]).toMatchObject({ kind: "resumed", severity: "info" });
  });

  it("Lockdown is urgent and its key wipe raises no second alert; a later re-key is reported as lockdown-off", () => {
    const core = new WatcherCore({ targets });
    const tx = txh(0x30);
    const a = core.ingest([
      ev("BunkerEnabled", {}, { tx }),
      ev(
        "HotKeyRotated",
        { oldKey: GUARDIAN, newKey: "0x0000000000000000000000000000000000000000" },
        { tx, logIndex: 1 },
      ),
    ]);
    expect(a.map((x) => [x.kind, x.severity])).toEqual([["lockdown-on", "urgent"]]);
    const tx2 = txh(0x31);
    const b = core.ingest([
      ev("BunkerDisabled", {}, { tx: tx2 }),
      ev(
        "HotKeyRotated",
        { oldKey: "0x0000000000000000000000000000000000000000", newKey: GUARDIAN },
        { tx: tx2, logIndex: 1 },
      ),
    ]);
    expect(b.map((x) => x.kind)).toEqual(["lockdown-off"]);
  });

  it("an executed scheduled change reports once, not once per setter it ran", () => {
    const core = new WatcherCore({ targets });
    const tx = txh(0x40);
    const a = core.ingest([
      ev("CapUpdated", { capUsdPerDay: 1n, perTxMaxUsd: 1n, maxFeeWeiPerTx: 1n, maxHotFrames: 4 }, { tx }),
      ev("QueueExecuted", { opId: txh(0x41) }, { tx, logIndex: 1 }),
    ]);
    expect(a.map((x) => x.kind)).toEqual(["scheduled-done"]);
  });

  it("account creation (initialize) raises nothing (real devnet logs)", () => {
    const core = new WatcherCore({ targets, roles: () => ({ vault: VAULT, guardians: [GUARDIAN] }) });
    const alerts = core.ingest(decodeLogs(fixture.logs, idx));
    // Creation (block 845) and hot activity are silent; the guardian add, its pause and the Vault's resume alert.
    expect(alerts.map((a) => a.kind)).toEqual(["guardian-changed", "paused", "resumed"]);
  });

  it("recipient mode (Open/Strict): instant tightening -> info; folded at creation and under an executed queued op", () => {
    const core = new WatcherCore({ targets });
    // Open -> Strict is an instant Vault setter: a settings change, nothing to cancel.
    const [strict] = core.ingest([ev("RecipientModeSet", { mode: 1 })]);
    expect(strict).toMatchObject({ kind: "settings-changed", severity: "info", action: { deepLink: "#limits" } });
    // Emitted by `initialize` next to the first everyday key: creation is silent.
    const t = txh(0x40);
    expect(
      core.ingest([
        ev("HotKeyRotated", { oldKey: `0x${"0".repeat(40)}`, newKey: VAULT }, { tx: t, logIndex: 0 }),
        ev("RecipientModeSet", { mode: 0 }, { tx: t, logIndex: 1 }),
      ]),
    ).toEqual([]);
    // Strict -> Open is a queued loosening: `Queued` announced it (urgent); its execution is one "done" alert.
    const opId = txh(0x41);
    expect(core.ingest([ev("Queued", { opId, kind: 1, eta: T0 + H48 })])[0]!.kind).toBe("change-scheduled");
    const t2 = txh(0x42);
    expect(
      core
        .ingest([
          ev("RecipientModeSet", { mode: 0 }, { tx: t2, logIndex: 0 }),
          ev("QueueExecuted", { opId }, { tx: t2, logIndex: 1 }),
        ])
        .map((a) => a.kind),
    ).toEqual(["scheduled-done"]);
  });

  it("a module reinstall (first everyday key inside an executed scheduled change) is not account creation", () => {
    const core = new WatcherCore({ targets });
    const tx = txh(0x50);
    const a = core.ingest([
      ev("HotKeyRotated", { oldKey: `0x${"0".repeat(40)}`, newKey: VAULT }, { tx, logIndex: 0 }),
      ev("CapUpdated", { capUsdPerDay: 1n, perTxMaxUsd: 1n, maxFeeWeiPerTx: 1n, maxHotFrames: 4 }, { tx, logIndex: 1 }),
      ev("QueueExecuted", { opId: txh(0x51) }, { tx, logIndex: 2 }),
    ]);
    expect(a.map((x) => x.kind)).toEqual(["scheduled-done"]);
  });

  it("copy: a ready change is not promised during a Vault replacement; Vault-side reverts are not everyday payments", () => {
    const ready = copyFor({ kind: "scheduled-ready", queueKind: "loosen", ref: {} });
    expect(ready.body).not.toContain("Anyone can now finish it");
    expect(ready.body).toContain("unless your Vault is being replaced");
    const vault = copyFor({ kind: "payment-blocked", reason: "other", ref: { errorName: "VaultOverDailyThreshold" } });
    expect(vault.title).toBe("Vault request didn't go through");
    expect(vault.body).not.toMatch(/everyday/i);
    const hot = copyFor({ kind: "payment-blocked", reason: "over-limit", ref: { errorName: "OverCap" } });
    expect(hot.title).toBe("Over the limit: payment blocked");
    for (const what of ["staked", "unlocked", "withdrawn"] as const) {
      expect(copyFor({ kind: "vault-sender-deposit", what, ref: {} }).body).not.toMatch(/staked|lane/i);
    }
  });

  it("repeated blocked payments -> one urgent alert per window", () => {
    const core = new WatcherCore({ targets, blockedThreshold: 3, blockedWindowSec: 3600 });
    const blocked = (i: number, t: number): WatchedEvent => ({
      chainId: 1337,
      account: ACC,
      backend: "frame",
      emitter: ACC,
      blockNumber: BigInt(1000 + i),
      blockHash: txh(5000 + i),
      txHash: txh(6000 + i),
      logIndex: -3,
      timestamp: t,
      event: { type: "hotBlocked", reason: "over-limit" },
    });
    const kinds = [0, 1, 2, 3].flatMap((i) => core.ingest([blocked(i, T0 + i * 60)]).map((a) => a.kind));
    expect(kinds).toEqual([
      "payment-blocked",
      "payment-blocked",
      "payment-blocked",
      "repeated-blocked",
      "payment-blocked",
    ]);
    const state = core.snapshot();
    expect(state.blocked[ACC.toLowerCase()]).toHaveLength(4);
  });

  it("dedups: re-ingesting the same events (poll overlap, reorg re-inclusion) alerts once", () => {
    const core = new WatcherCore({ targets });
    const e = ev("Queued", { opId: txh(0x50), kind: 1, eta: T0 + H48 });
    expect(core.ingest([e])).toHaveLength(1);
    expect(core.ingest([e])).toHaveLength(0);
    // A reorg moves the tx to another block: same tx hash -> same id.
    expect(core.ingest([{ ...e, blockNumber: e.blockNumber + 1n, blockHash: txh(0x99), logIndex: 7 }])).toHaveLength(0);
    // Restored from a snapshot, it still remembers.
    const again = new WatcherCore({ targets, state: core.snapshot() });
    expect(again.ingest([e])).toHaveLength(0);
    again.forget([core.snapshot().seen[0]!]);
    expect(again.ingest([e])).toHaveLength(1);
  });
});

describe("copy", () => {
  const kinds: AlertKind[] = [
    "change-scheduled",
    "payment-scheduled",
    "update-scheduled",
    "move-scheduled",
    "scheduled-ready",
    "scheduled-done",
    "scheduled-cancelled",
    "scheduled-void",
    "paused",
    "pause-ended",
    "resumed",
    "lockdown-on",
    "lockdown-off",
    "everyday-key-replaced",
    "vault-replacement-started",
    "vault-replacement-ready",
    "vault-replaced",
    "vault-replacement-cancelled",
    "recovery-key-changed",
    "guardian-changed",
    "limits-changed",
    "settings-changed",
    "account-updated",
    "account-moved",
    "payment-blocked",
    "repeated-blocked",
    "vault-sender-deposit",
  ];
  const BANNED =
    /\b(mempool|frame|nonce|gas|hash|EOA|1271|4337|8141|PQ|bunker|cap|hot key|allowlist|timelock|sidecar)\b/i;

  it.each(kinds)("%s: plain language, no amounts, no addresses, no banned words", (kind) => {
    const c = copyFor({ kind, left: 3600 * 31 + 1200, ref: { txHash: txh(1), opId: txh(2) }, who: "guardian" });
    for (const s of [c.title, c.body]) {
      expect(s).not.toMatch(ADDR_RE);
      expect(s).not.toMatch(AMOUNT_RE);
      expect(s).not.toMatch(BANNED);
      expect(s).not.toContain("undefined");
    }
    expect(c.action.deepLink.startsWith("#")).toBe(true);
  });

  it("formats durations like the Pending countdown", () => {
    expect(formatDuration(48 * 3600)).toBe("48 h");
    expect(formatDuration(31 * 3600 + 20 * 60)).toBe("31 h 20 m");
    expect(formatDuration(6 * 86400 + 21 * 3600)).toBe("6 d 21 h");
    expect(formatDuration(7 * 86400)).toBe("7 d");
    expect(formatDuration(72 * 3600)).toBe("3 d");
    expect(formatDuration(90)).toBe("1 m");
    expect(formatDuration(0)).toBe("now");
  });
});
