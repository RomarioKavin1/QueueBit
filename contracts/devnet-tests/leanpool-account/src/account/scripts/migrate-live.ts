/**
 * Live on the devnet: every migration rail into a LeanAccount, each proved by chain reads and a PQ spend through
 * LeanPool afterwards.
 *
 *   A. migrateEOA, move (default)   a new LeanAccount; the EOA's tokens, then its ETH, arrive there
 *   B. migrateEOA, 7702             same address; plus: a relayer holding an EOA's authorization cannot install its own
 *                                   keys (mined revert), and the ECDSA key still sends txs (no EIP-7851 here)
 *   C. migrateSA, upgradeable       an ERC-1967/UUPS account upgrades in place: same address, nothing moves, the old
 *                                   owner's execute is gone (mined revert)
 *   D. migrateSA, not upgradeable   one tx from the old account: tokens + ETH into a new LeanAccount
 *
 * Usage: bun ts/account/scripts/migrate-live.ts   (LeanPool nodes and sidecars running: ./run-nodes-v2.sh)
 * Writes deployments/migration-live.json; keys stay in .keys/migration-live.json.
 */
import fs from "node:fs";
import path from "node:path";
import { bytesToHex, encodeDeployData, encodeFunctionData, formatEther, keccak256, parseEther, toFunctionSelector, toHex } from "viem";
import type { Address, Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ROOT, explorerTx, key } from "../../core/config.ts";
import { artifact } from "../../core/artifacts.ts";
import { publicClient, sendLegacy, walletClient } from "../../core/chain.ts";
import * as pq from "../../v2/leanpq.ts";
import { readAccountDeployment, KIND, ROLE } from "../config.ts";
import { pqKeysOf, sendViaLeanPool } from "../sdk.ts";
import type { CreateOptions } from "../sdk.ts";
import { classifyCode, implementationOf, plainFees, initializeData, legacyAccountSender, migrateEOA, migrateSA, tokenBalances } from "../migrate.ts";

const d = readAccountDeployment();
if (!d.testToken || !d.legacyImplementation) throw new Error("run ts/account/scripts/deploy.ts first (migration fixtures)");
const TOKEN = d.testToken;
const funder = key("funder");
const aggregator = key("aggregator").address;
const legacyAbi = artifact("LegacyAccount").abi;
const tokenAbi = artifact("TestToken", "LegacyAccount").abi;
const FUND = parseEther("0.0007"); // covers a LeanPool tx's reserve (~250k gas at 2 gwei)
const GAS_ONLY = parseEther("0.0001"); // owner keys that only send plain txs
const TOKENS = parseEther("1000");

const secrets: Record<string, Hex> = {};
const record: Record<string, unknown> = { network: "alt-mempool devnet", deployment: d };
const KEYS_FILE = path.join(ROOT, ".keys", "migration-live.json");
const saveKeys = () => fs.writeFileSync(KEYS_FILE, JSON.stringify(secrets, null, 2), { mode: 0o600 });
const fresh = (name: string) => ((secrets[name] = generatePrivateKey()), saveKeys(), secrets[name]);
async function pqKey(name: string) {
  secrets[name] = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
  saveKeys();
  return pq.keyFromSeed(secrets[name]);
}
const targetFor = (k: pq.PqKey, label: string): CreateOptions => ({
  salt: keccak256(toHex(`migration ${label} ${k.publicKey} ${Date.now()}`)),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator },
  keys: [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: k.publicKey }],
});

const eth = (a: Address) => publicClient.getBalance({ address: a });
const mtt = async (a: Address) => (await tokenBalances(a, [TOKEN]))[0].balance;
/** Prints and returns an address's ETH and MTT balances (read from chain). */
async function show(label: string, a: Address) {
  const b = { eth: await eth(a), mtt: await mtt(a) };
  console.log(`   ${label} ${a}: ${formatEther(b.eth)} ETH, ${formatEther(b.mtt)} MTT`);
  return b;
}
function check(ok: boolean, what: string) {
  if (!ok) throw new Error(`check failed: ${what}`);
}
async function mint(to: Address) {
  const data = encodeFunctionData({ abi: tokenAbi, functionName: "mint", args: [to, TOKENS] });
  const est = await publicClient.estimateGas({ account: funder.address, to: TOKEN, data }); // new slots cost state gas here
  return sendLegacy(funder.privateKey, { to: TOKEN, data, gas: (est * 13n) / 10n });
}

/** A tx expected to revert: sent with a fixed gas limit (estimation would refuse it) and checked to be mined failed. */
async function minedRevert(label: string, privateKey: Hex, to: Address, data: Hex, extra: Record<string, unknown> = {}) {
  let reason = "reverted";
  try {
    await publicClient.call({ account: privateKeyToAccount(privateKey).address, to, data, ...extra } as any);
  } catch (e: any) {
    reason = e.shortMessage?.split("\n")[0] ?? e.message.slice(0, 120);
    const sel = /0x[0-9a-f]{8}\b/.exec(reason)?.[0];
    const named = sel && [...artifact("LeanAccount").abi, ...legacyAbi].find((x: any) => x.type === "error" && toFunctionSelector(`${x.name}(${x.inputs.map((i: any) => i.type).join(",")})`) === sel);
    if (named) reason = (named as any).name;
  }
  const w = walletClient(privateKey);
  const hash = await w.sendTransaction({ to, data, gas: 1_000_000n, ...(await plainFees()), ...extra } as any);
  const rc = await publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (rc.status !== "reverted") throw new Error(`${label}: expected a revert, got ${rc.status} (${hash})`);
  console.log(`   ${label} → reverted on chain (${reason}): ${hash} (block ${rc.blockNumber})`);
  return { tx: hash, block: Number(rc.blockNumber), reason };
}

async function pqSpend(label: string, account: Address, k: pq.PqKey) {
  const r = await sendViaLeanPool(d, account, [{ to: funder.address, value: 1n }], k); // local nodes A/B + sidecar A
  console.log(`   ${label}: PQ key spends 1 wei through LeanPool, block ${r.block}, frames ${r.frames}\n   ${explorerTx(r.txHash)}`);
  return r;
}

console.log(`funder ${formatEther(await eth(funder.address))} ETH; token ${TOKEN}`);

// ------------------------------------------------------------------------------------------ A. EOA, move ----------
{
  console.log("\nA. migrateEOA (move, the default): a new LeanAccount");
  const eoaKey = fresh("A_eoa");
  const eoa = privateKeyToAccount(eoaKey).address;
  await sendLegacy(funder.privateKey, { to: eoa, value: FUND });
  await mint(eoa);
  const before = await show("before: EOA", eoa);
  const owner = await pqKey("A_pq");
  const r = await migrateEOA(d, { privateKey: eoaKey, target: targetFor(owner, "A"), tokens: [TOKEN] }); // default mode
  console.log(`   migration txs: ${r.txs.join(", ")}`);
  check(r.mode === "move", "A: the default EOA mode is move");
  const src = await show("after:  EOA", eoa);
  const dst = await show("after:  LeanAccount", r.account);
  check(dst.mtt === TOKENS && src.mtt === 0n, "A: all tokens moved");
  check(dst.eth > 0n && dst.eth + src.eth < before.eth && src.eth < before.eth / 100n, "A: the ETH moved (dust < 1% stays as the gas refund)");
  check((await pqKeysOf(d, r.account)).includes(owner.publicKey), "A: the keystore holds the PQ key");
  const spend = await pqSpend("A", r.account, owner);
  record.A = { eoa, account: r.account, migrationTxs: r.txs, before, eoaAfter: src, accountAfter: dst, pqSpend: spend.txHash };
}

// ------------------------------------------------------------------------------------------ B. EOA, 7702 ----------
{
  console.log("\nB. migrateEOA (7702): same address");
  const eoaKey = fresh("B_eoa");
  const eoa = privateKeyToAccount(eoaKey).address;
  await sendLegacy(funder.privateKey, { to: eoa, value: FUND });
  await mint(eoa);
  const before = await show("before: EOA", eoa);
  const owner = await pqKey("B_pq");
  const r = await migrateEOA(d, { privateKey: eoaKey, target: targetFor(owner, "B"), mode: "7702" });
  const code = await publicClient.getCode({ address: eoa });
  console.log(`   migration tx: ${r.txs[0]}; code at ${eoa}: ${code}`);
  check(classifyCode(code).kind === "7702" && r.account === eoa, "B: delegated, same address");
  const after = await show("after:  same address", eoa);
  check(after.mtt === TOKENS && after.eth > (before.eth * 9n) / 10n, "B: nothing moved (only the migration's gas spent)");
  const keys = await pqKeysOf(d, eoa);
  console.log(`   keystore PQ keys: ${keys.join(", ")}`);
  check(keys.length === 1 && keys[0] === owner.publicKey, "B: the keystore holds exactly the owner's PQ key");
  const spend = await pqSpend("B", eoa, owner);
  const reinit = await minedRevert("a third party re-initializes it with its own key", funder.privateKey, eoa, initializeData(d, targetFor(await pqKey("B_attacker"), "B2")));

  // The front-running case: a relayer holds C's authorization (signed for a gasless migration) and submits it with its
  // own initialize. The delegation lands, but initialize is refused: a delegated EOA initializes only from itself.
  const cKey = fresh("B_victim");
  const c = privateKeyToAccount(cKey).address;
  await sendLegacy(funder.privateKey, { to: c, value: GAS_ONLY });
  const cw = walletClient(cKey);
  const auth = await cw.signAuthorization({ account: cw.account!, contractAddress: d.implementation });
  const relayed = await minedRevert("a relayer submits C's authorization with its own initialize", funder.privateKey, c,
    initializeData(d, targetFor(await pqKey("B_relayer"), "B3")), { authorizationList: [auth] });
  const cCode = await publicClient.getCode({ address: c });
  console.log(`   C after the relayed tx: code ${cCode}, keys ${(await pqKeysOf(d, c)).length}`);
  check(classifyCode(cCode).kind === "7702" && (await pqKeysOf(d, c)).length === 0, "B: the relayer's delegation landed but installed no keys");
  // migrateEOA sees a LeanAccount delegation that nobody configured and only initializes (no new authorization).
  const cOwner = await pqKey("B_victim_pq");
  const own = await migrateEOA(d, { privateKey: cKey, target: targetFor(cOwner, "B4"), mode: "7702" });
  const cKeys = await pqKeysOf(d, c);
  console.log(`   C runs migrateEOA(7702) itself: ${own.txs[0]}; its keys: ${cKeys.join(", ")}`);
  check(cKeys.length === 1 && cKeys[0] === cOwner.publicKey, "B: C's own key is installed");

  const ecdsa = await sendLegacy(eoaKey, { to: funder.address, value: 1n, gas: 100_000n });
  console.log(`   caveat: the EOA's ECDSA key still sends txs (${ecdsa.transactionHash}, block ${ecdsa.blockNumber}): PQ-safe only once EIP-7851 key deactivation exists`);
  record.B = { eoa, migrationTx: r.txs[0], code, before, after, pqSpend: spend.txHash, thirdPartyReinit: reinit, relayedAuthorization: relayed, victimInitializesItself: own.txs[0], ecdsaStillWorks: ecdsa.transactionHash };
}

// ------------------------------------------------------------------------------------------ C. SA, upgrade -------
{
  console.log("\nC. migrateSA (upgradeable account): upgrade in place");
  const ownerKey = fresh("C_owner");
  const ownerAddr = privateKeyToAccount(ownerKey).address;
  await sendLegacy(funder.privateKey, { to: ownerAddr, value: GAS_ONLY });
  const deploy = encodeDeployData({ abi: artifact("LegacyERC1967Proxy", "LegacyAccount").abi, bytecode: artifact("LegacyERC1967Proxy", "LegacyAccount").bytecode,
    args: [d.legacyImplementation, encodeFunctionData({ abi: legacyAbi, functionName: "initialize", args: [ownerAddr] })] });
  const est = await publicClient.estimateGas({ account: funder.address, data: deploy });
  const sa = (await sendLegacy(funder.privateKey, { data: deploy, gas: (est * 13n) / 10n })).contractAddress as Address;
  await sendLegacy(funder.privateKey, { to: sa, value: FUND }); // after: the constructor's initialize is not payable
  await mint(sa);
  console.log(`   existing account ${sa} (ERC-1967 proxy → LegacyAccount ${await implementationOf(sa)}), owner ${ownerAddr}`);
  const before = await show("before:", sa);
  const owner = await pqKey("C_pq");
  const r = await migrateSA(d, { account: sa, target: targetFor(owner, "C"), tokens: [TOKEN], send: legacyAccountSender(sa, ownerKey) });
  check(r.mode === "upgrade" && r.account === sa, `C: an upgrade in place (got ${r.mode})`);
  const impl = await implementationOf(sa);
  console.log(`   migration tx: ${r.txs[0]}; implementation now ${impl}`);
  check(impl?.toLowerCase() === d.implementation.toLowerCase(), "C: the proxy points at LeanAccount");
  const after = await show("after:  same address", sa);
  check(after.eth === before.eth && after.mtt === before.mtt, "C: nothing moved (the owner paid the gas)");
  check((await pqKeysOf(d, sa)).includes(owner.publicKey), "C: the keystore holds the PQ key");
  const spend = await pqSpend("C", sa, owner);
  const old = await minedRevert("the old owner calls execute", ownerKey, sa,
    encodeFunctionData({ abi: legacyAbi, functionName: "execute", args: [[{ to: ownerAddr, value: 1n, data: "0x" }]] }));
  record.C = { account: sa, oldImplementation: d.legacyImplementation, migrationTx: r.txs[0], implementation: impl, before, after, pqSpend: spend.txHash, oldOwnerRefused: old };
}

// ------------------------------------------------------------------------------------------ D. SA, move ----------
{
  console.log("\nD. migrateSA (not upgradeable): one tx moves everything");
  const ownerKey = fresh("D_owner");
  const ownerAddr = privateKeyToAccount(ownerKey).address;
  await sendLegacy(funder.privateKey, { to: ownerAddr, value: GAS_ONLY });
  const deploy = encodeDeployData({ abi: legacyAbi, bytecode: artifact("LegacyAccount").bytecode, args: [ownerAddr] });
  const est = await publicClient.estimateGas({ account: funder.address, data: deploy });
  const sa = (await sendLegacy(funder.privateKey, { data: deploy, gas: (est * 13n) / 10n })).contractAddress as Address;
  await sendLegacy(funder.privateKey, { to: sa, value: FUND });
  await mint(sa);
  const before = await show("before: existing account", sa);
  const owner = await pqKey("D_pq");
  const r = await migrateSA(d, { account: sa, target: targetFor(owner, "D"), tokens: [TOKEN], send: legacyAccountSender(sa, ownerKey) });
  check(r.mode === "move", `D: a move (got ${r.mode})`);
  console.log(`   migration tx (one): ${r.txs[0]}`);
  const src = await show("after:  existing account", sa);
  const dst = await show("after:  LeanAccount", r.account);
  check(src.eth === 0n && src.mtt === 0n && dst.eth === before.eth && dst.mtt === before.mtt, "D: everything moved, exactly");
  check((await pqKeysOf(d, r.account)).includes(owner.publicKey), "D: the keystore holds the PQ key");
  const spend = await pqSpend("D", r.account, owner);
  record.D = { oldAccount: sa, account: r.account, migrationTx: r.txs[0], before, oldAfter: src, accountAfter: dst, pqSpend: spend.txHash };
}

fs.writeFileSync(path.join(ROOT, "deployments", "migration-live.json"), JSON.stringify(record, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
console.log("\nwrote deployments/migration-live.json");
