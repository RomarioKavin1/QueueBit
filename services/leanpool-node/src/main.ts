#!/usr/bin/env node
// LeanPool node for QueueBit's post-quantum everyday key. Configuration: environment variables (config.ts).
//
//   LEANPOOL_PRIVATE_KEY=0x… LEANPOOL_RPC_URL=… LEANPOOL_SIDECAR_URL=… LEANPOOL_REGISTRY=0x… LEANPOOL_AGGREGATE=1 \
//     node dist/main.js
//
// PQ mode (the aggregator is a PQAggregator contract; LEANPOOL_PRIVATE_KEY only pays gas):
//   … LEANPOOL_PQ_AGGREGATOR=0x… LEANPOOL_PQ_KEY_FILE=/path/to/pq-aggregator.json node dist/main.js
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, hexToBytes, keccak256 } from "viem";
import type { Hex } from "viem";
import { loadConfig } from "./config.js";
import { jsonRpc, makeChain } from "./chain.js";
import type { PQSetup } from "./chain.js";
import { readSecretKey, workerSigner } from "./c13.js";
import { SignatureLedger } from "./pqOps.js";
import { AGGREGATION_INTERVAL_MS, Node8288 } from "./node.js";
import * as pq from "./leanpq.js";
import { createRpcServer } from "./server.js";

const cfg = loadConfig();
const name = `${cfg.aggregate ? "aggregator" : "relay"}:${cfg.port}`;
const log = (...a: unknown[]) => console.log(`[leanpool ${name}]`, ...a);
let pqSetup: PQSetup | undefined;
if (cfg.pq) {
  const sk = readSecretKey(cfg.pq);
  pqSetup = { signer: workerSigner(sk), ledger: new SignatureLedger(path.join(cfg.dataDir, "pq-signatures.json")) };
  sk.fill(0);
}
const { chain, keyedNonce, ensureBond, address, gasPayer, pq: pqOps } = makeChain(cfg, log, pqSetup);
let pqInfo: { publicKey: Hex; signaturesUsed: string; budget: string; reserve: string } | null = null;
if (pqOps && pqSetup) {
  const c = await pqOps.check(); // the contract must hold this node's C13 key
  pqInfo = {
    publicKey: pqSetup.signer.publicKey,
    signaturesUsed: c.signaturesUsed.toString(),
    budget: c.budget.toString(),
    reserve: c.reserve.toString(),
  };
  log(
    `PQ mode: aggregator ${address} (C13 key ${pqSetup.signer.publicKey}, ${c.signaturesUsed}/${c.budget} signatures used); gas payer ${gasPayer}`,
  );
}

// Every STARK is kept on disk and loaded at start: an on-chain proof hash is only checkable while someone serves it.
const starkDir = path.join(cfg.dataDir, "starks");
fs.mkdirSync(starkDir, { recursive: true });
const persist = (h: Hex, bytes: Hex) => fs.writeFileSync(path.join(starkDir, `${h}.bin`), hexToBytes(bytes));
/** A STARK from disk, checked against its hash (a damaged file is not served). */
const loadStark = (h: Hex): Hex | null => {
  const f = path.join(starkDir, `${h}.bin`);
  if (!/^0x[0-9a-f]{64}$/u.test(h) || !fs.existsSync(f)) return null;
  const b = bytesToHex(fs.readFileSync(f));
  return keccak256(b) === h ? b : null;
};
const storedCount = fs.readdirSync(starkDir).filter((f) => f.endsWith(".bin")).length;

const node = new Node8288({ chain, aggregate: cfg.aggregate, rolling: cfg.rolling, name, log, persist, loadStark });
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
// Txs the alt mempool admitted but didn't mine in time: follow them to a receipt, or to the sidecar dropping them.
if (cfg.aggregate) every(15_000, "follow", () => node.followPending());
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
    ...(pqInfo ? { gasPayer, pq: pqInfo } : {}),
    registry: cfg.registry,
    peers: cfg.peers,
    sidecar: cfg.sidecarUrl,
    chainId: cfg.chainId,
    ...(bond ? { bond: { bonded: bond.bonded.toString(), min: bond.min.toString() } } : {}),
  }),
});
server.listen(cfg.port, cfg.host, () =>
  log(
    `listening on ${cfg.host}:${cfg.port} as ${address}; registry ${cfg.registry}; sidecar ${cfg.sidecarUrl}; peers: ${cfg.peers.join(", ") || "none"}; ${storedCount} STARK(s) on disk`,
  ),
);
