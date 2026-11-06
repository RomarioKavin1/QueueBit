// Shared constants and helpers for the local ERC-4337 chain (deploy-4337.ts, bundler.ts, smoke-4337.ts, up-4337.ts).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { concatHex, pad, parseAbi, toHex, type Abi, type Address, type Hex } from "viem";

/** EntryPoint v0.8.0, canonical CREATE2 address. */
export const ENTRY_POINT: Address = "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108";
/** Arachnid deterministic-deployment proxy. Calldata = salt ‖ initCode. */
export const CREATE2_DEPLOYER: Address = "0x4e59b44847b379578588920cA78FbF26c0B4956C";
/** Runtime code of the Arachnid proxy (for `anvil_setCode` when the node does not have it). */
export const ARACHNID_RUNTIME: Hex =
  "0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";
/** The salt of the EntryPoint v0.8.0 release deployment. */
export const EP_SALT: Hex = "0x0a59dbff790c23c976a548690c27297883cc66b4c67024f9117b0238995e35e9";

export const ANVIL_URL = process.env.ANVIL_URL ?? "http://localhost:8546";
export const ANVIL_CHAIN_ID = 31337;
export const BUNDLER_URL = `http://localhost:${process.env.BUNDLER_PORT ?? 4337}/rpc`;

const here = fileURLToPath(new URL(".", import.meta.url));
export const OUT = fileURLToPath(new URL("../../contracts/out/", import.meta.url));
export const ADDRESSES_FILE = `${here}addresses.anvil4337.json`;
export const EP_JSON = fileURLToPath(
  new URL("../../contracts/lib/account-abstraction/deployments/ethereum/EntryPoint.json", import.meta.url),
);

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function artifact(file: string, name: string): Artifact {
  const j = JSON.parse(readFileSync(`${OUT}${file}/${name}.json`, "utf8"));
  return { abi: j.abi, bytecode: j.bytecode.object };
}

export const epAbi = parseAbi([
  "struct PackedUserOperation { address sender; uint256 nonce; bytes initCode; bytes callData; bytes32 accountGasLimits; uint256 preVerificationGas; bytes32 gasFees; bytes paymasterAndData; bytes signature; }",
  "function handleOps(PackedUserOperation[] ops, address beneficiary)",
  "function getUserOpHash(PackedUserOperation op) view returns (bytes32)",
  "function getNonce(address sender, uint192 key) view returns (uint256)",
  "event BeforeExecution()",
  "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  "event UserOperationRevertReason(bytes32 indexed userOpHash, address indexed sender, uint256 nonce, bytes revertReason)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);

export interface PackedUserOp {
  sender: Address;
  nonce: bigint;
  initCode: Hex;
  callData: Hex;
  accountGasLimits: Hex;
  preVerificationGas: bigint;
  gasFees: Hex;
  paymasterAndData: Hex;
  signature: Hex;
}

/** The v0.7/v0.8 unpacked JSON-RPC user operation (hex quantities), as viem's `formatUserOperationRequest` emits. */
export interface RpcUserOp {
  sender: Address;
  nonce: Hex;
  factory?: Address | null;
  factoryData?: Hex | null;
  callData: Hex;
  callGasLimit: Hex;
  verificationGasLimit: Hex;
  preVerificationGas: Hex;
  maxFeePerGas: Hex;
  maxPriorityFeePerGas: Hex;
  paymaster?: Address | null;
  paymasterVerificationGasLimit?: Hex | null;
  paymasterPostOpGasLimit?: Hex | null;
  paymasterData?: Hex | null;
  signature: Hex;
  eip7702Auth?: unknown;
}

const big = (v: Hex | null | undefined): bigint => (v ? BigInt(v) : 0n);
const pack128 = (hi: bigint, lo: bigint): Hex => pad(toHex((hi << 128n) | lo), { size: 32 });
const hex16 = (v: bigint): Hex => pad(toHex(v), { size: 16 });

export function packUserOp(op: RpcUserOp): PackedUserOp {
  return {
    sender: op.sender,
    nonce: big(op.nonce),
    initCode: op.factory ? concatHex([op.factory, op.factoryData ?? "0x"]) : "0x",
    callData: op.callData ?? "0x",
    accountGasLimits: pack128(big(op.verificationGasLimit), big(op.callGasLimit)),
    preVerificationGas: big(op.preVerificationGas),
    gasFees: pack128(big(op.maxPriorityFeePerGas), big(op.maxFeePerGas)),
    paymasterAndData: op.paymaster
      ? concatHex([op.paymaster, hex16(big(op.paymasterVerificationGasLimit)), hex16(big(op.paymasterPostOpGasLimit)), op.paymasterData ?? "0x"])
      : "0x",
    signature: op.signature ?? "0x",
  };
}

export function unpackUserOp(p: PackedUserOp): RpcUserOp {
  const q = (v: bigint): Hex => toHex(v);
  const hi = (w: Hex) => BigInt(w) >> 128n;
  const lo = (w: Hex) => BigInt(w) & ((1n << 128n) - 1n);
  const op: RpcUserOp = {
    sender: p.sender,
    nonce: q(p.nonce),
    callData: p.callData,
    callGasLimit: q(lo(p.accountGasLimits)),
    verificationGasLimit: q(hi(p.accountGasLimits)),
    preVerificationGas: q(p.preVerificationGas),
    maxFeePerGas: q(lo(p.gasFees)),
    maxPriorityFeePerGas: q(hi(p.gasFees)),
    signature: p.signature,
  };
  if (p.initCode.length >= 42) {
    op.factory = `0x${p.initCode.slice(2, 42)}`;
    op.factoryData = `0x${p.initCode.slice(42)}`;
  }
  if (p.paymasterAndData.length >= 106) {
    const d = p.paymasterAndData.slice(2);
    op.paymaster = `0x${d.slice(0, 40)}`;
    op.paymasterVerificationGasLimit = q(BigInt(`0x${d.slice(40, 72)}`));
    op.paymasterPostOpGasLimit = q(BigInt(`0x${d.slice(72, 104)}`));
    op.paymasterData = `0x${d.slice(104)}`;
  }
  return op;
}

/** Minimal JSON-RPC client that keeps the node's error (code, message, data) intact. */
export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

let rpcId = 0;
export async function rpc<T = any>(url: string, method: string, params: unknown[] = []): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  const j = (await res.json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
  if (j.error) throw new RpcError(j.error.code, j.error.message, j.error.data);
  return j.result as T;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
