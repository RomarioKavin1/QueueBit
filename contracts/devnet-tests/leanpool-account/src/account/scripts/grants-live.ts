/**
 * Live on the public devnet: "let someone spend from my account" (the web wallet's Spending permissions and /delegate
 * pages), driven with the same @queuebit/account functions the pages call (grantCalls, readGrant, findGrants,
 * checkGrantPayment, buildDelegatePayment, revokeGrantCalls, submit). The pages themselves need a passkey and a
 * browser wallet, so this script plays both people: a QueueBit account with a PQ owner, and a MetaMask-like delegate
 * (an EIP712 key; viem's signTypedData is eth_signTypedData_v4's encoding).
 *
 *   0. a fresh account (PQ owner, SpendingLimitHook), funded, holding test tokens
 *   1. the owner grants the delegate ETH (to one listed address) and the token (to anyone), through LeanPool
 *   2. the delegate finds the grant from the chain alone (findGrants: KeyAdded for its key id)
 *   3. the delegate pays ETH and tokens within it (frame txs to the alt mempool, the account pays the fees)  mined
 *   4. over the per-payment token cap                                     refused at admission (no fee)
 *   5. over what is left today in ETH (the hook's daily cap)              no ETH moves (SENDER reverts, or never included)
 *   6. the owner revokes; the delegate finds nothing                      mined
 *
 * Usage (from this folder; the funder key in .keys/funder.json or FUNDER_KEY): ACCOUNT_DEPLOYMENT=queuebit-public.json bun --conditions=source \
 *   src/account/scripts/grants-live.ts       (LeanPool node at LEANPOOL_NODE_URL, default http://127.0.0.1:8701)
 * Writes deployments/grants-live.json; keys stay in .keys/grants-live.json.
 */
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, createPublicClient, decodeErrorResult, encodeFunctionData, formatEther, http, keccak256, parseEther, toHex } from "viem";
import { encodeTx } from "../../../../../../packages/frames/src/index.ts";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createSidecarClient, httpTransport } from "../../../../../../packages/rpc/src/index.ts";
import * as A from "../../../../../../packages/account/src/index.ts";
import { ROOT, devnet, explorerTx, key, local } from "../../core/config.ts";
import { artifact } from "../../core/artifacts.ts";
import { rpc, sendLegacy, waitFrameReceipt } from "../../core/chain.ts";
import * as pq from "../../v2/leanpq.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { createAccount, predictAccount, sendViaLeanPool, waitSidecarSettled } from "../sdk.ts";

const dep = readAccountDeployment();
if (!dep.testToken) throw new Error("this deployment has no test token");
const TOKEN = dep.testToken;
const d: A.AccountDeployment = { chainId: devnet.chainId, ...dep };
const client = createPublicClient({ transport: http(devnet.ethrexUrl) });
const sidecar = createSidecarClient(httpTransport(local.sidecarA));
const funder = key("funder");
const AGGREGATOR: Address = "0x99Bd573ABC2E87D33429856d13712BA82203AF41"; // QueueBit's public-devnet LeanPool node
const tokenAbi = artifact("TestToken", "LegacyAccount").abi;
const hookAbi = artifact("SpendingLimitHook").abi;
const RECORD = path.join(ROOT, "deployments", "grants-live.json");
const save = () => fs.writeFileSync(RECORD, JSON.stringify(record, null, 2) + "\n");

const KEYS_FILE = path.join(ROOT, ".keys", "grants-live.json");
const secrets = {
  owner: bytesToHex(crypto.getRandomValues(new Uint8Array(32))),
  delegate: generatePrivateKey() as Hex,
  shop: privateKeyToAccount(generatePrivateKey()).address,
};
const owner = await pq.keyFromSeed(secrets.owner);
const delegate = privateKeyToAccount(secrets.delegate);
const shop: Address = secrets.shop;
const anyone: Address = privateKeyToAccount(generatePrivateKey()).address; // a token recipient nobody listed
const now = () => Math.floor(Date.now() / 1000);

const ETH_PER_PAYMENT = parseEther("0.0001");
const ETH_PER_DAY = parseEther("0.00015");
const TOK_PER_PAYMENT = parseEther("10");
const TOK_PER_DAY = parseEther("25");
const record: Record<string, unknown> = { delegate: delegate.address, shop, token: TOKEN };

// ------------------------------------------------------------------------------------------ 0. the account ------
const createOpts = {
  salt: keccak256(toHex(`grants ${owner.publicKey} ${Date.now()}`)),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator: AGGREGATOR },
  keys: [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: owner.publicKey }],
  fund: parseEther("0.01"),
};
const account = await predictAccount(dep, createOpts);
const all = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")) : {};
fs.writeFileSync(KEYS_FILE, JSON.stringify({ ...all, [account]: secrets }, null, 2), { mode: 0o600 });
await createAccount(dep, createOpts);
const mint = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [account, parseEther("1000")] });
const est = await client.estimateGas({ account: funder.address, to: TOKEN, data: mint });
await sendLegacy(funder.privateKey, { to: TOKEN, data: mint, gas: (est * 13n) / 10n });
console.log(`account ${account}, delegate ${delegate.address}, shop ${shop}`);
record.account = account;

// ------------------------------------------------------------------------------------------ 1. the grant ---------
console.log("\n1. the owner grants: ETH to the shop only, the token to anyone (through LeanPool)");
const spec: A.GrantSpec = {
  delegate: delegate.address,
  validUntil: now() + 7 * 86_400,
  eth: { perPayment: ETH_PER_PAYMENT, perDay: ETH_PER_DAY, recipients: [shop] },
  tokens: [{ token: TOKEN, perPayment: TOK_PER_PAYMENT, perDay: TOK_PER_DAY }],
};
A.validateGrant(d, account, spec, now());
const before = await A.readGrant(client, d, account, delegate.address, now());
const g1 = await sendViaLeanPool(dep, account, A.grantCalls(d, spec, before), owner, { senderGas: 600_000n, senderState: 900_000n });
console.log(`   mined in block ${g1.block}, frames ${g1.frames}\n   ${explorerTx(g1.txHash)}`);
record.grant = g1.txHash;
save();

// ------------------------------------------------------------------------------------------ 2. found -------------
console.log("\n2. the delegate finds it from the chain alone");
const show = (g: A.Grant) =>
  `account ${g.account}: ETH ${formatEther(g.eth?.perPayment ?? 0n)}/payment, ${formatEther(g.eth?.leftToday ?? 0n)} left today, to ${g.eth?.recipients.join(", ")}; ` +
  g.tokens.map((t) => `token ${formatEther(t.perPayment)}/payment, ${formatEther(t.leftToday)} left today`).join("; ") +
  `; until ${new Date(g.validUntil * 1000).toISOString()}`;
let found = await A.findGrants(client, d, delegate.address, now());
const mine = found.find((g) => g.account.toLowerCase() === account.toLowerCase());
if (!mine) throw new Error("the delegate did not find the grant");
console.log(`   ${show(mine)}`);
if (!mine.eth?.recipients.some((r) => r.toLowerCase() === shop.toLowerCase())) throw new Error("recipient not read back");

// ------------------------------------------------------------------------------------------ the delegate pays ----
async function pay(label: string, calls: A.Call[], expect: "mined" | "reverted" | "refused", check = true) {
  const g = (await A.findGrants(client, d, delegate.address, now())).find(
    (x) => x.account.toLowerCase() === account.toLowerCase(),
  )!;
  const c = A.checkGrantPayment(d, g, calls, now());
  console.log(`   ${label}: the page says ${c.ok ? "OK" : `"${c.reason}"`}`);
  if (check && !c.ok) throw new Error(`${label}: refused by the page`);
  // The public devnet's blocks are often near full: a sidecar may drop an admitted tx after a few relays. Then the
  // lane's nonce is unused, nothing was spent, and the same payment is sent again (1 wei more fee: a new hash).
  let rc: any;
  let hash: Hex = "0x";
  for (let attempt = 0; attempt < 4 && !rc; attempt++) {
    const fees = await A.paymentFees(client);
    const plan = await A.buildDelegatePayment({
      d,
      grant: g,
      calls,
      nonceSeq: await A.laneNonce(client, account, A.delegateNonceKey(delegate.address)),
      maxFeePerGas: fees.maxFeePerGas + BigInt(attempt),
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      signTypedData: (t) => delegate.signTypedData(t),
    });
    try {
      hash = ((await A.submit(plan, { sidecar })) as { txHash: Hex }).txHash;
    } catch (e) {
      const why = ((e as Error).message ?? String(e)).split("\n")[0]!.slice(0, 200);
      if (expect !== "refused") throw new Error(`${label}: refused: ${why}`);
      console.log(`   → refused at admission: ${why}`);
      return { refused: why, pageSaid: c.ok ? "ok" : c.reason };
    }
    if (expect === "refused") throw new Error(`${label}: expected a refusal, got ${hash}`);
    rc = await waitFrameReceipt(hash, 90_000).catch(() => undefined);
    if (!rc) console.log(`   (${hash} not included in 90 s; sending again)`);
  }
  if (!rc) throw new Error(`${label}: never included`);
  await waitSidecarSettled(hash, local.sidecarA); // the sidecar frees the lane a little after the block
  const frames = (rc.frameReceipts ?? []).map((f: any) => `${f.status}/${BigInt(f.gasUsed ?? "0x0")}`).join(" ");
  const ok = (rc.frameReceipts ?? []).every((f: any) => BigInt(f.status) === 1n);
  if ((expect === "mined") !== ok) throw new Error(`${label}: expected ${expect}, frames ${frames} (${hash})`);
  console.log(`   → ${expect === "mined" ? "mined" : "mined, SENDER frame reverted (the hook)"}: block ${BigInt(rc.blockNumber)}, frames ${frames}\n   ${explorerTx(hash)}`);
  return { tx: hash, block: Number(BigInt(rc.blockNumber)), frames, pageSaid: c.ok ? "ok" : c.reason };
}

console.log("\n3. the delegate pays within the grant (the account pays the fees)");
const ethBefore = await client.getBalance({ address: shop });
record.ethWithin = await pay("0.0001 ETH to the shop", [A.grantPaymentCall("ETH", shop, ETH_PER_PAYMENT)], "mined");
record.tokenWithin = await pay("10 tokens to an unlisted address", [A.grantPaymentCall(TOKEN, anyone, TOK_PER_PAYMENT)], "mined");
const shopGot = (await client.getBalance({ address: shop })) - ethBefore;
const anyoneGot = (await client.readContract({ address: TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [anyone] })) as bigint;
console.log(`   the shop got ${formatEther(shopGot)} ETH; the unlisted address got ${formatEther(anyoneGot)} tokens`);
const after = (await A.readGrant(client, d, account, delegate.address, now()));
console.log(`   now: ${show(after)}`);
save();
record.afterPayments = { ethLeftToday: after.eth?.leftToday.toString(), tokenLeftToday: after.tokens[0]?.leftToday.toString() };

console.log("\n4. over the per-payment token cap (11 > 10)");
record.overPerPayment = await pay("11 tokens", [A.grantPaymentCall(TOKEN, anyone, parseEther("11"))], "refused", false);
console.log("\n   ETH to an address the owner did not list");
record.unlistedEth = await pay("0.00001 ETH to an unlisted address", [A.grantPaymentCall("ETH", anyone, parseEther("0.00001"))], "refused", false);

console.log("\n5. over what is left today in ETH (0.0001 + 0.0001 > 0.00015): the page refuses it; sent anyway:");
record.overDaily = await overDaily();
save();

/**
 * The keystore can't read the hook's daily spend in VERIFY, so this one is admitted; the hook reverts its SENDER
 * frame in execution (DailyCapExceeded). Simulated first (the revert reason), then sent: either a block takes it
 * (mined, SENDER reverted, the account pays the fee) or the producer never includes it and the sidecar drops it.
 * Either way no ETH moves: checked on the shop's balance and the hook's record.
 */
async function overDaily() {
  const calls = [A.grantPaymentCall("ETH", shop, ETH_PER_PAYMENT)];
  const g = (await A.findGrants(client, d, delegate.address, now())).find(
    (x) => x.account.toLowerCase() === account.toLowerCase(),
  )!;
  const c = A.checkGrantPayment(d, g, calls, now());
  console.log(`   another 0.0001 ETH: the page says ${c.ok ? "OK" : `"${c.reason}"`}`);
  const shopBefore = await client.getBalance({ address: shop });
  const spentBefore = g.eth!.spentToday;
  const fees = await A.paymentFees(client);
  const plan = await A.buildDelegatePayment({
    d,
    grant: g,
    calls,
    nonceSeq: await A.laneNonce(client, account, A.delegateNonceKey(delegate.address)),
    ...fees,
    signTypedData: (t) => delegate.signTypedData(t),
  });
  const sim: any = await rpc("ethrex_simulateFrameTransaction", [encodeTx(A.LEAN_PROFILE, plan.tx), "latest", { trace: false }]).catch((e) => ({ error: String(e) }));
  const revertData: Hex | undefined = sim?.frames?.[1]?.revertData ?? sim?.revertData;
  let reason = "no revert data";
  try {
    if (revertData) {
      const e = decodeErrorResult({ abi: hookAbi, data: revertData });
      reason = `${e.errorName}(${(e.args ?? []).map(String).join(", ")})`;
    }
  } catch {
    reason = revertData!.slice(0, 10);
  }
  console.log(sim?.frames ? `   simulated: SENDER revert ${reason}` : `   (simulation unavailable: ${String(sim?.error ?? "no result").slice(0, 120)})`);
  const hash = ((await A.submit(plan, { sidecar })) as { txHash: Hex }).txHash;
  console.log(`   admitted by the sidecar: ${hash}`);
  const rc: any = await waitFrameReceipt(hash, 150_000).catch(() => undefined);
  let outcome: Record<string, unknown>;
  if (rc) {
    const frames = (rc.frameReceipts ?? []).map((f: any) => `${f.status}/${BigInt(f.gasUsed ?? "0x0")}`).join(" ");
    console.log(`   → mined, SENDER frame reverted: block ${BigInt(rc.blockNumber)}, frames ${frames}\n   ${explorerTx(hash)}`);
    outcome = { tx: hash, block: Number(BigInt(rc.blockNumber)), frames };
  } else {
    const st = await sidecar.frameTransactionStatus(hash).catch(() => null);
    console.log(`   → never included; the sidecar says ${st?.status ?? "unknown"}`);
    outcome = { tx: hash, included: false, sidecarStatus: st?.status ?? "unknown" };
  }
  const shopAfter = await client.getBalance({ address: shop });
  const spentAfter = (await A.readGrant(client, d, account, delegate.address, now())).eth!.spentToday;
  console.log(`   the shop's balance changed by ${formatEther(shopAfter - shopBefore)} ETH; spent today ${formatEther(spentBefore)} → ${formatEther(spentAfter)}`);
  if (shopAfter !== shopBefore || spentAfter !== spentBefore) throw new Error("the over-limit payment moved ETH");
  return { ...outcome, pageSaid: c.ok ? "ok" : c.reason, simulatedRevert: reason };
}

// ------------------------------------------------------------------------------------------ 6. revoke ----------
console.log("\n6. the owner revokes");
const cur = await A.readGrant(client, d, account, delegate.address, now());
const r = await sendViaLeanPool(dep, account, A.revokeGrantCalls(d, cur), owner, { senderGas: 300_000n, senderState: 200_000n });
console.log(`   mined in block ${r.block}, frames ${r.frames}\n   ${explorerTx(r.txHash)}`);
record.revoke = r.txHash;
found = await A.findGrants(client, d, delegate.address, now());
const gone = !found.some((g) => g.account.toLowerCase() === account.toLowerCase());
const left = await A.readGrant(client, d, account, delegate.address, now());
console.log(`   the delegate finds it: ${gone ? "no" : "yes"}; targets still allowed: ${left.targets.length}; token caps left: ${left.tokens.length}`);
if (!gone || left.targets.length || left.tokens.length) throw new Error("revoke left something behind");
record.revokedClean = true;

save();
console.log("\nwrote deployments/grants-live.json");
