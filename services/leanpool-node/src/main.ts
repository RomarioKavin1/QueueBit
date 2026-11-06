#!/usr/bin/env node
// LeanPool node for QueueBit's post-quantum everyday key. Configuration: environment variables (config.ts).
//
//   LEANPOOL_PRIVATE_KEY=0x… LEANPOOL_RPC_URL=… LEANPOOL_SIDECAR_URL=… LEANPOOL_REGISTRY=0x… LEANPOOL_AGGREGATE=1 \
//     node dist/main.js
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Hex } from "viem";
import { loadConfig } from "./config.js";
import { jsonRpc, makeChain } from "./chain.js";
import { AGGREGATION_INTERVAL_MS, Node8288 } from "./node.js";
import * as pq from "./leanpq.js";
import { createRpcServer } from "./server.js";

const cfg = loadConfig();
const name = `${cfg.aggregate ? "aggregator" : "relay"}:${cfg.port}`;
const log = (...a: unknown[]) => console.log(`[leanpool ${name}]`, ...a);
const { chain, keyedNonce, ensureBond, address } = makeChain(cfg, log);

// Every STARK is kept on disk and loaded at start: an on-chain proof hash is only checkable while someone serves it.
const starkDir = path.join(cfg.dataDir, "starks");
fs.mkdirSync(starkDir, { recursive: true });
const persist = (h: Hex, bytes: Hex) => fs.writeFileSync(path.join(starkDir, `${h}.bin`), hexToBytes(bytes));
const stored = fs
  .readdirSync(starkDir)
  .filter((f) => f.endsWith(".bin"))
  .map((f) => [f.slice(0, -4) as Hex, bytesToHex(fs.readFileSync(path.join(starkDir, f)))] as [Hex, Hex])
  .filter(([h, b]) => keccak256(b) === h);

const node = new Node8288({ chain, aggregate: cfg.aggregate, rolling: cfg.rolling, name, log, persist });
node.loadStarks(stored);
node.peers = cfg.peers.map((p) => (wrapper: Hex) => jsonRpc(p, "leanpool_wrapper", [wrapper]));

let bond: { bonded: bigint; min: bigint } | null = null;
if (cfg.aggregate) {
  bond = await ensureBond();
  if (bond.bonded < bond.min)
    log(
      `WARNING: bond ${bond.bonded} < registry minimum ${bond.min}: postRoot will revert (set LEANPOOL_AUTO_BOND_WEI)`,
    );
}

// Loops. Errors are logged, never fatal.
const every = (ms: number, what: string, fn: () => Promise<unknown>) => {
  let running = false;
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await fn();
    } catch (e) {
      const err = e as { shortMessage?: string; message?: string };
      log(`${what}: ${err.shortMessage ?? err.message ?? String(e)}`);
    } finally {
      running = false;
    }
  }, ms);
};
every(AGGREGATION_INTERVAL_MS, "mode 0 gossip", () => node.broadcastMode0());
if (cfg.aggregate) every(cfg.batchMs, "batch", () => node.batchOnce());
if (cfg.aggregate || cfg.rolling) every(2000, "prover", () => node.proveNext());
// Pruning: a tx whose nonce lane moved past its seq was included (or replaced): it leaves the pool.
every(6000, "prune", async () => {
  for (const p of [...node.pool.values()]) {
    if ((await keyedNonce(p.tx.sender, p.tx.nonceKeys[0] ?? 0n)) > p.tx.nonceSeq) node.remove(p.hash);
  }
});

await pq.setup();
const server = createRpcServer({
  node,
  maxBodyBytes: cfg.maxBodyBytes,
  log,
  extraStatus: () => ({
    nodeId: address,
    registry: cfg.registry,
    peers: cfg.peers,
    sidecar: cfg.sidecarUrl,
    chainId: cfg.chainId,
    ...(bond ? { bond: { bonded: bond.bonded.toString(), min: bond.min.toString() } } : {}),
  }),
});
server.listen(cfg.port, cfg.host, () =>
  log(
    `listening on ${cfg.host}:${cfg.port} as ${address}; registry ${cfg.registry}; sidecar ${cfg.sidecarUrl}; peers: ${cfg.peers.join(", ") || "none"}; ${stored.length} STARK(s) loaded`,
  ),
);
