import { describe, expect, it } from "vitest";
import { encodeAbiParameters, encodeEventTopics, type Abi, type Address, type Hex } from "viem";
import { frameAccountAbi, hmacHex, signAlert, type Alert, type RpcLog } from "@leaked/watcher-core";
import type { AccountPlan } from "../../src/background/account";
import { DeployBlocks, findDeployBlock } from "../../src/background/deployBlock";
import {
  AlertStore,
  MAX_ALERTS,
  alertUrl,
  badgeFor,
  mergeAlerts,
  notificationFor,
  type AlertRecord,
} from "../../src/background/watcher/alerts";
import { WATCHER_STATE_KEY, WatcherLight, watchTargets, type LightClient } from "../../src/background/watcher/light";
import { PairingStore, readPairedWatcher, readPairingCode } from "../../src/background/watcher/pairing";
import { MemoryKV } from "../../src/shared/kv";

/**
 * Watcher light mode (plan §40 §5, §30 §6.5): the account's events from its deployment block through
 * @leaked/watcher-core, mapped to the notification, the badge and the in-app list with deep links (ux-spec §2.3).
 */

const ACCOUNT: Address = "0x1111111111111111111111111111111111111111";
const VAULT_SIGNER: Address = "0x2222222222222222222222222222222222222222";
const OP: Hex = `0x${"ab".repeat(32)}`;

const alert = (o: Partial<Alert> = {}): Alert => ({
  v: 1,
  id: o.id ?? "a1",
  chainId: 1337,
  account: ACCOUNT,
  backend: "frame",
  kind: "change-scheduled",
  severity: "urgent",
  title: "Limit change scheduled",
  body: "Your Vault scheduled a change that loosens your limits.",
  action: { label: "Review", deepLink: `#pending/${OP}` },
  at: 1_800_000_000,
  ref: { opId: OP },
  ...o,
});

describe("alert mapping", () => {
  it("notification: urgent stays and is prefixed, warning is normal, info (you did it) is silent", () => {
    expect(notificationFor(alert())).toMatchObject({
      title: "Urgent: Limit change scheduled",
      priority: 2,
      requireInteraction: true,
      silent: false,
      buttonTitle: "Review",
    });
    expect(notificationFor(alert({ severity: "warning" }))).toMatchObject({ priority: 1, requireInteraction: false });
    expect(notificationFor(alert({ severity: "info" }))).toMatchObject({ priority: 0, silent: true });
    // The copy never carries amounts or addresses (plan §40 §5): the notification text is the core's copy.
    expect(notificationFor(alert()).message).not.toMatch(/0x[0-9a-f]{8}|\$\d/iu);
  });

  it("deep links open the full app at the alert's screen (ux-spec §2.3)", () => {
    expect(alertUrl(alert())).toBe(`/app.html#pending/${OP}`);
    expect(alertUrl(alert({ action: { label: "Open", deepLink: "#security/lockdown" } }))).toBe(
      "/app.html#security/lockdown",
    );
    // A malformed link never becomes an arbitrary URL.
    expect(alertUrl(alert({ action: { label: "x", deepLink: "https://evil.example" } }))).toBe("/app.html#pending");
  });

  it("badge: unread, not retracted; colour by the worst one; 9+", () => {
    const rec = (id: string, severity: Alert["severity"], extra: Partial<AlertRecord> = {}): AlertRecord => ({
      alert: alert({ id, severity }),
      source: "browser",
      receivedAt: 1,
      ...extra,
    });
    expect(badgeFor([])).toEqual({ text: "", color: expect.any(String), count: 0 });
    const b = badgeFor([rec("1", "info"), rec("2", "warning"), rec("3", "urgent", { readAt: 5 })]);
    expect(b).toMatchObject({ text: "2", count: 2, color: "#B26A00" });
    expect(badgeFor([rec("1", "urgent"), rec("2", "urgent", { retracted: true })])).toMatchObject({
      text: "1",
      color: "#C62828",
    });
    expect(badgeFor(Array.from({ length: 12 }, (_, i) => rec(String(i), "info"))).text).toBe("9+");
  });

  it("merge: dedup by id, newest first, capped", () => {
    const { records, added } = mergeAlerts([], [alert({ id: "x", at: 1 }), alert({ id: "y", at: 2 })], "browser", 9);
    expect(records.map((r) => r.alert.id)).toEqual(["y", "x"]);
    expect(added).toHaveLength(2);
    const again = mergeAlerts(records, [alert({ id: "x" }), alert({ id: "z", at: 3 })], "watcher", 10);
    expect(again.added.map((r) => r.alert.id)).toEqual(["z"]);
    expect(again.records.map((r) => r.alert.id)).toEqual(["z", "y", "x"]);
    const many = mergeAlerts(
      [],
      Array.from({ length: MAX_ALERTS + 5 }, (_, i) => alert({ id: `m${i}`, at: i })),
      "browser",
      1,
    );
    expect(many.records).toHaveLength(MAX_ALERTS);
  });

  it("store: add, mark read, retract", async () => {
    const s = new AlertStore(new MemoryKV(), () => 42);
    await s.add([alert({ id: "1" }), alert({ id: "2" })], "browser");
    expect(await s.add([alert({ id: "1" })], "browser")).toEqual([]);
    await s.markRead(["1"]);
    await s.retract(["2"]);
    const l = await s.list();
    expect(l.find((r) => r.alert.id === "1")?.readAt).toBe(42);
    expect(l.find((r) => r.alert.id === "2")?.retracted).toBe(true);
    expect(badgeFor(l).count).toBe(0);
  });
});

// ---- a fake chain with the account deployed at block 40 and a queued loosening at block 60 ----------------------

function makeLog(abi: Abi, eventName: string, args: Record<string, unknown>, block: bigint, tx: Hex): RpcLog {
  const ev = abi.find((x) => x.type === "event" && x.name === eventName) as Extract<Abi[number], { type: "event" }>;
  const topics = encodeEventTopics({ abi: [ev], eventName, args: args as never }) as Hex[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  return {
    address: ACCOUNT,
    topics,
    data: encodeAbiParameters(nonIndexed, nonIndexed.map((i) => args[i.name!]) as never),
    blockNumber: `0x${block.toString(16)}`,
    blockHash: `0x${block.toString(16).padStart(64, "b")}`,
    transactionHash: tx,
    logIndex: "0x0",
  };
}

function fakeChain(o: { deployAt: bigint; head: bigint; logs: RpcLog[]; ts: (b: bigint) => number }) {
  const calls = { getCode: 0, getLogs: [] as Array<{ from: bigint; to: bigint }> };
  const c: LightClient & { head: bigint; calls: typeof calls } = {
    head: o.head,
    calls,
    getBlockNumber: async () => c.head,
    getCode: async ({ blockNumber }) => {
      calls.getCode++;
      return (blockNumber ?? c.head) >= o.deployAt ? "0x6000" : undefined;
    },
    getBlock: async ({ blockNumber }) => ({ timestamp: BigInt(o.ts(blockNumber)) }),
    request: async ({ method, params }) => {
      if (method !== "eth_getLogs") throw new Error(method);
      const f = params[0] as { fromBlock: Hex; toBlock: Hex };
      const from = BigInt(f.fromBlock);
      const to = BigInt(f.toBlock);
      calls.getLogs.push({ from, to });
      return o.logs.filter((l) => BigInt(l.blockNumber as Hex) >= from && BigInt(l.blockNumber as Hex) <= to);
    },
  };
  return c;
}

const plan = { chainId: 1337, address: ACCOUNT, vaultSigner: VAULT_SIGNER } as unknown as AccountPlan;

describe("deploy block (BACKLOG: Pending scanned Queued from block 0)", () => {
  it("binary search finds the first block with code; the activation receipt is used when it matches", async () => {
    const c = fakeChain({ deployAt: 40n, head: 1000n, logs: [], ts: () => 0 });
    expect(await findDeployBlock(c, ACCOUNT)).toBe(40n);
    const withReceipt = { ...c, getTransactionReceipt: async () => ({ blockNumber: 40n }) };
    c.calls.getCode = 0;
    expect(await findDeployBlock(withReceipt, ACCOUNT, { activationTx: "0x01" })).toBe(40n);
    expect(c.calls.getCode).toBeLessThanOrEqual(3);
    // A receipt for a later tx (someone else deployed it first) falls back to the search.
    const late = { ...c, getTransactionReceipt: async () => ({ blockNumber: 70n }) };
    expect(await findDeployBlock(late, ACCOUNT, { activationTx: "0x02" })).toBe(40n);
    expect(await findDeployBlock(fakeChain({ deployAt: 5000n, head: 1000n, logs: [], ts: () => 0 }), ACCOUNT)).toBe(
      undefined,
    );
  });

  it("is cached per chain and account", async () => {
    const kv = new MemoryKV();
    const c = fakeChain({ deployAt: 40n, head: 1000n, logs: [], ts: () => 0 });
    const d = new DeployBlocks(kv);
    expect(await d.get(1337, ACCOUNT, c)).toBe(40n);
    c.calls.getCode = 0;
    expect(await d.get(1337, ACCOUNT, c)).toBe(40n);
    expect(c.calls.getCode).toBe(0);
  });
});

describe("WatcherLight", () => {
  const ETA = 1_800_172_800;
  const queued = makeLog(
    frameAccountAbi as Abi,
    "Queued",
    { opId: OP, kind: 1, eta: ETA },
    60n,
    `0x${"cd".repeat(32)}`,
  );

  const setup = (initiated: boolean | undefined) => {
    const kv = new MemoryKV();
    const chain = fakeChain({ deployAt: 40n, head: 100n, logs: [queued], ts: () => 1_800_000_000 });
    let now = 1_800_000_100_000;
    const w = new WatcherLight({
      kv,
      deployBlocks: new DeployBlocks(kv),
      client: () => chain,
      plan: async () => plan,
      roles: async () => ({ vault: VAULT_SIGNER }),
      initiated: async () => (ref) => (initiated && ref.opId === OP ? true : undefined),
      now: () => now,
      confirmations: 1,
    });
    return { w, chain, kv, setNow: (t: number) => (now = t) };
  };

  it("reads from the deployment block (not 0), raises one urgent alert for a loosening nobody here asked for", async () => {
    const { w, chain } = setup(undefined);
    const r = await w.poll(1337);
    expect(chain.calls.getLogs[0]).toEqual({ from: 40n, to: 99n });
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0]).toMatchObject({
      kind: "change-scheduled",
      severity: "urgent",
      title: "Limit change scheduled",
      action: { deepLink: `#pending/${OP}` },
    });
    expect(r.nextDeadline).toBe(ETA);
    expect((await w.state(1337))?.cursor).toBe("99");
    // The next poll continues from the cursor and never repeats an alert.
    chain.head = 130n;
    const r2 = await w.poll(1337);
    expect(chain.calls.getLogs[1]).toEqual({ from: 100n, to: 129n });
    expect(r2.alerts).toEqual([]);
  });

  it('downgrades what this browser started to info ("you did this")', async () => {
    const { w } = setup(true);
    const r = await w.poll(1337);
    expect(r.alerts[0]?.severity).toBe("info");
  });

  it("the waiting period ending raises its own alert from the persisted deadline (an SW restart loses nothing)", async () => {
    const { w, kv, setNow } = setup(true);
    await w.poll(1337);
    setNow((ETA + 60) * 1000);
    // A new instance on the same storage: the deadline came from storage, not memory.
    const w2 = new WatcherLight({
      kv,
      deployBlocks: new DeployBlocks(kv),
      client: () => fakeChain({ deployAt: 40n, head: 100n, logs: [queued], ts: () => 1_800_000_000 }),
      plan: async () => plan,
      roles: async () => ({}),
      initiated: async () => () => undefined,
      now: () => (ETA + 60) * 1000,
    });
    const t = await w2.tick(1337);
    expect(t.map((a) => a.kind)).toEqual(["scheduled-ready"]);
    expect(await w2.tick(1337)).toEqual([]);
  });

  it("no account yet, or not deployed yet: nothing to read", async () => {
    const kv = new MemoryKV();
    const w = new WatcherLight({
      kv,
      deployBlocks: new DeployBlocks(kv),
      client: () => fakeChain({ deployAt: 500n, head: 100n, logs: [], ts: () => 0 }),
      plan: async () => plan,
      roles: async () => ({}),
      initiated: async () => () => undefined,
    });
    expect((await w.poll(1337)).alerts).toEqual([]);
    expect((await w.state(1337))?.cursor).toBeUndefined();
  });

  it("targets: the account and its role signers (frame backend)", () => {
    expect(watchTargets(plan)).toEqual({
      chainId: 1337,
      accounts: [{ address: ACCOUNT, backend: "frame" }],
      roleSigners: [{ address: VAULT_SIGNER, account: ACCOUNT }],
    });
  });
});

describe("pairing with a self-hosted watcher", () => {
  const code = JSON.stringify({
    url: "https://watcher.example/",
    topic: "leaked-7f3a",
    keyId: "laptop",
    hmacKey: "00112233445566778899aabbccddeeff",
  });

  it("reads the pairing code {url, topic, keyId, hmacKey}; refuses anything else in plain words", () => {
    expect(readPairingCode(code)).toEqual({
      url: "https://watcher.example",
      topic: "leaked-7f3a",
      keyId: "laptop",
      hmacKey: "00112233445566778899aabbccddeeff",
    });
    expect(() => readPairingCode('{"url":"ftp://x","topic":"t","keyId":"k","hmacKey":"00"}')).toThrow(
      /isn't a LEAKED watcher pairing code/,
    );
    expect(() => readPairingCode("not json")).toThrow(/pairing code/);
  });

  it("keeps only alerts whose HMAC verifies under the shared key; follows retractions and the sequence", async () => {
    const store = new PairingStore(new MemoryKV(), () => 1);
    const p = await store.set(readPairingCode(code));
    const good = await signAlert(p.hmacKey, { type: "alert", seq: 3, alert: alert({ id: "w1" }) }, 1000);
    const forged = await signAlert(
      "ffeeddccbbaa99887766554433221100",
      { type: "alert", seq: 4, alert: alert({ id: "w2", title: "All clear" }) },
      1000,
    );
    const retract = await signAlert(p.hmacKey, { type: "retract", seq: 5, alert: alert({ id: "w0" }) }, 1000);
    const replayed = await signAlert(p.hmacKey, { type: "alert", seq: 6, alert: alert({ id: "w6" }) }, 1000);
    const v1 = {
      v: 1,
      t: 1000,
      seq: 8,
      type: "alert",
      alert: alert({ id: "v1" }),
      sig: await hmacHex(p.hmacKey, `1000.${JSON.stringify(alert({ id: "v1" }))}`),
    };
    const seen: Array<{ url: string; auth: string }> = [];
    const r = await readPairedWatcher(
      p,
      async (url, init) => {
        seen.push({ url, auth: init.headers.authorization! });
        return {
          ok: true,
          status: 200,
          json: async () => ({
            alerts: [
              good,
              forged,
              retract,
              // A forged entry cannot move the cursor (it would hide every later genuine alert), nor crash the poll.
              { ...forged, seq: 2 ** 52 },
              // Signed with our key, but `type` / `seq` tampered with in transit: both are covered by the signature.
              { ...replayed, type: "retract" },
              { ...replayed, seq: 2 ** 52 },
              // A v1 envelope (signed `t.alert` only) is refused outright.
              v1,
              null,
            ],
          }),
        };
      },
      1000,
    );
    expect(seen[0]!.url).toBe("https://watcher.example/v1/alerts?since=0");
    expect(seen[0]!.auth).toMatch(/^LEAKED-HMAC id=laptop,t=1000,n=[0-9a-f]{32},sig=[0-9a-f]{64}$/u);
    expect(r.alerts.map((a) => a.id)).toEqual(["w1"]);
    expect(r.retracted).toEqual(["w0"]);
    expect(r.rejected).toBe(6);
    expect(r.since).toBe(5);
    await expect(
      readPairedWatcher(p, async () => ({ ok: false, status: 401, json: async () => ({}) })),
    ).rejects.toThrow(/refused this browser's key/);
  });

  it("a watcher's (verified) retraction cannot hide an alert this browser raised itself", async () => {
    const store = new AlertStore(new MemoryKV(), () => 1);
    await store.add([alert({ id: "mine", severity: "urgent" })], "browser");
    await store.add([alert({ id: "theirs" })], "watcher");
    await store.retract(["mine", "theirs"], "watcher");
    const byId = Object.fromEntries((await store.list()).map((r) => [r.alert.id, r.retracted ?? false]));
    expect(byId).toEqual({ mine: false, theirs: true });
  });
});

describe("light mode across a reset chain (M6 review: deploy-block cache and cursor)", () => {
  const withGenesis = (deployAt: bigint, head: bigint, genesis: Hex) => {
    const c = fakeChain({ deployAt, head, logs: [], ts: () => 1_800_000_000 });
    return Object.assign(c, {
      getBlock: async ({ blockNumber }: { blockNumber: bigint }) => ({
        timestamp: 1_800_000_000n,
        ...(blockNumber === 0n ? { hash: genesis } : {}),
      }),
      getChainId: async () => 1337,
    });
  };
  const light = (kv: MemoryKV, chain: LightClient) =>
    new WatcherLight({
      kv,
      deployBlocks: new DeployBlocks(kv),
      client: () => chain,
      plan: async () => plan,
      roles: async () => ({}),
      initiated: async () => () => undefined,
      confirmations: 1,
    });

  it("a new genesis under the same chain id drops the cursor and the cached deploy block", async () => {
    const kv = new MemoryKV();
    const a = withGenesis(40n, 1000n, "0x01");
    await light(kv, a).poll(1337);
    expect((await kv.get<{ cursor: string }>(WATCHER_STATE_KEY(1337)))?.cursor).toBe("999");
    const b = withGenesis(7n, 50n, "0x02"); // the devnet restarted: account redeployed at 7, head 50
    await light(kv, b).poll(1337);
    expect(b.calls.getLogs[0]?.from).toBe(7n);
    expect(await kv.get(WATCHER_STATE_KEY(1337))).toMatchObject({ cursor: "49", chain: "1337:0x02" });
  });

  it("a head below the cursor (no fingerprint available) also starts over", async () => {
    const kv = new MemoryKV();
    await light(kv, fakeChain({ deployAt: 40n, head: 1000n, logs: [], ts: () => 0 })).poll(1337);
    const low = fakeChain({ deployAt: 40n, head: 60n, logs: [], ts: () => 0 });
    await light(kv, low).poll(1337);
    expect(low.calls.getLogs[0]?.from).toBe(40n);
  });
});
