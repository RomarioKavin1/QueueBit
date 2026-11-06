// Read-only integration test against the public LeanPool devnet (chain 1337) — sends NO transactions:
//
//   LIVE_DEVNET=1 WATCHER_LIVE_RPC=https://<devnet rpc> pnpm --filter @queuebit/watcher test
//
// Replays the real history of the `contracts/devnet-tests/leanpool-account` sessions-live account (the fixture
// packages/watcher-core/test/fixtures/devnet-1337-account.json: creation, the owner's session limits, session ETH and
// token payments) through the whole service: the poller reads the account and the shared modules with eth_getLogs
// from the node, the core raises alerts, the SSE stream and the HMAC webhook deliver them. Asserts the service raises
// exactly what the core raises offline from the fixture, and that every delivery verifies.
//
// Producing new events (a key added, a guardian recovery, a module installed) needs PQ-signed frame transactions and
// devnet ETH; that is covered offline by packages/watcher-core/test/rules.test.ts and test/poller.test.ts.
import { readFileSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { getAddress, type Address } from "viem";
import {
  TargetIndex,
  WatcherCore,
  authHeader,
  decodeLogs,
  verifyAlert,
  verifyWebhook,
  type RpcLog,
  type SignedAlert,
} from "@queuebit/watcher-core";
import { rpcChainClient } from "../src/chain.js";
import { parseConfig } from "../src/config.js";
import { createService, type Service } from "../src/service.js";

const LIVE = process.env.LIVE_DEVNET === "1";
const RPC = process.env.WATCHER_LIVE_RPC ?? process.env.ETHREX_URL ?? "http://localhost:8545";
const CHAIN_ID = 1337;

const fixture = JSON.parse(
  readFileSync(
    new URL("../../../packages/watcher-core/test/fixtures/devnet-1337-account.json", import.meta.url),
    "utf8",
  ),
) as { account: Address; keystore: Address; hook: Address; logs: RpcLog[] };
const ACCOUNT = getAddress(fixture.account);
const MODULES = [getAddress(fixture.keystore), getAddress(fixture.hook)];
const blocks = fixture.logs.map((l) => BigInt(l.blockNumber));
const FIRST = blocks.reduce((a, b) => (a < b ? a : b));
const LAST = blocks.reduce((a, b) => (a > b ? a : b));

describe.skipIf(!LIVE)("watcher against the public devnet (read-only replay)", () => {
  let svc: Service | undefined;
  const servers: Server[] = [];
  afterAll(async () => {
    await svc?.stop();
    for (const s of servers) {
      s.closeAllConnections();
      s.close();
    }
  });

  it("replays the sessions-live account through poller, core, SSE and webhook", async () => {
    const chain = rpcChainClient(RPC);
    const id = await chain.chainId().catch(() => undefined);
    if (id !== CHAIN_ID) throw new Error(`no chain-${CHAIN_ID} node at ${RPC} (set WATCHER_LIVE_RPC)`);
    if ((await chain.blockNumber()) < LAST) throw new Error(`the node at ${RPC} is not past block ${LAST}`);

    // What the core raises offline from the recorded logs.
    const targets = { chainId: CHAIN_ID, accounts: [{ address: ACCOUNT }], modules: MODULES };
    const want = new WatcherCore({ targets }).ingest(decodeLogs(fixture.logs, new TargetIndex(targets)));
    expect(want.length).toBeGreaterThan(0);

    const KEY = `0x${"5a".repeat(32)}`;
    const WEBHOOK_KEY = `0x${"6b".repeat(32)}`;
    const hooks: { body: string; sig: string }[] = [];
    const receiver = createServer((req, res) => {
      let b = "";
      req.on("data", (c) => (b += c));
      req.on("end", () => {
        hooks.push({ body: b, sig: String(req.headers["x-queuebit-signature"]) });
        res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => receiver.listen(0, "127.0.0.1", r));
    servers.push(receiver);

    const cfg = parseConfig({
      rpcUrl: RPC,
      chainId: CHAIN_ID,
      confirmations: 0,
      pollIntervalMs: 3_600_000, // polled by hand below
      startBlock: FIRST.toString(),
      maxBlockRange: 50,
      accounts: [{ address: ACCOUNT }],
      modules: MODULES,
      store: `file:${join(mkdtempSync(join(tmpdir(), "queuebit-watcher-")), "state.json")}`,
      http: { host: "127.0.0.1", port: 0, trustProxy: 0 },
      apiKeys: [{ id: "ext", secret: KEY }],
      webhook: {
        url: `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`,
        secret: WEBHOOK_KEY,
        minSeverity: "info",
      },
    });
    svc = await createService(cfg, { log: () => {} });
    await svc.start(); // checks the chain id, then polls once

    // Catch up to LAST (the first poll may still be running; one more is harmless — alerts are deduplicated).
    for (let i = 0; i < 20 && (svc.poller.cursor ?? -1n) < LAST; i++) await svc.pollOnce();
    expect(svc.poller.cursor! >= LAST).toBe(true);

    const got = svc.hub
      .since(0)
      .filter((e) => e.type === "alert")
      .map((e) => e.alert)
      .filter((a) => BigInt(a.ref.blockNumber ?? "0") <= LAST);
    expect(got.map((a) => [a.id, a.kind, a.severity])).toEqual(want.map((a) => [a.id, a.kind, a.severity]));
    expect(svc.poller.watcher.policyOf(ACCOUNT)).toBeDefined();

    // The stream replays the history to a new subscriber; every envelope verifies with the extension's key.
    const res = await fetch(`http://127.0.0.1:${svc.port()}/v1/stream`, {
      headers: { authorization: await authHeader("ext", KEY, "GET", "/v1/stream") },
    });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const streamed: SignedAlert[] = [];
    while (streamed.length < got.length) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf
          .slice(0, i)
          .split("\n")
          .find((l) => l.startsWith("data: "));
        buf = buf.slice(i + 2);
        if (line) streamed.push(JSON.parse(line.slice(6)) as SignedAlert);
      }
    }
    await reader.cancel();
    for (const s of streamed) expect(await verifyAlert(KEY, s)).toBe(true);

    await new Promise((r) => setTimeout(r, 500));
    expect(hooks.length).toBeGreaterThanOrEqual(got.length);
    for (const h of hooks) expect(await verifyWebhook(WEBHOOK_KEY, h.body, h.sig)).toBe(true);
    console.log(
      JSON.stringify({ rpc: RPC, from: FIRST.toString(), to: LAST.toString(), alerts: got.map((a) => a.kind) }),
    );
  }, 120_000);
});
