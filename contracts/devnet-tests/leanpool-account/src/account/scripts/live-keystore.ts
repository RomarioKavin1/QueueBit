/**
 * Live on the devnet: one LeanAccount whose keystore holds two post-quantum keys, a device P256 key and a passkey.
 *
 *   keys     PQ-A (admin + spend), PQ-B (admin), device P256 (admin + spend), passkey (spend)
 *   policy   spend: 1 signer; admin: 2 signers, at least one PQ (requirePQ)
 *
 *   1. spend, device P256 key alone      protocol-verified P256 entry; straight to the alt mempool
 *   2. spend, PQ-A alone                 leanSPHINCS through LeanPool (one dependency)
 *   3. admin, PQ-A + device key          batch: add a session key (funder only, 1000 wei per tx) + its daily cap
 *   4. spend, session key alone          within its allowlist, per-tx cap and daily cap (SpendingLimitHook)
 *   5. batch spend, PQ-A                 two calls in one execute
 *   6. admin, PQ-A + PQ-B                rotate PQ-B to PQ-C: two dependencies, one witness with two Merkle proofs
 *   7. admin, PQ-A + PQ-C                revoke the session key: the rotated-in key signs
 *   8. admin, PQ-A + PQ-B (rotated out)  refused by the LeanPool node: PQ-B is no longer in the keystore
 *   9. admin, device key alone           refused by the alt mempool: below the threshold, no PQ signer
 *  10. spend, passkey (WebAuthn)         verified in VERIFY with SHA256 + P256VERIFY: refused while the devnet's
 *                                        sidecars list no precompiles (ERC-7562 OP-041 allows them)
 * Then waits for each batch's recursive STARK hash on-chain.
 *
 * Usage: bun ts/account/scripts/live-keystore.ts   (LeanPool nodes and sidecars running: ./run-nodes-v2.sh)
 * Writes deployments/account-live.json (addresses and tx hashes; the keys stay in .keys/account-live.json).
 */
import fs from "node:fs";
import path from "node:path";
import { p256 } from "@noble/curves/p256";
import { bytesToHex, encodeFunctionData, hexToBytes, keccak256, parseEther, toHex } from "viem";
import type { Address, Hex } from "viem";
import { ROOT, explorerTx, key } from "../../core/config.ts";
import { artifact } from "../../core/artifacts.ts";
import { keyedNonce, sendFrameTx, sendRawCanonical, waitFrameReceipt } from "../../core/chain.ts";
import * as pq from "../../v2/leanpq.ts";
import { nodeRpc } from "../../v2/sdk.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { addrKey, buildAndSign, createAccount, keyArg, keyIdOf, keystoreCall, p256Address, submit, waitLeanPoolTx, waitSidecarSettled } from "../sdk.ts";
import type { Signer, TxPlan } from "../sdk.ts";
import { publicKeyXY, softSign } from "../webauthn.ts";
import { local } from "../../core/config.ts";

/** LeanPool node A aggregates (its status lists the batches); txs enter through node B, as a wallet's would. */
const NODE_A = local.nodeA;
const NODE_B = local.nodeB;
const SIDECAR = local.sidecarA;
const RP = "localhost";
const ORIGIN = "http://localhost:8787";
const d = readAccountDeployment();

// ------------------------------------------------------------------------------------------ keys (kept local) ----
const KEYS_FILE = path.join(ROOT, ".keys", "account-live.json");
const rand = () => bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const secrets: { pqA: Hex; pqB: Hex; passkey: Hex; p256: Hex; device?: Hex; pqC?: Hex } = fs.existsSync(KEYS_FILE)
  ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf8"))
  : { pqA: rand(), pqB: rand(), passkey: bytesToHex(p256.utils.randomPrivateKey()), p256: bytesToHex(p256.utils.randomPrivateKey()) };
secrets.device ??= bytesToHex(p256.utils.randomPrivateKey());
secrets.pqC ??= rand();
fs.writeFileSync(KEYS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });

const pqA = await pq.keyFromSeed(secrets.pqA);
const pqB = await pq.keyFromSeed(secrets.pqB);
const pqC = await pq.keyFromSeed(secrets.pqC);
const passkeyPriv = hexToBytes(secrets.passkey);
const pk = publicKeyXY(passkeyPriv);
const passkeyId = keyIdOf(KIND.PASSKEY, pk.x, pk.y);
const sessionKey = publicKeyXY(hexToBytes(secrets.p256));
const devicePriv = hexToBytes(secrets.device);
const device = publicKeyXY(devicePriv);
const deviceAddr = p256Address(device.x, device.y);

const PQ = (k: pq.PqKey): Signer => ({ kind: "PQ", vk: k.publicKey, sign: (m) => k.sign(m) });
const DEVICE: Signer = { kind: "P256", privateKey: devicePriv };
const SESSION: Signer = { kind: "P256", privateKey: hexToBytes(secrets.p256) };
const PASSKEY: Signer = { kind: "PASSKEY", keyId: passkeyId, sign: async (challenge) => softSign(passkeyPriv, challenge, RP, ORIGIN) };

// ------------------------------------------------------------------------------------------ the account ---------
const aggregator = key("aggregator").address;
const account = await createAccount(d, {
  salt: keccak256(toHex(`keystore ${pqA.publicKey} ${pqB.publicKey} ${deviceAddr} ${passkeyId} ${Date.now()}`)), // a fresh account per run
  policy: { adminThreshold: 2, spendThreshold: 1, requirePQ: true, aggregator },
  keys: [
    { kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: pqA.publicKey },
    { kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN, a: pqB.publicKey },
    { kind: KIND.P256, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: addrKey(deviceAddr) },
    { kind: KIND.PASSKEY, weight: 1, roles: ROLE.SPEND, a: pk.x, b: pk.y },
  ],
  fund: parseEther("0.05"),
});
console.log(`account ${account}`);
console.log(`  PQ-A    ${pqA.publicKey}\n  PQ-B    ${pqB.publicKey}\n  device  ${deviceAddr} (P256)\n  passkey ${passkeyId} (WebAuthn)`);

// ------------------------------------------------------------------------------------------ sending -------------
const LANE = 1n;
const out: Record<string, any>[] = [];

async function build(calls: { to: Address; value?: bigint; data?: Hex }[], signers: Signer[], senderState = 0n, senderGas?: bigint): Promise<TxPlan> {
  return buildAndSign({ d, account, nonceKey: LANE, nonceSeq: await keyedNonce(account, LANE), calls: [calls], signers, senderState, senderGas });
}

async function run(label: string, plan: TxPlan) {
  console.log(`\n${label}`);
  const sent = await submit(plan, { node: NODE_B, sidecar: SIDECAR });
  let txHash: Hex;
  const rec: Record<string, unknown> = { label };
  if (sent.via === "leanpool") {
    console.log(`  LeanPool admitted ${sent.poolTx}; waiting for its batch`);
    const r = await waitLeanPoolTx(sent.poolTx, { aggregatorNode: NODE_A });
    txHash = r.txHash;
    Object.assign(rec, { poolTx: sent.poolTx, root: r.root, rootPostTx: r.postTx });
    console.log(`  batch root ${r.root} (postRoot ${r.postTx})`);
  } else {
    txHash = sent.txHash;
    console.log(`  alt mempool admitted ${txHash}`);
  }
  const rc = await waitFrameReceipt(txHash, 240_000);
  const frames = (rc.frameReceipts ?? []).map((f: any) => ({ status: f.status, gas: Number(BigInt(f.gasUsed)) }));
  Object.assign(rec, { txHash, block: Number(BigInt(rc.blockNumber)), status: rc.status, gasUsed: Number(BigInt(rc.gasUsed)), verifyGas: frames[0]?.gas, frames });
  console.log(`  mined in block ${rec.block}, status ${rc.status}, gas ${rec.gasUsed} (VERIFY ${rec.verifyGas}); frames ${frames.map((f) => `${f.status}/${f.gas}`).join(" ")}`);
  console.log(`  ${explorerTx(txHash)}`);
  if (BigInt(rc.status) !== 1n || frames.some((f) => BigInt(f.status) !== 1n)) throw new Error(`${label}: not every frame succeeded`);
  await waitSidecarSettled(txHash, SIDECAR);
  out.push(rec);
  return rec;
}

const funder = key("funder").address;

async function refused(label: string, send: () => Promise<unknown>) {
  console.log(`\n${label}`);
  try {
    await send();
  } catch (e: any) {
    console.log(`  refused: ${e.message.slice(0, 200)}`);
    out.push({ label, refused: e.message.slice(0, 300) });
    return;
  }
  throw new Error(`${label}: it was admitted`);
}
const toSidecar = (plan: TxPlan) => () => sendFrameTx(plan.tx, SIDECAR);

// 1. the device P256 key spends alone
const p1 = await build([{ to: funder, value: 1n }], [DEVICE]);
try {
  await sendRawCanonical(p1.tx);
  console.log("canonical mempool accepted a keystore tx?!");
} catch (e: any) {
  console.log(`canonical mempool: REJECTED (${e.message.match(/StorageReadNonSender/)?.[0] ?? e.message.slice(0, 120)})`);
}
await run("1. spend 1 wei, device P256 key alone (native entry)", p1);

// 2. PQ-A spends alone
await run("2. spend 1 wei, PQ-A alone (leanSPHINCS via LeanPool)", await build([{ to: funder, value: 1n }], [PQ(pqA)]));

// 3. admin batch: add a session key and give it a daily cap, signed by PQ-A + the device key
const session = { kind: KIND.P256, weight: 1, roles: ROLE.SESSION, perTxCap: 1000n, a: addrKey(p256Address(sessionKey.x, sessionKey.y)), sessionTargets: [funder] };
const sessionId = keyIdOf(KIND.P256, session.a);
const setCap = { to: d.hook, data: encodeFunctionData({ abi: artifact("SpendingLimitHook").abi, functionName: "setDailyCap", args: [sessionId, 1500n] }) };
await run("3. admin batch: add a session key + its daily cap of 1500 wei, signed by PQ-A + device key",
  await build([keystoreCall(d, "addKey", [keyArg(session)]), setCap], [PQ(pqA), DEVICE], 800_000n, 300_000n));

// 4. the session key spends within its limits
await run("4. spend 600 wei to the funder, session key alone (allowlist, per-tx cap, daily cap)", await build([{ to: funder, value: 600n }], [SESSION], 200_000n));

// 5. batch spend
await run("5. batch: two transfers in one execute, PQ-A", await build([{ to: funder, value: 1n }, { to: funder, value: 2n }], [PQ(pqA)]));

// 6. rotate PQ-B to PQ-C, signed by PQ-A + PQ-B
const pqCKey = { kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN, a: pqC.publicKey };
await run("6. admin: rotate PQ-B to PQ-C, signed by PQ-A + PQ-B (two PQ dependencies)", await build(
  [keystoreCall(d, "rotateKey", [keyIdOf(KIND.PQ, pqB.publicKey), keyArg(pqCKey)])], [PQ(pqA), PQ(pqB)], 600_000n));

// 7. the rotated-in key signs an admin action
await run("7. admin: revoke the session key, signed by PQ-A + PQ-C (the rotated-in key)", await build(
  [keystoreCall(d, "removeKey", [sessionId])], [PQ(pqA), PQ(pqC)], 100_000n));

// 8. the rotated-out key: the LeanPool node refuses it at intake
const p8 = await build([keystoreCall(d, "removeKey", [keyIdOf(KIND.P256, addrKey(deviceAddr))])], [PQ(pqA), PQ(pqB)], 100_000n);
await refused("8. admin signed by PQ-A + PQ-B after the rotation (expected: refused by LeanPool)", () => submit(p8, { node: NODE_B }));

// 9. an admin action with one non-PQ key
await refused("9. admin with the device key alone (expected: refused by the alt mempool)",
  toSidecar(await build([keystoreCall(d, "removeKey", [keyIdOf(KIND.PQ, pqC.publicKey)])], [DEVICE], 100_000n)));

// 10. passkey (WebAuthn) spend
await refused("10. spend with the passkey (WebAuthn: SHA256 + P256VERIFY precompiles in VERIFY)", toSidecar(await build([{ to: funder, value: 1n }], [PASSKEY])));

// Each LeanPool batch's recursive STARK: its keccak256 is attached on-chain by the aggregator.
console.log("\nwaiting for each batch's recursive STARK hash on-chain");
const roots = out.filter((r) => r.root).map((r) => r.root as Hex);
const end = Date.now() + 15 * 60_000;
while (Date.now() < end) {
  const s = await nodeRpc(NODE_A, "leanpool_status");
  const proven = new Map<string, Hex>(s.batches.filter((b: any) => b.proofHash).map((b: any) => [b.root.toLowerCase(), b.proofHash]));
  for (const r of out) if (r.root && proven.has((r.root as string).toLowerCase())) r.proofHash = proven.get((r.root as string).toLowerCase());
  if (roots.every((root) => proven.has(root.toLowerCase()))) break;
  await new Promise((r) => setTimeout(r, 10_000));
}
for (const r of out.filter((x) => x.root)) console.log(`  ${r.label.slice(0, 3)} root ${r.root} STARK hash ${r.proofHash ?? "(not yet)"}`);

const file = path.join(ROOT, "deployments", "account-live.json");
fs.writeFileSync(file, JSON.stringify({ at: new Date().toISOString(), account, keys: { pqA: pqA.publicKey, pqB: pqB.publicKey, pqC: pqC.publicKey, device: deviceAddr, passkeyId, passkey: pk }, txs: out }, null, 2) + "\n");
console.log(`\nwrote ${path.relative(ROOT, file)}`);
