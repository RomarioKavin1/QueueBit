// M7 local e2e on a standard EVM (anvil, chain 31337): the ERC-4337 + ERC-7579 backend with the LEAKED modules.
//
//   1. starts anvil (or uses RPC_URL), deploys EntryPoint v0.8.0 at its canonical address by replaying the release
//      CREATE2 (salt 0x0a59…e9 through 0x4e59b448…, initcode = deployments/ethereum/EntryPoint.json, which equals
//      the input of the mainnet deploy tx 0xae4eafd1…);
//   2. deploys C13Verifier, LeakedRoleExecutor, LeakedPolicyHook, LeakedHotValidator, the reference MSA (shim with
//      a configurable EntryPoint) and creates an account with the three modules;
//   3. runs a minimal bundler (eth_call simulation of handleOps, then a handleOps tx from a bundler EOA; no alt
//      mempool, no ERC-7562 tracing: anvil has no bundler collector tracer):
//      - a hot userOp within the cap (mined, ETH moves, bucket debited);
//      - an over-perTx userOp, rejected in simulation (AA23 PerTxMaxExceeded): never submitted;
//      - an over-cap userOp after the bucket is drained: included, execution reverts (OverCap), nothing moves;
//      - a vault exec through LeakedRoleExecutor with a fresh C13 signature (@leaked/pq-signer), relayed by a
//        SimpleAccount userOp (ECDSA validation; the PQ check runs in execution).
//   Writes last-run.json. Needs `forge build` in contracts/ first.
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  concat,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  encodeAbiParameters,
  encodeDeployData,
  encodeFunctionData,
  encodePacked,
  http,
  keccak256,
  pad,
  parseAbi,
  parseEther,
  toHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { sign as pqSign } from "@leaked/pq-signer";
import { artifact, hex, testKeys, vaultExecDigest, type Call } from "./lib.ts";

const PORT = Number(process.env.ANVIL_PORT ?? 8547);
const RPC = process.env.RPC_URL ?? `http://127.0.0.1:${PORT}`;
const EP: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
const CREATE2: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
const EP_SALT: Hex = "0x0a59dbff790c23c976a548690c27297883cc66b4c67024f9117b0238995e35e9";
const ARACHNID: Hex =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
// anvil default keys #0 (deployer), #1 (bundler), #3 (hot key), #4 (relayer owner). Public test keys, never real.
const DEPLOYER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const BUNDLER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const HOT = privateKeyToAccount("0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6");
const RELAYER_OWNER = privateKeyToAccount("0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a");
const RECIPIENT: Address = "0x000000000000000000000000000000000000beef";
const VAULT_DEST: Address = "0x000000000000000000000000000000000000cafe";

const epAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "function getUserOpHash(PackedUserOperation op) view returns (bytes32)",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);

const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const wallet = (acct: typeof DEPLOYER) => createWalletClient({ chain: foundry, transport: http(RPC), account: acct });

async function waitRpc() {
  for (let i = 0; i < 100; i++) {
    try {
      await pub.getChainId();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("anvil did not start");
}

async function deploy(file: string, name: string, args: unknown[] = []): Promise<{ address: Address; abi: Abi }> {
  const a = artifact(file, name);
  const hash = await wallet(DEPLOYER).sendTransaction({ data: encodeDeployData({ abi: a.abi, bytecode: a.bytecode, args }) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success" || !r.contractAddress) throw new Error(`deploy ${name} failed`);
  return { address: r.contractAddress, abi: a.abi };
}

async function send(to: Address, data: Hex, value = 0n, from = DEPLOYER) {
  const hash = await wallet(from).sendTransaction({ to, data, value });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`tx to ${to} reverted`);
  return r;
}

type UserOp = {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
};

const packed = (hi: bigint, lo: bigint): Hex => pad(toHex((hi << 128n) | lo), { size: 32 });

async function buildOp(sender: Address, key: bigint, callData: Hex, signer: typeof HOT, gas = { verif: 600_000n, call: 1_000_000n, pvg: 60_000n }): Promise<UserOp> {
  const op: UserOp = {
    sender,
    nonce: (await pub.readContract({ address: EP, abi: epAbi, functionName: "getNonce", args: [sender, key] })) as bigint,
    initCode: "0x",
    callData,
    accountGasLimits: packed(gas.verif, gas.call),
    preVerificationGas: gas.pvg,
    gasFees: packed(1_000_000_000n, 2_000_000_000n),
    paymasterAndData: "0x",
    signature: "0x",
  };
  const h = (await pub.readContract({ address: EP, abi: epAbi, functionName: "getUserOpHash", args: [op] })) as Hex;
  op.signature = await signer.sign({ hash: h });
  return op;
}

/** Minimal bundler: simulate handleOps with eth_call; submit only if validation passes. */
async function bundle(op: UserOp, extraAbis: Abi[] = []) {
  const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[op], BUNDLER.address] });
  try {
    await pub.call({ account: BUNDLER.address, to: EP, data });
  } catch (e: any) {
    const raw: Hex | undefined = e?.cause?.data ?? e?.data ?? e?.walk?.((x: any) => x?.data)?.data;
    let reason = String(e?.shortMessage ?? e);
    if (raw) {
      const d = decodeErrorResult({ abi: epAbi, data: raw });
      reason = `${d.errorName}(${(d.args as unknown[]).slice(1, 2).join("")})`;
      if (d.errorName === "FailedOpWithRevert") {
        const inner = (d.args as unknown[])[2] as Hex;
        for (const abi of extraAbis) {
          try {
            const x = decodeErrorResult({ abi, data: inner });
            reason += ` ${x.errorName}(${(x.args ?? []).map(String).join(",")})`;
            break;
          } catch {}
        }
      }
    }
    return { submitted: false as const, reason };
  }
  const hash = await wallet(BUNDLER).sendTransaction({ to: EP, data, gas: 3_000_000n });
  const r = await pub.waitForTransactionReceipt({ hash });
  let success = false;
  let actualGasUsed = 0n;
  let revertReason: Hex | undefined;
  for (const log of r.logs) {
    if (log.address.toLowerCase() !== EP.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi: epAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "UserOperationEvent") {
        success = ev.args.success;
        actualGasUsed = ev.args.actualGasUsed;
      } else if (ev.eventName === "UserOperationRevertReason") revertReason = ev.args.revertReason;
    } catch {}
  }
  let decoded: string | undefined;
  if (revertReason) {
    for (const abi of extraAbis) {
      try {
        const x = decodeErrorResult({ abi, data: revertReason });
        decoded = `${x.errorName}(${(x.args ?? []).map(String).join(",")})`;
        break;
      } catch {}
    }
  }
  return { submitted: true as const, txHash: hash, txGasUsed: r.gasUsed, success, actualGasUsed, revertReason: decoded ?? revertReason };
}

const executeSingle = (target: Address, value: bigint, data: Hex): Hex =>
  encodeFunctionData({
    abi: parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]),
    functionName: "execute",
    args: [pad("0x00", { size: 32 }), encodePacked(["address", "uint256", "bytes"], [target, value, data])],
  });

async function main() {
  let anvil: ReturnType<typeof spawn> | undefined;
  if (!process.env.RPC_URL) {
    anvil = spawn("anvil", ["--port", String(PORT), "--silent"], { stdio: "ignore" });
  }
  const out: Record<string, unknown> = { date: new Date().toISOString(), rpc: RPC };
  try {
    await waitRpc();
    out.chainId = await pub.getChainId();

    // 1. EntryPoint v0.8.0 at its canonical address.
    if (!(await pub.getCode({ address: CREATE2 }))) await pub.request({ method: "anvil_setCode" as any, params: [CREATE2, ARACHNID] as any });
    const epJson = JSON.parse(readFileSync(fileURLToPath(new URL("../../lib/account-abstraction/deployments/ethereum/EntryPoint.json", import.meta.url)), "utf8"));
    if (!(await pub.getCode({ address: EP }))) await send(CREATE2, concat([EP_SALT, epJson.bytecode]));
    const epCode = await pub.getCode({ address: EP });
    if (!epCode || epCode.length < 1000) throw new Error("EntryPoint v0.8 not at 0x4337084d…");
    out.entryPoint = { address: EP, codeHash: keccak256(epCode) };

    // 2. Modules and the host.
    const verifier = await deploy("C13Verifier.sol", "C13Verifier");
    const executor = await deploy("LeakedRoleExecutor.sol", "LeakedRoleExecutor");
    const hook = await deploy("LeakedPolicyHook.sol", "LeakedPolicyHook", [executor.address]);
    const validator = await deploy("LeakedHotValidator.sol", "LeakedHotValidator", [hook.address]);
    const msaImpl = await deploy("HostArtifacts.sol", "MSAAdvancedEP", [EP]);
    const factory = await deploy("MSAFactory.sol", "MSAFactory", [msaImpl.address]);
    const bootstrap = await deploy("Bootstrap.sol", "Bootstrap");
    const { vault, recovery } = testKeys();

    const hookInit = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "hotKey", type: "address" }, { name: "capUsdPerDay", type: "uint256" }, { name: "perTxMaxUsd", type: "uint256" },
        { name: "maxFeeWei", type: "uint256" }, { name: "maxPriorityFeePerGas", type: "uint256" }, { name: "ethUsdPrice", type: "uint256" },
        { name: "tokens", type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "decimals", type: "uint8" }, { name: "usdPerToken", type: "uint256" }] },
        { name: "targets", type: "address[]" },
      ] }],
      [{ hotKey: HOT.address, capUsdPerDay: 1000_000000n, perTxMaxUsd: 500_000000n, maxFeeWei: parseEther("0.05"), maxPriorityFeePerGas: 10_000_000_000n, ethUsdPrice: 3000_000000n, tokens: [], targets: [RECIPIENT] }],
    );
    const execInit = encodeAbiParameters(
      [{ type: "tuple", components: [
        { name: "hook", type: "address" }, { name: "verifier", type: "address" }, { name: "vaultPk", type: "bytes32" }, { name: "recoveryPk", type: "bytes32" },
        { name: "timelockDelay", type: "uint48" }, { name: "timelockThresholdUsd", type: "uint256" }, { name: "guardians", type: "address[]" },
      ] }],
      [{ hook: hook.address, verifier: verifier.address, vaultPk: hex(vault.publicKey), recoveryPk: hex(recovery.publicKey), timelockDelay: 172800, timelockThresholdUsd: 5000_000000n, guardians: [] }],
    );
    const bootAbi = parseAbi([
      "struct Cfg { address module; bytes data; }",
      "function initMSA(Cfg[] validators, Cfg[] executors, Cfg hook, Cfg[] fallbacks)",
    ]);
    const initCall = encodeFunctionData({
      abi: bootAbi,
      functionName: "initMSA",
      args: [[{ module: validator.address, data: "0x" }], [{ module: executor.address, data: execInit }], { module: hook.address, data: hookInit }, []],
    });
    const initCode = encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [bootstrap.address, initCall]);
    const salt = keccak256(toHex("leaked-e2e"));
    const account = (await pub.readContract({ address: factory.address, abi: factory.abi, functionName: "getAddress", args: [salt, initCode] })) as Address;
    const created = await send(factory.address, encodeFunctionData({ abi: factory.abi, functionName: "createAccount", args: [salt, initCode] }));
    await send(account, "0x", parseEther("5"));
    out.contracts = { verifier: verifier.address, executor: executor.address, hook: hook.address, validator: validator.address, msaImpl: msaImpl.address, account };
    out.accountCreationGas = created.gasUsed.toString();
    const key = BigInt(validator.address) << 32n; // MSA: validator in the nonce key's top 20 bytes
    const errAbis = [hook.abi, validator.abi, executor.abi, parseAbi(["error OverCap(uint256 requested, uint256 available)"])];

    // 3a. Hot userOp within the cap.
    const r1 = await bundle(await buildOp(account, key, executeSingle(RECIPIENT, parseEther("0.1"), "0x"), HOT), errAbis);
    if (!r1.submitted || !r1.success) throw new Error(`hot op failed: ${JSON.stringify(r1, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    const bucket = (await pub.readContract({ address: hook.address, abi: hook.abi, functionName: "getBucket", args: [account] })) as readonly bigint[];
    out.hotWithinCap = { ...r1, recipientBalance: (await pub.getBalance({ address: RECIPIENT })).toString(), bucketAvailable: bucket[0].toString() };

    // 3b. Over the per-tx max: rejected by the bundler's simulation (validation), never submitted.
    const r2 = await bundle(await buildOp(account, key, executeSingle(RECIPIENT, parseEther("0.2"), "0x"), HOT), errAbis);
    if (r2.submitted) throw new Error("over-perTx op was not rejected in validation");
    out.overPerTxRejected = r2;

    // 3c. Over the rolling cap: $300 + $450 spent, $300 more passes validation and reverts in postCheck.
    await bundle(await buildOp(account, key, executeSingle(RECIPIENT, parseEther("0.15"), "0x"), HOT), errAbis);
    const before = await pub.getBalance({ address: RECIPIENT });
    const r3 = await bundle(await buildOp(account, key, executeSingle(RECIPIENT, parseEther("0.1"), "0x"), HOT), errAbis);
    const after = await pub.getBalance({ address: RECIPIENT });
    if (!r3.submitted || r3.success || after !== before) throw new Error("over-cap op did not fail in execution");
    out.overCapRejected = { ...r3, recipientUnchanged: after === before };

    // 3d. Vault exec through LeakedRoleExecutor, C13-signed, relayed by a SimpleAccount userOp.
    const saImpl = await deploy("SimpleAccount.sol", "SimpleAccount", [EP]);
    const proxy = await deploy("ERC1967Proxy.sol", "ERC1967Proxy", [
      saImpl.address,
      encodeFunctionData({ abi: saImpl.abi, functionName: "initialize", args: [RELAYER_OWNER.address] }),
    ]);
    await send(proxy.address, "0x", parseEther("1"));
    const calls: Call[] = [{ target: VAULT_DEST, value: parseEther("1"), data: "0x" }];
    const digest = (await pub.readContract({ address: executor.address, abi: executor.abi, functionName: "hashVaultExec", args: [account, 0n, calls, 0n] })) as Hex;
    const digestTs = vaultExecDigest(31337, executor.address, account, 0n, calls, 0n);
    if (digest !== digestTs) throw new Error("executor digest != viem digest");
    const t0 = Date.now();
    const pqSig = hex(pqSign(vault.secretKey, Buffer.from(digest.slice(2), "hex")));
    const signMs = Date.now() - t0;
    const inner = encodeFunctionData({ abi: executor.abi, functionName: "vaultExec", args: [account, calls, 0n, 0n, pqSig] });
    const relayCall = encodeFunctionData({ abi: saImpl.abi, functionName: "execute", args: [executor.address, 0n, inner] });
    const r4 = await bundle(await buildOp(proxy.address, 0n, relayCall, RELAYER_OWNER, { verif: 100_000n, call: 600_000n, pvg: 120_000n }), errAbis);
    if (!r4.submitted || !r4.success) throw new Error(`vault exec failed: ${JSON.stringify(r4, (_, v) => (typeof v === "bigint" ? v.toString() : v))}`);
    out.vaultExecRelayed = { ...r4, pqSignMs: signMs, sigBytes: (pqSig.length - 2) / 2, callDataBytes: (relayCall.length - 2) / 2, destBalance: (await pub.getBalance({ address: VAULT_DEST })).toString() };

    const file = fileURLToPath(new URL("./last-run.json", import.meta.url));
    writeFileSync(file, JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
    console.log(JSON.stringify(out, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2));
    console.log("e2e OK");
  } finally {
    anvil?.kill();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
