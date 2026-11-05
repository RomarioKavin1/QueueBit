// PQ role-signer integration test on the LOCAL devnet (devnet/README.md; `cd devnet && ./up.sh`).
//
//   cd contracts && forge build && cd devnet-tests/pq && bun install && bun run test
//
// 1. Deploys C13Verifier, a MockLeakedAccount (stand-in for the account's vault entry points), RoleSignerFactory, and
//    a VaultSigner (PQRoleSigner, role 1) through the factory; funds them from anvil #2.
// 2. Generates a real SPHINCS- C13 key and signatures with @leaked/pq-signer over the codec's sig hash.
// 3. Path B (public mempool, ethrex eth_sendRawTransaction): vaultExecute moving ETH via the mock -> mined.
// 4. Path B through the sidecar: executePQ(self, stake(86400, 0.012 ETH)) -> staked in the ERC-8421 registry.
// 5. Path B with a forged PQ witness: admitted (payer key is valid), SENDER frame reverts, nothing moves, nonce +1.
// 6. Path A: PQ verified in VERIFY. Rejected by the stock sidecar and by ethrex (MAX_VERIFY_GAS = 100k), then
//    admitted with ethrex_submitPrivilegedFrameTransaction (the sidecar's relay path) and mined.
// Every tx is first run through ethrex_simulateFrameTransaction {trace:true}: canonicalMempoolValid + frame gas.
// Results go to stdout and ./last-run.json.
import { writeFileSync } from "node:fs";
import {
  bytesToHex,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  parseEther,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import {
  encodeTx,
  getProfile,
  roleSignerPathATx,
  roleSignerPathBTx,
  setSignature,
  sigHash,
  signTx,
  txHash,
  type FrameTx,
} from "@leaked/frames";
import { SCHEME_ID, SIG_LENGTH, keygen, sign } from "@leaked/pq-signer";
import { STAKING_REGISTRY, artifact, call, deploy, ethrexRaw, json, log, pub, rpc, waitReceipt } from "./lib.js";

const profile = getProfile("ethrex-eip8141-tracer");
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const MAX_FEE_WEI = parseEther("0.05"); // PQRoleSigner.maxFee, bounding TXPARAM(MAX_COST) on this profile
const TXPARAM_MAX_COST = 6;
const DEVNET_ERC8421_WORKSHOP = 0;
const PATH_B_VERIFY_GAS = 90_000n; // + 2,800 (secp) + 100 (arbitrary) <= MAX_VERIFY_GAS 100,000
const PATH_A_VERIFY_GAS = 400_000n;
const BODY = { execution: 600_000n, state: 400_000n };
const MOVE = parseEther("0.001");

const results: Record<string, unknown> = { startedAt: new Date().toISOString() };

const verifierArt = artifact("C13Verifier.sol", "C13Verifier");
const signerArt = artifact("PQRoleSigner.sol", "PQRoleSigner");
const factoryArt = artifact("RoleSignerFactory.sol", "RoleSignerFactory");
const mockArt = artifact("RoleMocks.sol", "MockLeakedAccount");
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

// ------------------------------------------------------------------------------------------------ setup ----------

const chainId = await rpc.node.chainId();
if (chainId !== 1337n) throw new Error(`expected chain 1337, got ${chainId}`);
log("node", { chainId, client: await rpc.node.clientVersion(), block: await rpc.node.blockNumber() });

// A deterministic test PQ key (public test material: never use for funds).
const seed = hexToBytes(
  `${keccak256(stringToHex("leaked/devnet-tests/pq/seed/0"))}${keccak256(stringToHex("leaked/devnet-tests/pq/seed/1")).slice(2)}` as Hex,
);
const { publicKey, secretKey } = keygen(seed, { role: "vault" });
const pk = bytesToHex(publicKey);
const payerPriv = generatePrivateKey();
const payer = privateKeyToAccount(payerPriv).address;
const recipient = privateKeyToAccount(generatePrivateKey()).address;
log("keys", { pk, payer, recipient });

const verifier = await deploy(verifierArt);
const mock = await deploy(mockArt);
const factory = await deploy(factoryArt, [DEVNET_ERC8421_WORKSHOP, TXPARAM_MAX_COST, STAKING_REGISTRY, MAX_FEE_WEI]);
const salt = keccak256(stringToHex(`leaked/devnet-tests/pq/${Date.now()}`));
const createArgs = [salt, 1, mock.address, pk, verifier.address, payer] as const;
const signer = (await pub.readContract({
  address: factory.address,
  abi: factoryArt.abi,
  functionName: "predictRoleSigner",
  args: createArgs,
})) as Address;
const created = await call(
  factory.address,
  encodeFunctionData({ abi: factoryArt.abi, functionName: "createRoleSigner", args: createArgs }),
  parseEther("1"),
);
if (((await pub.getCode({ address: signer })) ?? "0x") === "0x") throw new Error("factory did not deploy the signer");
const setRoles = await call(
  mock.address,
  encodeFunctionData({ abi: mockArt.abi, functionName: "setRoles", args: [signer, signer, signer] }),
  0n,
  3_000_000n, // three fresh slots: Amsterdam+ state gas (200k ran out)
);
await call(mock.address, "0x", parseEther("0.1"), 500_000n);
results.deployments = {
  C13Verifier: { address: verifier.address, tx: verifier.hash, gasUsed: verifier.gasUsed },
  MockLeakedAccount: { address: mock.address, tx: mock.hash, gasUsed: mock.gasUsed },
  RoleSignerFactory: { address: factory.address, tx: factory.hash, gasUsed: factory.gasUsed },
  VaultSigner: { address: signer, tx: created.hash, gasUsed: created.gasUsed },
  setRoles: setRoles.hash,
};
log("deployments", results.deployments);

const read = (address: Address, abi: typeof signerArt.abi, functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args: args as never });
if ((await read(verifier.address, verifierArt.abi, "schemeId")) !== SCHEME_ID) throw new Error("schemeId mismatch");
if ((await read(signer, signerArt.abi, "pk")) !== pk) throw new Error("signer pk mismatch");
if ((await read(signer, signerArt.abi, "sigLength")) !== BigInt(SIG_LENGTH)) throw new Error("sigLength mismatch");

// The adapter on chain, via eth_call: a fresh signature verifies, a truncated one returns false (no revert).
{
  const d = keccak256(stringToHex("adapter check"));
  const s = bytesToHex(sign(secretKey, hexToBytes(d)));
  const ok = await read(verifier.address, verifierArt.abi, "verify", [pk, d, s]);
  const short = await read(verifier.address, verifierArt.abi, "verify", [pk, d, s.slice(0, -2) as Hex]);
  results.adapterEthCall = { valid: ok, truncated: short };
  if (ok !== true || short !== false) throw new Error(`adapter eth_call: ${ok} ${short}`);
}

// ---------------------------------------------------------------------------------------------- helpers ----------

const executePQ = (target: Address, data: Hex) =>
  encodeFunctionData({ abi: signerArt.abi, functionName: "executePQ", args: [0n, target, data] });
const relay = (target: Address, data: Hex) =>
  encodeFunctionData({ abi: signerArt.abi, functionName: "relay", args: [target, data] });
const vaultMove = (amount: bigint) =>
  encodeFunctionData({
    abi: mockArt.abi,
    functionName: "vaultExecute",
    args: [[{ target: recipient, value: amount, data: "0x" }], 0n],
  });

async function pqSign(tx: FrameTx, forge = false): Promise<FrameTx> {
  const h = sigHash(profile, tx);
  const t0 = performance.now();
  const sig = sign(secretKey, hexToBytes(h));
  const ms = Math.round(performance.now() - t0);
  if (forge) sig[100] ^= 0x01;
  results.lastSignMs = ms;
  return setSignature(profile, tx, 0, bytesToHex(sig));
}

async function pathB(data: Hex, forge = false): Promise<FrameTx> {
  const nonceSeq = await rpc.node.getTransactionCount(signer, "latest");
  let tx = roleSignerPathBTx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: FEES,
    roleSigner: signer,
    sigLength: SIG_LENGTH,
    verifyGas: PATH_B_VERIFY_GAS,
    payerKey: payer, // signer = owner EOA explicitly (devnet review F10)
    body: { data, ...BODY },
  });
  tx = await pqSign(tx, forge);
  return signTx(profile, tx, payerPriv, 1);
}

async function pathA(data: Hex): Promise<FrameTx> {
  const nonceSeq = await rpc.node.getTransactionCount(signer, "latest");
  const tx = roleSignerPathATx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: FEES,
    roleSigner: signer,
    sigLength: SIG_LENGTH,
    verifyGas: PATH_A_VERIFY_GAS,
    body: { data, ...BODY },
  });
  return pqSign(tx);
}

// EIP-8141 validation-prefix bans (plan §10.1.4) plus transient storage; ethrex reports usedOpcodes by decimal byte.
const BANNED: Record<number, string> = {
  0x31: "BALANCE", 0x3a: "GASPRICE", 0x40: "BLOCKHASH", 0x41: "COINBASE", 0x42: "TIMESTAMP", 0x43: "NUMBER",
  0x44: "PREVRANDAO", 0x45: "GASLIMIT", 0x47: "SELFBALANCE", 0x48: "BASEFEE", 0x4a: "BLOBBASEFEE", 0x55: "SSTORE",
  0x5c: "TLOAD", 0x5d: "TSTORE", 0xf0: "CREATE", 0xf5: "CREATE2", 0xfe: "INVALID", 0xff: "SELFDESTRUCT",
};

interface TraceCall {
  to?: string;
  usedOpcodes?: Record<string, number>;
  accessedSlots?: { reads?: Record<string, unknown>; writes?: Record<string, unknown>; transientReads?: Record<string, unknown>; transientWrites?: Record<string, unknown> };
  calls?: TraceCall[];
  outOfGas?: boolean;
}

/** The ERC-7562 trace of the VERIFY frame (frame 0): banned opcodes, storage outside tx.sender, transient storage. */
function traceSummary(trace: unknown, sender: Address): unknown {
  if (!Array.isArray(trace)) return trace ?? null;
  const f0 = trace.find((f: { frameIndex?: number }) => f.frameIndex === 0) as { root?: TraceCall } | undefined;
  if (!f0?.root) return { error: "no frame-0 trace" };
  const opcodes: Record<string, number> = {};
  const foreignReads: string[] = [];
  let writes = 0;
  let transient = 0;
  let outOfGas = false;
  const walk = (c: TraceCall) => {
    for (const [k, v] of Object.entries(c.usedOpcodes ?? {})) {
      const name = BANNED[Number(k)];
      if (name) opcodes[name] = (opcodes[name] ?? 0) + v;
    }
    const sl = c.accessedSlots;
    if (sl) {
      const n = Object.keys(sl.reads ?? {}).length;
      if (n && String(c.to).toLowerCase() !== sender.toLowerCase()) foreignReads.push(`${c.to}:${n}`);
      writes += Object.keys(sl.writes ?? {}).length;
      transient += Object.keys(sl.transientReads ?? {}).length + Object.keys(sl.transientWrites ?? {}).length;
    }
    if (c.outOfGas) outOfGas = true;
    for (const x of c.calls ?? []) walk(x);
  };
  walk(f0.root);
  return { verifyBannedOpcodes: opcodes, verifyForeignStorageReads: foreignReads, verifyWrites: writes, verifyTransient: transient, outOfGas };
}

async function simulate(label: string, tx: FrameTx) {
  const sim = await rpc.node.simulateFrameTransaction(encodeTx(profile, tx), { trace: true });
  const out = {
    canonicalMempoolValid: sim.valid,
    violation: sim.violation,
    prefixShape: sim.prefixShape,
    executionStatus: sim.executionStatus,
    executionError: sim.executionError,
    gasUsed: sim.gasUsed,
    frames: sim.frames,
    trace: traceSummary(sim.erc7562Trace, signer),
    traceError: sim.erc7562TraceError ?? null,
  };
  log(`simulate: ${label}`, out);
  // The gate (foundations review): the VERIFY frame uses no banned opcode, no transient storage, no storage outside
  // the signer, no writes. MAX_VERIFY_GAS is the only canonical violation allowed, and only for Path A.
  const t = out.trace as { verifyBannedOpcodes?: Record<string, number>; verifyForeignStorageReads?: string[]; verifyWrites?: number; verifyTransient?: number } | null;
  if (!t || Object.keys(t.verifyBannedOpcodes ?? { x: 1 }).length || t.verifyForeignStorageReads?.length || t.verifyWrites || t.verifyTransient) {
    throw new Error(`${label}: VERIFY trace gate failed: ${json(t)}`);
  }
  if (!sim.valid && !/MAX_VERIFY_GAS/.test(sim.violation ?? "")) throw new Error(`${label}: ${sim.violation}`);
  return { sim, out };
}

async function balances() {
  return {
    recipient: await rpc.node.getBalance(recipient),
    mock: await rpc.node.getBalance(mock.address),
    signer: await rpc.node.getBalance(signer),
    signerNonce: await rpc.node.getTransactionCount(signer, "latest"),
  };
}

/** Gas of the STATICCALLs into the C13Verifier (the adapter call, incl. its self-call), from callTracer. */
async function verifierGas(hash: Hex): Promise<number[]> {
  const t = await ethrexRaw<Record<string, unknown>>("debug_traceTransaction", [hash, { tracer: "callTracer" }]);
  const out: number[] = [];
  const walk = (c: Record<string, unknown>, parentIsVerifier: boolean) => {
    const isV = String(c.to ?? "").toLowerCase() === verifier.address.toLowerCase();
    if (isV && !parentIsVerifier) out.push(Number(BigInt(String(c.gasUsed))));
    for (const x of (c.calls as Record<string, unknown>[] | undefined) ?? []) walk(x, isV);
  };
  walk(t, false);
  return out;
}

function frameGas(r: Awaited<ReturnType<typeof waitReceipt>>) {
  return r.frameReceipts.map((f) => ({ status: f.status, execution: f.gasUsed.execution, state: f.gasUsed.state }));
}

// ------------------------------------------------------------------------------- 3. Path B, canonical mempool -----
{
  const before = await balances();
  const tx = await pathB(executePQ(mock.address, vaultMove(MOVE)));
  const { out } = await simulate("Path B valid", tx);
  const hash = await rpc.node.sendRawTransaction(encodeTx(profile, tx));
  if (hash !== txHash(profile, tx)) throw new Error("tx hash mismatch");
  const r = await waitReceipt(hash);
  const after = await balances();
  results.pathB = {
    verifierCallGas: await verifierGas(hash),
    via: "ethrex eth_sendRawTransaction (canonical public mempool)",
    hash,
    sigHash: sigHash(profile, tx),
    block: r.blockNumber,
    gasUsed: r.gasUsed,
    frames: frameGas(r),
    simulate: out,
    moved: after.recipient - before.recipient,
    signerPaid: before.signer - after.signer,
    nonce: [before.signerNonce, after.signerNonce],
    signMs: results.lastSignMs,
  };
  log("Path B valid", results.pathB);
  if (after.recipient - before.recipient !== MOVE) throw new Error("Path B: funds did not move");
}

// --------------------------------------------------------------------------- 4. Path B via sidecar: stake ---------
{
  const stakeData = encodeFunctionData({ abi: signerArt.abi, functionName: "stake", args: [86400, parseEther("0.012")] });
  const tx = await pathB(executePQ(signer, stakeData));
  const { out } = await simulate("Path B stake", tx);
  const hash = await rpc.sidecar.sendFrameTransaction(tx);
  const r = await waitReceipt(hash);
  const dep = await pub.readContract({ address: STAKING_REGISTRY, abi: registryAbi, functionName: "getDepositInfo", args: [signer] });
  results.pathBStake = {
    via: "sidecar eth_sendFrameTransaction",
    hash,
    status: (await rpc.sidecar.frameTransactionStatus(hash))?.status ?? null,
    block: r.blockNumber,
    frames: frameGas(r),
    simulate: out,
    depositInfo: dep,
  };
  log("Path B stake (executePQ -> self.stake)", results.pathBStake);
  if (dep[0] < parseEther("0.012")) throw new Error("stake not recorded");
}

// ------------------------------------------------------------------------- 5. Path B with a forged PQ witness -----
{
  const before = await balances();
  const tx = await pathB(executePQ(mock.address, vaultMove(MOVE)), true);
  const { out } = await simulate("Path B forged PQ", tx);
  const hash = await rpc.node.sendRawTransaction(encodeTx(profile, tx));
  const r = await waitReceipt(hash);
  const after = await balances();
  results.pathBForged = {
    verifierCallGas: await verifierGas(hash),
    via: "ethrex eth_sendRawTransaction",
    hash,
    gasUsed: r.gasUsed,
    frames: frameGas(r),
    simulate: out,
    moved: after.recipient - before.recipient,
    mockBalanceDelta: after.mock - before.mock,
    signerPaid: before.signer - after.signer,
    nonce: [before.signerNonce, after.signerNonce],
  };
  log("Path B forged PQ witness", results.pathBForged);
  if (after.recipient !== before.recipient) throw new Error("forged Path B moved funds!");
  if (r.frameReceipts[1]?.status === "success") throw new Error("forged Path B SENDER frame succeeded!");
}

// ------------------------------------------------------------------------------------------------ 6. Path A ------
{
  const before = await balances();
  const tx = await pathA(relay(mock.address, vaultMove(MOVE)));
  const raw = encodeTx(profile, tx);
  const { out } = await simulate("Path A", tx);
  const sidecarVerdict = await rpc.sidecar
    .sendFrameTransaction(tx)
    .then((h) => ({ accepted: h }))
    .catch((e: Error) => ({ rejected: e.message }));
  const ethrexVerdict = await rpc.node
    .sendRawTransaction(raw)
    .then((h) => ({ accepted: h }))
    .catch((e: Error) => ({ rejected: e.message }));
  log("Path A, stock admission", { sidecar: sidecarVerdict, ethrex: ethrexVerdict });
  if ("accepted" in sidecarVerdict || "accepted" in ethrexVerdict) {
    throw new Error("Path A was admitted by a stock mempool: MAX_VERIFY_GAS rule changed?");
  }
  // Re-sign before the privileged submission. Observed 2026-11-06: ethrex accepted a privileged submission of the
  // exact bytes it had just rejected on eth_sendRawTransaction (same tx hash) but never mined it; a fresh hedged
  // witness (same sig hash, new tx hash) mines.
  const tx2 = await pqSign(tx);
  const hash = await ethrexRaw<Hex>("ethrex_submitPrivilegedFrameTransaction", [encodeTx(profile, tx2)]);
  const r = await waitReceipt(hash);
  const after = await balances();
  results.pathA = {
    verifierCallGas: await verifierGas(hash),
    rejectedBy: { sidecar: sidecarVerdict, ethrex: ethrexVerdict },
    admittedVia: "ethrex_submitPrivilegedFrameTransaction",
    hash,
    block: r.blockNumber,
    gasUsed: r.gasUsed,
    frames: frameGas(r),
    simulate: out,
    moved: after.recipient - before.recipient,
    nonce: [before.signerNonce, after.signerNonce],
  };
  log("Path A", results.pathA);
  if (after.recipient - before.recipient !== MOVE) throw new Error("Path A: funds did not move");
}

secretKey.fill(0);
results.finishedAt = new Date().toISOString();
writeFileSync(new URL("./last-run.json", import.meta.url), json(results));
console.log("\nPQ DEVNET OK");
