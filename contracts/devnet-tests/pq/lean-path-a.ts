// leanSphincs-s Path A on the LOCAL devnet, through the STOCK mempool (devnet/README.md; `cd devnet && ./up.sh`).
//
//   cd contracts && forge build && cd devnet-tests/pq && bun install && bun run lean-path-a
//
// 1. Deploys LeanSphincsSVerifier, a MockLeakedAccount (the account's vault entry points), RoleSignerFactory and a
//    VaultSigner clone (PQRoleSigner, role 1) whose verifier is leanSphincs-s; funds them from anvil #2.
// 2. A leanSphincs-s key (Light tier) and signatures from @leaked/pq-signer `schemes.leanSphincsS` over the codec's
//    sig hash.
// 3. Path A (PQ verified inside VERIFY, no payer key): relay -> vaultExecute moving ETH. The VERIFY limit is 99,900
//    (+100 for the ARBITRARY entry = the stock MAX_VERIFY_GAS 100,000). Simulated first ({trace:true}: canonical
//    mempool validity + the VERIFY trace gate), then sent to the STOCK sidecar (:14337, eth_sendFrameTransaction) and
//    mined. No staking, no BUDGET-010, no privileged submission.
// 4. A forged Path A witness: simulated only (VERIFY must reject; never offered to a mempool, poisoned-lane rule).
// Results: stdout and ./last-run-lean.json.
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
import { encodeTx, getProfile, roleSignerPathATx, setSignature, sigHash, txHash, type FrameTx } from "@leaked/frames";
import { schemes } from "@leaked/pq-signer";
import { artifact, call, deploy, ethrexRaw, json, log, pub, rpc, traceSummary, waitReceipt } from "./lib.js";

const L = schemes.leanSphincsS;
const profile = getProfile("ethrex-eip8141-tracer");
const FEES = { maxFeePerGas: 2_000_000_000n, maxPriorityFeePerGas: 1_000_000_000n };
const MAX_FEE_WEI = parseEther("0.05");
const TXPARAM_MAX_COST = 6;
const DEVNET_ERC8421_WORKSHOP = 0;
const STOCK_MAX_VERIFY_GAS = 100_000n;
const PATH_A_VERIFY_GAS = STOCK_MAX_VERIFY_GAS - 100n; // the ARBITRARY entry's signature-verification cost
const BODY = { execution: 600_000n, state: 400_000n };
const MOVE = parseEther("0.001");
const STAKING_REGISTRY = (process.env.STAKING_REGISTRY ?? "0x8464135c8F25Da09e49BC8782676a84730C318bC") as Address;

const results: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  scheme: L.name,
  experimental: L.experimental,
};

const verifierArt = artifact("LeanSphincsSVerifier.sol", "LeanSphincsSVerifier");
const signerArt = artifact("PQRoleSigner.sol", "PQRoleSigner");
const factoryArt = artifact("RoleSignerFactory.sol", "RoleSignerFactory");
const mockArt = artifact("RoleMocks.sol", "MockLeakedAccount");

// ------------------------------------------------------------------------------------------------ setup ----------

const chainId = await rpc.node.chainId();
if (chainId !== 1337n) throw new Error(`expected chain 1337, got ${chainId}`);
log("node", { chainId, client: await rpc.node.clientVersion(), block: await rpc.node.blockNumber() });

// A deterministic test PQ key (public test material: never use for funds).
const seed = hexToBytes(
  `${keccak256(stringToHex("leaked/devnet-tests/pq/lean/seed/0"))}${keccak256(stringToHex("leaked/devnet-tests/pq/lean/seed/1")).slice(2)}` as Hex,
);
const t0 = performance.now();
const { publicKey, secretKey } = L.keygen(seed, { role: "vault" });
results.keygenMs = Math.round(performance.now() - t0);
const pk = bytesToHex(publicKey);
const recipient = privateKeyToAccount(generatePrivateKey()).address;
log("keys", { scheme: L.name, schemeId: L.SCHEME_ID, pk, recipient, keygenMs: results.keygenMs });

const verifier = await deploy(verifierArt);
const mock = await deploy(mockArt);
const factory = await deploy(factoryArt, [DEVNET_ERC8421_WORKSHOP, TXPARAM_MAX_COST, STAKING_REGISTRY, MAX_FEE_WEI]);
const salt = keccak256(stringToHex(`leaked/devnet-tests/pq/lean/${Date.now()}`));
// payerKey = 0: Path B disabled; this signer can only act through Path A.
const createArgs = [salt, 1, mock.address, pk, verifier.address, "0x0000000000000000000000000000000000000000"] as const;
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
const implementation = (await pub.readContract({
  address: factory.address,
  abi: factoryArt.abi,
  functionName: "implementation",
})) as Address;
const setRoles = await call(
  mock.address,
  encodeFunctionData({ abi: mockArt.abi, functionName: "setRoles", args: [signer, signer, signer] }),
  0n,
  3_000_000n,
);
await call(mock.address, "0x", parseEther("0.1"), 500_000n);
results.deployments = {
  LeanSphincsSVerifier: { address: verifier.address, tx: verifier.hash, gasUsed: verifier.gasUsed },
  MockLeakedAccount: { address: mock.address, tx: mock.hash, gasUsed: mock.gasUsed },
  RoleSignerFactory: { address: factory.address, tx: factory.hash, gasUsed: factory.gasUsed },
  PQRoleSignerImplementation: implementation,
  VaultSigner: { address: signer, tx: created.hash, gasUsed: created.gasUsed, payerKey: "none (Path A only)" },
  setRoles: setRoles.hash,
};
log("deployments", results.deployments);

const read = (address: Address, abi: typeof signerArt.abi, functionName: string, args: readonly unknown[] = []) =>
  pub.readContract({ address, abi, functionName, args: args as never });
if ((await read(verifier.address, verifierArt.abi, "schemeId")) !== L.SCHEME_ID) throw new Error("schemeId mismatch");
if ((await read(signer, signerArt.abi, "pk")) !== pk) throw new Error("signer pk mismatch");
if (String(await read(signer, signerArt.abi, "verifier")).toLowerCase() !== verifier.address.toLowerCase())
  throw new Error("signer verifier mismatch");
if ((await read(signer, signerArt.abi, "sigLength")) !== BigInt(L.SIG_LENGTH)) throw new Error("sigLength mismatch");

// The adapter on chain, via eth_call: a fresh signature verifies, a truncated one returns false (no revert).
{
  const d = keccak256(stringToHex("adapter check"));
  const s = bytesToHex(L.sign(secretKey, hexToBytes(d)));
  const ok = await read(verifier.address, verifierArt.abi, "verify", [pk, d, s]);
  const short = await read(verifier.address, verifierArt.abi, "verify", [pk, d, s.slice(0, -2) as Hex]);
  results.adapterEthCall = { valid: ok, truncated: short };
  if (ok !== true || short !== false) throw new Error(`adapter eth_call: ${ok} ${short}`);
}

// ---------------------------------------------------------------------------------------------- helpers ----------

const relay = (target: Address, data: Hex) =>
  encodeFunctionData({ abi: signerArt.abi, functionName: "relay", args: [target, data] });
const vaultMove = (amount: bigint) =>
  encodeFunctionData({
    abi: mockArt.abi,
    functionName: "vaultExecute",
    args: [[{ target: recipient, value: amount, data: "0x" }], 0n],
  });

async function pathA(data: Hex, forge = false): Promise<FrameTx> {
  const nonceSeq = await rpc.node.getTransactionCount(signer, "latest");
  const tx = roleSignerPathATx(profile, {
    chainId: 1337,
    nonceSeq,
    fees: FEES,
    roleSigner: signer,
    sigLength: L.SIG_LENGTH,
    verifyGas: PATH_A_VERIFY_GAS,
    body: { data, ...BODY },
  });
  const h = sigHash(profile, tx);
  const t = performance.now();
  const sig = L.sign(secretKey, hexToBytes(h));
  results.lastSignMs = Math.round(performance.now() - t);
  if (forge) sig[2720] ^= 0x01; // WOTS+C counter
  return setSignature(profile, tx, 0, bytesToHex(sig));
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
    trace: traceSummary(sim.erc7562Trace, [signer, implementation]),
    traceError: sim.erc7562TraceError ?? null,
  };
  log(`simulate: ${label}`, out);
  return { sim, out };
}

/** Compact frame-0 call tree: `type to [reads: slots]` per call. */
function callTree(trace: unknown): string[] {
  const out: string[] = [];
  if (!Array.isArray(trace)) return out;
  const f0 = trace.find((f: { frameIndex?: number }) => f.frameIndex === 0) as
    { root?: Record<string, unknown> } | undefined;
  const walk = (c: Record<string, unknown>, d: number) => {
    const reads = Object.keys((c.accessedSlots as { reads?: Record<string, unknown> } | undefined)?.reads ?? {});
    out.push(
      `${"  ".repeat(d)}${String(c.type ?? "?")} ${String(c.to ?? "?")}${reads.length ? ` reads ${reads.join(",")}` : ""}`,
    );
    for (const x of (c.calls as Record<string, unknown>[] | undefined) ?? []) walk(x, d + 1);
  };
  if (f0?.root) walk(f0.root, 0);
  return out;
}

function traceGate(label: string, t: unknown) {
  const g = t as {
    verifyBannedOpcodes?: Record<string, number>;
    verifyForeignStorageReads?: string[];
    verifyWrites?: number;
    verifyTransient?: number;
  } | null;
  if (
    !g ||
    Object.keys(g.verifyBannedOpcodes ?? { x: 1 }).length ||
    g.verifyForeignStorageReads?.length ||
    g.verifyWrites ||
    g.verifyTransient
  ) {
    throw new Error(`${label}: VERIFY trace gate failed: ${json(g)}`);
  }
}

/** Gas of the STATICCALLs into the verifier (the adapter call, incl. its self-call), from callTracer. */
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

// ------------------------------------------------------------------- 3. Path A via the STOCK sidecar -------------
{
  const before = {
    recipient: await rpc.node.getBalance(recipient),
    signer: await rpc.node.getBalance(signer),
    nonce: await rpc.node.getTransactionCount(signer, "latest"),
  };
  const tx = await pathA(relay(mock.address, vaultMove(MOVE)));
  const { sim, out } = await simulate("Path A (leanSphincs-s)", tx);
  results.pathAVerifyCallTree = callTree(sim.erc7562Trace);
  log("Path A VERIFY call tree", results.pathAVerifyCallTree);
  traceGate("Path A", out.trace);
  if (!sim.valid) throw new Error(`Path A not canonical-mempool valid: ${sim.violation}`);
  const hash = await rpc.sidecar.sendFrameTransaction(tx);
  if (hash !== txHash(profile, tx)) throw new Error("tx hash mismatch");
  const r = await waitReceipt(hash);
  const after = {
    recipient: await rpc.node.getBalance(recipient),
    signer: await rpc.node.getBalance(signer),
    nonce: await rpc.node.getTransactionCount(signer, "latest"),
  };
  const frames = r.frameReceipts.map((f) => ({
    status: f.status,
    execution: f.gasUsed.execution,
    state: f.gasUsed.state,
  }));
  results.pathA = {
    via: "STOCK sidecar :14337 eth_sendFrameTransaction (MAX_VERIFY_GAS 100,000; signer not staked)",
    hash,
    sigHash: sigHash(profile, tx),
    block: r.blockNumber,
    gasUsed: r.gasUsed,
    verifyLimit: PATH_A_VERIFY_GAS,
    verifyFrameGas: frames[0]?.execution,
    frames,
    verifierCallGas: await verifierGas(hash),
    simulate: out,
    sidecarStatus: (await rpc.sidecar.frameTransactionStatus(hash).catch(() => null))?.status ?? null,
    moved: after.recipient - before.recipient,
    signerPaid: before.signer - after.signer,
    nonce: [before.nonce, after.nonce],
    signMs: results.lastSignMs,
    witnessBytes: L.SIG_LENGTH,
  };
  log("Path A (leanSphincs-s, stock sidecar)", results.pathA);
  if (after.recipient - before.recipient !== MOVE) throw new Error("Path A: funds did not move");
  if (r.frameReceipts[1]?.status !== "success") throw new Error("Path A: SENDER frame failed");
  if (BigInt(frames[0]!.execution) >= STOCK_MAX_VERIFY_GAS) throw new Error("Path A VERIFY frame >= 100k");
}

// ---------------------------------------------------------------- 4. forged Path A witness: simulated only -------
{
  const tx = await pathA(relay(mock.address, vaultMove(MOVE)), true);
  const { sim, out } = await simulate("Path A forged witness (simulate only)", tx);
  results.pathAForged = { simulate: out, submitted: false };
  if (sim.valid && sim.executionStatus === "success") throw new Error("forged Path A simulated as valid!");
}

secretKey.fill(0);
results.finishedAt = new Date().toISOString();
writeFileSync(new URL("./last-run-lean.json", import.meta.url), json(results));
console.log("\nLEAN PATH A DEVNET OK");
