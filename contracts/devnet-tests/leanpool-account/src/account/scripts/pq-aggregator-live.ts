/**
 * Live on the devnet: an owner payment whose LeanPool root is authorized by a post-quantum key.
 *
 * A fresh LeanAccount (one leanSPHINCS owner key, admin + spend) names the PQAggregator as its aggregator. The owner
 * signs a 1-wei payment; the LeanPool node (PQ mode: LEANPOOL_PQ_AGGREGATOR) batches it, signs the root with the
 * aggregator's SPHINCS- C13 key and sends PQAggregator.post from its gas-payer EOA; the contract verifies the C13
 * signature in execution and posts into the account's ring; the payment is mined.
 *
 * Usage (a node in PQ mode on LEANPOOL_NODE_URL):
 *   ACCOUNT_DEPLOYMENT=queuebit-public.json LEANPOOL_NODE_URL=http://127.0.0.1:8702 \
 *     [PQ_AGGREGATOR=0x…] [KEYS_DIR=…/.keys] bun src/account/scripts/pq-aggregator-live.ts
 * PQ_AGGREGATOR defaults to devnet/deploy/addresses.public.json's PQAggregator. Writes deployments/pq-aggregator-live.json;
 * the owner key stays in KEYS_DIR/pq-aggregator-live.json.
 */
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, getAddress, keccak256, parseEther, toHex } from "viem";
import type { Address, Hex } from "viem";
import { KEYS_DIR, ROOT, chainTx, explorerTx, key, local } from "../../core/config.ts";
import { publicClient, rpc } from "../../core/chain.ts";
import * as pq from "../../v2/leanpq.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { createAccount, predictAccount, sendViaLeanPool } from "../sdk.ts";

const d = readAccountDeployment();
const deployed = JSON.parse(fs.readFileSync(path.join(ROOT, "../../../devnet/deploy/addresses.public.json"), "utf8"));
const aggregator = getAddress((process.env.PQ_AGGREGATOR ?? deployed.contracts.PQAggregator?.address) as Address);
if (!aggregator) throw new Error("no PQAggregator: set PQ_AGGREGATOR or deploy it (devnet/deploy, PQ_AGGREGATOR_PK)");

// The node must speak for this aggregator (its leanpool_status nodeId), or the root lands in another namespace.
const status = await rpc("leanpool_status", [], local.nodeA);
if (getAddress(status.nodeId) !== aggregator) throw new Error(`the node at ${local.nodeA} is ${status.nodeId}, not ${aggregator}`);
console.log(`node ${local.nodeA}: aggregator ${status.nodeId}, C13 key ${status.pq?.publicKey}, gas payer ${status.gasPayer}`);

// Owner key: saved before the account is funded (a failed run must not strand its ETH).
const KEYS_FILE = path.join(KEYS_DIR, "pq-aggregator-live.json");
const seed = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const owner = await pq.keyFromSeed(seed);
const opts = {
  salt: keccak256(toHex(`pq-aggregator ${owner.publicKey} ${Date.now()}`)),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator },
  keys: [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: owner.publicKey }],
  fund: parseEther("0.003"),
};
const account = await predictAccount(d, opts);
const all = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")) : {};
all[account] = { owner: seed };
fs.writeFileSync(KEYS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
await createAccount(d, opts);
console.log(`account ${account} (policy aggregator ${aggregator})`);

const to = key("funder").address;
const r = await sendViaLeanPool(d, account, [{ to, value: 1n }], owner, { node: local.nodeB, aggregatorNode: local.nodeA });
console.log(`owner payment mined: ${r.txHash} in block ${r.block}, frames ${r.frames}`);
console.log(`  ${explorerTx(r.txHash)}`);

// The root post: PQAggregator.post from the node's gas payer, C13 signature verified in execution.
const s = await rpc("leanpool_status", [], local.nodeA);
const batch = s.batches.find((b: { root: Hex }) => b.root === r.root);
const post = await publicClient.getTransactionReceipt({ hash: batch.postTx });
const postTx = await publicClient.getTransaction({ hash: batch.postTx });
if (getAddress(postTx.to!) !== aggregator) throw new Error(`root ${r.root} was not posted through ${aggregator}`);
console.log(`root ${r.root} posted by PQAggregator.post: ${chainTx(batch.postTx)}`);
console.log(`  from gas payer ${postTx.from}, ${post.gasUsed} gas, ${(postTx.input.length - 2) / 2} bytes of calldata`);

const out = {
  account,
  aggregator,
  owner: owner.publicKey,
  payment: { tx: r.txHash, block: r.block, frames: r.frames },
  rootPost: { root: r.root, tx: batch.postTx, gasUsed: post.gasUsed.toString(), from: postTx.from, block: Number(post.blockNumber) },
};
fs.writeFileSync(path.join(ROOT, "deployments", "pq-aggregator-live.json"), `${JSON.stringify(out, null, 2)}\n`);
console.log("wrote deployments/pq-aggregator-live.json");
