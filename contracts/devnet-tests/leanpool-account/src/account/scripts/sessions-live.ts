/**
 * Live on the devnet: a plain LeanAccount (PQ owner, no vault) with a MetaMask-style session key. The session key is
 * an EIP712 key: it signs typed data `LeanAccountTx(sigHash, calls)`, exactly what MetaMask's eth_signTypedData_v4
 * produces (viem's signTypedData here). Every tx is a frame tx; session txs need no LeanPool.
 *
 *   0. owner (PQ, via LeanPool) sets the session's caps: ETH per tx (at creation) and per day, token per tx and per day
 *   1. session pays ETH within its caps                          mined
 *   2. session pays tokens within its caps                       mined
 *   3. session pays tokens again, over the daily token cap       mined, SENDER frame reverted (the hook)
 *   4. session tries approve / an uncapped token / over the per-tx token cap / calls MetaMask did not show
 *                                                                refused at admission (VERIFY)
 *
 * Usage: bun ts/account/scripts/sessions-live.ts   (LeanPool nodes and sidecars running)
 * Writes deployments/sessions-live.json; keys stay in .keys/sessions-live.json.
 */
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, decodeErrorResult, encodeFunctionData, formatEther, keccak256, parseEther, toHex } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ROOT, explorerTx, key, local } from "../../core/config.ts";
import { artifact } from "../../core/artifacts.ts";
import { keyedNonce, publicClient, rpc, sendFrameTx, sendLegacy, waitFrameReceipt } from "../../core/chain.ts";
import { encodeRaw } from "../../core/frameTx.ts";
import * as pq from "../../v2/leanpq.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { addrKey, buildAndSign, createAccount, keyIdOf, predictAccount, sendViaLeanPool, typedTx, waitSidecarSettled } from "../sdk.ts";
import type { Call, Signer } from "../sdk.ts";

const d = readAccountDeployment();
if (!d.testToken) throw new Error("deploy the fixtures first (ts/account/scripts/deploy.ts)");
const funder = key("funder");
// SESSIONS_RESUME=<account>: continue with step 4 on an account an earlier run created (its keys are in KEYS_FILE).
const RESUME = process.env.SESSIONS_RESUME as Address | undefined;
const saved = RESUME ? JSON.parse(fs.readFileSync(path.join(ROOT, ".keys", "sessions-live.json"), "utf8"))[RESUME] : undefined;
if (RESUME && !saved) throw new Error(`no saved keys for ${RESUME}`);
const shop: Address = saved?.shop ?? privateKeyToAccount(generatePrivateKey()).address; // where the session pays
const tokenAbi = artifact("TestToken", "LegacyAccount").abi; // TestToken(symbol, decimals)
const hookAbi = artifact("SpendingLimitHook").abi;
const ksAbi = artifact("KeystoreValidator").abi;
const KEYS_FILE = path.join(ROOT, ".keys", "sessions-live.json");
const secrets = saved ?? { owner: bytesToHex(crypto.getRandomValues(new Uint8Array(32))), metamask: generatePrivateKey() as Hex, shop };
/** Every run's keys are kept, by account, before the account is funded (a failed run must not strand its ETH). */
function saveKeys(account: Address) {
  const all = fs.existsSync(KEYS_FILE) ? JSON.parse(fs.readFileSync(KEYS_FILE, "utf8")) : {};
  all[account] = secrets;
  fs.writeFileSync(KEYS_FILE, JSON.stringify(all, null, 2), { mode: 0o600 });
}

const owner = await pq.keyFromSeed(secrets.owner);
const metamask = privateKeyToAccount(secrets.metamask);
const sid = keyIdOf(KIND.EIP712, addrKey(metamask.address));
const MM: Signer = { kind: "EIP712", keyId: sid, signTypedData: (t) => metamask.signTypedData(t) };
const ETH_PER_TX = parseEther("0.0001");
const ETH_PER_DAY = parseEther("0.00015");
const TOK_PER_TX = parseEther("100");
const TOK_PER_DAY = parseEther("150");

// ------------------------------------------------------------------------------------------ the account ---------
const createOpts = {
  salt: keccak256(toHex(`sessions ${owner.publicKey} ${metamask.address} ${Date.now()}`)),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator: key("aggregator").address },
  keys: [
    { kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: owner.publicKey },
    {
      kind: KIND.EIP712, weight: 1, roles: ROLE.SESSION, a: addrKey(metamask.address),
      validUntil: Math.floor(Date.now() / 1000) + 86_400, perTxCap: ETH_PER_TX, sessionTargets: [shop, d.testToken],
    },
  ],
  fund: parseEther("0.006"),
};
const account: Address = RESUME ?? (await predictAccount(d, createOpts));
if (!RESUME) {
  saveKeys(account);
  await createAccount(d, createOpts);
}
if (!RESUME) {
const est = await publicClient.estimateGas({ account: funder.address, to: d.testToken, data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [account, parseEther("1000")] }) });
await sendLegacy(funder.privateKey, { to: d.testToken, data: encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [account, parseEther("1000")] }), gas: (est * 13n) / 10n });
}
console.log(`account ${account}: PQ owner ${owner.publicKey.slice(0, 18)}…, MetaMask session key ${metamask.address}, shop ${shop}`);

const RECORD_FILE = path.join(ROOT, "deployments", "sessions-live.json");
// A resumed run adds to the record of the run that created the account (steps 0-3 stay).
const record: Record<string, unknown> = {
  ...(RESUME && fs.existsSync(RECORD_FILE) ? JSON.parse(fs.readFileSync(RECORD_FILE, "utf8")) : {}),
  account, sessionKey: metamask.address, keyId: sid, shop, token: d.testToken, deployment: d,
};
const tokenBal = async (a: Address) => (await publicClient.readContract({ address: d.testToken!, abi: tokenAbi, functionName: "balanceOf", args: [a] })) as bigint;
const transfer = (amount: bigint, token: Address = d.testToken!): Call => ({ to: token, data: encodeFunctionData({ abi: tokenAbi, functionName: "transfer", args: [shop, amount] }) });

// ------------------------------------------------------------------------------------------ 0. owner sets caps --
if (!RESUME) {
console.log("\n0. the owner (PQ, through LeanPool) sets the session's daily ETH cap and its token caps");
const caps = await sendViaLeanPool(d, account, [
  { to: d.keystore, data: encodeFunctionData({ abi: ksAbi, functionName: "setSessionToken", args: [sid, d.testToken, TOK_PER_TX] }) },
  { to: d.hook, data: encodeFunctionData({ abi: hookAbi, functionName: "setTokenDailyCap", args: [sid, d.testToken, TOK_PER_DAY] }) },
  { to: d.hook, data: encodeFunctionData({ abi: hookAbi, functionName: "setDailyCap", args: [sid, ETH_PER_DAY] }) },
], owner, { senderState: 600_000n });
console.log(`   mined in block ${caps.block}, frames ${caps.frames}\n   ${explorerTx(caps.txHash)}`);
record.ownerSetsCaps = caps.txHash;
}

function decodeHookError(data: Hex): string {
  try {
    const e = decodeErrorResult({ abi: hookAbi, data });
    return `${e.errorName}(${(e.args ?? []).map(String).join(", ")})`;
  } catch {
    return data.slice(0, 10);
  }
}

/** A session tx straight to the alt mempool (protocol-free: the keystore checks the typed signature in VERIFY). */
async function session(label: string, calls: Call[], o: { expect: "mined" | "reverted" | "refused"; signer?: Signer }) {
  // State gas on this devnet: the hook's first spend records and a payment to a new address create state (a payment
  // to a fresh address measured 281,520 state gas). The account must hold the tx's maximum cost (all limits x fee),
  // or the producer keeps skipping it: limits sized to the need, not padded.
  const plan = await buildAndSign({ d, account, nonceKey: 2n, nonceSeq: await keyedNonce(account, 2n), calls: [calls], signers: [o.signer ?? MM], senderGas: 300_000n, senderState: 400_000n });
  const sim: any = await rpc("ethrex_simulateFrameTransaction", [encodeRaw(plan.tx), "latest", { trace: false }]).catch(() => null);
  const verifyGas = sim?.frames?.[0]?.gasUsed ? BigInt(sim.frames[0].gasUsed) : undefined;
  const balance = await publicClient.getBalance({ address: account });
  if (sim?.maxCost && BigInt(sim.maxCost) > balance) throw new Error(`${label}: max cost ${formatEther(BigInt(sim.maxCost))} ETH > the account's ${formatEther(balance)}`);
  let hash: Hex;
  try {
    hash = await sendFrameTx(plan.tx, local.sidecarA);
  } catch (e: any) {
    if (o.expect !== "refused") throw new Error(`${label}: refused: ${e.message}`);
    const why = (e.message as string).split("\n")[0].slice(0, 160);
    console.log(`   ${label} → refused at admission: ${why}`);
    return { refused: why };
  }
  if (o.expect === "refused") throw new Error(`${label}: expected a refusal, got ${hash}`);
  const rc = await waitFrameReceipt(hash, 240_000);
  const frames = (rc.frameReceipts ?? []).map((f: any) => `${f.status}/${BigInt(f.gasUsed ?? "0x0")}`).join(" ");
  const senderOk = (rc.frameReceipts ?? []).every((f: any) => BigInt(f.status) === 1n);
  if ((o.expect === "mined") !== senderOk) throw new Error(`${label}: expected ${o.expect}, frames ${frames}`);
  // Why a SENDER frame reverted, from the pre-send simulation (receipts carry no revert data).
  const revertData: Hex | undefined = sim?.frames?.[1]?.revertData ?? sim?.revertData ?? undefined;
  const why = o.expect === "reverted" && revertData ? decodeHookError(revertData) : undefined;
  console.log(`   ${label} → ${o.expect === "mined" ? "mined" : `mined, SENDER frame reverted${why ? ` (${why})` : ""}`}: block ${BigInt(rc.blockNumber)}, frames ${frames}${verifyGas ? `, VERIFY ${verifyGas}` : ""}\n   ${explorerTx(hash)}`);
  await waitSidecarSettled(hash, local.sidecarA);
  return { tx: hash, block: Number(BigInt(rc.blockNumber)), frames, ...(why ? { reason: why } : {}) };
}

if (!RESUME) {
console.log("\n1. the session (MetaMask typed signature) pays ETH within its caps");
record.ethWithinCaps = await session("0.0001 ETH to the shop", [{ to: shop, value: ETH_PER_TX }], { expect: "mined" });

console.log("\n2. the session pays tokens within its caps");
record.tokensWithinCaps = await session("100 MTT to the shop", [transfer(TOK_PER_TX)], { expect: "mined" });

console.log("\n3. again: 100 more MTT today would be 200 > the daily 150");
record.overDailyTokenCap = await session("100 MTT more", [transfer(TOK_PER_TX)], { expect: "reverted" });
const recorded = ((await publicClient.readContract({ address: d.hook, abi: hookAbi, functionName: "tokenLimitOf", args: [account, sid, d.testToken] })) as any).spent as bigint;
console.log(`   the shop holds ${formatEther(await tokenBal(shop))} MTT; the hook recorded ${formatEther(recorded)} today`);
record.hookTokenSpentToday = recorded.toString();

}
if (RESUME) record.resumedAt = "step 4 (steps 0-3 ran on this account in the previous run)";

console.log("\n4. refused before any fee is spent");
const approve: Call = { to: d.testToken, data: encodeFunctionData({ abi: tokenAbi, functionName: "approve", args: [shop, parseEther("1000")] }) };
record.approveRefused = await session("approve(shop, 1000 MTT)", [approve], { expect: "refused" });
record.overPerTxRefused = await session("101 MTT in one tx (per-tx cap 100)", [transfer(parseEther("101"))], { expect: "refused" });
// The shop is allowlisted (for ETH) but has no token cap: a transfer call to it is refused, so forgetting a cap fails closed.
record.uncappedTokenRefused = await session("transfer() on an allowlisted target with no token cap", [transfer(1n, shop)], { expect: "refused" });
const lying: Signer = { kind: "EIP712", keyId: sid, signTypedData: (t) => metamask.signTypedData(typedTx(account, t.message.sigHash, [{ to: shop, value: 1n }])) };
record.tamperedCallsRefused = await session("MetaMask shown 1 wei, the tx sends 0.0001 ETH", [{ to: shop, value: ETH_PER_TX }], { expect: "refused", signer: lying });

const shopEth = await publicClient.getBalance({ address: shop });
const shopTok = await tokenBal(shop);
console.log(`\nshop: ${formatEther(shopEth)} ETH, ${formatEther(shopTok)} MTT`);
record.shopFinal = { eth: shopEth.toString(), tokens: shopTok.toString() };
fs.writeFileSync(RECORD_FILE, JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log("wrote deployments/sessions-live.json");
