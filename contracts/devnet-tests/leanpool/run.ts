// The post-quantum everyday key, end to end on the PUBLIC alt-mempool devnet (chain 1337, altmempool.forshtat.com).
//
//   cd contracts && forge build && cd ../devnet/deploy && bun run deploy:public        # contracts, once
//   LEANPOOL_* … node services/leanpool-node/dist/main.js                               # an aggregating node
//   cd contracts/devnet-tests/leanpool && bun install && DEPLOYER_KEY=0x… bun run test
//
// 1. A fresh QueueBit account in bound mode (C13 Vault, Path B), funded; its VaultSigner clone deployed lazily.
// 2. A LeanPoolHotSigner clone for the account (leanSPHINCS key, the node's aggregator), created by the fee tank.
// 3. The Vault installs it: Path B `vaultSetPQHotSigner`, public mempool.
// 4. A post-quantum everyday payment: the leanSPHINCS key signs the frame tx's sig hash; the LeanPool node verifies it,
//    posts the batch root into the signer's ring, fills the witness and delivers the tx to the alt mempool, which
//    admits it unstaked and mines it. The canonical mempool's verdict on the same tx is recorded (StorageReadNonSender).
// 5. An over-limit payment is refused by the pre-check (an eth_call of the SENDER body), never signed.
// 6. The batch's recursive STARK is fetched, verified, and its claims rebuild the posted root.
// Results: stdout and ./last-run.json.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bytesToHex,
  concat,
  createPublicClient,
  decodeErrorResult,
  encodeFunctionData,
  hexToBytes,
  http,
  keccak256,
  pad,
  parseEther,
  stringToHex,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  encodeTx,
  getProfile,
  hotSpendTx,
  leanPoolHotTx,
  leanPoolWitness,
  roleSignerPathBTx,
  setSignature,
  sigHash,
  signTx,
  txHash,
  type FrameTx,
} from "@queuebit/frames";
import { createFrameRpc } from "@queuebit/rpc";
import { SIG_LENGTH as C13_SIG_LENGTH, keygen, sign as c13Sign } from "@queuebit/pq-signer";
import { LeanSphincsKey } from "@queuebit/lean-sphincs";
import { verifyBatch } from "../../../services/leanpool-node/src/verify-batch.ts";

const ETHREX = process.env.ETHREX_URL ?? "https://altmempool.forshtat.com";
const NODE = process.env.LEANPOOL_NODE_URL ?? "http://127.0.0.1:8711";
const ADDRESSES = process.env.ADDRESSES_FILE ?? fileURLToPath(new URL("../../../devnet/deploy/addresses.public.json", import.meta.url));
const FUNDER_KEY = process.env.DEPLOYER_KEY as Hex | undefined;
if (!FUNDER_KEY) throw new Error("DEPLOYER_KEY (a funded devnet key) is required");

const profile = getProfile("ethrex-eip8141-tracer");
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const USD = 1_000_000n;
const ETH_PRICE = 3_000n * USD;
const PATH_B_VERIFY_GAS = 90_000n;
const ROLE_BODY = { execution: 600_000n, state: 400_000n };
const PQ_VERIFY_GAS = 90_000n; // + ARBITRARY 100 <= MAX_VERIFY_GAS 100,000
const PQ_BODY = { execution: 300_000n, state: 250_000n };
const HOT_SIGNER_MAX_FEE = parseEther("0.01");

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), run: "LeanPool PQ everyday key, public devnet" };
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2);
const log = (title: string, v: unknown) => console.log(`\n== ${title}\n${json(v)}`);
const save = () => writeFileSync(new URL("./last-run.json", import.meta.url), `${json(results)}\n`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const addresses = JSON.parse(readFileSync(ADDRESSES, "utf8"));
const C = (name: string): Address => {
  const a = addresses.contracts?.[name]?.address;
  if (!a) throw new Error(`${name} is not in ${ADDRESSES}: run deploy:public`);
  return a;
};
const OUT = fileURLToPath(new URL("../../out/", import.meta.url));
const art = (file: string, name: string) => JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8")) as { abi: Abi };
const implAbi = art("QueueBitAccountImpl.sol", "QueueBitAccountImpl").abi;
const rolesAbi = art("QueueBitAccountRoles.sol", "QueueBitAccountRoles").abi;
const accountAbi = [...implAbi, ...rolesAbi.filter((x) => (x as { type: string }).type === "function" || (x as { type: string }).type === "error")] as Abi;
const accFactoryAbi = art("AccountFactory.sol", "AccountFactory").abi;
const rsFactoryAbi = art("RoleSignerFactory.sol", "RoleSignerFactory").abi;
const signerAbi = art("PQRoleSigner.sol", "PQRoleSigner").abi;
const hotFactoryAbi = art("LeanPoolHotSignerFactory.sol", "LeanPoolHotSignerFactory").abi;
const hotSignerAbi = art("LeanPoolHotSigner.sol", "LeanPoolHotSigner").abi;
const registryAbi = art("DepsRegistry.sol", "DepsRegistry").abi;

const rpc = createFrameRpc(ETHREX, { sidecarUrl: `${ETHREX}/rpc` });
const pub = createPublicClient({ transport: http(ETHREX) });
const funder = privateKeyToAccount(FUNDER_KEY);

async function legacy(from: PrivateKeyAccount, tx: { to: Address; data?: Hex; value?: bigint; gas?: bigint }) {
  const nonce = await pub.getTransactionCount({ address: from.address, blockTag: "pending" });
  const signed = await from.signTransaction({
    type: "legacy",
    chainId: 1337,
    nonce,
    gasPrice: 2_000_000_000n,
    gas: tx.gas ?? 250_000n,
    to: tx.to,
    data: tx.data,
    value: tx.value ?? 0n,
  });
  const hash = await rpc.node.sendRawTransaction(signed);
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 240_000 });
  if (r.status !== "success") throw new Error(`legacy tx ${hash} reverted`);
  return { hash, gasUsed: r.gasUsed };
}

async function nodeRpc<T>(method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(NODE, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const b = (await res.json()) as { result?: T; error?: { message: string } };
  if (b.error) throw new Error(b.error.message);
  return b.result as T;
}

async function waitReceipt(hash: Hex, timeoutMs = 240_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const r = await rpc.node.getTransactionReceipt(hash).catch(() => null);
    if (r) return r;
    await sleep(1500);
  }
  throw new Error(`timeout waiting for ${hash}`);
}

const keyedNonce = async (sender: Address, key: bigint) => {
  const slot = keccak256(concat([pad(sender), toHex(key, { size: 32 })]));
  return BigInt((await pub.getStorageAt({ address: profile.predeploys!.NONCE_MANAGER as Address, slot })) ?? "0x0");
};

// ------------------------------------------------------------------------------------------- 0. setup ---------
const chainId = await pub.getChainId();
if (chainId !== 1337) throw new Error(`expected chain 1337, got ${chainId}`);
const status = await nodeRpc<{ nodeId: Address; registry: Address; aggregating: boolean; bond?: { bonded: string; min: string } }>("leanpool_status");
if (!status.aggregating) throw new Error(`${NODE} is not an aggregating LeanPool node`);
if (status.registry.toLowerCase() !== C("DepsRegistry").toLowerCase()) throw new Error(`node posts to ${status.registry}, not QueueBit's DepsRegistry ${C("DepsRegistry")}`);
const aggregator = status.nodeId;
results.node = { url: NODE, aggregator, registry: status.registry, bond: status.bond, block: await pub.getBlockNumber() };
log("LeanPool node", results.node);

const runTag = `${Date.now()}`;
const seed = (tag: string, n = 1) =>
  hexToBytes(concat(Array.from({ length: n }, (_, i) => keccak256(stringToHex(`queuebit/devnet-tests/leanpool/${tag}/${runTag}/${i}`)))));
const vaultPQ = keygen(seed("vault", 2), { role: "vault" });
const leanKey = LeanSphincsKey.fromSeed(seed("lean-hot"));
const vk = bytesToHex(leanKey.publicKey);
const hotPriv = generatePrivateKey();
const tankPriv = generatePrivateKey();
const payerPriv = generatePrivateKey();
const hot = privateKeyToAccount(hotPriv);
const tank = privateKeyToAccount(tankPriv);
const payer = privateKeyToAccount(payerPriv);
const recipient = privateKeyToAccount(generatePrivateKey()).address;
results.keys = { hot: hot.address, tank: tank.address, vaultPayer: payer.address, recipient, vaultPk: bytesToHex(vaultPQ.publicKey), leanSphincsVk: vk };

// ------------------------------------------------------------------- 1. the account (bound mode) ---------
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const roleSalt = keccak256(stringToHex(`queuebit/devnet-tests/leanpool/roles/${runTag}`));
const initCfg = {
  hotKey: hot.address,
  roleSignerFactory: C("RoleSignerFactory"),
  vault: { salt: roleSalt, pk: bytesToHex(vaultPQ.publicKey), verifier: C("C13Verifier"), payerKey: payer.address },
  recovery: { salt: `0x${"00".repeat(32)}` as Hex, pk: `0x${"00".repeat(32)}` as Hex, verifier: ZERO, payerKey: ZERO }, // no Recovery key in this run
  vaultSigner: ZERO,
  recoverySigner: ZERO,
  tank: tank.address,
  capUsdPerDay: 10n * USD,
  perTxMaxUsd: 8n * USD,
  maxFeeWeiPerTx: parseEther("0.01"),
  maxPriorityFeePerGas: 2_000_000_000n,
  maxHotFrames: 4,
  selfPay: false,
  timelockDelay: 3600,
  timelockThresholdUsd: 100n * USD,
  ethUsdPrice: ETH_PRICE,
  recipientMode: 0,
  tokens: [] as { token: Address; decimals: number; usdPerToken: bigint }[],
};
const initData = encodeFunctionData({ abi: implAbi, functionName: "initialize", args: [initCfg] });
const accSalt = keccak256(stringToHex(`queuebit/devnet-tests/leanpool/account/${runTag}`));
const account = (await pub.readContract({ address: C("AccountFactory"), abi: accFactoryAbi, functionName: "predictAccount", args: [accSalt, C("QueueBitAccountImpl"), initData] })) as Address;
const created = await legacy(funder, { to: C("AccountFactory"), data: encodeFunctionData({ abi: accFactoryAbi, functionName: "createAccount", args: [accSalt, C("QueueBitAccountImpl"), initData] }), gas: 12_000_000n });
const [vaultSigner] = (await pub.readContract({ address: account, abi: rolesAbi, functionName: "getRoles" })) as readonly [Address, Address, Address, number, number];
const vaultClone = await legacy(funder, {
  to: C("RoleSignerFactory"),
  data: encodeFunctionData({ abi: rsFactoryAbi, functionName: "createRoleSigner", args: [roleSalt, 1, account, bytesToHex(vaultPQ.publicKey), C("C13Verifier"), payer.address] }),
  value: parseEther("0.5"),
  gas: 2_000_000n,
});
await legacy(funder, { to: account, value: parseEther("0.2") });
await legacy(funder, { to: tank.address, value: parseEther("0.3") });
results.account = { address: account, createTx: created.hash, vaultSigner, vaultCloneTx: vaultClone.hash };
log("account", results.account);
save();

// ------------------------------------------------------ 2. the LeanPoolHotSigner, created by the fee tank ---------
const hotSigner = (await pub.readContract({ address: C("LeanPoolHotSignerFactory"), abi: hotFactoryAbi, functionName: "predictHotSigner", args: [account, aggregator, vk, HOT_SIGNER_MAX_FEE] })) as Address;
const hotCreate = await legacy(tank, {
  to: C("LeanPoolHotSignerFactory"),
  data: encodeFunctionData({ abi: hotFactoryAbi, functionName: "createHotSigner", args: [account, aggregator, vk, HOT_SIGNER_MAX_FEE] }),
  value: parseEther("0.05"),
  gas: 1_500_000n,
});
const readHot = <T>(functionName: string) => pub.readContract({ address: hotSigner, abi: hotSignerAbi, functionName }) as Promise<T>;
const hotArgs = { account: await readHot<Address>("account"), registry: await readHot<Address>("registry"), aggregator: await readHot<Address>("aggregator"), vk: await readHot<Hex>("vk"), maxFee: await readHot<bigint>("maxFee") };
if (hotArgs.account !== account || hotArgs.vk !== vk || hotArgs.aggregator.toLowerCase() !== aggregator.toLowerCase()) throw new Error(`hot signer args ${json(hotArgs)}`);
results.hotSigner = { address: hotSigner, createTx: hotCreate.hash, createGas: hotCreate.gasUsed, args: hotArgs, balance: await pub.getBalance({ address: hotSigner }) };
log("LeanPoolHotSigner (created by the fee tank)", results.hotSigner);

// ----------------------------------------------------------- 3. the Vault installs it (Path B) ---------
async function vaultPathB(label: string, data: Hex) {
  const nonceSeq = await rpc.node.getTransactionCount(vaultSigner, "latest");
  let tx = roleSignerPathBTx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: FEES,
    roleSigner: vaultSigner,
    sigLength: C13_SIG_LENGTH,
    verifyGas: PATH_B_VERIFY_GAS,
    payerKey: payer.address,
    body: { data: encodeFunctionData({ abi: signerAbi, functionName: "executePQ", args: [0n, account, data] }), ...ROLE_BODY },
  });
  const t0 = performance.now();
  tx = setSignature(profile, tx, 0, bytesToHex(c13Sign(vaultPQ.secretKey, hexToBytes(sigHash(profile, tx)))));
  const signMs = Math.round(performance.now() - t0);
  tx = await signTx(profile, tx, payerPriv, 1);
  const sim = await rpc.node.simulateFrameTransaction(encodeTx(profile, tx));
  if (!sim.valid) throw new Error(`${label}: simulation refused: ${sim.violation ?? sim.executionError}`);
  const hash = await rpc.node.sendRawTransaction(encodeTx(profile, tx));
  const r = await waitReceipt(hash);
  if (r.frameReceipts[1]?.status !== "success") throw new Error(`${label}: SENDER frame failed`);
  return { label, hash, block: r.blockNumber, gasUsed: r.gasUsed, c13SignMs: signMs };
}
results.install = await vaultPathB("Vault: vaultSetPQHotSigner", encodeFunctionData({ abi: accountAbi, functionName: "vaultSetPQHotSigner", args: [hotSigner] }));
const installed = (await pub.readContract({ address: account, abi: accountAbi, functionName: "pqHotSigner" })) as Address;
if (installed !== hotSigner) throw new Error(`pqHotSigner() = ${installed}`);
log("installed by the Vault (Path B, public mempool)", results.install);
save();

// ------------------------------------------------------------ 4. a post-quantum everyday payment ---------
type Call = { target: Address; value: bigint; data: Hex };
const execData = (declaredUsd: bigint, calls: Call[]) => encodeFunctionData({ abi: hotSignerAbi, functionName: "execute", args: [declaredUsd, calls] });

/**
 * The extension's pre-check. ethrex refuses an eth_call from a contract address (EIP-3607) and has no state overrides,
 * so the signer's body cannot be called directly. `hotExecute` and `hotExecuteFrom` share one body (`_hotExecute`):
 * the same payment as an everyday ECDSA transaction is simulated instead (signed, simulated, never sent), exactly what
 * the extension's FrameEngine.prepare does; its body frame's outcome is the PQ payment's.
 */
async function precheck(declaredUsd: bigint, calls: Call[]): Promise<{ ok: true } | { ok: false; error: string }> {
  let twin = hotSpendTx(profile, {
    chainId: 1337,
    nonceSeq: await rpc.node.getTransactionCount(account, "latest"),
    fees: FEES,
    account,
    hotKey: hot.address,
    tank: tank.address,
    verifyGas: 80_000n,
    tankGas: 10_000n,
    body: { data: encodeFunctionData({ abi: accountAbi, functionName: "hotExecute", args: [declaredUsd, calls] }), ...PQ_BODY },
  });
  twin = await signTx(profile, await signTx(profile, twin, hotPriv, 0), tankPriv, 1);
  const sim = await rpc.node.simulateFrameTransaction(encodeTx(profile, twin));
  const body = (sim.frames as Record<string, unknown>[] | null)?.[2];
  // As the extension's parseSimFrames: a frame without an outcome counts as failed.
  const succeeded = body ? Boolean(body.succeeded ?? body.success ?? (body.status === "0x1" || body.status === 1)) : false;
  const ok = sim.valid && !sim.executionError && succeeded;
  if (ok) return { ok: true };
  const data = (body?.returnData ?? body?.output) as Hex | undefined;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const d = decodeErrorResult({ abi: accountAbi, data });
      return { ok: false, error: `${d.errorName}(${(d.args ?? []).join(", ")})` };
    } catch {}
  }
  return { ok: false, error: sim.executionError ?? sim.violation ?? json(body) };
}

const bucket = async () => (await pub.readContract({ address: account, abi: accountAbi, functionName: "getBucket" })) as readonly [bigint, number, bigint, number];
const bucketBefore = (await bucket())[0];
const amount = parseEther("0.001"); // $3 at the account's price
const declared = (amount * ETH_PRICE) / 10n ** 18n;
const calls: Call[] = [{ target: recipient, value: amount, data: "0x" }];
const pre = await precheck(declared, calls);
if (!pre.ok) throw new Error(`pre-check refused a valid payment: ${pre.error}`);

const nonceKey = 1n;
const unsigned = leanPoolHotTx(profile, {
  chainId: 1337,
  nonceSeq: await keyedNonce(hotSigner, nonceKey),
  nonceKey,
  fees: FEES,
  signer: hotSigner,
  vk,
  verifyGas: PQ_VERIFY_GAS,
  body: { data: execData(declared, calls), ...PQ_BODY },
});
const sh = sigHash(profile, unsigned);
const t0 = performance.now();
const leanSig = bytesToHex(leanKey.sign(hexToBytes(sh)));
const leanSignMs = Math.round(performance.now() - t0);
const submitted = await nodeRpc<{ txHash: Hex }>("leanpool_sendTransaction", [{ raw: encodeTx(profile, unsigned), sigs: [leanSig] }]);
log("submitted to the LeanPool node", { poolId: submitted.txHash, sigHash: sh, leanSphincsSigBytes: (leanSig.length - 2) / 2, leanSignMs });

// Follow it; while its root is posted and the tx waits in the alt mempool, ask the canonical mempool about the same tx.
type TxStatus = { stage: string; txHash?: Hex; gasUsed?: string; batch?: { root: Hex; ring: number; postTx: Hex; block: string; proofHash?: Hex }; error?: string; lastError?: string };
let st: TxStatus | null = null;
let canonical: unknown = "not checked (mined before the check)";
const stages: string[] = [];
for (const t1 = Date.now(); Date.now() - t1 < 300_000; await sleep(300)) {
  st = await nodeRpc<TxStatus | null>("leanpool_getTx", [submitted.txHash]);
  if (st && stages.at(-1) !== st.stage) stages.push(st.stage);
  if (st?.stage === "posted" && st.batch && canonical === "not checked (mined before the check)") {
    // A one-tx batch: the root is the leaf and the proof is empty.
    const final = setSignature(profile, unsigned, 0, leanPoolWitness(st.batch.root, st.batch.ring, []));
    const sim = await rpc.node.simulateFrameTransaction(encodeTx(profile, final), { trace: true }).catch((e) => ({ error: String(e) }));
    canonical = "error" in sim ? sim : { canonicalMempoolValid: sim.valid, violation: sim.violation, verifyFrameGas: (sim.frames as any)?.[0]?.gasUsed };
  }
  if (st && ["mined", "reverted", "refused"].includes(st.stage)) break;
}
if (st?.stage !== "mined" || !st.txHash) throw new Error(`PQ payment did not mine: ${json(st)}`);
const receipt = await waitReceipt(st.txHash);
const recipientBal = await pub.getBalance({ address: recipient });
const bucketAfter = (await bucket())[0];
if (recipientBal !== amount) throw new Error(`recipient got ${recipientBal}`);
if (bucketBefore - bucketAfter !== declared) throw new Error(`bucket moved ${bucketBefore - bucketAfter}, expected ${declared}`);
const minedTx = await rpc.node.getTransactionReceipt(st.txHash);
results.pqPayment = {
  poolId: submitted.txHash,
  txHash: st.txHash,
  explorer: `https://explorer.altmempool.wtf/tx/${st.txHash}?node=${encodeURIComponent(`${ETHREX}/rpc`)}`,
  stages,
  block: receipt.blockNumber,
  payer: receipt.payer,
  gasUsed: receipt.gasUsed,
  verifyGas: receipt.frameReceipts[0]?.gasUsed.execution,
  frames: receipt.frameReceipts.map((f) => ({ status: f.status, execution: f.gasUsed.execution, state: f.gasUsed.state })),
  batch: st.batch,
  canonicalMempoolOnTheSameTx: canonical,
  leanSphincs: { signatureBytes: (leanSig.length - 2) / 2, signMs: leanSignMs, onChainSignatureBytes: 0 },
  recipientReceived: recipientBal,
  bucketDebitedUsd6: bucketBefore - bucketAfter,
  minedFrom: minedTx?.payer,
};
log("PQ everyday payment: mined", results.pqPayment);
if ((receipt.frameReceipts[0]?.gasUsed.execution ?? 100_000n) >= 100_000n) throw new Error("VERIFY over the 100k budget");
save();

// -------------------------------------------------------------- 5. an over-limit payment is refused ---------
const big = parseEther("0.003"); // $9 > $8 per payment
const refused = await precheck((big * ETH_PRICE) / 10n ** 18n, [{ target: recipient, value: big, data: "0x" }]);
if (refused.ok) throw new Error("the pre-check passed an over-limit payment");
results.overLimit = { amountWei: big, refusedBy: refused.error, signed: false };
log("over-limit payment refused before signing", results.overLimit);

// ---------------------------------------------------------------- 6. the batch's STARK, verified ---------
let proofHash: Hex | undefined;
for (const t1 = Date.now(); Date.now() - t1 < 600_000 && !proofHash; await sleep(5000)) {
  proofHash = (await nodeRpc<TxStatus | null>("leanpool_getTx", [submitted.txHash]))?.batch?.proofHash;
}
if (!proofHash) throw new Error("no STARK hash attached within 10 minutes");
const v = await verifyBatch({ root: st.batch!.root, aggregator, registry: C("DepsRegistry"), rpcUrl: ETHREX, nodes: [NODE] });
const onChain = (await pub.readContract({ address: C("DepsRegistry"), abi: registryAbi, functionName: "batches", args: [aggregator, st.batch!.root] })) as readonly [bigint, number, boolean, Hex];
results.stark = { proofHash, onChainProofHash: onChain[3], verdict: v.verdict, why: v.why };
log("batch STARK", results.stark);
if (v.verdict !== "VALID") throw new Error(`verify-batch: ${v.verdict}`);

leanKey.dispose();
results.finishedAt = new Date().toISOString();
results.passed = true;
save();
console.log("\nPASS: post-quantum everyday payment through LeanPool, end to end on the public devnet");
