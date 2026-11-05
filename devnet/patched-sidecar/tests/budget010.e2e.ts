// BUDGET-010 end to end on the LOCAL devnet, against the patched sidecar (devnet/patched-sidecar/README.md).
//
//   cd devnet && ./patched-sidecar/up-patched.sh && cd patched-sidecar/tests && bun install && bun run test
//
// Funding key: anvil #9 (devnet/README.md "Funding-key allocation"). Every run deploys a fresh wallet, so it starts
// unstaked. Steps:
//   0. skandha_config on the patched sidecar advertises `budgets` (the stock one does not).
//   1. A 150k self_verify (152,800 with the secp256k1 signature cost) from the UNSTAKED wallet: rejected by the patched
//      sidecar with the BUDGET-010 reason; rejected by the stock sidecar (flat MAX_VERIFY_GAS) and by ethrex
//      eth_sendRawTransaction (public-mempool MAX_VERIFY_GAS) for comparison.
//   2. The wallet stakes itself (SENDER frame -> NaiveStakingRegistry.addStake(86400), 0.012 ETH) via the patched sidecar.
//   3. The same 150k tx shape (next nonce): admitted by the patched sidecar, relayed via
//      ethrex_submitPrivilegedFrameTransaction, mined (OnChain, receipt status 0x1).
//   4. A 1,100,000 self_verify from the now-STAKED wallet: rejected (over MAX_VERIFY_GAS_STAKED_ENTITY).
//   5. The explorer's admission records show the BUDGET-010 rule verdicts.
// Results: stdout and ./last-run.json.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeTx, frame, getProfile, newTx, secp256k1Placeholder, signTx, txHash, type FrameTx } from "@leaked/frames";
import { RpcError, createNodeClient, createSidecarClient, httpTransport } from "@leaked/rpc";

const ETHREX = process.env.ETHREX_URL ?? "http://localhost:8545";
const PATCHED = process.env.PATCHED_SIDECAR_URL ?? "http://localhost:14340/rpc";
const STOCK = process.env.SIDECAR_URL ?? "http://localhost:14337/rpc";
const REGISTRY = (process.env.STAKING_REGISTRY ?? "0x8464135c8F25Da09e49BC8782676a84730C318bC") as Address;
const CHAIN_ID = 1337;
/** anvil #9. Public test key, never real. */
const FUNDER_KEY: Hex = "0x2a871d0798f97d79848a013d4936a73bf4cc922c825d33c1cf7073dff6d409c6";
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };

const profile = getProfile("ethrex-eip8141-tracer");
const node = createNodeClient(httpTransport(ETHREX));
const patched = createSidecarClient(httpTransport(PATCHED));
const stock = createSidecarClient(httpTransport(STOCK));
const chain = {
  id: CHAIN_ID,
  name: "leaked-devnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ETHREX] } },
} as const;
const pub = createPublicClient({ chain, transport: http(ETHREX) });
const owner = privateKeyToAccount(FUNDER_KEY);
const funder = createWalletClient({ chain, transport: http(ETHREX), account: owner });

const REGISTRY_ABI = [
  { type: "function", name: "addStake", stateMutability: "payable", inputs: [{ name: "unstakeDelaySec", type: "uint32" }], outputs: [] },
  {
    type: "function",
    name: "getDepositInfo",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "stake", type: "uint256" },
      { name: "unstakeDelaySec", type: "uint32" },
      { name: "withdrawTime", type: "uint64" },
    ],
  },
] as const;

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), endpoints: { ETHREX, PATCHED, STOCK } };
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
function record(key: string, v: unknown) {
  results[key] = v;
  console.log(`\n## ${key}\n${json(v)}`);
}
let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
  (results.checks ??= [] as string[]) && (results.checks as string[]).push(`${ok ? "PASS" : "FAIL"} ${what}`);
}
const reason = (e: unknown) => (e instanceof RpcError ? e.message.replace(/^\S+ on \S+: /, "") : String(e));

// --- wallet: VerifyBisect (devnet/tools) with data 0x00 = plain APPROVE(EXECUTION_AND_PAYMENT), owner = anvil #9 ----
const art = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../tools/artifacts/VerifyBisect.json", import.meta.url)), "utf8"),
) as { bytecode: Hex };

async function legacy(tx: { to?: Address; data?: Hex; value?: bigint; gas: bigint }) {
  const nonce = await pub.getTransactionCount({ address: owner.address, blockTag: "pending" });
  const hash = await funder.sendTransaction({ ...tx, nonce, gasPrice: 2_000_000_000n, type: "legacy", chain });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (r.status !== "success") throw new Error(`legacy tx ${hash} failed`);
  return r;
}

async function selfVerifyTx(wallet: Address, verifyGas: bigint, body = [] as ReturnType<typeof frame>[]): Promise<FrameTx> {
  const nonceSeq = await node.getTransactionCount(wallet, "latest");
  const tx = newTx({
    chainId: CHAIN_ID,
    sender: wallet,
    nonceSeq,
    fees: FEES,
    signatures: [secp256k1Placeholder(profile, owner.address)],
    frames: [
      frame(profile, "VERIFY", { scope: "EXECUTION_AND_PAYMENT", execution: verifyGas, data: "0x00" }),
      ...(body.length ? body : [frame(profile, "SENDER", { target: owner.address, execution: 50_000n, value: 1n })]),
    ],
  });
  return signTx(profile, tx, FUNDER_KEY, 0);
}

async function waitOnChain(hash: Hex, timeoutMs = 240_000) {
  const t0 = Date.now();
  let status: string | undefined;
  while (Date.now() - t0 < timeoutMs) {
    const s = await patched.frameTransactionStatus(hash).catch(() => null);
    status = (s as { status?: string } | null)?.status;
    if (status === "OnChain" || status === "Reverted" || status === "Cancelled") break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const receipt = await node.getTransactionReceipt(hash);
  return { status, receipt };
}

// 0. skandha_config
const [patchedCfg, stockCfg] = await Promise.all([patched.config(), stock.config().catch((e) => ({ error: reason(e) }))]);
record("0. skandha_config", {
  patched: { budgets: patchedCfg.budgets, minStake: patchedCfg.minStake, minUnstakeDelay: patchedCfg.minUnstakeDelay },
  stock: { budgets: (stockCfg as Record<string, unknown>).budgets ?? "(none advertised)" },
});
const budgets = patchedCfg.budgets as { maxVerifyGasPerEntity: number; maxVerifyGasStakedEntity: number } | undefined;
check(budgets?.maxVerifyGasPerEntity === 100_000 && budgets?.maxVerifyGasStakedEntity === 1_000_000, "skandha_config.budgets = 100k unstaked / 1M staked");

// deploy a fresh (unstaked) wallet
const deployData = (art.bytecode + owner.address.toLowerCase().slice(2).padStart(64, "0")) as Hex;
const dep = await legacy({ data: deployData, value: parseEther("0.2"), gas: 25_000_000n });
const wallet = dep.contractAddress as Address;
record("deploy wallet (VerifyBisect, owner anvil #9)", { wallet, hash: dep.transactionHash, gasUsed: dep.gasUsed });

// 1. unstaked 150k
const tx1 = await selfVerifyTx(wallet, 150_000n);
const raw1 = encodeTx(profile, tx1);
const sim1 = await node.simulateFrameTransaction(raw1, { trace: true });
const r1patched = await patched.sendFrameTransaction(tx1).then((h) => `accepted ${h}`, (e) => `rejected: ${reason(e)}`);
const r1stock = await stock.sendFrameTransaction(tx1).then((h) => `accepted ${h}`, (e) => `rejected: ${reason(e)}`);
const r1ethrex = await node.sendRawTransaction(raw1).then((h) => `accepted ${h}`, (e) => `rejected: ${reason(e)}`);
record("1. UNSTAKED wallet, VERIFY limit 150,000", {
  simulate: { valid: sim1.valid, violation: sim1.violation, executionStatus: sim1.executionStatus, frame0: sim1.frames?.[0], traced: sim1.erc7562Trace != null },
  patchedSidecar: r1patched,
  stockSidecar: r1stock,
  ethrexSendRawTransaction: r1ethrex,
});
check(/^rejected: BUDGET-010: .*exceeds MAX_VERIFY_GAS_PER_ENTITY 100000 for an unstaked entity/.test(r1patched), "patched sidecar rejects the unstaked 150k VERIFY with the BUDGET-010 reason");
check(/MAX_VERIFY_GAS 100000/.test(r1stock), "stock sidecar rejects it with the flat MAX_VERIFY_GAS");
check(/^rejected: .*MAX_VERIFY_GAS/.test(r1ethrex), "ethrex eth_sendRawTransaction rejects it (public-mempool MAX_VERIFY_GAS)");

// 2. stake the wallet via a SENDER frame (msg.sender == wallet), submitted to the patched sidecar
const stakeData = encodeFunctionData({ abi: REGISTRY_ABI, functionName: "addStake", args: [86400] });
const tx2 = await selfVerifyTx(wallet, 60_000n, [
  frame(profile, "SENDER", { target: REGISTRY, execution: 150_000n, state: 200_000n, value: parseEther("0.012"), data: stakeData }),
]);
const h2 = await patched.sendFrameTransaction(tx2);
const s2 = await waitOnChain(h2);
const deposit = await pub.readContract({ address: REGISTRY, abi: REGISTRY_ABI, functionName: "getDepositInfo", args: [wallet] });
record("2. stake 0.012 ETH, unstakeDelay 86400 (via patched sidecar)", { hash: h2, status: s2.status, receiptFrames: s2.receipt?.frameReceipts.map((f) => f.status), deposit });
check(s2.status === "OnChain" && deposit[0] === parseEther("0.012") && deposit[1] === 86400, "wallet staked in NaiveStakingRegistry");

// 3. staked 150k: admitted and mined
const tx3 = await selfVerifyTx(wallet, 150_000n);
const raw3 = encodeTx(profile, tx3);
const r3ethrex = await node.sendRawTransaction(raw3).then((h) => `accepted ${h}`, (e) => `rejected: ${reason(e)}`);
let h3: Hex | undefined;
let r3patched: string;
try {
  h3 = await patched.sendFrameTransaction(tx3);
  r3patched = `accepted ${h3}`;
} catch (e) {
  r3patched = `rejected: ${reason(e)}`;
}
const s3 = h3 ? await waitOnChain(h3) : null;
record("3. STAKED wallet, same 150,000 VERIFY shape (next nonce)", {
  ethrexSendRawTransaction: r3ethrex,
  patchedSidecar: r3patched,
  codecTxHash: txHash(profile, tx3),
  status: s3?.status,
  receipt: s3?.receipt
    ? { reportedStatus: s3.receipt.reportedStatus, blockNumber: s3.receipt.blockNumber, gasUsed: s3.receipt.gasUsed, frames: s3.receipt.frameReceipts.map((f) => ({ status: f.status, gasUsed: f.gasUsed })) }
    : null,
});
check(/^rejected: .*MAX_VERIFY_GAS/.test(r3ethrex), "ethrex public path still rejects the staked 150k tx (needs the privileged route)");
check(h3 !== undefined && h3 === txHash(profile, tx3), "patched sidecar admits the staked 150k VERIFY");
check(s3?.status === "OnChain" && (s3.receipt?.frameReceipts ?? []).length === 2 && s3!.receipt!.frameReceipts.every((f) => f.status === "success"), "staked 150k tx mined via ethrex_submitPrivilegedFrameTransaction");

// 4. staked 1.1M: rejected
const tx4 = await selfVerifyTx(wallet, 1_100_000n);
const r4 = await patched.sendFrameTransaction(tx4).then((h) => `accepted ${h}`, (e) => `rejected: ${reason(e)}`);
record("4. STAKED wallet, VERIFY limit 1,100,000", { patchedSidecar: r4 });
check(/^rejected: BUDGET-010: .*exceeds MAX_VERIFY_GAS_STAKED_ENTITY 1000000/.test(r4), "patched sidecar rejects a 1.1M VERIFY even when staked");

// 5. explorer admission reports
const adm = await patched.explorer.listAdmissions({ limit: 20 }).catch((e) => ({ items: [], error: reason(e) }));
const mine = ((adm as { items?: unknown[] }).items ?? []).filter((a) => json(a).toLowerCase().includes(wallet.toLowerCase()));
record(
  "5. explorer admissions (BUDGET-010 checks)",
  mine.map((a) => {
    const r = a as { outcome?: string; checks?: { rule: string; verdict: string; detail?: string }[]; error?: { message?: string } };
    return { outcome: r.outcome, budget: r.checks?.find((c) => c.rule === "BUDGET-010") };
  }),
);

results.finishedAt = new Date().toISOString();
results.failures = failures;
writeFileSync(new URL("./last-run.json", import.meta.url), json(results) + "\n");
console.log(failures === 0 ? "\nBUDGET-010 E2E OK" : `\nBUDGET-010 E2E: ${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
