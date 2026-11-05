import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { WatcherCore, type CoreState, type MinedFrameReceipt } from "@leaked/watcher-core";
import type { RawTx } from "../src/chain.js";
import { Hub, type HubEntry } from "../src/hub.js";
import { Poller, type PollerOptions } from "../src/poller.js";
import { FileStore, SqliteStore } from "../src/store.js";
import { MockChain, accountLog, tx } from "./mockChain.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../packages/watcher-core/test/fixtures/devnet-1337-account.json", import.meta.url),
    "utf8",
  ),
);
const ACC: Address = getAddress(fixture.account);
const H48 = 48 * 3600;

function setup(over: Partial<PollerOptions> = {}, chain = new MockChain()) {
  const entries: HubEntry[] = [];
  const hub = new Hub([(e) => void entries.push(e)]);
  const makeCore = (state?: CoreState) =>
    new WatcherCore({
      targets: { chainId: 1337, accounts: [{ address: ACC, backend: "frame" }] },
      ...(state ? { state } : {}),
    });
  let now = chain.t0;
  const poller = new Poller({
    chain,
    makeCore,
    hub,
    chainId: 1337,
    confirmations: 2,
    startBlock: 1n,
    maxBlockRange: 100,
    reorgWindow: 16,
    scanFrameTxs: true,
    clock: () => now,
    ...over,
  });
  return { chain, hub, poller, entries, setNow: (t: number) => (now = t) };
}

describe("poller", () => {
  it("only processes blocks `confirmations` behind the head", async () => {
    const { chain, poller, entries } = setup();
    chain.mine({ logs: [accountLog(ACC, "Queued", { opId: tx(), kind: 1, eta: chain.t0 + H48 })] }); // block 1
    expect((await poller.poll()).processedTo).toBe(null); // head 1, safe -1
    chain.mineEmpty(1);
    expect((await poller.poll()).processedTo).toBe(null); // head 2, safe 0
    chain.mineEmpty(1);
    const r = await poller.poll(); // head 3, safe 1
    expect(r.processedTo).toBe(1n);
    expect(entries.map((e) => [e.type, e.alert.kind, e.alert.severity])).toEqual([
      ["alert", "change-scheduled", "urgent"],
    ]);
    expect((await poller.poll()).alerts).toEqual([]); // nothing new
  });

  it("pages eth_getLogs and halves the range when the node refuses it", async () => {
    const { chain, poller, entries } = setup({ maxBlockRange: 50, confirmations: 0 });
    chain.maxLogRange = 10;
    for (let i = 0; i < 30; i++) {
      chain.mine(i % 10 === 5 ? { logs: [accountLog(ACC, "Unfrozen", { by: ACC })] } : {});
    }
    const r = await poller.poll();
    expect(r.processedTo).toBe(30n);
    expect(entries.filter((e) => e.alert.kind === "resumed")).toHaveLength(3);
    expect(chain.calls.getLogs).toBeGreaterThan(3);
  });

  it("reorg deeper than the confirmations: rewinds, reprocesses, retracts alerts whose tx vanished, keeps re-included ones", async () => {
    const { chain, poller, entries } = setup({ confirmations: 0 });
    const stays = tx();
    const vanishes = tx();
    const opA = tx();
    const opB = tx();
    chain.mine(); // 1
    chain.mine({ logs: [accountLog(ACC, "Queued", { opId: opA, kind: 1, eta: chain.t0 + H48 }, stays)] }); // 2
    chain.mine({ logs: [accountLog(ACC, "Queued", { opId: opB, kind: 0, eta: chain.t0 + H48 }, vanishes)] }); // 3
    await poller.poll();
    expect(entries.map((e) => e.alert.kind)).toEqual(["change-scheduled", "payment-scheduled"]);
    const [idA, idB] = entries.map((e) => e.alert.id);

    // Blocks 2 and 3 are replaced; the loosening tx is re-included in the new block 3, the payment is gone.
    chain.reorg(2);
    chain.mine(); // 2'
    chain.mine({ logs: [accountLog(ACC, "Queued", { opId: opA, kind: 1, eta: chain.t0 + H48 }, stays)] }); // 3'
    chain.mine(); // 4'
    const r = await poller.poll();
    expect(r.reorg).toEqual({ at: 3n, ancestor: 1n });
    expect(r.retracted).toEqual([idB]);
    expect(entries.slice(2).map((e) => [e.type, e.alert.id])).toEqual([["retract", idB]]);
    expect(r.processedTo).toBe(4n);
    // The deadline of the vanished payment went with the rewind; the loosening's stays.
    expect(poller.watcher.deadlines().map((d) => d.opId)).toEqual([opA]);
    expect(idA).toBeDefined();
  });

  it("re-alerts after a reorg if the same tx comes back after its retraction", async () => {
    const { chain, poller, entries } = setup({ confirmations: 0 });
    const h = tx();
    chain.mine({ logs: [accountLog(ACC, "BunkerEnabled", {}, h)] }); // 1
    await poller.poll();
    chain.reorg(1);
    chain.mine(); // 1'
    await poller.poll();
    chain.mine({ logs: [accountLog(ACC, "BunkerEnabled", {}, h)] }); // 2'
    await poller.poll();
    expect(entries.map((e) => [e.type, e.alert.kind])).toEqual([
      ["alert", "lockdown-on"],
      ["retract", "lockdown-on"],
      ["alert", "lockdown-on"],
    ]);
  });

  it("derives over-limit attempts from frame receipts (real devnet tx) with bucket evidence", async () => {
    const { chain, poller, entries } = setup({ confirmations: 0 });
    const { tx: t, receipt } = fixture.overCap as { tx: RawTx & { frames: never }; receipt: MinedFrameReceipt };
    chain.bucket = { available: 5_000_000n, cap: 10_000_000n };
    chain.mine({ txs: [{ tx: t, receipt }] });
    await poller.poll();
    expect(entries.map((e) => [e.alert.kind, e.alert.title, e.alert.ref.reason])).toEqual([
      ["payment-blocked", "Over the limit: payment blocked", "over-limit"],
    ]);
  });

  it("ticks deadlines on the wall clock (ready at eta)", async () => {
    const { chain, poller, entries, setNow } = setup({ confirmations: 0 });
    const op = tx();
    chain.mine({ logs: [accountLog(ACC, "Queued", { opId: op, kind: 1, eta: chain.t0 + H48 })] });
    await poller.poll();
    setNow(chain.t0 + H48);
    expect(poller.tick().map((a) => a.kind)).toEqual(["scheduled-ready"]);
    expect(entries.map((e) => e.alert.kind)).toEqual(["change-scheduled", "scheduled-ready"]);
  });

  it.each([
    ["file", (dir: string) => new FileStore(`${dir}/state.json`)],
    ["sqlite", (dir: string) => new SqliteStore(`${dir}/state.db`, process.getBuiltinModule("node:sqlite"))],
  ] as const)("checkpoints to %s and resumes without re-alerting", async (_name, open) => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/leaked-watcher-test-${Math.random().toString(36).slice(2)}`;
    const chain = new MockChain();
    const store = open(dir);
    const a = setup({ confirmations: 0, store }, chain);
    chain.mine({ logs: [accountLog(ACC, "Queued", { opId: tx(), kind: 1, eta: chain.t0 + H48 })] });
    await a.poller.poll();
    const saved = store.load()!;
    expect(saved.lastBlock).toBe("1");
    chain.mine({ logs: [accountLog(ACC, "BunkerEnabled", {})] });
    const hub = new Hub([], saved.hub);
    const entries: HubEntry[] = [];
    hub.subscribe((e) => void entries.push(e));
    const b = new Poller(
      {
        chain,
        makeCore: (state) =>
          new WatcherCore({
            targets: { chainId: 1337, accounts: [{ address: ACC, backend: "frame" }] },
            ...(state ? { state } : {}),
          }),
        hub,
        store,
        chainId: 1337,
        confirmations: 0,
        startBlock: 1n,
        maxBlockRange: 100,
        reorgWindow: 16,
        scanFrameTxs: true,
      },
      saved,
    );
    await b.poll();
    expect(entries.map((e) => e.alert.kind)).toEqual(["lockdown-on"]);
    expect(hub.since(0).map((e) => e.alert.kind)).toEqual(["change-scheduled", "lockdown-on"]);
    store.close();
  });

  it("refuses a checkpoint of another chain", () => {
    const chain = new MockChain();
    expect(
      () =>
        new Poller(
          {
            chain,
            makeCore: () => new WatcherCore({ targets: { chainId: 1, accounts: [] } }),
            hub: new Hub(),
            chainId: 1,
            confirmations: 0,
            startBlock: 1n,
            maxBlockRange: 1,
            reorgWindow: 1,
            scanFrameTxs: false,
          },
          { v: 1, chainId: 1337, lastBlock: "5", recent: [], core: null, hub: { seq: 0, history: [] } },
        ),
    ).toThrow(/chain 1337/);
  });
});

export type { Hex };
