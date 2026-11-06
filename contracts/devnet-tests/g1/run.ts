// Phase-1 gate G1 on the LOCAL devnet (plan §5.2; devnet/README.md; `cd devnet && ./up.sh`, and for (g)
// `./patched-sidecar/up-patched.sh`).
//
//   cd contracts && forge build && cd devnet-tests/g1 && bun install && bun run test
//
// Deploys the real stack: LeakedAccountRoles + LeakedAccountImpl (ERC8421_WORKSHOP, per-gas MAX_FEE) behind an
// AccountFactory proxy, C13Verifier, RoleSignerFactory (clone implementation), and a GuardianSigner. The account is
// created in bound mode: its InitConfig carries the vault's and the recovery's C13 public keys, and `initialize`
// DERIVES both signers (`predictRoleSigner(salt, role, account, pk, C13Verifier, payerKey)`); the VaultSigner and
// RecoverySigner clones, bound to the account, are deployed afterwards by an unrelated party (lazy, deterministic).
// C13 keys and signatures from @leaked/pq-signer. Then:
//   (a) an Open-mode hot payment to an arbitrary (never allowlisted) recipient, public mempool;
//   (b) Path B vault actions through VaultSigner.executePQ: an instant tightening (lower daily cap) and a vault spend
//       within the instant allowance, public mempool;
//   (c) a forged vault PQ signature: Path B is mined with its SENDER frame reverted and nothing changed; Path A is
//       rejected in VERIFY (simulated only);
//   (d) an over-cap hot tx: SENDER reverts OverCap, only the tank pays;
//   (e) a loosening queued by the vault, cancelled by the RecoverySigner (recovery priority);
//   (f) a GuardianSigner freeze blocks the hot path; vault unfreeze; a short vault freeze (vaultExtendFreeze) that
//       expires and is cleared by a hot `clearExpiredFreeze()` tx;
//   (g) VaultSigner stakes (Path B), then a Path A vault action through the BUDGET-010 sidecar (:14340).
// Every frame tx is first run through ethrex_simulateFrameTransaction {trace:true} and must pass the VERIFY-trace gate
// (frame 0: no banned opcode, no LOG, no transient storage, no writes, no storage outside the sender and its
// implementation; frame-0 gas recorded). Per the poisoned-lane note (IMPLEMENTATION-NOTES, M4), a tx that ethrex's
// simulation rejects is never offered to eth_sendRawTransaction. Results: stdout and ./last-run.json.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bytesToHex,
  decodeEventLog,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  parseEther,
  stringToHex,
  toFunctionSelector,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  accountVerifyData,
  encodeTx,
  getProfile,
  hotSpendTx,
  newTx,
  roleSignerPathATx,
  roleSignerPathBTx,
  secp256k1Entry,
  selfVerify,
  senderFrame,
  setSignature,
  sigHash,
  signTx,
  txHash,
  type FrameTx,
  type FrameTxReceipt,
} from "@leaked/frames";
import { SIG_LENGTH, keygen, sign } from "@leaked/pq-signer";
import {
  STAKING_REGISTRY,
  artifact,
  budgetRpc,
  call,
  deploy,
  deployer,
  fundDeployer,
  json,
  legacy,
  log,
  pub,
  rpc,
  waitForTimestamp,
  waitReceipt,
} from "./lib.js";

const profile = getProfile("ethrex-eip8141-tracer");
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const USD = 1_000_000n;
const ETH_PRICE = 3_000n * USD;
const DEVNET_ERC8421_WORKSHOP = 0;
const TXPARAM_MAX_COST = 6;
const SIGNER_MAX_FEE = parseEther("0.05");
const HOT_VERIFY_GAS = 80_000n; // + tank 10,000 + 2 x 2,800 <= MAX_VERIFY_GAS 100,000
const TANK_GAS = 10_000n;
const HOT_BODY = { execution: 300_000n, state: 200_000n };
const PATH_B_VERIFY_GAS = 90_000n; // + 2,800 + 100 <= 100,000
const PATH_A_VERIFY_GAS = 300_000n; // staked BUDGET-010 entity: <= 1,000,000
const ROLE_BODY = { execution: 600_000n, state: 400_000n };
const GUARDIAN_VERIFY_GAS = 60_000n;
const KIND_LOOSEN = 1;
const OP_CANCELLED = 3;
const CLONE_GAS_TARGET = 300_000n;

const results: Record<string, unknown> = { startedAt: new Date().toISOString(), gate: "G1 (plan §5.2)" };
const checklist: Record<string, string> = {};

const verifierArt = artifact("C13Verifier.sol", "C13Verifier");
const rolesArt = artifact("LeakedAccountRoles.sol", "LeakedAccountRoles");
const implArt = artifact("LeakedAccountImpl.sol", "LeakedAccountImpl");
const accFactoryArt = artifact("AccountFactory.sol", "AccountFactory");
const rsFactoryArt = artifact("RoleSignerFactory.sol", "RoleSignerFactory");
const signerArt = artifact("PQRoleSigner.sol", "PQRoleSigner");
const guardianArt = artifact("GuardianSigner.sol", "GuardianSigner");
const accountAbi = [
  ...implArt.abi,
  ...rolesArt.abi.filter((x) => (x as { type: string }).type === "function"),
] as Abi;

// ---------------------------------------------------------------------------------------------- setup ----------

const chainId = await rpc.node.chainId();
if (chainId !== 1337n) throw new Error(`expected chain 1337, got ${chainId}`);
results.node = { chainId, client: await rpc.node.clientVersion(), block: await rpc.node.blockNumber() };
log("node", results.node);
results.fundDeployer = { deployer: deployer.address, anvil0Tx: await fundDeployer() };

// Keys. PQ keys are deterministic test material (public seeds: never use for funds); ECDSA keys are fresh per run.
const pqSeed = (tag: string) =>
  hexToBytes(
    `${keccak256(stringToHex(`leaked/devnet-tests/g1/${tag}/0`))}${keccak256(stringToHex(`leaked/devnet-tests/g1/${tag}/1`)).slice(2)}` as Hex,
  );
const vaultPQ = keygen(pqSeed("vault"), { role: "vault" });
const recoveryPQ = keygen(pqSeed("recovery"), { role: "recovery" });
const hotPriv = generatePrivateKey();
const tankPriv = generatePrivateKey();
const vaultPayerPriv = generatePrivateKey();
const recoveryPayerPriv = generatePrivateKey();
const guardianPriv = generatePrivateKey();
const hot = privateKeyToAccount(hotPriv);
const tank = privateKeyToAccount(tankPriv);
const vaultPayer = privateKeyToAccount(vaultPayerPriv);
const recoveryPayer = privateKeyToAccount(recoveryPayerPriv);
const guardianKey = privateKeyToAccount(guardianPriv);
const recipient = privateKeyToAccount(generatePrivateKey()).address;
results.keys = {
  hot: hot.address,
  tank: tank.address,
  vaultPayer: vaultPayer.address,
  recoveryPayer: recoveryPayer.address,
  guardianKey: guardianKey.address,
  recipient,
  vaultPk: bytesToHex(vaultPQ.publicKey),
  recoveryPk: bytesToHex(recoveryPQ.publicKey),
};

const verifierD = await deploy(verifierArt, [], 10_000_000n);
const rolesD = await deploy(rolesArt, [], 40_000_000n);
const implD = await deploy(implArt, [DEVNET_ERC8421_WORKSHOP, true, rolesD.address], 45_000_000n);
const accFactoryD = await deploy(accFactoryArt, [], 10_000_000n);
const rsFactoryD = await deploy(
  rsFactoryArt,
  [DEVNET_ERC8421_WORKSHOP, TXPARAM_MAX_COST, STAKING_REGISTRY, SIGNER_MAX_FEE],
  40_000_000n,
);
const signerImpl = (await pub.readContract({
  address: rsFactoryD.address,
  abi: rsFactoryArt.abi,
  functionName: "implementation",
})) as Address;
results.deployments = {
  C13Verifier: verifierD,
  LeakedAccountRoles: rolesD,
  LeakedAccountImpl: implD,
  AccountFactory: accFactoryD,
  RoleSignerFactory: { ...rsFactoryD, implementation: signerImpl },
};
log("deployments", results.deployments);

const runSalt = keccak256(stringToHex(`leaked/devnet-tests/g1/${Date.now()}`));

/** createRoleSigner via a legacy tx; returns the clone and the creating tx's gas (the < 300k target). */
async function createClone(role: number, account: Address, pk: Hex, payer: Address, value: bigint) {
  const args = [runSalt, role, account, pk, verifierD.address, payer] as const;
  const predicted = (await pub.readContract({
    address: rsFactoryD.address,
    abi: rsFactoryArt.abi,
    functionName: "predictRoleSigner",
    args,
  })) as Address;
  const c = await call(
    rsFactoryD.address,
    encodeFunctionData({ abi: rsFactoryArt.abi, functionName: "createRoleSigner", args }),
    { value, gas: 2_000_000n },
  );
  const code = (await pub.getCode({ address: predicted })) ?? "0x";
  if (code === "0x") throw new Error("clone not deployed at the predicted address");
  return { address: predicted, tx: c.hash, gasUsed: c.gasUsed, code };
}

// Bound mode: the account's address commits to the vault's and recovery's PQ parameters (initialize data) and
// initialize derives the signer addresses from them and the account's own address: no cycle, both counterfactual.
const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const initCfg = {
  hotKey: hot.address,
  roleSignerFactory: rsFactoryD.address,
  vault: { salt: runSalt, pk: bytesToHex(vaultPQ.publicKey), verifier: verifierD.address, payerKey: vaultPayer.address },
  recovery: { salt: runSalt, pk: bytesToHex(recoveryPQ.publicKey), verifier: verifierD.address, payerKey: recoveryPayer.address },
  vaultSigner: ZERO,
  recoverySigner: ZERO,
  tank: tank.address,
  capUsdPerDay: 10n * USD,
  perTxMaxUsd: 8n * USD,
  maxFeeWeiPerTx: parseEther("0.01"),
  maxPriorityFeePerGas: 2_000_000_000n,
  maxHotFrames: 4,
  selfPay: false,
  timelockDelay: 3600, // MIN_TIMELOCK
  timelockThresholdUsd: 100n * USD,
  ethUsdPrice: ETH_PRICE,
  recipientMode: 0, // Open (the default)
  tokens: [] as { token: Address; decimals: number; usdPerToken: bigint }[], // InitConfig.tokens (none here)
};
const initData = encodeFunctionData({ abi: implArt.abi, functionName: "initialize", args: [initCfg] });
const accSalt = keccak256(stringToHex(`leaked/devnet-tests/g1/account/${runSalt}`));
const account = (await pub.readContract({
  address: accFactoryD.address,
  abi: accFactoryArt.abi,
  functionName: "predictAccount",
  args: [accSalt, implD.address, initData],
})) as Address;
const createdAcc = await call(
  accFactoryD.address,
  encodeFunctionData({ abi: accFactoryArt.abi, functionName: "createAccount", args: [accSalt, implD.address, initData] }),
  { gas: 10_000_000n },
);

// The signers initialize derived: nothing deployed there yet.
const [derivedVault, derivedRecovery] = (await pub.readContract({
  address: account,
  abi: rolesArt.abi,
  functionName: "getRoles",
})) as readonly [Address, Address, Address, number, number];
const derivedHadCode = ((await pub.getCode({ address: derivedVault })) ?? "0x") !== "0x";
if (derivedHadCode) throw new Error("derived VaultSigner already has code before its lazy deployment");
// Lazy deployment of both clones (bound to the account; account arg read from their code by EXTCODECOPY) by a party
// unrelated to the account (the G1 deployer key): createRoleSigner is permissionless and deterministic.
const vaultC = await createClone(1, account, bytesToHex(vaultPQ.publicKey), vaultPayer.address, parseEther("1"));
const recoveryC = await createClone(2, account, bytesToHex(recoveryPQ.publicKey), recoveryPayer.address, parseEther("1"));
const vaultSigner = vaultC.address;
const recoverySigner = recoveryC.address;
if (vaultSigner !== derivedVault || recoverySigner !== derivedRecovery) {
  throw new Error(`lazy clones ${vaultSigner}/${recoverySigner} != derived ${derivedVault}/${derivedRecovery}`);
}

const guardianD = await deploy(
  guardianArt,
  [DEVNET_ERC8421_WORKSHOP, account, guardianKey.address, parseEther("0.05"), TXPARAM_MAX_COST],
  40_000_000n,
);
const guardian = guardianD.address;

for (const [to, v] of [
  [account, parseEther("0.2")],
  [tank.address, parseEther("0.3")],
  [guardian, parseEther("0.2")],
] as const) {
  await pub.waitForTransactionReceipt({ hash: await legacy({ to, value: v }), timeout: 180_000 });
}

results.wiring = {
  account: { address: account, createTx: createdAcc.hash, createGas: createdAcc.gasUsed },
  vaultSigner: {
    address: vaultSigner,
    mode: "bound to the account, derived by initialize, clone deployed lazily",
    derivedByInitialize: derivedVault,
    codeBeforeLazyDeploy: derivedHadCode,
    tx: vaultC.tx,
    gasUsed: vaultC.gasUsed,
  },
  recoverySigner: {
    address: recoverySigner,
    mode: "bound to the account, derived by initialize, clone deployed lazily",
    derivedByInitialize: derivedRecovery,
    tx: recoveryC.tx,
    gasUsed: recoveryC.gasUsed,
  },
  guardianSigner: { address: guardian, tx: guardianD.hash, gasUsed: guardianD.gasUsed },
};
log("wiring", results.wiring);

const readAcc = <T>(functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address: account, abi: accountAbi, functionName, args: args as never }) as Promise<T>;
const readSigner = <T>(address: Address, functionName: string) =>
  pub.readContract({ address, abi: signerArt.abi, functionName }) as Promise<T>;

// ----------------------------------------------------------------------- clone checks (task 1, static) ----------

{
  // Deployed clone runtime = Solady ERC-1167-with-args proxy (45 bytes, delegating to the implementation) ‖ args.
  const implHex = signerImpl.slice(2).toLowerCase();
  const proxy = `0x363d3d373d3d3d363d73${implHex}5af43d82803e903d91602b57fd5bf3`;
  const lintClone = (code: Hex) => code.toLowerCase().startsWith(proxy) && (code.length - 2) / 2 === 0x2d + 105;
  const argsOf = async (s: Address) => ({
    account: await readSigner<Address>(s, "account"),
    role: await readSigner<number>(s, "role"),
    pk: await readSigner<Hex>(s, "pk"),
    verifier: await readSigner<Address>(s, "verifier"),
    sigLength: await readSigner<bigint>(s, "sigLength"),
    payerKey: await readSigner<Address>(s, "payerKey"),
    maxFee: await readSigner<bigint>(s, "maxFee"),
    feeParam: await readSigner<number>(s, "feeParam"),
  });
  const v = await argsOf(vaultSigner);
  const r = await argsOf(recoverySigner);
  // Implementation bytecode: the same pre-filter as devnet-tests/pq/lint-verify-opcodes.py over the deployed code.
  const implCode = (await pub.getCode({ address: signerImpl })) ?? "0x";
  const lintImpl = lintOpcodes(implCode);
  const clones = {
    vaultCodeIsProxyToImpl: lintClone(vaultC.code),
    recoveryCodeIsProxyToImpl: lintClone(recoveryC.code),
    vault: v,
    recovery: r,
    implementationOpcodeLint: lintImpl,
    instanceGas: { vault: vaultC.gasUsed, recovery: recoveryC.gasUsed, target: CLONE_GAS_TARGET, bareCreateFloor: await bareCreateFloor(vaultC.code) },
  };
  results.clones = clones;
  log("clones", clones);
  if (!clones.vaultCodeIsProxyToImpl || !clones.recoveryCodeIsProxyToImpl) throw new Error("clone code shape");
  if (v.account !== account || r.account !== account) throw new Error("clone account arg");
  if (v.role !== 1 || r.role !== 2 || v.sigLength !== BigInt(SIG_LENGTH) || v.verifier.toLowerCase() !== verifierD.address.toLowerCase()) {
    throw new Error("clone args");
  }
  if (v.pk !== bytesToHex(vaultPQ.publicKey) || v.payerKey !== vaultPayer.address || v.maxFee !== SIGNER_MAX_FEE) {
    throw new Error("clone args/storage");
  }
  if (v.feeParam !== TXPARAM_MAX_COST) throw new Error("fee param");
  // Execution-side SSTOREs (initialize + 3 setters) are expected; anything else banned is not.
  const unexpected = Object.keys(lintImpl).filter((k) => k !== "SSTORE" && k !== "INVALID");
  if (unexpected.length || (lintImpl.INVALID ?? 0) > 1) throw new Error(`implementation lint: ${json(lintImpl)}`);
}

/**
 * eth_estimateGas of a plain CREATE that deploys exactly `runtime` (and of an empty CREATE): the Amsterdam+ floor for
 * any contract of that size (new account + per-byte code state gas), independent of the factory.
 */
async function bareCreateFloor(runtime: Hex) {
  const n = (runtime.length - 2) / 2;
  const init = (rt: string, len: number) => `0x61${len.toString(16).padStart(4, "0")}80600c6000396000f3${rt}` as Hex;
  const est = (data: Hex) => pub.estimateGas({ account: deployer.address, data });
  return { codeBytes: n, create: await est(init(runtime.slice(2), n)), emptyCreate: await est(init("", 0)) };
}

/** Banned validation-prefix opcodes in runtime code, plus GAS not directly followed by a *CALL (pre-filter). */
function lintOpcodes(code: Hex): Record<string, number> {
  const b = hexToBytes(code);
  const ban: Record<number, string> = {
    0x3a: "GASPRICE", 0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER", 0x44: "PREVRANDAO",
    0x45: "GASLIMIT", 0x48: "BASEFEE", 0x4a: "BLOBBASEFEE", 0x4b: "SLOTNUM", 0xf0: "CREATE", 0xf5: "CREATE2",
    0xf6: "SETDELEGATE", 0xff: "SELFDESTRUCT", 0x31: "BALANCE", 0x47: "SELFBALANCE", 0x55: "SSTORE", 0x5c: "TLOAD",
    0x5d: "TSTORE", 0xfe: "INVALID",
  };
  const calls = new Set([0xf1, 0xf2, 0xf4, 0xfa]);
  const hits: Record<string, number> = {};
  for (let i = 0; i < b.length; i++) {
    const op = b[i]!;
    if (op >= 0x60 && op <= 0x7f) {
      i += op - 0x5f;
      continue;
    }
    let name = ban[op];
    if (op === 0x5a && (i + 1 >= b.length || !calls.has(b[i + 1]!))) name = "GAS(not before CALL)";
    if (name) hits[name] = (hits[name] ?? 0) + 1;
  }
  return hits;
}

// ------------------------------------------------------------------------------------ the trace gate ----------

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

interface TraceGate {
  bannedOpcodes: Record<string, number>;
  foreignStorageReads: string[];
  writes: number;
  transient: number;
  outOfGas: boolean;
  delegateCallees: string[];
}

/** Frame 0 (the sender's VERIFY) of the ERC-7562 trace. `own`: the sender and the code it DELEGATECALLs. */
function traceGate(trace: unknown, own: Address[]): TraceGate | { error: string } {
  if (!Array.isArray(trace)) return { error: "no trace" };
  const f0 = trace.find((f: { frameIndex?: number }) => f.frameIndex === 0) as { root?: TraceCall } | undefined;
  if (!f0?.root) return { error: "no frame-0 trace" };
  const ownSet = new Set(own.map((a) => a.toLowerCase()));
  const g: TraceGate = { bannedOpcodes: {}, foreignStorageReads: [], writes: 0, transient: 0, outOfGas: false, delegateCallees: [] };
  const walk = (c: TraceCall) => {
    if (c.type === "DELEGATECALL" && c.to) g.delegateCallees.push(c.to);
    for (const [k, v] of Object.entries(c.usedOpcodes ?? {})) {
      const name = BANNED[Number(k)];
      if (name) g.bannedOpcodes[name] = (g.bannedOpcodes[name] ?? 0) + v;
    }
    const sl = c.accessedSlots;
    if (sl) {
      const n = Object.keys(sl.reads ?? {}).length;
      if (n && !ownSet.has(String(c.to).toLowerCase())) g.foreignStorageReads.push(`${c.to}:${n}`);
      g.writes += Object.keys(sl.writes ?? {}).length;
      g.transient += Object.keys(sl.transientReads ?? {}).length + Object.keys(sl.transientWrites ?? {}).length;
    }
    if (c.outOfGas) g.outOfGas = true;
    for (const x of c.calls ?? []) walk(x);
  };
  walk(f0.root);
  g.delegateCallees = [...new Set(g.delegateCallees)];
  return g;
}

function frameGas(frames: unknown, i = 0): bigint | null {
  if (!Array.isArray(frames) || frames.length <= i) return null;
  const f = frames[i] as Record<string, unknown>;
  const v = f.gasUsed ?? f.executionGasUsed;
  return v === undefined ? null : BigInt(String(v));
}

type Expect = "valid" | "invalid" | "overBudget";

/**
 * ethrex_simulateFrameTransaction {trace:true} + the gate. `valid`: canonicalMempoolValid; `overBudget`: only the
 * MAX_VERIFY_GAS violation (Path A); `invalid`: must be rejected (never submitted). The frame-0 trace must be clean in
 * every case it exists; for valid/overBudget it must exist.
 */
async function simulate(label: string, tx: FrameTx, own: Address[], expect: Expect, maxVerifyGas?: bigint) {
  const sim = await rpc.node.simulateFrameTransaction(encodeTx(profile, tx), { trace: true });
  const gate = traceGate(sim.erc7562Trace, own);
  const out = {
    canonicalMempoolValid: sim.valid,
    violation: sim.violation,
    prefixShape: sim.prefixShape,
    payer: sim.payer,
    maxCost: sim.maxCost,
    executionStatus: sim.executionStatus,
    executionError: sim.executionError,
    gasUsed: sim.gasUsed,
    verifyFrameGas: frameGas(sim.frames, 0),
    frames: sim.frames,
    gate,
    traceError: sim.erc7562TraceError ?? null,
  };
  log(`simulate: ${label}`, out);
  const fail = (why: string) => {
    throw new Error(`${label}: ${why}: ${json(out)}`);
  };
  if (expect === "valid" && !sim.valid) fail("not canonicalMempoolValid");
  if (expect === "overBudget" && (sim.valid || !/MAX_VERIFY_GAS/.test(sim.violation ?? ""))) fail("expected only MAX_VERIFY_GAS");
  if (expect === "invalid" && sim.valid) fail("expected rejection");
  if ("error" in gate) {
    if (expect !== "invalid") fail(gate.error);
  } else if (
    Object.keys(gate.bannedOpcodes).length || gate.foreignStorageReads.length || gate.writes || gate.transient || gate.outOfGas
  ) {
    fail("VERIFY trace gate failed");
  }
  if (maxVerifyGas !== undefined && expect !== "invalid" && (out.verifyFrameGas === null || out.verifyFrameGas >= maxVerifyGas)) {
    fail(`VERIFY frame gas ${out.verifyFrameGas} >= ${maxVerifyGas}`);
  }
  return out;
}

const framesOf = (r: FrameTxReceipt) =>
  r.frameReceipts.map((f) => ({ status: f.status, execution: f.gasUsed.execution, state: f.gasUsed.state, logs: f.logs.length }));

type Sim = Awaited<ReturnType<typeof simulate>>;
const simBrief = (s: Sim) => ({
  canonicalMempoolValid: s.canonicalMempoolValid,
  violation: s.violation,
  verifyFrameGas: s.verifyFrameGas,
  executionStatus: s.executionStatus,
  executionError: s.executionError,
  gate: s.gate,
});

/** Public mempool: ethrex eth_sendRawTransaction, after a valid simulation. */
async function sendPublic(label: string, tx: FrameTx, own: Address[], maxVerifyGas?: bigint) {
  const sim = await simulate(label, tx, own, "valid", maxVerifyGas);
  const hash = await rpc.node.sendRawTransaction(encodeTx(profile, tx));
  if (hash !== txHash(profile, tx)) throw new Error(`${label}: tx hash mismatch`);
  const r = await waitReceipt(hash);
  const out = {
    via: "ethrex eth_sendRawTransaction (canonical public mempool)",
    hash,
    block: r.blockNumber,
    payer: r.payer,
    gasUsed: r.gasUsed,
    frames: framesOf(r),
    verifyGas: r.frameReceipts[0]?.gasUsed.execution,
    simulate: simBrief(sim),
  };
  log(label, out);
  return { r, out };
}

// --------------------------------------------------------------------------------------- builders ----------

type CallT = { target: Address; value: bigint; data: Hex };
const enc = (functionName: string, args: readonly unknown[] = []) =>
  encodeFunctionData({ abi: accountAbi, functionName, args: args as never });
const hotExecute = (declaredUsd: bigint, calls: CallT[]) => enc("hotExecute", [declaredUsd, calls]);

async function hotTx(data: Hex): Promise<FrameTx> {
  const nonceSeq = await rpc.node.getTransactionCount(account, "latest");
  let tx = hotSpendTx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: FEES,
    account,
    hotKey: hot.address,
    tank: tank.address,
    verifyGas: HOT_VERIFY_GAS,
    tankGas: TANK_GAS,
    body: { data, ...HOT_BODY },
  });
  tx = await signTx(profile, tx, hotPriv, 0);
  return signTx(profile, tx, tankPriv, 1);
}
const HOT_OWN = [account, implD.address];

interface RoleCtx {
  name: string;
  address: Address;
  payerPriv: Hex;
  payer: Address;
  secretKey: Uint8Array;
}
const VAULT: RoleCtx = { name: "VaultSigner", address: vaultSigner, payerPriv: vaultPayerPriv, payer: vaultPayer.address, secretKey: vaultPQ.secretKey };
const RECOVERY: RoleCtx = {
  name: "RecoverySigner",
  address: recoverySigner,
  payerPriv: recoveryPayerPriv,
  payer: recoveryPayer.address,
  secretKey: recoveryPQ.secretKey,
};
const roleOwn = (c: RoleCtx) => [c.address, signerImpl];

const executePQ = (target: Address, data: Hex) =>
  encodeFunctionData({ abi: signerArt.abi, functionName: "executePQ", args: [0n, target, data] });
const relay = (target: Address, data: Hex) =>
  encodeFunctionData({ abi: signerArt.abi, functionName: "relay", args: [target, data] });

const signMs: number[] = [];
function pqSign(c: RoleCtx, tx: FrameTx, forge: boolean): FrameTx {
  const t0 = performance.now();
  const sig = sign(c.secretKey, hexToBytes(sigHash(profile, tx)));
  signMs.push(Math.round(performance.now() - t0));
  if (forge) sig[100] ^= 0x01;
  return setSignature(profile, tx, 0, bytesToHex(sig));
}

async function pathBTx(c: RoleCtx, target: Address, data: Hex, forge = false): Promise<FrameTx> {
  const nonceSeq = await rpc.node.getTransactionCount(c.address, "latest");
  let tx = roleSignerPathBTx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: FEES,
    roleSigner: c.address,
    sigLength: SIG_LENGTH,
    verifyGas: PATH_B_VERIFY_GAS,
    payerKey: c.payer,
    body: { data: executePQ(target, data), ...ROLE_BODY },
  });
  tx = pqSign(c, tx, forge);
  return signTx(profile, tx, c.payerPriv, 1);
}

async function pathATx(c: RoleCtx, target: Address, data: Hex, forge = false): Promise<FrameTx> {
  const nonceSeq = await rpc.node.getTransactionCount(c.address, "latest");
  const tx = roleSignerPathATx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: FEES,
    roleSigner: c.address,
    sigLength: SIG_LENGTH,
    verifyGas: PATH_A_VERIFY_GAS,
    body: { data: relay(target, data), ...ROLE_BODY },
  });
  return pqSign(c, tx, forge);
}

/** A Path B role action, public mempool; asserts the SENDER frame (executePQ -> account) succeeded. */
async function pathB(label: string, c: RoleCtx, target: Address, data: Hex) {
  const { r, out } = await sendPublic(label, await pathBTx(c, target, data), roleOwn(c), 100_000n - 2_900n);
  if (r.frameReceipts[1]?.status !== "success") throw new Error(`${label}: SENDER frame failed: ${json(out)}`);
  return { r, out };
}

const hotCfg = () =>
  readAcc<{ hotFrozen: boolean; frozenUntil: number; perTxMaxUsd: bigint; maxFeeWeiPerTx: bigint }>("getHotConfig");
const bucket = async () => {
  const [available, , cap] = await readAcc<[bigint, number, bigint, number]>("getBucket");
  return { available, cap };
};
const bal = (a: Address) => rpc.node.getBalance(a);

// ------------------------------------------------------------------- role wiring via Path B (setup) ----------

{
  // Both role signers were wired by initialize (bound mode): only the guardian is added here.
  const b = await pathB("setup: vault enables the GuardianSigner", VAULT, account, enc("vaultSetGuardian", [guardian, true]));
  const roles = await readAcc<readonly [Address, Address, Address, number, number]>("getRoles");
  if (roles[0] !== vaultSigner || roles[1] !== recoverySigner) throw new Error(`roles not wired: ${json(roles)}`);
  results.setup = { vaultSetGuardian: b.out, getRoles: roles };
}

// -------------------------------------------------------------------------------- (a) hot payment ----------
{
  // RecipientMode.Open (the default): an everyday payment to an address the vault never allowlisted.
  const payee = privateKeyToAccount(generatePrivateKey()).address;
  const mode = Number(await readAcc<number>("recipientMode"));
  const payeeIsTarget = await readAcc<boolean>("isTarget", [payee]);
  if (mode !== 0 || payeeIsTarget) throw new Error(`(a) expected Open mode and an unlisted payee: ${mode} ${payeeIsTarget}`);
  const pay = parseEther("0.001"); // $3
  const before = { payee: await bal(payee), account: await bal(account), bucket: await bucket() };
  const { r, out } = await sendPublic(
    "(a) Open-mode hot payment to an arbitrary recipient",
    await hotTx(hotExecute(3n * USD, [{ target: payee, value: pay, data: "0x" }])),
    HOT_OWN,
    80_000n,
  );
  const after = { payee: await bal(payee), account: await bal(account), bucket: await bucket() };
  if (r.frameReceipts[2]?.status !== "success") throw new Error("(a) SENDER frame failed");
  if (after.account !== before.account - pay || after.payee !== before.payee + pay) throw new Error("(a) balance deltas != payment");
  if (before.bucket.available - after.bucket.available < 2_900_000n) throw new Error("(a) bucket not debited");
  results.a_hotPayment = { ...out, recipientMode: "Open", payee, payeeIsTarget, before, after };
  checklist.a = `PASS: Open-mode hot payment to an arbitrary recipient ${payee} mined via public mempool (${out.hash}); VERIFY ${out.verifyGas} gas; bucket debited`;
}

// ------------------------------------------------------------------------ (b) Path B vault actions ----------
{
  const tighten = await pathB("(b1) vault: instant tightening, daily cap $10 -> $6", VAULT, account, enc("vaultSetCap", [6n * USD, 8n * USD, parseEther("0.01"), 4]));
  const capAfter = (await bucket()).cap;
  if (capAfter !== 6n * USD) throw new Error(`(b1) cap ${capAfter}`);

  const spend = parseEther("0.01"); // $30 <= the $100 daily instant allowance
  const before = { recipient: await bal(recipient), account: await bal(account), vaultBucket: await readAcc<readonly [bigint, bigint, number]>("getVaultBucket") };
  const sp = await pathB("(b2) vault: spend within the instant allowance ($30)", VAULT, account, enc("vaultExecute", [[{ target: recipient, value: spend, data: "0x" }], 30n * USD]));
  const after = { recipient: await bal(recipient), account: await bal(account), vaultBucket: await readAcc<readonly [bigint, bigint, number]>("getVaultBucket") };
  if (after.recipient - before.recipient !== spend) throw new Error("(b2) spend did not arrive");
  results.b_pathB = { tighten: { ...tighten.out, capAfter }, spend: { ...sp.out, before, after } };
  checklist.b = `PASS: Path B C13 vault txs mined via public mempool: tightening ${tighten.out.hash}, spend ${sp.out.hash}; VERIFY ${tighten.out.verifyGas} gas`;
}

// ---------------------------------------------------------------------------- (c) forged vault sig ----------
{
  const move = enc("vaultExecute", [[{ target: recipient, value: parseEther("0.01"), data: "0x" }], 30n * USD]);
  const snap = async () => ({
    recipient: await bal(recipient),
    account: await bal(account),
    vaultBucket: await readAcc<readonly [bigint, bigint, number]>("getVaultBucket"),
    cap: (await bucket()).cap,
    signer: await bal(vaultSigner),
    nonce: await rpc.node.getTransactionCount(vaultSigner, "latest"),
  });
  const before = await snap();
  const forgedB = await pathBTx(VAULT, account, move, true);
  const { r, out } = await sendPublic("(c) forged PQ witness, Path B", forgedB, roleOwn(VAULT), 100_000n - 2_900n);
  const after = await snap();
  if (r.frameReceipts[1]?.status === "success") throw new Error("(c) forged Path B SENDER succeeded!");
  if (after.recipient !== before.recipient || after.account !== before.account || after.cap !== before.cap) {
    throw new Error("(c) forged Path B changed state!");
  }
  if (after.vaultBucket[0] < before.vaultBucket[0]) throw new Error("(c) vault allowance consumed");
  // Path A with a forged witness: the PQ check is inside VERIFY, so the tx is not even valid. Simulated only.
  const forgedA = await pathATx(VAULT, account, move, true);
  const simA = await simulate("(c) forged PQ witness, Path A (simulate only)", forgedA, roleOwn(VAULT), "invalid");
  results.c_forged = {
    pathB: { ...out, before, after, signerPaid: before.signer - after.signer },
    pathA: { submitted: false, simulate: simBrief(simA) },
  };
  checklist.c = `PASS: forged vault sig moves nothing: Path B ${out.hash} mined with SENDER reverted (balances, cap, allowance unchanged; signer paid ${before.signer - after.signer} wei, nonce ${before.nonce}->${after.nonce}); Path A rejected in VERIFY (${simA.executionError ?? simA.violation})`;
}

// --------------------------------------------------------------------------------- (d) over-cap hot ----------
{
  const amount = parseEther("0.0025"); // $7.50 <= perTx $8, > the bucket ($6 cap after (b1))
  const before = { tank: await bal(tank.address), account: await bal(account), bucket: await bucket() };
  const { r, out } = await sendPublic(
    "(d) over-cap hot tx (admitted; SENDER reverts)",
    await hotTx(hotExecute(7_500_000n, [{ target: tank.address, value: amount, data: "0x" }])),
    HOT_OWN,
    80_000n,
  );
  const after = { tank: await bal(tank.address), account: await bal(account), bucket: await bucket() };
  if (r.frameReceipts[2]?.status === "success") throw new Error("(d) over-cap SENDER succeeded!");
  if (after.account !== before.account) throw new Error("(d) account balance moved");
  if (!(after.tank < before.tank)) throw new Error("(d) tank did not pay");
  if (r.payer && r.payer.toLowerCase() !== tank.address.toLowerCase()) throw new Error(`(d) payer ${r.payer}`);
  results.d_overCap = { ...out, before, after, tankPaid: before.tank - after.tank };
  checklist.d = `PASS: over-cap hot tx ${out.hash}: SENDER reverted, account unchanged, tank paid ${before.tank - after.tank} wei`;
}

// ------------------------------------------------------------- (e) loosening queued, recovery cancels ----------
{
  const loosen = enc("vaultSetCap", [20n * USD, 8n * USD, parseEther("0.01"), 4]);
  const q = await pathB("(e1) vault queues a loosening (cap $6 -> $20)", VAULT, account, enc("vaultQueue", [[{ target: account, value: 0n, data: loosen }], KIND_LOOSEN]));
  const queuedAbi = rolesArt.abi.filter((x) => (x as { name?: string }).name === "Queued") as Abi;
  let opId: Hex | undefined;
  for (const f of q.r.frameReceipts) {
    for (const l of f.logs) {
      if (l.address.toLowerCase() !== account.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: queuedAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        opId = (ev.args as unknown as { opId: Hex }).opId;
      } catch {
        /* other event */
      }
    }
  }
  if (!opId) throw new Error("(e) no Queued event");
  const pending = await readAcc<{ eta: number; kind: number; state: number }>("getQueued", [opId]);
  // Path B for the recovery (2026-11-06 recovery fee path): the RecoverySigner was derived at initialize with its own
  // payer key (entry 1, SECP256K1, held on the recovery device; never the hot key, the tank or the vault's payer)
  // and is NOT staked, so it pays its own fee on the canonical public mempool: no Path A, no stake, no privileged or
  // private submission (`sendPublic` = ethrex eth_sendRawTransaction after a valid simulation).
  const recPayerOnChain = await readSigner<Address>(recoverySigner, "payerKey");
  if (recPayerOnChain !== recoveryPayer.address) throw new Error(`(e) recovery payerKey ${recPayerOnChain}`);
  if ([hot.address, tank.address, vaultPayer.address].includes(recPayerOnChain)) throw new Error("(e) payer key reused");
  const regAbi = [
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
  const recStake = await pub.readContract({ address: STAKING_REGISTRY, abi: regAbi, functionName: "getDepositInfo", args: [recoverySigner] });
  if (recStake[0] !== 0n) throw new Error("(e) the RecoverySigner is staked; Path B must not need it");
  const recBal0 = await bal(recoverySigner);
  const c = await pathB("(e2) RecoverySigner cancels the queued loosening", RECOVERY, account, enc("recoveryCancel", [opId]));
  const recBal1 = await bal(recoverySigner);
  if (c.r.payer && c.r.payer.toLowerCase() !== recoverySigner.toLowerCase()) throw new Error(`(e) payer ${c.r.payer}`);
  if (!(recBal1 < recBal0)) throw new Error("(e) the RecoverySigner did not pay its own fee");
  const op = await readAcc<{ eta: number; kind: number; state: number }>("getQueued", [opId]);
  if (op.state !== OP_CANCELLED) throw new Error(`(e) op state ${op.state}`);
  if ((await bucket()).cap !== 6n * USD) throw new Error("(e) cap changed");
  results.e_recoveryPriority = {
    queue: { ...q.out, opId, pending },
    cancel: {
      ...c.out,
      op,
      path: "B (2 signatures: C13 witness + SECP256K1 recovery payer)",
      recoveryPayerKey: recPayerOnChain,
      recoveryStake: recStake[0],
      recoverySignerPaid: recBal0 - recBal1,
    },
  };
  checklist.e = `PASS: loosening queued by the vault (${q.out.hash}, op ${opId}), cancelled by the RecoverySigner on Path B (public mempool, own payer key ${recPayerOnChain}, unstaked, paid ${recBal0 - recBal1} wei) (${c.out.hash}), state CANCELLED`;
}

// ------------------------------------------------------------------------------------ (f) freezes ----------
{
  // f1: guardian freeze through GuardianSigner, public mempool.
  const gNonce = await rpc.node.getTransactionCount(guardian, "latest");
  let gtx = newTx({
    chainId: 1337,
    sender: guardian,
    nonceSeq: gNonce,
    fees: FEES,
    frames: [
      selfVerify(profile, { execution: GUARDIAN_VERIFY_GAS, data: accountVerifyData() }),
      senderFrame(profile, { target: account, data: toFunctionSelector("guardianFreeze()"), execution: 200_000n, state: 100_000n }),
    ],
    signatures: [secp256k1Entry(profile, guardianKey.address)],
  });
  gtx = await signTx(profile, gtx, guardianPriv, 0);
  const gf = await sendPublic("(f1) GuardianSigner freeze", gtx, [guardian], 100_000n - 2_800n);
  if (gf.r.frameReceipts[1]?.status !== "success") throw new Error("(f1) guardianFreeze frame failed");
  const cfg1 = await hotCfg();
  if (!cfg1.hotFrozen) throw new Error("(f1) not frozen");

  // f2: the hot path is blocked: VERIFY rejects (simulate only; never offered to ethrex).
  const blocked = await simulate(
    "(f2) hot payment while frozen (must be rejected)",
    await hotTx(hotExecute(USD, [{ target: tank.address, value: parseEther("0.0001"), data: "0x" }])),
    HOT_OWN,
    "invalid",
  );

  // f3: "guardian pauses, user resumes": the vault unfreezes (Path B).
  const uf = await pathB("(f3) vault unfreezes", VAULT, account, enc("vaultUnfreeze"));
  if ((await hotCfg()).hotFrozen) throw new Error("(f3) still frozen");

  // f4: a short freeze (vaultExtendFreeze to now + 40 s) that expires and is cleared by the hot key.
  const now = (await pub.getBlock({ blockTag: "latest" })).timestamp;
  const until = now + 40n;
  const ef = await pathB("(f4) vault: short freeze (vaultExtendFreeze, +40 s)", VAULT, account, enc("vaultExtendFreeze", [Number(until)]));
  const cfg4 = await hotCfg();
  if (!cfg4.hotFrozen) throw new Error("(f4) not frozen");
  const blocked2 = await simulate(
    "(f5) hot payment during the short freeze (must be rejected)",
    await hotTx(hotExecute(USD, [{ target: tank.address, value: parseEther("0.0001"), data: "0x" }])),
    HOT_OWN,
    "invalid",
  );
  await waitForTimestamp(BigInt(cfg4.frozenUntil) + 1n);
  const clear = await sendPublic("(f6) hot key: clearExpiredFreeze() after expiry", await hotTx(enc("clearExpiredFreeze")), HOT_OWN, 80_000n);
  if (clear.r.frameReceipts[2]?.status !== "success") throw new Error("(f6) clearExpiredFreeze frame failed");
  if ((await hotCfg()).hotFrozen) throw new Error("(f6) still frozen");
  const resumed = await sendPublic(
    "(f7) hot payment after the freeze cleared",
    await hotTx(hotExecute(USD, [{ target: tank.address, value: parseEther("0.0001"), data: "0x" }])),
    HOT_OWN,
    80_000n,
  );
  if (resumed.r.frameReceipts[2]?.status !== "success") throw new Error("(f7) hot payment failed");
  results.f_freeze = {
    guardianFreeze: { ...gf.out, frozenUntil: cfg1.frozenUntil },
    blockedWhileGuardianFrozen: { submitted: false, simulate: simBrief(blocked) },
    vaultUnfreeze: uf.out,
    shortFreeze: { ...ef.out, frozenUntil: cfg4.frozenUntil },
    blockedWhileShortFrozen: { submitted: false, simulate: simBrief(blocked2) },
    clearExpiredFreeze: clear.out,
    hotPaymentAfterClear: resumed.out,
  };
  checklist.f = `PASS: GuardianSigner freeze ${gf.out.hash} blocks the hot path (VERIFY: ${blocked.executionError ?? blocked.violation}); vault unfreeze ${uf.out.hash}; short freeze ${ef.out.hash} expired and cleared by clearExpiredFreeze ${clear.out.hash}; hot payment ${resumed.out.hash}`;
}

// ------------------------------------------------------------------------------- (g) Path A, staked ----------
{
  const registryAbi = [
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
  const st = await pathB(
    "(g1) VaultSigner stakes 0.012 ETH (Path B executePQ -> self.stake)",
    VAULT,
    vaultSigner,
    encodeFunctionData({ abi: signerArt.abi, functionName: "stake", args: [86400, parseEther("0.012")] }),
  );
  const dep = await pub.readContract({ address: STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [vaultSigner] });
  if (dep[0] < parseEther("0.01")) throw new Error("(g1) stake not recorded");

  const cfg = (await budgetRpc.sidecar.config().catch(() => null)) as { budgets?: unknown } | null;
  const tighten = enc("vaultSetCap", [5n * USD, 8n * USD, parseEther("0.01"), 4]);
  const tx = await pathATx(VAULT, account, tighten);
  const sim = await simulate("(g2) Path A vault tightening (cap $6 -> $5)", tx, roleOwn(VAULT), "overBudget");
  // The stock sidecar rejects before reaching ethrex (harmless for the lane); ethrex's own verdict is the simulation.
  const stock = await rpc.sidecar
    .sendFrameTransaction(tx)
    .then((h) => ({ accepted: h }))
    .catch((e: Error) => ({ rejected: e.message }));
  if ("accepted" in stock) throw new Error("(g) the stock sidecar admitted a Path A tx");
  const hash = await budgetRpc.sidecar.sendFrameTransaction(tx);
  const r = await waitReceipt(hash);
  const status = await budgetRpc.sidecar.frameTransactionStatus(hash).catch(() => null);
  if (r.frameReceipts[1]?.status !== "success") throw new Error(`(g) Path A SENDER failed: ${json(framesOf(r))}`);
  const capAfter = (await bucket()).cap;
  if (capAfter !== 5n * USD) throw new Error(`(g) cap ${capAfter}`);
  results.g_pathA = {
    stake: { ...st.out, depositInfo: dep },
    budgetSidecarConfig: cfg?.budgets ?? cfg,
    stockSidecar: stock,
    ethrexVerdict: { canonicalMempoolValid: sim.canonicalMempoolValid, violation: sim.violation },
    pathA: {
      via: "BUDGET-010 sidecar eth_sendFrameTransaction (http://localhost:14340/rpc)",
      hash,
      status: status?.status ?? null,
      block: r.blockNumber,
      gasUsed: r.gasUsed,
      frames: framesOf(r),
      verifyGas: r.frameReceipts[0]?.gasUsed.execution,
      simulate: simBrief(sim),
      capAfter,
    },
  };
  log("(g) Path A", results.g_pathA);
  checklist.g = `PASS: VaultSigner staked (${st.out.hash}); Path A tightening ${hash} admitted by the BUDGET-010 sidecar (stock sidecar and ethrex reject: MAX_VERIFY_GAS), mined; VERIFY ${r.frameReceipts[0]?.gasUsed.execution} gas`;
}

// --------------------------------------------------------------------------- fee-profile script ----------
{
  const contracts = fileURLToPath(new URL("../../", import.meta.url));
  const p = spawnSync("forge", ["script", "script/CheckFeeProfile.s.sol", "--rpc-url", process.env.ETHREX_URL ?? "http://localhost:8545"], {
    cwd: contracts,
    encoding: "utf8",
    env: {
      ...process.env,
      ROLE_SIGNER_FACTORY: rsFactoryD.address,
      FEE_CHECK_ADDRESSES: [vaultSigner, recoverySigner, guardian].join(","),
    },
  });
  const out = `${p.stdout}\n${p.stderr}`;
  results.feeProfileScript = { exit: p.status, ok: /fee profile OK/.test(out), log: out.split("\n").filter((l) => /ok|OK|chain id|expected|Error|revert/i.test(l)).slice(0, 12) };
  log("fee-profile script", results.feeProfileScript);
}

vaultPQ.secretKey.fill(0);
recoveryPQ.secretKey.fill(0);
results.pqSignMs = signMs;
results.checklist = checklist;
results.finishedAt = new Date().toISOString();
writeFileSync(new URL("./last-run.json", import.meta.url), json(results));
log("G1 CHECKLIST", checklist);
console.log("\nG1 OK");
