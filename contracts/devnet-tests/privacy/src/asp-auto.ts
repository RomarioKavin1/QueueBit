// The association-set (ASP) auto-approver for OUR public-devnet Privacy Pools deployment (deployments/public.json),
// where the funder key is the ASP postman. It watches the pool's `Deposited` events and posts
// `Entrypoint.updateRoot(root, cid)` with the LeanIMT root of EVERY deposit label in deposit order, batched: at most
// one post per `ASP_INTERVAL_MS` (default 60 s), and only when the root changed.
//
// Why "every label, in order": the wallet (apps/extension `poolOrderAsp`, the `pool-order` ASP source) rebuilds the
// approved label list as the longest prefix of the pool's deposits whose root equals `Entrypoint.latestRoot()`, and
// re-checks that root exactly; so no extra file has to be served, the chain is the source.
//
// Devnet only: approving everything is what a reviewer must NOT do on a real network.
//
//   PUBLIC=1 FUNDER_KEY_FILE=/abs/path/funder.json node src/asp-auto.ts        (or `bun run asp-auto`)
//   ASP_INTERVAL_MS=60000 ASP_POLL_MS=10000 ASP_ONCE=1 (one pass, then exit)
import { readFileSync } from "node:fs";
import { decodeEventLog, encodeFunctionData, parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { poseidon2 } from "poseidon-lite/poseidon2";
import { LeanIMT } from "@zk-kit/lean-imt";
import { CHAIN_ID, ETHREX, FUNDER, LEGACY_GAS_PRICE, PUBLIC, addr, ethrex, hex, sleep } from "./lib.ts";

if (!PUBLIC) throw new Error("asp-auto targets the public devnet deployment: run with PUBLIC=1");

const DEPLOYMENT = JSON.parse(readFileSync(new URL("../deployments/public.json", import.meta.url), "utf8"));
const POOL = DEPLOYMENT.privacyPools.pool as Address;
const ENTRYPOINT = DEPLOYMENT.privacyPools.entrypoint as Address;
const FROM_BLOCK = BigInt(DEPLOYMENT.privacyPools.deployBlock);
const CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi"; // deploy.ts (the Entrypoint wants 32..64 chars)
const INTERVAL_MS = Number(process.env.ASP_INTERVAL_MS ?? 60_000);
const POLL_MS = Number(process.env.ASP_POLL_MS ?? 10_000);
const ONCE = process.env.ASP_ONCE === "1";
const LOG_CHUNK = 5_000n;

const EP = parseAbi([
  "function latestRoot() view returns (uint256)",
  "function updateRoot(uint256 _root, string _ipfsCID) returns (uint256)",
]);
const DEPOSITED = parseAbiItem(
  "event Deposited(address indexed _depositor, uint256 _commitment, uint256 _label, uint256 _value, uint256 _precommitmentHash)",
);

const ts = () => new Date().toISOString();
const say = (msg: string, extra?: Record<string, unknown>) =>
  console.log(`${ts()} ${msg}${extra ? ` ${JSON.stringify(extra, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : ""}`);

export function aspRoot(labels: readonly bigint[]): bigint {
  const t = new LeanIMT<bigint>((a, b) => poseidon2([a, b]));
  t.insertMany([...labels]);
  return t.root;
}

/** Every deposit label of the pool, in deposit (log) order. */
const labels: bigint[] = [];
let scannedTo = FROM_BLOCK - 1n;

async function scan(): Promise<void> {
  const head = BigInt(await ethrex("eth_blockNumber"));
  while (scannedTo < head) {
    const from = scannedTo + 1n;
    const to = from + LOG_CHUNK - 1n < head ? from + LOG_CHUNK - 1n : head;
    const logs: any[] = await ethrex("eth_getLogs", [{ address: POOL, fromBlock: hex(from), toBlock: hex(to) }]);
    logs.sort((a, b) =>
      BigInt(a.blockNumber) === BigInt(b.blockNumber)
        ? Number(BigInt(a.logIndex) - BigInt(b.logIndex))
        : Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)),
    );
    for (const l of logs) {
      try {
        const e = decodeEventLog({ abi: [DEPOSITED], data: l.data, topics: l.topics });
        labels.push((e.args as { _label: bigint })._label);
        say("deposit seen", { label: (e.args as { _label: bigint })._label, block: BigInt(l.blockNumber) });
      } catch {
        /* LeafInserted, Withdrawn, Ragequit */
      }
    }
    scannedTo = to;
  }
}

async function latestRoot(): Promise<bigint> {
  try {
    return BigInt(await ethrex("eth_call", [{ to: ENTRYPOINT, data: encodeFunctionData({ abi: EP, functionName: "latestRoot" }) }, "latest"]));
  } catch (e) {
    // NoRootsAvailable (a revert): never posted. A network error is not "never posted": skip this tick.
    if (/revert/iu.test(String((e as Error).message ?? e))) return 0n;
    throw e;
  }
}

/** A legacy tx from the postman with a fresh `pending` nonce each time (another script may use the same key). */
async function post(root: bigint): Promise<Hex> {
  const acct = privateKeyToAccount(FUNDER);
  const data = encodeFunctionData({ abi: EP, functionName: "updateRoot", args: [root, CID] });
  const gas = (BigInt(await ethrex("eth_estimateGas", [{ from: acct.address, to: ENTRYPOINT, data }])) * 5n) / 4n;
  for (let attempt = 0; ; attempt++) {
    const nonce = Number(BigInt(await ethrex("eth_getTransactionCount", [acct.address, "pending"])));
    const signed = await acct.signTransaction({
      type: "legacy", chainId: Number(CHAIN_ID), nonce, gasPrice: LEGACY_GAS_PRICE, gas, to: ENTRYPOINT, data,
    });
    try {
      const hash: Hex = await ethrex("eth_sendRawTransaction", [signed]);
      for (let i = 0; i < 120; i++) {
        const r = await ethrex("eth_getTransactionReceipt", [hash]).catch(() => null);
        if (r) {
          if (r.status !== "0x1") throw new Error(`updateRoot reverted: ${hash}`);
          return hash;
        }
        await sleep(1500);
      }
      throw new Error(`updateRoot not mined after 180 s: ${hash}`);
    } catch (e) {
      const m = String((e as Error).message ?? e);
      if (attempt < 3 && /nonce|underpriced|already known/iu.test(m)) {
        await sleep(3000);
        if ((await latestRoot()) === root) throw new Error("root already posted (an earlier attempt landed)");
        continue;
      }
      throw e;
    }
  }
}

let lastPost = 0;
async function tick(): Promise<void> {
  await scan();
  if (labels.length === 0) return;
  const want = aspRoot(labels);
  const have = await latestRoot();
  if (want === have) return;
  const wait = lastPost + INTERVAL_MS - Date.now();
  if (wait > 0 && !ONCE) return; // batched: the next tick after the interval posts everything seen by then
  lastPost = Date.now(); // a failed attempt counts too: at most one try per interval
  const hash = await post(want);
  say("ASP root posted", { root: want, labels: labels.length, tx: hash });
}

say("asp-auto started", { rpc: ETHREX, pool: POOL, entrypoint: ENTRYPOINT, postman: addr(FUNDER), fromBlock: FROM_BLOCK, intervalMs: INTERVAL_MS });
for (;;) {
  try {
    await tick();
  } catch (e) {
    say("error (will retry)", { error: String((e as Error).message ?? e).split("\n")[0] });
  }
  if (ONCE) break;
  await sleep(POLL_MS);
}
