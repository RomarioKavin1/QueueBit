import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAddress, type Address, type Hex } from "viem";
import { WatcherCore, type CoreState } from "@queuebit/watcher-core";
import type { ChainClient } from "../src/chain.js";
import { Hub, type HubEntry } from "../src/hub.js";
import { Poller, type PollerOptions } from "../src/poller.js";
import { FileStore, SqliteStore } from "../src/store.js";
import { MockChain, accountLog, moduleLog, tx } from "./mockChain.js";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../packages/watcher-core/test/fixtures/devnet-1337-account.json", import.meta.url),
    "utf8",
  ),
);
const ACC: Address = getAddress(fixture.account);
const OTHER: Address = "0x00000000000000000000000000000000000000bb";
const KS: Address = getAddress(fixture.keystore);
const REC: Address = "0x0000000000000000000000000000000000000ec0";
const IMPL: Address = "0x00000000000000000000000000000000000001a9";
const H48 = 48 * 3600;
const TARGETS = { chainId: 1337, accounts: [{ address: ACC, backend: "frame" as const }], modules: [KS, REC] };
/** The account now runs a new implementation (account-updated, urgent). */
const upgraded = (txHash?: Hex, logIndex?: number) =>
  accountLog(ACC, "Upgraded", { implementation: IMPL }, txHash, logIndex);
/** Guardians reached the threshold: a recovery that can run at `readyAt` (recovery-started, urgent). */
const recoveryStarted = (id: Hex, readyAt: number, txHash?: Hex, logIndex?: number) =>
  moduleLog(REC, ACC, "Approved", { id, guardian: OTHER, approvals: 2, readyAt: BigInt(readyAt) }, txHash, logIndex);

function setup(over: Partial<PollerOptions> = {}, chain = new MockChain()) {
  const entries: HubEntry[] = [];
  const hub = new Hub([(e) => void entries.push(e)]);
  const makeCore = (state?: CoreState) =>
    new WatcherCore({
      targets: TARGETS,
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
    clock: () => now,
    ...over,
  });
  return { chain, hub, poller, entries, setNow: (t: number) => (now = t) };
}

describe("poller", () => {
  it("only processes blocks `confirmations` behind the head", async () => {
    const { chain, poller, entries } = setup();
    chain.mine({ logs: [upgraded()] }); // block 1
    expect((await poller.poll()).processedTo).toBe(null); // head 1, safe -1
    chain.mineEmpty(1);
    expect((await poller.poll()).processedTo).toBe(null); // head 2, safe 0
    chain.mineEmpty(1);
    const r = await poller.poll(); // head 3, safe 1
    expect(r.processedTo).toBe(1n);
    expect(entries.map((e) => [e.type, e.alert.kind, e.alert.severity])).toEqual([
      ["alert", "account-updated", "urgent"],
    ]);
    expect((await poller.poll()).alerts).toEqual([]); // nothing new
  });

  it("pages eth_getLogs and halves the range when the node refuses it", async () => {
    const { chain, poller, entries } = setup({ maxBlockRange: 50, confirmations: 0 });
    chain.maxLogRange = 10;
    for (let i = 0; i < 30; i++) {
      chain.mine(i % 10 === 5 ? { logs: [upgraded()] } : {});
    }
    const r = await poller.poll();
    expect(r.processedTo).toBe(30n);
    expect(entries.filter((e) => e.alert.kind === "account-updated")).toHaveLength(3);
    expect(chain.calls.getLogs).toBeGreaterThan(3);
  });

  it("reorg deeper than the confirmations: rewinds, reprocesses, retracts alerts whose tx vanished, keeps re-included ones", async () => {
    const { chain, poller, entries } = setup({ confirmations: 0 });
    const stays = tx();
    const vanishes = tx();
    const opA = tx();
    const opB = tx();
    chain.mine(); // 1
    chain.mine({ logs: [recoveryStarted(opA, chain.t0 + H48, stays)] }); // 2
    chain.mine({ logs: [recoveryStarted(opB, chain.t0 + H48, vanishes)] }); // 3
    await poller.poll();
    expect(entries.map((e) => e.alert.kind)).toEqual(["recovery-started", "recovery-started"]);
    const [idA, idB] = entries.map((e) => e.alert.id);

    // Blocks 2 and 3 are replaced; recovery A is re-included in the new block 3, recovery B is gone.
    chain.reorg(2);
    chain.mine(); // 2'
    chain.mine({ logs: [recoveryStarted(opA, chain.t0 + H48, stays)] }); // 3'
    chain.mine(); // 4'
    const r = await poller.poll();
    expect(r.reorg).toEqual({ at: 3n, ancestor: 1n });
    expect(r.retracted).toEqual([idB]);
    expect(entries.slice(2).map((e) => [e.type, e.alert.id])).toEqual([["retract", idB]]);
    expect(r.processedTo).toBe(4n);
    // The deadline of the vanished recovery went with the rewind; A's stays.
    expect(poller.watcher.deadlines().map((d) => d.recoveryId)).toEqual([opA]);
    expect(idA).toBeDefined();
  });

  it("does not retract orphaned alerts until their block height is reprocessed (reprocessing interrupted)", async () => {
    const chain = new MockChain();
    // After arming: the first fetch of block 2 is the reorg check (answered), the second the reprocessing (fails).
    let block2Fetches = -1;
    // The node's view goes inconsistent on the first fetch of the new block 2' (a reorg under our feet).
    const flaky: ChainClient = {
      chainId: () => chain.chainId(),
      blockNumber: () => chain.blockNumber(),
      getBlock: async (n) => {
        if (n === 2n && block2Fetches >= 0 && ++block2Fetches === 2) return null;
        return chain.getBlock(n);
      },
      getLogs: (q) => chain.getLogs(q),
    };
    const { poller, entries } = setup({ confirmations: 0, chain: flaky }, chain);
    const stays = tx();
    const vanishes = tx();
    chain.mine(); // 1
    const recA = tx();
    chain.mine({
      logs: [recoveryStarted(recA, chain.t0 + H48, stays, 0), recoveryStarted(tx(), chain.t0 + H48, vanishes, 1)],
    }); // 2
    await poller.poll();
    expect(entries.map((e) => e.alert.kind)).toEqual(["recovery-started", "recovery-started"]);
    const idB = entries[1]!.alert.id;

    chain.reorg(2);
    chain.mine({ logs: [recoveryStarted(recA, chain.t0 + H48, stays, 0)] }); // 2'
    chain.mine(); // 3'
    block2Fetches = 0;
    const r1 = await poller.poll();
    expect(r1.reorg).toEqual({ at: 2n, ancestor: 1n });
    expect(r1.processedTo).toBe(null); // stopped at the inconsistent block 2'
    expect(r1.retracted).toEqual([]); // nothing retracted yet: the orphaned blocks were not reprocessed
    expect(entries).toHaveLength(2);

    const r2 = await poller.poll();
    expect(r2.processedTo).toBe(3n);
    expect(r2.retracted).toEqual([idB]); // only recovery B vanished; A came back in 2'
    expect(entries.slice(2).map((e) => [e.type, e.alert.id])).toEqual([["retract", idB]]);
    expect((await poller.poll()).retracted).toEqual([]);
  });

  it("starts on a chain younger than the confirmation depth without a negative cursor", async () => {
    const chain = new MockChain(); // genesis only: head 0
    const { poller, entries } = setup({ confirmations: 2, startBlock: "latest" }, chain);
    expect((await poller.poll()).processedTo).toBe(null);
    expect(poller.cursor).toBe(-1n);
    chain.mine({ logs: [upgraded()] }); // 1
    chain.mineEmpty(3); // head 4, safe 2
    const r = await poller.poll();
    expect(r.processedTo).toBe(2n);
    expect(chain.calls.getBlock).toBeGreaterThan(0);
    expect(entries.map((e) => e.alert.kind)).toEqual(["account-updated"]);
  });

  it("re-alerts after a reorg if the same tx comes back after its retraction", async () => {
    const { chain, poller, entries } = setup({ confirmations: 0 });
    const h = tx();
    chain.mine({ logs: [upgraded(h)] }); // 1
    await poller.poll();
    chain.reorg(1);
    chain.mine(); // 1'
    await poller.poll();
    chain.mine({ logs: [upgraded(h)] }); // 2'
    await poller.poll();
    expect(entries.map((e) => [e.type, e.alert.kind])).toEqual([
      ["alert", "account-updated"],
      ["retract", "account-updated"],
      ["alert", "account-updated"],
    ]);
  });

  it("reads the shared modules' events for the watched account only (real creation tx stays quiet)", async () => {
    const { chain, poller, entries } = setup({ confirmations: 0 });
    // The real devnet creation tx of the account (ModuleInstalled + KeyAdded + PolicySet): setup, no alert.
    const creationTx = fixture.logs[0].transactionHash as Hex;
    const creation = fixture.logs
      .filter((l: { transactionHash: Hex }) => l.transactionHash === creationTx)
      .map(({ blockNumber: _n, blockHash: _h, ...l }: Record<string, unknown>) => l);
    chain.mine({ logs: creation }); // 1
    chain.mine({
      logs: [
        moduleLog(KS, ACC, "KeyAdded", { keyId: tx(), kind: 1, weight: 1, roles: 1 }),
        moduleLog(KS, OTHER, "KeyAdded", { keyId: tx(), kind: 1, weight: 1, roles: 1 }),
      ],
    }); // 2
    await poller.poll();
    expect(entries.map((e) => [e.alert.kind, e.alert.severity, e.alert.account])).toEqual([
      ["admin-key-added", "urgent", ACC],
    ]);
    expect(poller.watcher.policyOf(ACC)).toBeDefined();
  });

  it("ticks deadlines on the wall clock (ready at eta)", async () => {
    const { chain, poller, entries, setNow } = setup({ confirmations: 0 });
    chain.mine({ logs: [recoveryStarted(tx(), chain.t0 + H48)] });
    await poller.poll();
    setNow(chain.t0 + H48);
    expect(poller.tick().map((a) => a.kind)).toEqual(["recovery-ready"]);
    expect(entries.map((e) => e.alert.kind)).toEqual(["recovery-started", "recovery-ready"]);
  });

  it.each([
    ["file", (dir: string) => new FileStore(`${dir}/state.json`)],
    ["sqlite", (dir: string) => new SqliteStore(`${dir}/state.db`, process.getBuiltinModule("node:sqlite"))],
  ] as const)("checkpoints to %s and resumes without re-alerting", async (_name, open) => {
    const dir = `${process.env.TMPDIR ?? "/tmp"}/queuebit-watcher-test-${Math.random().toString(36).slice(2)}`;
    const chain = new MockChain();
    const store = open(dir);
    const a = setup({ confirmations: 0, store }, chain);
    chain.mine({ logs: [recoveryStarted(tx(), chain.t0 + H48)] });
    await a.poller.poll();
    const saved = store.load()!;
    expect(saved.lastBlock).toBe("1");
    chain.mine({ logs: [upgraded()] });
    const hub = new Hub([], saved.hub);
    const entries: HubEntry[] = [];
    hub.subscribe((e) => void entries.push(e));
    const b = new Poller(
      {
        chain,
        makeCore: (state) =>
          new WatcherCore({
            targets: TARGETS,
            ...(state ? { state } : {}),
          }),
        hub,
        store,
        chainId: 1337,
        confirmations: 0,
        startBlock: 1n,
        maxBlockRange: 100,
        reorgWindow: 16,
      },
      saved,
    );
    await b.poll();
    expect(entries.map((e) => e.alert.kind)).toEqual(["account-updated"]);
    expect(hub.since(0).map((e) => e.alert.kind)).toEqual(["recovery-started", "account-updated"]);
    store.close();
  });

  it("catches up over a long history without a header per empty block, and still checks the reorg window", async () => {
    const { chain, poller, entries } = setup({ confirmations: 0, reorgWindow: 16, maxBlockRange: 100 });
    chain.mineEmpty(150);
    chain.mine({ logs: [upgraded()] }); // 151
    chain.mineEmpty(150); // head 301
    chain.calls.getBlock = 0;
    const r = await poller.poll();
    expect(r.processedTo).toBe(301n);
    expect(entries.map((e) => e.alert.kind)).toEqual(["account-updated"]);
    // 301 blocks: the one with logs, the pages' last blocks (100, 200) and the 16-block reorg window (+1 at its edge).
    expect(chain.calls.getBlock).toBeLessThanOrEqual(1 + 2 + 17 + 1);
  });

  it("shares a poll already in flight (timer and pollOnce overlapping) instead of running two", async () => {
    const { chain, poller, entries } = setup({ confirmations: 0 });
    chain.mine({ logs: [upgraded()] });
    const [a, b] = await Promise.all([poller.poll(), poller.poll()]);
    expect(a).toBe(b);
    expect(entries).toHaveLength(1);
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
          },
          { v: 1, chainId: 1337, lastBlock: "5", recent: [], core: null, hub: { seq: 0, history: [] } },
        ),
    ).toThrow(/chain 1337/);
  });
});

export type { Hex };
