import {
  concatHex,
  decodeErrorResult,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  pad,
  parseAbi,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import {
  entryPoint08Abi,
  formatUserOperationRequest,
  getUserOperationHash,
  toPackedUserOperation,
  type UserOperation,
} from "viem/account-abstraction";
import { hotValidatorAbi, policyHookAbi, roleExecutorAbi } from "../../generated/contracts";
import type { Call } from "../routing";

/**
 * ERC-4337 v0.8 user operations for the compatible account (viem's account-abstraction helpers: hash, pack, RPC
 * format; no permissionless.js needed). Only `execute(single|batch, default exec)` is hot-reachable (the validator
 * refuses every other mode) and the calldata must be canonically ABI-encoded, which viem's encoder is.
 */

export const MODE_SINGLE: Hex = pad("0x00", { size: 32, dir: "right" });
export const MODE_BATCH: Hex = pad("0x01", { size: 32, dir: "right" });

const executeAbi = parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]);

/** ERC-7579 `execute`: one call as `target ‖ value ‖ data`, several as `abi.encode(Execution[])`. */
export function executeCalldata(calls: Call[]): Hex {
  if (calls.length === 1) {
    const c = calls[0]!;
    return encodeFunctionData({
      abi: executeAbi,
      functionName: "execute",
      args: [MODE_SINGLE, encodePacked(["address", "uint256", "bytes"], [c.target, c.value, c.data])],
    });
  }
  const batch = encodeAbiParameters(
    [
      {
        type: "tuple[]",
        components: [
          { name: "target", type: "address" },
          { name: "value", type: "uint256" },
          { name: "callData", type: "bytes" },
        ],
      },
    ],
    [calls.map((c) => ({ target: c.target, value: c.value, callData: c.data }))],
  );
  return encodeFunctionData({ abi: executeAbi, functionName: "execute", args: [MODE_BATCH, batch] });
}

/** MSA / Safe7579 pick the validator from the nonce key's top 20 bytes (key = validator << 32, uint192). */
export const validatorNonceKey = (validator: Address): bigint => BigInt(validator) << 32n;

export type Op = UserOperation<"0.8">;

export function userOpHash(op: Op, chainId: number, entryPoint: Address): Hex {
  return getUserOperationHash({ chainId, entryPointAddress: entryPoint, entryPointVersion: "0.8", userOperation: op });
}

/** A 65-byte stub (estimation): the validator returns "signature failed" for it before any policy check. */
export const STUB_SIGNATURE: Hex = concatHex([pad("0x01", { size: 32 }), pad("0x01", { size: 32 }), "0x1b"]);

/** JSON-safe op (activity storage, re-submission). */
export type SerializedOp = Record<keyof Pick<Op, "sender" | "callData" | "signature">, string> & {
  nonce: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
};

export function serializeOp(op: Op): SerializedOp {
  return {
    sender: op.sender,
    nonce: op.nonce.toString(),
    callData: op.callData,
    callGasLimit: op.callGasLimit.toString(),
    verificationGasLimit: op.verificationGasLimit.toString(),
    preVerificationGas: op.preVerificationGas.toString(),
    maxFeePerGas: op.maxFeePerGas.toString(),
    maxPriorityFeePerGas: op.maxPriorityFeePerGas.toString(),
    signature: op.signature,
  };
}

/** `handleOps([op], beneficiary)` (exact-bytes simulation through `eth_call`, plan §30 §4: never send unsimulated). */
export function handleOpsCalldata(op: Op, beneficiary: Address): Hex {
  return encodeFunctionData({
    abi: entryPoint08Abi,
    functionName: "handleOps",
    args: [[toPackedUserOperation(op)], beneficiary],
  });
}

/** The prefund the op may draw from the account (the hook's `maxFeeWei` bounds it; no paymaster). */
export const maxPrefund = (op: Op): bigint =>
  (op.verificationGasLimit + op.callGasLimit + op.preVerificationGas) * op.maxFeePerGas;

// ---- the bundler (ERC-4337 JSON-RPC) ----------------------------------------------------------------------------

export class BundlerError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: Hex,
  ) {
    super(message);
    this.name = "BundlerError";
  }
}

export interface UserOpReceipt {
  userOpHash: Hex;
  sender: Address;
  nonce: Hex;
  success: boolean;
  actualGasCost: Hex;
  actualGasUsed: Hex;
  reason?: Hex | null;
  logs: Array<{ address: Address; data: Hex; topics: Hex[] }>;
  receipt: { transactionHash: Hex; blockNumber: Hex; status: Hex; [k: string]: unknown };
}

export interface GasEstimate {
  preVerificationGas: bigint;
  verificationGasLimit: bigint;
  callGasLimit: bigint;
}

export type Fetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{
  json(): Promise<unknown>;
}>;

/** A minimal ERC-4337 bundler client (Alto, Pimlico, or devnet/deploy/bundler.ts locally). */
export class BundlerClient {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly fetchFn: Fetch = (u, i) => fetch(u, i),
  ) {}

  async request<T>(method: string, params: unknown[]): Promise<T> {
    const res = (await (
      await this.fetchFn(this.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
      })
    ).json()) as { result?: T; error?: { code: number; message: string; data?: unknown } };
    if (res.error) {
      const data =
        typeof res.error.data === "string" && res.error.data.startsWith("0x") ? (res.error.data as Hex) : undefined;
      throw new BundlerError(res.error.code, res.error.message, data);
    }
    return res.result as T;
  }

  supportedEntryPoints(): Promise<Address[]> {
    return this.request("eth_supportedEntryPoints", []);
  }

  async estimate(op: Op, entryPoint: Address): Promise<GasEstimate> {
    const r = await this.request<Record<string, Hex>>("eth_estimateUserOperationGas", [
      formatUserOperationRequest({ ...op, signature: STUB_SIGNATURE }),
      entryPoint,
    ]);
    return {
      preVerificationGas: BigInt(r.preVerificationGas!),
      verificationGasLimit: BigInt(r.verificationGasLimit!),
      callGasLimit: BigInt(r.callGasLimit!),
    };
  }

  send(op: Op, entryPoint: Address): Promise<Hex> {
    return this.request("eth_sendUserOperation", [formatUserOperationRequest(op), entryPoint]);
  }

  receipt(hash: Hex): Promise<UserOpReceipt | null> {
    return this.request("eth_getUserOperationReceipt", [hash]);
  }
}

// ---- revert reasons -----------------------------------------------------------------------------------------------

const epErrors = parseAbi([
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
  "error Error(string)",
  "error OverCap(uint256 requested, uint256 available)",
]);
const ABIS: Abi[] = [policyHookAbi as Abi, hotValidatorAbi as Abi, roleExecutorAbi as Abi, epErrors];

/** "OverCap(300000000,220000000)": a module / EntryPoint revert in words a log can carry (best effort). */
export function decodeRevert(data: Hex | undefined): string | undefined {
  if (!data || data === "0x") return undefined;
  for (const abi of ABIS) {
    try {
      const d = decodeErrorResult({ abi, data });
      const args = (d.args ?? []) as unknown[];
      if (d.errorName === "FailedOpWithRevert") {
        return `${String(args[1])}${decodeRevert(args[2] as Hex) ? `: ${decodeRevert(args[2] as Hex)}` : ""}`;
      }
      if (d.errorName === "FailedOp") return String(args[1]);
      if (d.errorName === "CallFailed") return decodeRevert(args[1] as Hex) ?? "CallFailed";
      return `${d.errorName}(${args.map(String).join(",")})`;
    } catch {
      // next ABI
    }
  }
  return data.slice(0, 10);
}

/** Finds revert bytes in a viem error (`cause.data`, nested). */
export function revertData(e: unknown): Hex | undefined {
  let x: unknown = e;
  for (let i = 0; i < 8 && x; i++) {
    const o = x as { data?: unknown; cause?: unknown };
    if (typeof o.data === "string" && o.data.startsWith("0x")) return o.data as Hex;
    if (o.data && typeof (o.data as { data?: unknown }).data === "string") return (o.data as { data: Hex }).data;
    x = o.cause;
  }
  return undefined;
}
