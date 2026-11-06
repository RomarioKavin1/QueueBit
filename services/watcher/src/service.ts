import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { WatcherCore, type CoreState } from "@leaked/watcher-core";
import { rpcChainClient, type ChainClient } from "./chain.js";
import type { WatcherConfig } from "./config.js";
import { ntfySink, webhookSink } from "./delivery.js";
import { Hub, type Sink } from "./hub.js";
import { Poller } from "./poller.js";
import { createWatcherServer } from "./server.js";
import { openStore, type CheckpointStore } from "./store.js";

export interface Service {
  poller: Poller;
  hub: Hub;
  server: Server;
  /** Bound port (after `start`). */
  port(): number;
  start(): Promise<void>;
  stop(): Promise<void>;
  /** One poll now (tests, or an external scheduler). */
  pollOnce(): ReturnType<Poller["poll"]>;
}

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

/** JSON lines on stderr; never logs secrets. */
export const jsonLog: Log = (msg, extra = {}) =>
  process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), msg, ...extra })}\n`);

export async function createService(
  cfg: WatcherConfig,
  deps: {
    chain?: ChainClient;
    store?: CheckpointStore;
    log?: Log;
    fetch?: typeof fetch;
    clock?: () => number;
    sinks?: Sink[];
  } = {},
): Promise<Service> {
  const log = deps.log ?? jsonLog;
  const chain = deps.chain ?? rpcChainClient(cfg.rpcUrl);
  const store = deps.store ?? (await openStore(cfg.store));
  const saved = store.load();

  const sinks: Sink[] = [...(deps.sinks ?? [])];
  const fetchOpt = deps.fetch ? { fetch: deps.fetch } : {};
  if (cfg.webhook) sinks.push(webhookSink(cfg.webhook, { ...fetchOpt, log }));
  if (cfg.ntfy) sinks.push(ntfySink(cfg.ntfy, { ...fetchOpt, log }));
  const hub = new Hub(sinks, saved?.hub);

  const makeCore = (state?: CoreState) =>
    new WatcherCore({
      targets: {
        chainId: cfg.chainId,
        accounts: cfg.accounts,
        modules: cfg.modules,
        ...(cfg.entryPoint ? { entryPoint: cfg.entryPoint } : {}),
        roleSigners: cfg.roleSigners,
      },
      blockedThreshold: cfg.blockedThreshold,
      blockedWindowSec: cfg.blockedWindowSec,
      ...(state ? { state } : {}),
    });

  const poller = new Poller(
    {
      chain,
      makeCore,
      hub,
      store,
      chainId: cfg.chainId,
      confirmations: cfg.confirmations,
      startBlock: cfg.startBlock,
      maxBlockRange: cfg.maxBlockRange,
      reorgWindow: cfg.reorgWindow,
      scanFrameTxs: cfg.scanFrameTxs,
      log,
      ...(deps.clock ? { clock: deps.clock } : {}),
    },
    saved,
  );

  const server = createWatcherServer({
    hub,
    log: (m) => log("http", { error: m }),
    apiKeys: cfg.apiKeys,
    rateLimit: cfg.rateLimit,
    trustProxy: cfg.http.trustProxy,
    status: () => ({
      chainId: cfg.chainId,
      lastBlock: poller.cursor?.toString() ?? null,
      accounts: cfg.accounts.length,
    }),
  });

  let timer: NodeJS.Timeout | undefined;
  let running = false;
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    if (!running) {
      running = true;
      try {
        const r = await poller.poll();
        if (r.alerts.length || r.retracted.length || r.reorg) {
          log("poll", {
            processedTo: r.processedTo?.toString() ?? null,
            alerts: r.alerts.map((a) => a.kind),
            retracted: r.retracted.length,
            ...(r.reorg ? { reorgAt: r.reorg.at.toString() } : {}),
          });
        }
      } catch (e) {
        log("poll failed", { error: (e as Error).message });
      } finally {
        running = false;
      }
    }
    if (!stopped) timer = setTimeout(loop, cfg.pollIntervalMs);
  };

  return {
    poller,
    hub,
    server,
    port: () => (server.address() as AddressInfo | null)?.port ?? 0,
    pollOnce: () => poller.poll(),
    async start() {
      const id = await chain.chainId();
      if (id !== cfg.chainId) throw new Error(`RPC is chain ${id}, config says ${cfg.chainId}`);
      await new Promise<void>((res) => server.listen(cfg.http.port, cfg.http.host, res));
      log("listening", {
        host: cfg.http.host,
        port: (server.address() as AddressInfo).port,
        accounts: cfg.accounts.length,
      });
      void loop();
    },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise<void>((res) => server.close(() => res()));
      store.close();
    },
  };
}
