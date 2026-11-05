// Mass-invalidation experiment (plan 40 §2.8 / §8.1) on the LOCAL devnet, funded from anvil #5 only.
// Needs the private patched sidecar in MANUAL bundling mode, so admitted txs stay `New`:
//   scripts/patched-sidecar.sh up manual && node src/mass-invalidation.ts [N=10]
// Steps: deploy Privacy Pools + PoolPayer, N deposits, N PoolPayer withdrawals (distinct notes, distinct fresh
// senders) admitted by the sidecar -> one ASP root update (Entrypoint.updateRoot) -> every pending withdrawal fails
// revalidation -> statuses + PoolPayer's reputation before/after.
import { writeFileSync, mkdirSync } from "node:fs";
import { encodeFunctionData } from "viem";
import { FUNDER, PATCHED_SIDECAR, sidecar, send, toWire, txHash, profile, log, big, sleep, ethrex } from "./lib.ts";
import { checkArtifacts, terminate } from "./pp.ts";
import { deployPool, ep, CID, NOTE_VALUE } from "./deploy.ts";
import { deployPayer, prepareWithdrawal } from "./payer.ts";

const N = Number(process.argv[2] ?? 10);
checkArtifacts();
const tag = `mass-${Date.now()}`;
const ver = await sidecar(PATCHED_SIDECAR, "web3_clientVersion").catch(() => null);
if (!ver) throw new Error(`patched sidecar not reachable at ${PATCHED_SIDECAR} (scripts/patched-sidecar.sh up manual)`);

const d = await deployPool(N, tag);
const P = await deployPayer(d.entrypoint, d.pool, { intrinsicGas: 0n, perFrameGas: 0n, gasPerDataByte: 4n, refundFrameGas: 0n }, 1_000_000_000_000_000_000n);
const payer = P.address;

async function reputation() {
  // skandha_explorer_listReputation (debug_bundler_dumpReputation is "not supported" on this build).
  const r = await sidecar(PATCHED_SIDECAR, "skandha_explorer_listReputation", [{}]);
  return (r.items ?? []).find((x: any) => x.address.toLowerCase() === payer.toLowerCase()) ?? { address: payer, opsSeen: 0, opsIncluded: 0, status: "none" };
}

const repBefore = await reputation();
log("reputation before", repBefore);

const hashes: string[] = [];
const admissions: any[] = [];
for (let k = 0; k < N; k++) {
  const w = await prepareWithdrawal({ d, payer, note: d.notes[k], withdrawn: NOTE_VALUE / 2n, stateLeaves: d.stateLeaves, hint: N % 64, tag: `${tag}/${k}` });
  const h = await sidecar(PATCHED_SIDECAR, "eth_sendFrameTransaction", [toWire(w.tx)]).catch((e) => `rejected: ${e.message}`);
  admissions.push({ k, sender: w.sender, hash: h, codecHash: txHash(profile, w.tx) });
  if (typeof h === "string" && h.startsWith("0x")) hashes.push(h);
}
log("admissions", admissions);
const statusOf = async () => Promise.all(hashes.map(async (h) => (await sidecar(PATCHED_SIDECAR, "skandha_frameTransactionStatus", [h]).catch((e) => ({ error: e.message })))));
const pending = await statusOf();
log("status before the ASP update", pending.map((s: any) => s?.status ?? s));
const repPending = await reputation();
log("reputation with N pending", repPending);

// The ASP postman (anvil #5 here) posts a new root: every pending withdrawal's proof now names a stale ASP root.
const newRoot = d.aspRoot ^ 1n;
const ur = await send(FUNDER, d.entrypoint, encodeFunctionData({ abi: ep.abi, functionName: "updateRoot", args: [newRoot, CID] }));
log("ASP updateRoot", { tx: ur.transactionHash, block: BigInt(ur.blockNumber) });
const b0 = BigInt(await ethrex("eth_blockNumber"));
let after: any[] = [];
for (let i = 0; i < 40; i++) {
  await sleep(3000);
  after = await statusOf();
  const done = after.every((s: any) => s?.status && s.status !== "New");
  if (done && BigInt(await ethrex("eth_blockNumber")) > b0 + 1n) break;
}
const explorerTx = await Promise.all(hashes.slice(0, 2).map((h) => sidecar(PATCHED_SIDECAR, "skandha_explorer_getTransaction", [h]).catch((e) => ({ error: e.message }))));
const repAfter = await reputation();
const results = { tag, N, payer, payerDeploy: P, pool: d.pool, entrypoint: d.entrypoint, updateRootTx: ur.transactionHash, admissions,
  statusBefore: pending, statusAfter: after, explorerSample: explorerTx, repBefore, repPending, repAfter };
log("status after the ASP update", after.map((s: any) => ({ status: s?.status ?? s, reason: s?.reason ?? s?.error })));
log("reputation after", repAfter);
mkdirSync(new URL("../results/", import.meta.url), { recursive: true });
const file = new URL(`../results/${tag}.json`, import.meta.url).pathname;
writeFileSync(file, big(results));
console.log(`\nMASS-INVALIDATION DONE -> ${file}`);
await terminate();
process.exit(0);
