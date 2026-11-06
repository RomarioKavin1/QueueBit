// Minimal ERC-4337 bundler for EntryPoint v0.8 against a local node (anvil). Devnet tooling, not a production bundler:
// no alt mempool, no ERC-7562 opcode/storage tracing, one op per bundle, submissions serialized.
//
//   bun bundler.ts        # NODE_URL (http://localhost:8546), BUNDLER_PORT (4337), BUNDLER_KEY (anvil #1)
//
// Methods: eth_chainId, eth_supportedEntryPoints, eth_estimateUserOperationGas, eth_sendUserOperation,
// eth_getUserOperationReceipt, eth_getUserOperationByHash. Any path ("/" and "/rpc"), CORS, single + batch requests.
// Gas estimation:
//   callGasLimit         = node eth_estimateGas({from: EntryPoint, to: sender, data: callData}) * 1.2 + 30,000
//   verificationGasLimit = constant 500,000 (the QueueBit validator + MSA + hook validation measures ~150-250k; a
//                          dummy signature makes simulated validation unreliable), + factory estimate * 1.2 when
//                          the op carries a factory (account deployment runs in the verification phase)
//   preVerificationGas   = 50,000 + 16 * byte length of the ABI-encoded PackedUserOperation
// Errors: -32602 bad params / unsupported entry point, -32521 callData reverts in estimation (data = revert bytes),
// -32500 handleOps simulation reverted (message = FailedOp reason, data = inner revert bytes), -32601 unknown method.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  createWalletClient,
  decodeErrorResult,
  decodeEventLog,
  decodeFunctionData,
  encodeAbiParameters,
  encodeEventTopics,
  encodeFunctionData,
  http,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ENTRY_POINT, RpcError, epAbi, packUserOp, rpc, unpackUserOp, type PackedUserOp, type RpcUserOp } from "./lib-4337.ts";

const NODE = process.env.NODE_URL ?? "http://localhost:8546";
const PORT = Number(process.env.BUNDLER_PORT ?? 4337);
const KEY = (process.env.BUNDLER_KEY ?? "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d") as Hex;
const VERIFICATION_GAS = 500_000n;
const bundlerAccount = privateKeyToAccount(KEY);

const packedTuple = epAbi.find((x) => x.type === "function" && x.name === "getUserOpHash")!.inputs as never;
const UOE_TOPIC = encodeEventTopics({ abi: epAbi, eventName: "UserOperationEvent" })[0];

let walletP: Promise<ReturnType<typeof makeWallet>> | undefined;
function makeWallet(chainId: number) {
  const chain = { id: chainId, name: "local", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [NODE] } } } as const;
  return createWalletClient({ chain, transport: http(NODE), account: bundlerAccount });
}
const wallet = () => (walletP ??= rpc<Hex>(NODE, "eth_chainId").then((c) => makeWallet(Number(c))));

const q = (v: bigint): Hex => toHex(v);
const lower = (a: string) => a.toLowerCase();

function checkEp(ep: unknown) {
  if (typeof ep !== "string" || lower(ep) !== lower(ENTRY_POINT)) {
    throw new RpcError(-32602, `unsupported entry point ${String(ep)}; supported: ${ENTRY_POINT}`);
  }
}
function checkOp(op: unknown): RpcUserOp {
  const o = op as RpcUserOp;
  if (!o || typeof o !== "object" || typeof o.sender !== "string" || typeof o.callData !== "string") {
    throw new RpcError(-32602, "invalid user operation");
  }
  return o;
}

const revertData = (e: unknown): Hex | undefined => {
  const d = (e as RpcError)?.data;
  if (typeof d === "string" && d.startsWith("0x")) return d as Hex;
  if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") return (d as { data: Hex }).data;
  return undefined;
};

async function getUserOpHash(p: PackedUserOp): Promise<Hex> {
  const data = encodeFunctionData({ abi: epAbi, functionName: "getUserOpHash", args: [p] });
  const r = await rpc<Hex>(NODE, "eth_call", [{ to: ENTRY_POINT, data }, "latest"]);
  return r.slice(0, 66) as Hex;
}

// ---------- estimation ----------
async function estimate(op: RpcUserOp) {
  const p = packUserOp({ ...op, signature: op.signature ?? "0x" });
  let callGasLimit = 0n;
  if (op.callData && op.callData !== "0x") {
    try {
      const g = BigInt(await rpc<Hex>(NODE, "eth_estimateGas", [{ from: ENTRY_POINT, to: op.sender, data: op.callData }]));
      callGasLimit = (g * 12n) / 10n + 30_000n;
    } catch (e) {
      if (e instanceof RpcError) throw new RpcError(-32521, `callData reverted in estimation: ${e.message}`, revertData(e) ?? "0x");
      throw e;
    }
  } else callGasLimit = 30_000n;
  let verificationGasLimit = VERIFICATION_GAS;
  if (op.factory) {
    try {
      const g = BigInt(await rpc<Hex>(NODE, "eth_estimateGas", [{ to: op.factory, data: op.factoryData ?? "0x" }]));
      verificationGasLimit += (g * 12n) / 10n;
    } catch {
      verificationGasLimit += 1_500_000n;
    }
  }
  const encoded = encodeAbiParameters(packedTuple, [p] as never);
  const preVerificationGas = 50_000n + 16n * BigInt((encoded.length - 2) / 2);
  return { preVerificationGas: q(preVerificationGas), verificationGasLimit: q(verificationGasLimit), callGasLimit: q(callGasLimit) };
}

// ---------- submission ----------
interface Known {
  userOpHash: Hex;
  op: RpcUserOp;
  txHash: Hex;
}
const known = new Map<string, Known>();
let queue: Promise<unknown> = Promise.resolve();
const serialize = <T>(f: () => Promise<T>): Promise<T> => {
  const r = queue.then(f, f);
  queue = r.catch(() => undefined);
  return r;
};

function simulationError(raw: Hex | undefined, fallback: string): RpcError {
  if (raw && raw !== "0x") {
    try {
      const d = decodeErrorResult({ abi: epAbi, data: raw });
      if (d.errorName === "FailedOp") return new RpcError(-32500, d.args[1], raw);
      if (d.errorName === "FailedOpWithRevert") return new RpcError(-32500, `${d.args[1]} (inner revert ${d.args[2]})`, d.args[2]);
    } catch {}
  }
  return new RpcError(-32500, `handleOps simulation reverted: ${fallback}`, raw ?? "0x");
}

async function sendUserOp(op: RpcUserOp): Promise<Hex> {
  const p = packUserOp(op);
  const userOpHash = await getUserOpHash(p);
  const data = encodeFunctionData({ abi: epAbi, functionName: "handleOps", args: [[p], bundlerAccount.address] });
  const limits = BigInt(op.callGasLimit) + BigInt(op.verificationGasLimit) + BigInt(op.preVerificationGas) +
    BigInt(op.paymasterVerificationGasLimit ?? "0x0") + BigInt(op.paymasterPostOpGasLimit ?? "0x0");
  const gas = limits + 300_000n;
  try {
    await rpc(NODE, "eth_call", [{ from: bundlerAccount.address, to: ENTRY_POINT, data, gas: q(gas) }, "latest"]);
  } catch (e) {
    if (e instanceof RpcError) throw simulationError(revertData(e), e.message);
    throw e;
  }
  const w = await wallet();
  const txHash = await w.sendTransaction({
    to: ENTRY_POINT,
    data,
    gas,
    maxFeePerGas: BigInt(op.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(op.maxPriorityFeePerGas),
  });
  known.set(lower(userOpHash), { userOpHash, op, txHash });
  for (let i = 0; i < 600; i++) {
    const r = await rpc(NODE, "eth_getTransactionReceipt", [txHash]);
    if (r) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  return userOpHash;
}

// ---------- lookup ----------
type Log = { address: Address; topics: Hex[]; data: Hex; logIndex: Hex; transactionHash: Hex; blockHash: Hex; blockNumber: Hex };
type Receipt = { logs: Log[]; transactionHash: Hex; blockHash: Hex; blockNumber: Hex };

async function findTx(hash: Hex): Promise<Hex | undefined> {
  const k = known.get(lower(hash));
  if (k) return k.txHash;
  const logs = await rpc<Log[]>(NODE, "eth_getLogs", [{ address: ENTRY_POINT, topics: [UOE_TOPIC, hash], fromBlock: "0x0", toBlock: "latest" }]);
  return logs[0]?.transactionHash;
}

async function getReceipt(hash: Hex) {
  const txHash = await findTx(hash);
  if (!txHash) return null;
  const receipt = await rpc<Receipt | null>(NODE, "eth_getTransactionReceipt", [txHash]);
  if (!receipt) return null;
  const isEp = (l: Log) => lower(l.address) === lower(ENTRY_POINT);
  let start = -1;
  let ev: { idx: number; args: any } | undefined;
  let reason: Hex | null = null;
  receipt.logs.forEach((l, idx) => {
    if (!isEp(l) || ev) return;
    try {
      const d = decodeEventLog({ abi: epAbi, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
      if (d.eventName === "BeforeExecution") start = idx;
      else if (d.eventName === "UserOperationEvent") {
        if (lower(d.args.userOpHash) === lower(hash)) ev = { idx, args: d.args };
        else start = idx; // the previous op's end bounds this op's logs
      } else if (d.eventName === "UserOperationRevertReason" && lower(d.args.userOpHash) === lower(hash)) reason = d.args.revertReason;
    } catch {}
  });
  if (!ev) return null;
  const a = ev.args;
  // The logs emitted during this op's execution: after BeforeExecution (or the previous op's UserOperationEvent).
  const logs = receipt.logs.slice(start + 1, ev.idx);
  return {
    userOpHash: hash,
    entryPoint: ENTRY_POINT,
    sender: a.sender as Address,
    nonce: q(a.nonce),
    paymaster: a.paymaster as Address,
    actualGasCost: q(a.actualGasCost),
    actualGasUsed: q(a.actualGasUsed),
    success: a.success as boolean,
    reason,
    logs,
    receipt,
  };
}

async function getByHash(hash: Hex) {
  const txHash = await findTx(hash);
  if (!txHash) return null;
  const tx = await rpc<{ input: Hex; blockHash: Hex | null; blockNumber: Hex | null } | null>(NODE, "eth_getTransactionByHash", [txHash]);
  if (!tx) return null;
  let userOperation: RpcUserOp | undefined = known.get(lower(hash))?.op;
  if (!userOperation) {
    try {
      const d = decodeFunctionData({ abi: epAbi, data: tx.input });
      if (d.functionName === "handleOps") {
        for (const p of d.args[0] as readonly PackedUserOp[]) {
          if (lower(await getUserOpHash(p)) === lower(hash)) userOperation = unpackUserOp(p);
        }
      }
    } catch {}
  }
  if (!userOperation) return null;
  return { userOperation, entryPoint: ENTRY_POINT, transactionHash: txHash, blockHash: tx.blockHash, blockNumber: tx.blockNumber };
}

// ---------- JSON-RPC ----------
async function dispatch(method: string, params: unknown[]): Promise<unknown> {
  switch (method) {
    case "eth_chainId":
      return rpc(NODE, "eth_chainId");
    case "eth_supportedEntryPoints":
      return [ENTRY_POINT];
    case "eth_estimateUserOperationGas":
      checkEp(params[1]);
      return estimate(checkOp(params[0]));
    case "eth_sendUserOperation": {
      checkEp(params[1]);
      const op = checkOp(params[0]);
      return serialize(() => sendUserOp(op));
    }
    case "eth_getUserOperationReceipt":
      if (typeof params[0] !== "string") throw new RpcError(-32602, "expected a userOpHash");
      return getReceipt(params[0] as Hex);
    case "eth_getUserOperationByHash":
      if (typeof params[0] !== "string") throw new RpcError(-32602, "expected a userOpHash");
      return getByHash(params[0] as Hex);
    default:
      throw new RpcError(-32601, `method ${method} not supported`);
  }
}

type Req = { jsonrpc?: string; id?: unknown; method?: string; params?: unknown[] };
async function handleOne(req: Req) {
  const id = req?.id ?? null;
  const t0 = Date.now();
  const method = String(req?.method);
  try {
    const result = await dispatch(method, Array.isArray(req?.params) ? req.params : []);
    console.log(`${new Date().toISOString()} ${method} ok ${Date.now() - t0}ms`);
    return { jsonrpc: "2.0", id, result: result ?? null };
  } catch (e) {
    const err = e instanceof RpcError ? e : new RpcError(-32603, String((e as Error)?.message ?? e));
    console.log(`${new Date().toISOString()} ${method} error ${err.code} ${err.message.slice(0, 160)}`);
    return { jsonrpc: "2.0", id, error: { code: err.code, message: err.message, ...(err.data !== undefined ? { data: err.data } : {}) } };
  }
}

const json = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? toHex(x) : x));
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "content-type",
};

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, cors).end();
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(200, { ...cors, "content-type": "text/plain" }).end("QueueBit dev bundler (EntryPoint v0.8): POST JSON-RPC\n");
    return;
  }
  const chunks: Buffer[] = [];
  req.on("data", (c: Buffer) => chunks.push(c));
  req.on("end", async () => {
    let body: unknown;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
      res.writeHead(200, { ...cors, "content-type": "application/json" }).end(json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }));
      return;
    }
    const out = Array.isArray(body) ? await Promise.all(body.map((r) => handleOne(r as Req))) : await handleOne(body as Req);
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end(json(out));
  });
});

server.listen(PORT, () => {
  console.log(`QueueBit bundler on http://localhost:${PORT} (node ${NODE}, entry point ${ENTRY_POINT}, bundler EOA ${bundlerAccount.address})`);
});
const stop = () => {
  console.log("bundler: shutting down");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
