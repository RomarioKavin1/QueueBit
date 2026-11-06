import { describe, expect, it } from "vitest";
import { getAddress, type Abi, type Address, type Hex } from "viem";
import {
  MODULE_TYPES,
  TargetIndex,
  WatcherCore,
  accountAbi,
  decodeLogs,
  modulesAbi,
  type Alert,
  type RpcLog,
} from "../src/index.js";
import { ADDR_RE, AMOUNT_RE, fixture, makeLog, txh } from "./helpers.js";

const ACC = getAddress(fixture.account);
const KS = fixture.keystore;
const HOOK = fixture.hook;
const REC: Address = "0x0000000000000000000000000000000000000ec0";
const AGG: Address = "0x00000000000000000000000000000000000000a9";
const OTHER_AGG: Address = "0x00000000000000000000000000000000000000aa";
const targets = { chainId: 1337, accounts: [{ address: ACC }], modules: [KS, HOOK, REC] };
const T0 = 1_800_000_000;

let logIndex = 0;
const at = (tx: number, address: Address) => ({
  address,
  tx: txh(tx),
  block: BigInt(tx),
  logIndex: logIndex++,
  timestamp: T0 + tx,
});
const ks = (name: string, args: Record<string, unknown>, tx: number) =>
  makeLog(modulesAbi as Abi, name, { account: ACC, ...args }, at(tx, KS));
const hook = (name: string, args: Record<string, unknown>, tx: number) =>
  makeLog(modulesAbi as Abi, name, { account: ACC, ...args }, at(tx, HOOK));
const rec = (name: string, args: Record<string, unknown>, tx: number) =>
  makeLog(modulesAbi as Abi, name, { account: ACC, ...args }, at(tx, REC));
const acct = (name: string, args: Record<string, unknown>, tx: number) =>
  makeLog(accountAbi as Abi, name, args, at(tx, ACC));
const policy = (admin: number, spend: number, requirePQ: boolean, aggregator = AGG) => ({
  adminThreshold: admin,
  spendThreshold: spend,
  requirePQ,
  aggregator,
});

/** Account creation: the keystore installed with its first key and policy (one tx). */
const creation = (tx = 1): RpcLog[] => [
  ks("PolicySet", policy(1, 1, true), tx),
  ks("KeyAdded", { keyId: txh(0xa0), kind: 1, weight: 1, roles: 3 }, tx),
  acct("ModuleInstalled", { moduleTypeId: BigInt(MODULE_TYPES.FRAME_VALIDATOR), module: KS }, tx),
];

function run(logs: RpcLog[], init?: (txHash?: Hex) => boolean | undefined) {
  const core = new WatcherCore({
    targets,
    ...(init ? { initiated: (_a: Address, r: { txHash?: Hex }) => init(r.txHash) } : {}),
  });
  const alerts = core.ingest(decodeLogs(logs, new TargetIndex(targets)), T0);
  return { core, alerts };
}
const kinds = (a: Alert[]) => a.map((x) => `${x.kind}:${x.severity}`);

describe("setup", () => {
  it("account creation raises nothing", () => {
    expect(run(creation()).alerts).toEqual([]);
  });
  it("the real devnet run: creation is quiet, the owner's session setup is info-to-warning, no spend crossed 80%", () => {
    const { alerts } = run(fixture.logs);
    expect(alerts.every((a) => a.kind === "session-added" || a.kind === "session-limits-changed")).toBe(true);
  });
});

describe("keys", () => {
  it("a new admin key is urgent, a spending key a warning, a session info; initiated lowers them", () => {
    const logs = [
      ...creation(),
      ks("KeyAdded", { keyId: txh(1), kind: 1, weight: 1, roles: 1 }, 2),
      ks("KeyAdded", { keyId: txh(2), kind: 4, weight: 1, roles: 2 }, 3),
      ks("KeyAdded", { keyId: txh(3), kind: 5, weight: 1, roles: 4 }, 4),
    ];
    expect(kinds(run(logs).alerts)).toEqual([
      "admin-key-added:urgent",
      "spending-key-added:warning",
      "session-added:info",
    ]);
    expect(kinds(run(logs, () => true).alerts)).toEqual([
      "admin-key-added:info",
      "spending-key-added:info",
      "session-added:info",
    ]);
    expect(kinds(run(logs, () => false).alerts)).toEqual([
      "admin-key-added:urgent",
      "spending-key-added:urgent",
      "session-added:warning",
    ]);
  });
  it("a removed key is a warning, a changed key urgent", () => {
    const logs = [...creation(), ks("KeyRemoved", { keyId: txh(1) }, 2), ks("KeyUpdated", { keyId: txh(2) }, 3)];
    expect(kinds(run(logs).alerts)).toEqual(["key-removed:warning", "key-changed:urgent"]);
  });
});

describe("policy", () => {
  it("lowered (thresholds, requirePQ, aggregator) is urgent; tightened is info", () => {
    const lower = [...creation(), ks("PolicySet", policy(1, 1, false), 2)];
    expect(kinds(run(lower).alerts)).toEqual(["security-lowered:urgent"]);
    const agg = [...creation(), ks("PolicySet", policy(1, 1, true, OTHER_AGG), 2)];
    expect(kinds(run(agg).alerts)).toEqual(["security-lowered:urgent"]);
    const tighter = [...creation(), ks("PolicySet", policy(2, 1, true), 2)];
    expect(kinds(run(tighter).alerts)).toEqual(["security-changed:info"]);
  });
  it("the core remembers the policy across ingests (and snapshots)", () => {
    const { core } = run(creation());
    const again = new WatcherCore({ targets, state: core.snapshot() });
    const a = again.ingest(decodeLogs([ks("PolicySet", policy(0 + 1, 0 + 1, false), 9)], new TargetIndex(targets)), T0);
    expect(kinds(a)).toEqual(["security-lowered:urgent"]);
  });
});

describe("sessions", () => {
  const sid = txh(0x5e);
  it("warns once, on the payment that crosses 80% of a known daily limit", () => {
    const logs = [
      ...creation(),
      hook("DailyCapSet", { keyId: sid, cap: 100n }, 2),
      hook("SessionSpend", { keyId: sid, amount: 50n, spentToday: 50n }, 3),
      hook("SessionSpend", { keyId: sid, amount: 35n, spentToday: 85n }, 4),
      hook("SessionSpend", { keyId: sid, amount: 10n, spentToday: 95n }, 5),
    ];
    const near = run(logs).alerts.filter((a) => a.kind === "session-near-limit");
    expect(near).toHaveLength(1);
    expect(near[0]!.severity).toBe("warning");
    expect(near[0]!.ref).toMatchObject({ keyId: sid, percent: 85 });
  });
  it("token limits are separate from ETH; no daily limit means no alert", () => {
    const token: Address = "0x00000000000000000000000000000000000070c1";
    const logs = [
      ...creation(),
      hook("TokenDailyCapSet", { keyId: sid, token, cap: 10n }, 2),
      hook("SessionSpend", { keyId: sid, amount: 9n, spentToday: 9n }, 3), // ETH: no limit known
      hook("SessionTokenSpend", { keyId: sid, token, amount: 9n, spentToday: 9n }, 4),
    ];
    const near = run(logs).alerts.filter((a) => a.kind === "session-near-limit");
    expect(near.map((a) => a.ref.token)).toEqual([getAddress(token)]);
  });
});

describe("recovery", () => {
  it("one approval warns; the threshold starts a countdown; ready, done and cancelled follow", () => {
    const id = txh(0x7e);
    const logs = [
      ...creation(),
      rec("Approved", { id, guardian: AGG, approvals: 1, readyAt: 0n }, 2),
      rec("Approved", { id, guardian: OTHER_AGG, approvals: 2, readyAt: BigInt(T0 + 3 + 86_400) }, 3),
    ];
    const { core, alerts } = run(logs);
    expect(kinds(alerts)).toEqual(["recovery-approved:warning", "recovery-started:urgent"]);
    expect(alerts[1]!.ref).toMatchObject({ recoveryId: id, eta: T0 + 3 + 86_400 });
    expect(alerts[1]!.body).toContain("24 h");
    expect(core.nextDeadline()).toBe(T0 + 3 + 86_400);
    expect(core.tick(T0 + 1000)).toEqual([]);
    expect(kinds(core.tick(T0 + 3 + 86_400))).toEqual(["recovery-ready:urgent"]);
    expect(core.tick(T0 + 10 * 86_400)).toEqual([]); // once
    const done = core.ingest(
      decodeLogs(
        [
          ks("KeyRemoved", { keyId: txh(0xa0) }, 9),
          ks("KeyAdded", { keyId: txh(0xa1), kind: 1, weight: 1, roles: 3 }, 9),
          rec("Recovered", { id }, 9),
        ],
        new TargetIndex(targets),
      ),
      T0,
    );
    expect(kinds(done)).toEqual(["recovery-done:urgent"]); // the reset's own key events are part of it
    expect(core.nextDeadline()).toBeUndefined();
  });
  it("a cancellation closes the deadline", () => {
    const id = txh(0x7f);
    const { core } = run([
      ...creation(),
      rec("Approved", { id, guardian: AGG, approvals: 1, readyAt: BigInt(T0 + 100) }, 2),
      rec("Cancelled", { id }, 3),
    ]);
    expect(core.tick(T0 + 1000)).toEqual([]);
  });
});

describe("account", () => {
  it("an upgrade is urgent; installing a module after setup is a warning; a migration in is setup + update", () => {
    const logs = [
      ...creation(),
      acct("Upgraded", { implementation: AGG }, 2),
      acct("ModuleInstalled", { moduleTypeId: BigInt(MODULE_TYPES.EXECUTOR), module: REC }, 3),
      acct("ModuleUninstalled", { moduleTypeId: BigInt(MODULE_TYPES.HOOK), module: HOOK }, 4),
    ];
    expect(kinds(run(logs).alerts)).toEqual([
      "account-updated:urgent",
      "module-added:warning",
      "module-removed:warning",
    ]);
    const migration = [acct("Upgraded", { implementation: AGG }, 1), ...creation(1)];
    expect(kinds(run(migration).alerts)).toEqual(["account-updated:urgent"]);
  });
});

describe("copy and ids", () => {
  it("titles and bodies carry no addresses or amounts; ids are stable and deduplicated", () => {
    const logs = [
      ...creation(),
      ks("KeyAdded", { keyId: txh(1), kind: 1, weight: 1, roles: 1 }, 2),
      hook("DailyCapSet", { keyId: txh(5), cap: 100n }, 3),
      hook("SessionSpend", { keyId: txh(5), amount: 90n, spentToday: 90n }, 4),
    ];
    const { core, alerts } = run(logs);
    for (const a of alerts) {
      expect(a.v).toBe(2);
      expect(`${a.title} ${a.body}`).not.toMatch(ADDR_RE);
      expect(`${a.title} ${a.body}`).not.toMatch(AMOUNT_RE);
      expect(a.action.deepLink.startsWith("#")).toBe(true);
    }
    expect(core.ingest(decodeLogs(logs, new TargetIndex(targets)), T0)).toEqual([]);
    // A restarted watcher re-scanning the creation tx (seen ids dropped) stays quiet about setup.
    const restarted = new WatcherCore({ targets, state: { ...core.snapshot(), seen: [] } });
    const replay = restarted.ingest(decodeLogs(creation(), new TargetIndex(targets)), T0);
    expect(replay).toEqual([]);
  });
  it("ignores a v1 (Vault-model) snapshot", () => {
    const core = new WatcherCore({ targets, state: { v: 1 } });
    expect(core.snapshot()).toMatchObject({ v: 2, policies: {}, caps: {} });
  });
});
