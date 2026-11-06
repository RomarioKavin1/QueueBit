/**
 * Live guardian recovery on the devnet. The recovery itself (steps 3–5) uses nothing from us: guardians are ordinary
 * addresses sending ordinary transactions to the chain's RPC, and the final step is triggered by an address with no
 * role. Steps 1, 2 and 6 are the owner's own PQ transactions, which go through LeanPool.
 *
 *   account   one PQ key (admin + spend, requirePQ), guardians G1 G2 G3 (2 of 3), delay DELAY_S seconds
 *
 *   1. the owner swaps guardian G2 for G4 (uninstall + reinstall in one PQ batch); G2's approval then reverts on chain
 *      (the bug fixed here: an uninstall used to leave every old guardian in place)
 *   2. hostile recovery: G1 + G3 approve a reset to an attacker's key; the owner, still holding the PQ key, cancels it;
 *      after the delay, executing it reverts on chain
 *   3. the owner loses the PQ key: G1 + G4 approve a reset to the owner's new PQ key
 *   4. executing before the delay reverts on chain
 *   5. after the delay an address with no role executes it: the keystore holds only the new key (read from chain)
 *   6. the new key spends through LeanPool; LeanPool refuses the lost key at admission
 *
 * Usage: bun ts/account/scripts/recovery-live.ts   (LeanPool nodes and sidecars running)
 * Writes deployments/recovery-live.json; keys stay in .keys/recovery-live.json.
 */
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, decodeErrorResult, encodeAbiParameters, encodeFunctionData, formatEther, keccak256, parseEther, toHex } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ROOT, explorerTx, key } from "../../core/config.ts";
import { artifact } from "../../core/artifacts.ts";
import { keyedNonce, publicClient, sendLegacy } from "../../core/chain.ts";
import * as pq from "../../v2/leanpq.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { buildAndSign, createAccount, keyArg, pqKeysOf, sendViaLeanPool, submit } from "../sdk.ts";
import type { Signer } from "../sdk.ts";
import { local } from "../../core/config.ts";

const DELAY_S = 90;
const NODE_A = local.nodeA;
const NODE_B = local.nodeB;
const SIDECAR = local.sidecarA;
const EXECUTOR = 2n; // ERC-7579 module type
const d = readAccountDeployment();
const recoveryAbi = artifact("GuardianRecovery").abi;
const keystoreAbi = artifact("KeystoreValidator").abi;
const accountAbi = artifact("LeanAccount").abi;
const aggregator = key("aggregator").address;
const funder = key("funder");

// ------------------------------------------------------------------------------------------ keys (kept local) ----
const KEYS_FILE = path.join(ROOT, ".keys", "recovery-live.json");
const rand = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const secrets = {
  owner: rand(), ownerNew: rand(), attacker: rand(),
  g1: generatePrivateKey(), g2: generatePrivateKey(), g3: generatePrivateKey(), g4: generatePrivateKey(), anyone: generatePrivateKey(),
};
fs.writeFileSync(KEYS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
const owner = await pq.keyFromSeed(secrets.owner);
const ownerNew = await pq.keyFromSeed(secrets.ownerNew);
const attacker = await pq.keyFromSeed(secrets.attacker);
const [g1, g2, g3, g4, anyone] = [secrets.g1, secrets.g2, secrets.g3, secrets.g4, secrets.anyone].map((k) => ({ ...privateKeyToAccount(k), pk: k }));
const PQ = (k: pq.PqKey): Signer => ({ kind: "PQ", vk: k.publicKey, sign: (m) => k.sign(m) });

const out: Record<string, any> = { at: new Date().toISOString(), delaySeconds: DELAY_S, steps: [] as any[] };
const step = (s: Record<string, unknown>) => out.steps.push(s);

// ------------------------------------------------------------------------------------------ plain transactions ----
/** An ordinary transaction from `pk` to the chain's RPC: what any guardian's wallet sends. Must succeed. */
async function plainTx(who: string, pk: Hex, to: Address, data: Hex): Promise<Hex> {
  const gas = await publicClient.estimateGas({ account: privateKeyToAccount(pk).address, to, data });
  const r = await sendLegacy(pk, { to, data, gas: (gas * 13n) / 10n });
  console.log(`  ${who} → ${r.transactionHash} (block ${r.blockNumber}, gas ${r.gasUsed})`);
  return r.transactionHash;
}

/** Sends a call that must fail and gets it mined anyway (fixed gas, no estimate): the chain's own refusal. The reason
 * is GuardianRecovery's error, read with eth_call just before sending. */
async function minedRevert(who: string, pk: Hex, data: Hex): Promise<{ tx: Hex; block: number; reason: string }> {
  const from = privateKeyToAccount(pk).address;
  let reason = "none: the call would succeed";
  try {
    await publicClient.call({ account: from, to: d.recovery, data });
  } catch (e: any) {
    const raw = (e.cause?.data ?? e.data ?? e.cause?.cause?.data) as Hex | undefined;
    try {
      reason = raw ? decodeErrorResult({ abi: recoveryAbi, data: raw }).errorName : (e.shortMessage ?? e.message).split("\n")[0];
    } catch {
      reason = (e.shortMessage ?? e.message).split("\n")[0];
    }
  }
  if (reason.startsWith("none")) throw new Error(`${who}: expected a revert, but the call would succeed`);
  try {
    await sendLegacy(pk, { to: d.recovery, data, gas: 300_000n });
  } catch (e: any) {
    const tx = e.message.match(/0x[0-9a-fA-F]{64}/)?.[0] as Hex | undefined;
    if (!tx) throw e;
    const rc = await publicClient.getTransactionReceipt({ hash: tx });
    console.log(`  ${who} → reverted on chain (${reason}): ${tx} (block ${rc.blockNumber})`);
    return { tx, block: Number(rc.blockNumber), reason };
  }
  throw new Error(`${who}: the transaction succeeded`);
}

const approve = (account: Address, resetCall: Hex) => encodeFunctionData({ abi: recoveryAbi, functionName: "approve", args: [account, resetCall] });
const execute = (account: Address, resetCall: Hex) => encodeFunctionData({ abi: recoveryAbi, functionName: "execute", args: [account, resetCall] });
const resetTo = (k: pq.PqKey) => encodeFunctionData({ abi: keystoreAbi, functionName: "resetKeys", args: [
  { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator },
  [keyArg({ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: k.publicKey })],
] as any });
const guardianInit = (gs: Address[]) => encodeAbiParameters([{ type: "address[]" }, { type: "uint8" }, { type: "uint32" }], [gs, 2, DELAY_S]);
const proposalOf = async (account: Address, call: Hex) =>
  (await publicClient.readContract({ address: d.recovery, abi: recoveryAbi, functionName: "proposalId", args: [account, call] })) as Hex;
const readyAtOf = async (account: Address, id: Hex) =>
  ((await publicClient.readContract({ address: d.recovery, abi: recoveryAbi, functionName: "proposals", args: [id, account] })) as [number, bigint, boolean])[1];


/** The owner's PQ-signed account tx through LeanPool; returns the mined tx. */
async function viaLeanPool(label: string, account: Address, calls: { to: Address; value?: bigint; data?: Hex }[], signer: pq.PqKey, senderState = 0n) {
  console.log(`\n${label}`);
  const r = await sendViaLeanPool(d, account, calls, signer, { node: NODE_B, aggregatorNode: NODE_A, sidecar: SIDECAR, senderState });
  console.log(`  mined in block ${r.block}, frames ${r.frames}\n  ${explorerTx(r.txHash)}`);
  return { txHash: r.txHash, block: r.block, root: r.root };
}

const waitUntil = async (t: bigint) => {
  for (;;) {
    if ((await publicClient.getBlock()).timestamp >= t) return;
    await new Promise((r) => setTimeout(r, 5000));
  }
};

// ------------------------------------------------------------------------------------------ setup ----------------
console.log(`funder ${formatEther(await publicClient.getBalance({ address: funder.address }))} ETH`);
for (const g of [g1, g2, g3, g4, anyone]) await sendLegacy(funder.privateKey, { to: g.address, value: parseEther("0.003") });
const account = await createAccount(d, {
  salt: keccak256(toHex(`recovery ${owner.publicKey} ${Date.now()}`)),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator },
  keys: [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: owner.publicKey }],
  guardians: [g1.address, g2.address, g3.address], guardianThreshold: 2, recoveryDelay: DELAY_S,
  fund: parseEther("0.02"),
});
Object.assign(out, { account, recovery: d.recovery, keystore: d.keystore, anyone: anyone.address,
  guardians: { g1: g1.address, g2: g2.address, g3: g3.address, g4: g4.address },
  keys: { owner: owner.publicKey, ownerNew: ownerNew.publicKey, attacker: attacker.publicKey } });
console.log(`account ${account}: one PQ key, guardians G1 G2 G3 (2 of 3), delay ${DELAY_S}s`);

// ------------------------------------------------------------------------------------------ 1. guardian swap -----
const swap = await viaLeanPool("1. the owner replaces G2 with G4: uninstall + reinstall the recovery module in one PQ batch", account, [
  { to: account, data: encodeFunctionData({ abi: accountAbi, functionName: "uninstallModule", args: [EXECUTOR, d.recovery, "0x"] }) },
  { to: account, data: encodeFunctionData({ abi: accountAbi, functionName: "installModule", args: [EXECUTOR, d.recovery, guardianInit([g1.address, g3.address, g4.address])] }) },
], owner, 400_000n);
const g2Refused = await minedRevert("   G2 (removed) approves", g2.pk, approve(account, resetTo(attacker)));
step({ step: "guardian G2 swapped for G4; G2 refused", swapTx: swap.txHash, swapBlock: swap.block, g2ApproveReverted: g2Refused });

// ------------------------------------------------------------------------------------------ 2. hostile, cancelled -
console.log("\n2. two guardians collude: G1 + G3 approve a reset to an attacker's key");
const hostile = resetTo(attacker);
const h1 = await plainTx("G1 approve", g1.pk, d.recovery, approve(account, hostile));
const h3 = await plainTx("G3 approve", g3.pk, d.recovery, approve(account, hostile));
const hostileId = await proposalOf(account, hostile);
const hostileReady = await readyAtOf(account, hostileId);
const cancel = await viaLeanPool("   the owner, still holding the PQ key, cancels it", account,
  [{ to: d.recovery, data: encodeFunctionData({ abi: recoveryAbi, functionName: "cancel", args: [hostileId] }) }], owner);
await waitUntil(hostileReady);
const hostileExec = await minedRevert("   after the delay, anyone executes the hostile reset", anyone.pk, execute(account, hostile));
step({ step: "hostile recovery cancelled", proposalId: hostileId, approvals: [h1, h3], cancelTx: cancel.txHash, cancelBlock: cancel.block, executeAfterDelayReverted: hostileExec });

// ------------------------------------------------------------------------------------------ 3–5. lost key --------
console.log("\n3. the owner loses the PQ key; G1 + G4 approve a reset to the owner's new PQ key");
const honest = resetTo(ownerNew);
const a1 = await plainTx("G1 approve", g1.pk, d.recovery, approve(account, honest));
const a4 = await plainTx("G4 approve", g4.pk, d.recovery, approve(account, honest));
const honestId = await proposalOf(account, honest);
const readyAt = await readyAtOf(account, honestId);
console.log("\n4. executing before the delay");
const early = await minedRevert("   anyone executes early", anyone.pk, execute(account, honest));
console.log(`   ready at ${new Date(Number(readyAt) * 1000).toISOString()}; waiting`);
await waitUntil(readyAt);
console.log(`\n5. after the delay, an address with no role (${anyone.address}) executes it`);
const ex = await plainTx("anyone execute", anyone.pk, d.recovery, execute(account, honest));
const after = await pqKeysOf(d, account);
console.log(`   keystore PQ keys now (read from chain): ${after.join(", ")}`);
if (after.length !== 1 || after[0].toLowerCase() !== ownerNew.publicKey.toLowerCase()) throw new Error("the keystore does not hold exactly the new key");
step({ step: "lost key recovered", proposalId: honestId, approvals: [a1, a4], executeEarlyReverted: early, executeTx: ex, executedBy: anyone.address, pqKeysAfter: after });

// ------------------------------------------------------------------------------------------ 6. new key works -----
const spend = await viaLeanPool("6. the new PQ key spends 1 wei", account, [{ to: funder.address, value: 1n }], ownerNew);
console.log("   the lost key tries the same");
let lostRefused = "";
try {
  const plan = await buildAndSign({ d, account, nonceKey: 1n, nonceSeq: await keyedNonce(account, 1n), calls: [[{ to: funder.address, value: 1n }]], signers: [PQ(owner)] });
  await submit(plan, { node: NODE_B, sidecar: SIDECAR });
} catch (e: any) {
  lostRefused = e.message.slice(0, 300);
}
if (!lostRefused) throw new Error("LeanPool admitted the lost key");
console.log(`   refused by the LeanPool node at admission (the key is not in the keystore): ${lostRefused.slice(0, 120)}`);
step({ step: "new key spends; lost key refused by the LeanPool node", spendTx: spend.txHash, spendBlock: spend.block, lostKeyRefusedByNode: lostRefused });

const file = path.join(ROOT, "deployments", "recovery-live.json");
fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`\nwrote ${path.relative(ROOT, file)}`);
