// QueueBitAccount integration test on the LOCAL devnet (devnet/README.md; `cd devnet && ./up.sh`).
//
//   cd contracts && forge build && cd devnet-tests/account && bun install && bun run test
//
// 1. Deploys QueueBitAccountRoles, QueueBitAccountImpl (HegotaSupport ERC8421_WORKSHOP, per-gas MAX_FEE) and
//    AccountFactory, then a proxy through the factory with: ETH priced at init, the fee-tank EOA allowlisted at init,
//    a $10/day bucket and an $8 per-tx bound. Funding from anvil #0 only.
// 2. Hot tx [only_verify(account, verifyFrame()), pay(tank EOA), SENDER(hotExecute)]: an ETH top-up of the tank
//    (an everyday payment) -> mined; VERIFY gas recorded.
// 3. Hot tx registering a value-bearing hash (registerHash), then ERC-1271 via eth_call: registered hash with an
//    empty signature and with the 36-byte marker -> 0x1626ba7e, an unregistered hash -> 0xffffffff.
// 4. Over-cap hot tx: admitted (declared <= per-tx max), the SENDER frame reverts OverCap, only the tank pays.
// 5. Guardian freeze (legacy tx from the guardian EOA), then a hot tx: rejected in VERIFY (simulate + submit).
// 6. Recipient mode: the account is Open (default), so a hot ETH payment to a fresh, never-allowlisted address is
//    mined; the vault tightens to Strict (instant) and the same payment then simulates VERIFY-valid with a failing
//    SENDER frame (never submitted); Strict -> Open directly reverts MustQueue.
// 7. Bound mode: a second account whose InitConfig carries a C13 vault pk (RoleSignerFactory/C13Verifier from
//    devnet/deploy/addresses.local.json) stores vaultSigner == predictRoleSigner(salt, 1, account, pk, ...).
// This account itself is created in explicit (unbound) mode, with an EOA as its vault (backward compatibility, and
// the role calls are plain legacy txs); G1 (devnet-tests/g1) runs the bound VaultSigner end to end.
// Every frame tx is first run through ethrex_simulateFrameTransaction {trace:true}; the gate is canonicalMempoolValid,
// frame-0 gasUsed < 80k, and a clean ERC-7562 trace of frame 0 (no banned opcode, no transient storage, no writes,
// no storage read outside the account). Results go to stdout and ./last-run.json.
import { readFileSync, writeFileSync } from "node:fs";
import {
  concatHex,
  encodeFunctionData,
  keccak256,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encodeTx, getProfile, hotSpendTx, sigHash, signTx, txHash, type FrameTx } from "@queuebit/frames";
import { artifact, call, deploy, json, legacy, log, pub, rpc, waitReceipt } from "./lib.js";

const profile = getProfile("ethrex-eip8141-tracer");
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const USD = 1_000_000n;
const ETH_PRICE = 3_000n * USD;
const VERIFY_GAS = 80_000n; // + tank 10,000 + 2 x 2,800 (secp) <= MAX_VERIFY_GAS 100,000
const TANK_GAS = 10_000n;
const BODY = { execution: 300_000n, state: 200_000n };
const DEVNET_ERC8421_WORKSHOP = 0;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

const results: Record<string, unknown> = { startedAt: new Date().toISOString() };

const rolesArt = artifact("QueueBitAccountRoles.sol", "QueueBitAccountRoles");
const implArt = artifact("QueueBitAccountImpl.sol", "QueueBitAccountImpl");
const factoryArt = artifact("AccountFactory.sol", "AccountFactory");
const accountAbi = [...implArt.abi, ...rolesArt.abi.filter((x) => (x as { type: string }).type === "function")];

// ------------------------------------------------------------------------------------------------ keys ----------

const hotPriv = generatePrivateKey();
const tankPriv = generatePrivateKey();
const hot = privateKeyToAccount(hotPriv);
const tank = privateKeyToAccount(tankPriv);
const vault = privateKeyToAccount(generatePrivateKey()); // stand-in for the VaultSigner contract (msg.sender auth)
const guardian = privateKeyToAccount(generatePrivateKey());
const recovery = privateKeyToAccount(generatePrivateKey()).address;
results.keys = { hot: hot.address, tank: tank.address, vault: vault.address, guardian: guardian.address, recovery };

// ---------------------------------------------------------------------------------------------- deploy ----------

const rolesD = await deploy(rolesArt, [], 35_000_000n);
const implD = await deploy(implArt, [DEVNET_ERC8421_WORKSHOP, true, rolesD.address], 36_000_000n);
const factoryD = await deploy(factoryArt, [], 10_000_000n);
results.deploy = {
  roles: { address: rolesD.address, gasUsed: rolesD.gasUsed, hash: rolesD.hash },
  impl: { address: implD.address, gasUsed: implD.gasUsed, hash: implD.hash },
  factory: { address: factoryD.address, gasUsed: factoryD.gasUsed, hash: factoryD.hash },
};
log("deployed", results.deploy);

const NO_SIGNER = { salt: `0x${"0".repeat(64)}` as Hex, pk: `0x${"0".repeat(64)}` as Hex, verifier: ZERO, payerKey: ZERO };
const initCfg = {
  hotKey: hot.address,
  roleSignerFactory: ZERO,
  vault: NO_SIGNER,
  recovery: NO_SIGNER,
  vaultSigner: vault.address,
  recoverySigner: recovery,
  tank: tank.address,
  capUsdPerDay: 10n * USD,
  perTxMaxUsd: 8n * USD,
  maxFeeWeiPerTx: parseEther("0.01"),
  maxPriorityFeePerGas: 2_000_000_000n,
  maxHotFrames: 4,
  selfPay: false,
  timelockDelay: 48 * 3600,
  timelockThresholdUsd: 100n * USD,
  ethUsdPrice: ETH_PRICE,
  recipientMode: 0, // Open
  tokens: [] as { token: Address; decimals: number; usdPerToken: bigint }[], // InitConfig.tokens
};
const initData = encodeFunctionData({ abi: implArt.abi, functionName: "initialize", args: [initCfg] });
const salt = keccak256(stringToHex(`queuebit-devnet-${Date.now()}`));
const account = (await pub.readContract({
  address: factoryD.address,
  abi: factoryArt.abi,
  functionName: "predictAccount",
  args: [salt, implD.address, initData],
})) as Address;
const created = await call(
  factoryD.address,
  encodeFunctionData({ abi: factoryArt.abi, functionName: "createAccount", args: [salt, implD.address, initData] }),
  { gas: 10_000_000n },
);
if ((await pub.getCode({ address: account }))?.length === undefined) throw new Error("account not deployed");
results.account = { address: account, createHash: created.hash, createGas: created.gasUsed };
log("account", results.account);

// funding (anvil #0): the account, the tank, the vault and guardian EOAs (legacy txs for the role calls)
for (const [to, v] of [
  [account, parseEther("0.1")],
  [tank.address, parseEther("0.2")],
  [vault.address, parseEther("0.05")],
  [guardian.address, parseEther("0.05")],
] as const) {
  await pub.waitForTransactionReceipt({ hash: await legacy({ to, value: v }), timeout: 180_000 });
}

const read = <T>(functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address: account, abi: accountAbi, functionName, args: args as never }) as Promise<T>;

// ------------------------------------------------------------------------------------------- helpers ----------

type Call = { target: Address; value: bigint; data: Hex };
const hotExecute = (declaredUsd: bigint, calls: Call[]) =>
  encodeFunctionData({ abi: implArt.abi, functionName: "hotExecute", args: [declaredUsd, calls] });

async function hotTx(declaredUsd: bigint, calls: Call[]): Promise<FrameTx> {
  const nonceSeq = await rpc.node.getTransactionCount(account, "latest");
  let tx = hotSpendTx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: FEES,
    account,
    hotKey: hot.address, // signer = owner EOA explicitly (devnet review F10)
    tank: tank.address,
    verifyGas: VERIFY_GAS,
    tankGas: TANK_GAS,
    body: { data: hotExecute(declaredUsd, calls), ...BODY },
  });
  tx = await signTx(profile, tx, hotPriv, 0);
  return signTx(profile, tx, tankPriv, 1);
}

const BANNED: Record<number, string> = {
  0x31: "BALANCE", 0x3a: "GASPRICE", 0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER",
  0x44: "PREVRANDAO", 0x45: "GASLIMIT", 0x47: "SELFBALANCE", 0x48: "BASEFEE", 0x4a: "BLOBBASEFEE", 0x55: "SSTORE",
  0x5c: "TLOAD", 0x5d: "TSTORE", 0xa0: "LOG0", 0xa1: "LOG1", 0xa2: "LOG2", 0xa3: "LOG3", 0xa4: "LOG4",
  0xf0: "CREATE", 0xf5: "CREATE2", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
};

interface TraceCall {
  to?: string;
  type?: string;
  usedOpcodes?: Record<string, number>;
  accessedSlots?: {
    reads?: Record<string, unknown>;
    writes?: Record<string, unknown>;
    transientReads?: Record<string, unknown>;
    transientWrites?: Record<string, unknown>;
  };
  calls?: TraceCall[];
  outOfGas?: boolean;
}

/** Frame 0 (the account's VERIFY) from the ERC-7562 trace: banned opcodes, foreign storage, writes, transient. */
function traceSummary(trace: unknown) {
  if (!Array.isArray(trace)) return { error: "no trace", trace };
  const f0 = trace.find((f: { frameIndex?: number }) => f.frameIndex === 0) as { root?: TraceCall } | undefined;
  if (!f0?.root) return { error: "no frame-0 trace" };
  const own = new Set([account.toLowerCase(), implD.address.toLowerCase()]); // impl runs by DELEGATECALL
  const opcodes: Record<string, number> = {};
  const foreignReads: string[] = [];
  const callees = new Set<string>();
  let writes = 0;
  let transient = 0;
  let outOfGas = false;
  const walk = (c: TraceCall) => {
    if (c.to) callees.add(`${c.type ?? "?"}:${c.to}`);
    for (const [k, v] of Object.entries(c.usedOpcodes ?? {})) {
      const name = BANNED[Number(k)];
      if (name) opcodes[name] = (opcodes[name] ?? 0) + v;
    }
    const sl = c.accessedSlots;
    if (sl) {
      const n = Object.keys(sl.reads ?? {}).length;
      if (n && !own.has(String(c.to).toLowerCase())) foreignReads.push(`${c.to}:${n}`);
      writes += Object.keys(sl.writes ?? {}).length;
      transient += Object.keys(sl.transientReads ?? {}).length + Object.keys(sl.transientWrites ?? {}).length;
    }
    if (c.outOfGas) outOfGas = true;
    for (const x of c.calls ?? []) walk(x);
  };
  walk(f0.root);
  return {
    bannedOpcodes: opcodes,
    foreignStorageReads: foreignReads,
    writes,
    transient,
    outOfGas,
    callees: [...callees],
  };
}

function frameGas(frames: unknown): bigint | null {
  if (!Array.isArray(frames) || frames.length === 0) return null;
  const f = frames[0] as Record<string, unknown>;
  const g = f.gasUsed ?? f.executionGasUsed;
  return g === undefined ? null : BigInt(String(g));
}

async function simulate(label: string, tx: FrameTx, expectValid = true) {
  const sim = await rpc.node.simulateFrameTransaction(encodeTx(profile, tx), { trace: true });
  const trace = traceSummary(sim.erc7562Trace);
  // TXPARAM(MAX_COST) (0x06) is what VERIFY bounds (H3): record how it relates to maxFeePerGas x sum(frame limits),
  // i.e. whether the intrinsic (calldata) gas the payer is also charged for is included.
  const limitsSum = tx.frames.reduce((s, f) => s + BigInt(f.limits.execution) + BigInt(f.limits.state), 0n);
  const maxCost = sim.maxCost;
  const out = {
    canonicalMempoolValid: sim.valid,
    violation: sim.violation,
    prefixShape: sim.prefixShape,
    payer: sim.payer,
    maxCost,
    maxCostGas: maxCost === null ? null : maxCost / FEES.maxFeePerGas,
    frameLimitsSum: limitsSum,
    intrinsicGasInMaxCost: maxCost === null ? null : maxCost / FEES.maxFeePerGas - limitsSum,
    executionStatus: sim.executionStatus,
    executionError: sim.executionError,
    gasUsed: sim.gasUsed,
    frames: sim.frames,
    verifyFrameGas: frameGas(sim.frames),
    trace,
    traceError: sim.erc7562TraceError ?? null,
  };
  log(`simulate: ${label}`, out);
  if (!expectValid) return out;
  // The conformance gate (foundations review).
  if (!sim.valid) throw new Error(`${label}: not canonicalMempoolValid: ${sim.violation}`);
  if ("error" in trace) throw new Error(`${label}: ${trace.error}`);
  if (
    Object.keys(trace.bannedOpcodes).length ||
    trace.foreignStorageReads.length ||
    trace.writes ||
    trace.transient ||
    trace.outOfGas
  ) {
    throw new Error(`${label}: VERIFY trace gate failed: ${json(trace)}`);
  }
  if (out.verifyFrameGas !== null && out.verifyFrameGas >= 80_000n) {
    throw new Error(`${label}: VERIFY frame gas ${out.verifyFrameGas} >= 80k`);
  }
  return out;
}

const framesOf = (r: Awaited<ReturnType<typeof waitReceipt>>) =>
  r.frameReceipts.map((f) => ({ status: f.status, execution: f.gasUsed.execution, state: f.gasUsed.state }));

async function sendHot(label: string, tx: FrameTx) {
  const sim = await simulate(label, tx);
  const hash = await rpc.node.sendRawTransaction(encodeTx(profile, tx));
  if (hash !== txHash(profile, tx)) throw new Error("tx hash mismatch");
  const r = await waitReceipt(hash);
  const out = {
    via: "ethrex eth_sendRawTransaction (canonical public mempool)",
    hash,
    sigHash: sigHash(profile, tx),
    block: r.blockNumber,
    payer: r.payer,
    gasUsed: r.gasUsed,
    frames: framesOf(r),
    simulatedVerifyGas: sim.verifyFrameGas,
    trace: sim.trace,
  };
  log(label, out);
  return { r, out };
}

const bucket = async () => {
  const [available, , cap, fullAt] = await read<[bigint, number, bigint, number]>("getBucket");
  return { available, cap, fullAt };
};
const bal = (a: Address) => rpc.node.getBalance(a);

// ---------------------------------------------------------------------------------- 2. hot payment ----------
{
  const topUp = parseEther("0.001"); // $3: a tank top-up, allowlisted at initialize
  const before = { tank: await bal(tank.address), account: await bal(account), bucket: await bucket() };
  const { r, out } = await sendHot("hot payment (tank top-up)", await hotTx(3n * USD, [{ target: tank.address, value: topUp, data: "0x" }]));
  const after = { tank: await bal(tank.address), account: await bal(account), bucket: await bucket() };
  if (r.frameReceipts[2]?.status !== "success") throw new Error("hot SENDER frame failed");
  if (after.account !== before.account - topUp) throw new Error("account balance delta != top-up");
  if (after.bucket.available >= before.bucket.available) throw new Error("bucket not debited");
  results.hotPayment = { ...out, before, after, verifyGas: r.frameReceipts[0]?.gasUsed.execution };
}

// --------------------------------------------------------------------------- 3. registerHash + 1271 ----------
{
  const h = keccak256(stringToHex("queuebit devnet value-bearing typed data"));
  const block = await pub.getBlock();
  const expiry = Number(block.timestamp) + 3600;
  const reg = encodeFunctionData({
    abi: implArt.abi,
    functionName: "registerHash",
    args: [h, "0x0000000000000000000000000000000000000000", parseEther("0.0003"), expiry],
  });
  const { r, out } = await sendHot("registerHash", await hotTx(USD, [{ target: account, value: 0n, data: reg }]));
  if (r.frameReceipts[2]?.status !== "success") throw new Error("registerHash frame failed");
  const marker = (await read<Hex>("REGISTERED_MARKER")) as Hex;
  const isValid = (hash: Hex, sig: Hex) => read<Hex>("isValidSignature", [hash, sig]);
  const checks = {
    registeredEmpty: await isValid(h, "0x"),
    registeredMarker: await isValid(h, concatHex([marker, h])),
    registeredWrongMarker: await isValid(h, concatHex(["0xdeadbeef", h])),
    unregistered: await isValid(keccak256(stringToHex("not registered")), "0x"),
    sentinel7739: await isValid("0x7739773977397739773977397739773977397739773977397739773977397739", "0x"),
    expiry: await read<number>("registeredHashExpiry", [h]),
  };
  log("ERC-1271 via eth_call", checks);
  if (checks.registeredEmpty !== "0x1626ba7e" || checks.registeredMarker !== "0x1626ba7e") throw new Error("1271");
  if (checks.unregistered !== "0xffffffff" || checks.registeredWrongMarker !== "0xffffffff") throw new Error("1271");
  if (checks.sentinel7739 !== "0x77390001") throw new Error("7739 sentinel");
  results.registerHash = { ...out, hash: out.hash, registered: h, checks };
}

// ------------------------------------------------------------------------------------ 4. over-cap ----------
{
  const amount = parseEther("0.0026"); // $7.80 <= perTx $8, > what is left of the $10 bucket
  const before = { tank: await bal(tank.address), account: await bal(account), bucket: await bucket() };
  const tx = await hotTx(7_800_000n, [{ target: tank.address, value: amount, data: "0x" }]);
  const { r, out } = await sendHot("over-cap (admitted, SENDER reverts)", tx);
  const after = { tank: await bal(tank.address), account: await bal(account), bucket: await bucket() };
  if (r.frameReceipts[2]?.status === "success") throw new Error("over-cap SENDER frame succeeded!");
  if (after.account !== before.account) throw new Error("account balance moved on an over-cap tx");
  if (!(after.tank < before.tank)) throw new Error("tank did not pay");
  results.overCap = { ...out, before, after, tankPaid: before.tank - after.tank };
}

// -------------------------------------------------------------------------------------- 5. frozen ----------
{
  const setG = await call(
    account,
    encodeFunctionData({ abi: rolesArt.abi, functionName: "vaultSetGuardian", args: [guardian.address, true] }),
    { from: vault },
  );
  const freeze = await call(account, encodeFunctionData({ abi: rolesArt.abi, functionName: "guardianFreeze" }), {
    from: guardian,
  });
  const cfg = await read<{ hotFrozen: boolean; frozenUntil: number }>("getHotConfig");
  if (!cfg.hotFrozen) throw new Error("not frozen");
  const tx = await hotTx(USD, [{ target: tank.address, value: parseEther("0.0001"), data: "0x" }]);
  const sim = await simulate("frozen hot tx (must be rejected)", tx, false);
  if (sim.canonicalMempoolValid) throw new Error("frozen hot tx admitted by simulate");
  let submitError = "";
  try {
    await rpc.node.sendRawTransaction(encodeTx(profile, tx));
  } catch (e) {
    submitError = (e as Error).message;
  }
  if (!submitError) throw new Error("frozen hot tx accepted by eth_sendRawTransaction");
  log("frozen: submit rejected", submitError);
  const unfreeze = await call(account, encodeFunctionData({ abi: rolesArt.abi, functionName: "vaultUnfreeze" }), {
    from: vault,
  });
  results.frozen = {
    setGuardianHash: setG.hash,
    guardianFreezeHash: freeze.hash,
    guardianFreezeGas: freeze.gasUsed,
    frozenUntil: cfg.frozenUntil,
    simulate: { valid: sim.canonicalMempoolValid, violation: sim.violation, executionError: sim.executionError },
    submitError,
    vaultUnfreezeHash: unfreeze.hash,
  };
}

// ------------------------------------------------------------------------------ 6. recipient mode ----------
{
  const mode = async () => Number(await read<number>("recipientMode"));
  if ((await mode()) !== 0) throw new Error("account is not Open by default");
  const anyone = privateKeyToAccount(generatePrivateKey()).address; // never allowlisted
  if (await read<boolean>("isTarget", [anyone])) throw new Error("fresh address is a target?");
  const pay = parseEther("0.0005"); // $1.50; the bucket refills continuously, so wait for room if needed
  for (let i = 0; i < 60 && (await bucket()).available < 2n * USD; i++) await new Promise((r) => setTimeout(r, 5_000));
  const before = { anyone: await bal(anyone), bucket: await bucket() };
  const { r, out } = await sendHot("Open mode: hot payment to an arbitrary recipient", await hotTx(2n * USD, [{ target: anyone, value: pay, data: "0x" }]));
  if (r.frameReceipts[2]?.status !== "success") throw new Error("Open-mode payment SENDER frame failed");
  if ((await bal(anyone)) !== before.anyone + pay) throw new Error("recipient did not receive the payment");
  const tighten = await call(
    account,
    encodeFunctionData({ abi: rolesArt.abi, functionName: "vaultSetRecipientMode", args: [1] }),
    { from: vault },
  );
  if ((await mode()) !== 1) throw new Error("not Strict after vaultSetRecipientMode(Strict)");
  const strictTx = await hotTx(2n * USD, [{ target: anyone, value: pay, data: "0x" }]);
  const strictSim = await simulate("Strict mode: same payment (VERIFY-valid, SENDER must fail; not submitted)", strictTx);
  const senderOk = (strictSim.frames as { succeeded?: boolean; status?: string }[] | undefined)?.[2];
  if (senderOk && (senderOk.succeeded === true || senderOk.status === "success")) {
    throw new Error("Strict mode SENDER frame would succeed for a non-allowlisted recipient");
  }
  let loosenError = "";
  try {
    await pub.simulateContract({ account: vault, address: account, abi: accountAbi, functionName: "vaultSetRecipientMode", args: [0] as never });
  } catch (e) {
    loosenError = (e as Error).message.includes("MustQueue") ? "MustQueue" : (e as Error).message.slice(0, 200);
  }
  if (loosenError !== "MustQueue") throw new Error(`Strict -> Open directly: expected MustQueue, got ${loosenError}`);
  results.recipientMode = {
    openPayment: { ...out, recipient: anyone, amount: pay, before, afterBucket: await bucket() },
    tightenHash: tighten.hash,
    tightenGas: tighten.gasUsed,
    strictSimulation: { valid: strictSim.canonicalMempoolValid, frames: strictSim.frames, verifyGas: strictSim.verifyFrameGas },
    strictToOpenDirect: loosenError,
  };
}

// --------------------------------------------------------------------------- 7. bound derivation ----------
{
  const dep = JSON.parse(readFileSync(new URL("../../../devnet/deploy/addresses.local.json", import.meta.url), "utf8"));
  const rsf = dep.contracts.RoleSignerFactory.address as Address;
  const c13 = dep.contracts.C13Verifier.address as Address;
  const rsfArt = artifact("RoleSignerFactory.sol", "RoleSignerFactory");
  const vaultPk = keccak256(stringToHex(`queuebit-devnet-bound-vault-pk-${Date.now()}`));
  const vaultPayer = privateKeyToAccount(generatePrivateKey()).address;
  const bSalt = keccak256(stringToHex(`queuebit-devnet-bound-${Date.now()}`));
  const cfg = {
    ...initCfg,
    roleSignerFactory: rsf,
    vault: { salt: bSalt, pk: vaultPk, verifier: c13, payerKey: vaultPayer },
    vaultSigner: ZERO,
  };
  const bInit = encodeFunctionData({ abi: implArt.abi, functionName: "initialize", args: [cfg] });
  const bAccount = (await pub.readContract({
    address: factoryD.address,
    abi: factoryArt.abi,
    functionName: "predictAccount",
    args: [bSalt, implD.address, bInit],
  })) as Address;
  const bCreated = await call(
    factoryD.address,
    encodeFunctionData({ abi: factoryArt.abi, functionName: "createAccount", args: [bSalt, implD.address, bInit] }),
    { gas: 10_000_000n },
  );
  const expected = (await pub.readContract({
    address: rsf,
    abi: rsfArt.abi,
    functionName: "predictRoleSigner",
    args: [bSalt, 1, bAccount, vaultPk, c13, vaultPayer],
  })) as Address;
  const [stored] = (await pub.readContract({ address: bAccount, abi: accountAbi, functionName: "getRoles" })) as [Address];
  if (stored.toLowerCase() !== expected.toLowerCase()) throw new Error(`bound vault ${stored} != predicted ${expected}`);
  results.boundDerivation = { account: bAccount, createHash: bCreated.hash, createGas: bCreated.gasUsed, vaultSigner: stored };
  log("bound derivation", results.boundDerivation);
}

results.finishedAt = new Date().toISOString();
writeFileSync(new URL("./last-run.json", import.meta.url), json(results));
log("ACCOUNT DEVNET OK", {
  verifyGas: (results.hotPayment as { verifyGas: unknown }).verifyGas,
  hotPayment: (results.hotPayment as { hash: unknown }).hash,
  registerHash: (results.registerHash as { hash: unknown }).hash,
  overCap: (results.overCap as { hash: unknown }).hash,
  openPayment: (results.recipientMode as { openPayment: { hash: unknown } }).openPayment.hash,
  boundVault: (results.boundDerivation as { vaultSigner: unknown }).vaultSigner,
});
