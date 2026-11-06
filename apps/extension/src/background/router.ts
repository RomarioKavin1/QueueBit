import { isAddress, isHex, type Address } from "viem";
import { findNetwork, toHexChainId } from "../shared/chains";
import { ProviderRpcError, RpcErrorCode, unauthorized, userRejected } from "../shared/errors";
import type { ApprovalTx } from "../shared/types";
import type { ApprovalOutcome } from "./approvals";
import type { PermissionsStore } from "./permissions";
import { MAX_HOT_CALLS } from "./routing";
import { classifyPersonalSign, classifyTypedData, type SignatureClass } from "./signing";

/**
 * The dapp-facing JSON-RPC method table (plan §30 §3.2), M1 subset: accounts, chains (per origin), reads, and on the
 * frame backend `eth_sendTransaction` and the EIP-5792 methods for everyday payments. Everything else answers
 * EIP-1193 `4200 unsupported method` with a message saying which milestone brings it; `queuebit_*` is internal and
 * never served to pages (`-32601`).
 */
export interface ProviderRequest {
  method: string;
  params?: unknown;
}

export interface RequestContext {
  /** From `MessageSender.origin` in the service worker; never from the page (plan §30 §9.1). */
  origin: string;
  /** Unique per dapp request; a replay after a service-worker restart carries the same id. */
  requestId: string;
  /** From `MessageSender.frameId`: true when the request comes from a frame inside another page. */
  embedded?: boolean;
  /** Embedded requests: the top-level page's origin, when the content script could read it. */
  topOrigin?: string;
}

export interface CallsStatus {
  version: string;
  id: string;
  chainId: `0x${string}`;
  status: number;
  atomic: boolean;
  receipts?: unknown[];
}

export interface RouterDeps {
  permissions: PermissionsStore;
  /** The wallet's selected chain (for sites that are not connected yet). */
  getChainId(): Promise<number>;
  /** Moves one connected site to another chain (per-origin chain). */
  setOriginChain(origin: string, chainId: number): Promise<void>;
  hasKeyring(): Promise<boolean>;
  isUnlocked(): Promise<boolean>;
  /** The account a site sees on `chainId`: the smart account where QueueBit has one, else the everyday key. */
  getAccount(chainId: number): Promise<Address | undefined>;
  requestConnect(ctx: RequestContext, chainId: number): Promise<ApprovalOutcome>;
  /** Opens the transaction approval; resolves once sent, or throws 4001 / 4100 (+ queuebitRule). */
  requestTransaction(
    ctx: RequestContext,
    chainId: number,
    tx: ApprovalTx,
  ): Promise<{ hash: `0x${string}`; activityId: string; batchId?: string }>;
  /** Opens the sign-in / pre-approval window; resolves with the signature bytes, or throws 4001 / 4100. */
  requestSignature(
    ctx: RequestContext,
    chainId: number,
    req: { method: "personal_sign" | "eth_signTypedData_v4"; raw: unknown; cls: SignatureClass },
  ): Promise<`0x${string}`>;
  callsStatus(origin: string, id: string): Promise<CallsStatus | null>;
  batchIdTaken(origin: string, id: string): Promise<boolean>;
  capabilities(chainId: number, account: Address): Promise<Record<string, unknown>>;
  showActivity(id: string): Promise<void>;
  readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown>;
}

/** Read methods forwarded to the site's chain RPC (plan §30 §3.2 whitelist, M1 subset). */
export const READ_METHODS = new Set([
  "eth_blockNumber",
  "eth_call",
  "eth_estimateGas",
  "eth_feeHistory",
  "eth_gasPrice",
  "eth_getBalance",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_getLogs",
  "eth_getStorageAt",
  "eth_getTransactionByHash",
  "eth_getTransactionCount",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
]);

/** Which later milestone fills in a method (plan §30 §10.2), for the 4200 message. */
const LATER: Record<string, string> = {
  wallet_requestExecutionPermissions: "M5",
  wallet_revokeExecutionPermission: "M5",
  wallet_getGrantedExecutionPermissions: "M5",
  wallet_getSupportedExecutionPermissions: "M5",
  wallet_requestPermissions: "a later milestone",
  wallet_getPermissions: "a later milestone",
  wallet_revokePermissions: "a later milestone",
  wallet_watchAsset: "a later milestone",
};

/** Methods QueueBit will never offer (plan §30 §3.2, ux-spec E-41/E-53). */
const NEVER: Record<string, string> = {
  eth_sign: "QueueBit never signs raw hashes.",
  eth_signTransaction: "A smart account has no raw transaction to hand back.",
  eth_signTypedData: "Use eth_signTypedData_v4.",
  eth_signTypedData_v1: "Use eth_signTypedData_v4.",
  eth_signTypedData_v3: "Use eth_signTypedData_v4.",
  wallet_addEthereumChain: "QueueBit uses a fixed list of networks so a site can't point it at a fake one.",
  wallet_prepareCalls: "QueueBit never hands signing digests to pages.",
  wallet_sendPreparedCalls: "QueueBit never hands signing digests to pages.",
};

export function unsupported(method: string): ProviderRpcError {
  const never = NEVER[method];
  if (never) {
    return new ProviderRpcError(RpcErrorCode.unsupportedMethod, `QueueBit does not support ${method}. ${never}`, {
      method,
    });
  }
  const when = LATER[method];
  return new ProviderRpcError(
    RpcErrorCode.unsupportedMethod,
    when
      ? `QueueBit does not support ${method} yet; it arrives in ${when}.`
      : `QueueBit does not support ${method} in this version.`,
    { method },
  );
}

function paramsArray(params: unknown): unknown[] {
  if (params === undefined) return [];
  if (!Array.isArray(params)) {
    throw new ProviderRpcError(RpcErrorCode.invalidParams, "params must be an array.");
  }
  return params;
}

/** The chain a site is on: its own (per-origin chain) once connected, else the wallet's selected chain. */
async function chainFor(origin: string, deps: RouterDeps): Promise<number> {
  return (await deps.permissions.chainOf(origin)) ?? (await deps.getChainId());
}

/** Accounts a dapp may see right now: only if connected and unlocked (locked wallets answer `[]`). */
async function accountsForDapp(origin: string, deps: RouterDeps): Promise<Address[]> {
  if (!(await deps.permissions.isPermitted(origin))) return [];
  if (!(await deps.isUnlocked())) return [];
  const account = await deps.getAccount(await chainFor(origin, deps));
  return account ? [account] : [];
}

const QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]*)$/u;

function parseChainId(params: unknown[]): number {
  const arg = params[0] as { chainId?: unknown } | undefined;
  const raw = arg?.chainId;
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]+$/u.test(raw) || /^0x0+[0-9a-fA-F]/u.test(raw)) {
    throw new ProviderRpcError(
      RpcErrorCode.invalidParams,
      "Expected [{ chainId: <0x-prefixed hex, no leading zeros> }].",
    );
  }
  return Number.parseInt(raw, 16);
}

const invalid = (m: string) => new ProviderRpcError(RpcErrorCode.invalidParams, m);

function parseQuantity(v: unknown, what: string): bigint {
  if (v === undefined || v === null) return 0n;
  if (typeof v !== "string" || !QUANTITY.test(v)) throw invalid(`${what} must be a 0x-prefixed hex quantity.`);
  return BigInt(v);
}

function parseCall(c: unknown, i: number): ApprovalTx["calls"][number] {
  const o = (c ?? {}) as { to?: unknown; value?: unknown; data?: unknown; input?: unknown };
  if (o.to === undefined || o.to === null) {
    throw invalid(`Call ${i}: QueueBit doesn't deploy contracts from the everyday key (missing "to").`);
  }
  if (typeof o.to !== "string" || !isAddress(o.to, { strict: false }))
    throw invalid(`Call ${i}: "to" is not an address.`);
  const data = o.data ?? o.input ?? "0x";
  if (typeof data !== "string" || !isHex(data) || data.length % 2 !== 0)
    throw invalid(`Call ${i}: "data" is not hex bytes.`);
  return {
    target: o.to as Address,
    value: parseQuantity(o.value, `Call ${i} "value"`).toString(),
    data: data as `0x${string}`,
  };
}

async function requireConnected(ctx: RequestContext, deps: RouterDeps): Promise<Address> {
  const [account] = await accountsForDapp(ctx.origin, deps);
  if (!account) throw unauthorized("Connect to QueueBit (eth_requestAccounts) first.");
  return account;
}

function checkFrom(from: unknown, account: Address): void {
  if (from === undefined || from === null) return;
  if (typeof from !== "string" || from.toLowerCase() !== account.toLowerCase()) {
    throw unauthorized(`"from" must be the connected account ${account}.`);
  }
}

export async function routeProviderRequest(
  ctx: RequestContext,
  req: ProviderRequest,
  deps: RouterDeps,
): Promise<unknown> {
  const { method } = req;
  if (typeof method !== "string" || method.length === 0) {
    throw new ProviderRpcError(RpcErrorCode.invalidParams, "Missing method.");
  }
  if (method.startsWith("queuebit_")) {
    throw new ProviderRpcError(RpcErrorCode.methodNotFound, `The method ${method} does not exist / is not available.`);
  }
  const params = paramsArray(req.params);

  switch (method) {
    case "eth_chainId":
      return toHexChainId(await chainFor(ctx.origin, deps));

    case "net_version":
      return String(await chainFor(ctx.origin, deps));

    case "eth_accounts":
      return accountsForDapp(ctx.origin, deps);

    case "eth_requestAccounts": {
      const existing = await accountsForDapp(ctx.origin, deps);
      if (existing.length > 0) return existing;
      const outcome = await deps.requestConnect(ctx, await chainFor(ctx.origin, deps));
      if (outcome !== "approved") throw userRejected("The user rejected the connection request.");
      const accounts = await accountsForDapp(ctx.origin, deps);
      // Approval requires an unlocked wallet; if it auto-locked in between, the request is not fulfilled.
      if (accounts.length === 0) throw userRejected("QueueBit is locked.");
      return accounts;
    }

    case "wallet_switchEthereumChain": {
      const chainId = parseChainId(params);
      if (!findNetwork(chainId)) {
        throw new ProviderRpcError(
          RpcErrorCode.unrecognizedChain,
          `QueueBit doesn't support chain ${toHexChainId(chainId)}. It uses a fixed list of networks.`,
          { chainId: toHexChainId(chainId) },
        );
      }
      if (!(await deps.permissions.isPermitted(ctx.origin))) {
        throw unauthorized("Connect to QueueBit (eth_requestAccounts) before switching networks.");
      }
      if (chainId !== (await chainFor(ctx.origin, deps))) await deps.setOriginChain(ctx.origin, chainId);
      return null;
    }

    case "eth_sendTransaction": {
      const account = await requireConnected(ctx, deps);
      const tx = (params[0] ?? null) as { from?: unknown; chainId?: unknown } | null;
      if (!tx || typeof tx !== "object") throw invalid("Expected [{ to, value?, data? }].");
      checkFrom(tx.from, account);
      const chainId = await chainFor(ctx.origin, deps);
      if (tx.chainId !== undefined && parseQuantity(tx.chainId, "chainId") !== BigInt(chainId)) {
        throw invalid(`This site is on chain ${toHexChainId(chainId)}; switch before sending on another chain.`);
      }
      const r = await deps.requestTransaction(ctx, chainId, {
        source: "eth_sendTransaction",
        calls: [parseCall(tx, 0)],
      });
      return r.hash;
    }

    case "wallet_sendCalls": {
      const account = await requireConnected(ctx, deps);
      const p = (params[0] ?? null) as {
        version?: unknown;
        chainId?: unknown;
        from?: unknown;
        calls?: unknown;
        id?: unknown;
        capabilities?: Record<string, { optional?: boolean }>;
        atomicRequired?: unknown;
      } | null;
      if (!p || typeof p !== "object") throw invalid("Expected [{ version, chainId, calls, atomicRequired }].");
      checkFrom(p.from, account);
      const chainId = await chainFor(ctx.origin, deps);
      if (typeof p.chainId !== "string" || parseQuantity(p.chainId, "chainId") !== BigInt(chainId)) {
        throw new ProviderRpcError(
          RpcErrorCode.unsupportedChain,
          `This site is on chain ${toHexChainId(chainId)}; the batch names another chain.`,
        );
      }
      for (const [name, cap] of Object.entries(p.capabilities ?? {})) {
        if (!cap?.optional) {
          throw new ProviderRpcError(
            RpcErrorCode.unsupportedCapability,
            `QueueBit doesn't support the "${name}" capability.`,
          );
        }
      }
      if (!Array.isArray(p.calls) || p.calls.length === 0) throw invalid("calls must be a non-empty array.");
      if (p.calls.length > MAX_HOT_CALLS) {
        throw new ProviderRpcError(
          RpcErrorCode.bundleTooLarge,
          `This request has too many steps for one payment (${p.calls.length} > ${MAX_HOT_CALLS}).`,
        );
      }
      let batchId: string | undefined;
      if (p.id !== undefined) {
        if (typeof p.id !== "string" || p.id.length === 0 || new TextEncoder().encode(p.id).length > 4096) {
          throw invalid("id must be a non-empty string of at most 4096 bytes.");
        }
        if (await deps.batchIdTaken(ctx.origin, p.id)) {
          throw new ProviderRpcError(RpcErrorCode.duplicateId, `A batch with id "${p.id}" already exists.`);
        }
        batchId = p.id;
      }
      // Everything inside one hotExecute is atomic by construction, so atomicRequired true or false is honoured.
      const calls = p.calls.map((c, i) => parseCall(c, i));
      const r = await deps.requestTransaction(ctx, chainId, {
        source: "wallet_sendCalls",
        calls,
        ...(batchId ? { batchId } : {}),
      });
      return { id: r.batchId ?? r.hash };
    }

    case "wallet_getCallsStatus": {
      await requireConnected(ctx, deps);
      const id = params[0];
      if (typeof id !== "string") throw invalid("Expected [id].");
      const status = await deps.callsStatus(ctx.origin, id);
      if (!status) throw new ProviderRpcError(RpcErrorCode.unknownBundle, `No batch with id "${id}".`);
      return status;
    }

    case "wallet_showCallsStatus": {
      await requireConnected(ctx, deps);
      const id = params[0];
      if (typeof id !== "string") throw invalid("Expected [id].");
      if (!(await deps.callsStatus(ctx.origin, id))) {
        throw new ProviderRpcError(RpcErrorCode.unknownBundle, `No batch with id "${id}".`);
      }
      await deps.showActivity(id);
      return null;
    }

    case "wallet_getCapabilities": {
      const account = await requireConnected(ctx, deps);
      const addr = params[0];
      if (addr !== undefined && (typeof addr !== "string" || addr.toLowerCase() !== account.toLowerCase())) {
        throw unauthorized("QueueBit only answers for the connected account.");
      }
      const wanted = params[1];
      const chainId = await chainFor(ctx.origin, deps);
      const ids = Array.isArray(wanted) ? wanted.map((c) => Number(parseQuantity(c, "chainId"))) : [chainId];
      const out: Record<string, unknown> = {};
      for (const id of ids) {
        if (id === chainId) out[toHexChainId(id)] = await deps.capabilities(id, account);
      }
      return out;
    }

    case "personal_sign":
    case "eth_signTypedData_v4": {
      const account = await requireConnected(ctx, deps);
      // personal_sign: [message, address]; eth_signTypedData_v4: [address, typedData].
      const [msgParam, addrParam] = method === "personal_sign" ? [params[0], params[1]] : [params[1], params[0]];
      if (typeof addrParam === "string" && addrParam.toLowerCase() !== account.toLowerCase()) {
        throw unauthorized(`QueueBit only signs for the connected account ${account}.`);
      }
      if (method === "personal_sign" && typeof msgParam !== "string") throw invalid("Expected [message, address].");
      if (method === "eth_signTypedData_v4" && typeof msgParam !== "string" && typeof msgParam !== "object") {
        throw invalid("Expected [address, typedData].");
      }
      const cls =
        method === "personal_sign"
          ? classifyPersonalSign(decodeMessage(msgParam as string))
          : classifyTypedData(msgParam);
      if (cls.kind === "needs-vault") throw signatureError(cls);
      return deps.requestSignature(ctx, await chainFor(ctx.origin, deps), { method, raw: msgParam, cls });
    }

    default:
      if (READ_METHODS.has(method)) return deps.readRpc(await chainFor(ctx.origin, deps), method, params);
      throw unsupported(method);
  }
}

function decodeMessage(hex: string): string {
  if (!isHex(hex)) return hex;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Uint8Array.from(hex.slice(2).match(/../gu) ?? [], (b) => Number.parseInt(b, 16)),
    );
  } catch {
    return "";
  }
}

/**
 * Value-bearing typed data the everyday key may never sign (classifier per the 2026-11-06 account audit,
 * `signing.ts`): `4100` + queuebitRule with the reason and what the user can do instead (ux-spec E-52).
 */
function signatureError(cls: Extract<SignatureClass, { kind: "needs-vault" }>): ProviderRpcError {
  const remedy =
    cls.rule === "SIG-PERMIT2"
      ? "QueueBit can pre-approve a single Permit2 allowance or transfer for an app you allowed. Ask the site for one of those, or approve the token with a payment instead."
      : "QueueBit never signs what can move money without a payment you approve. Ask the site for a regular transaction instead.";
  return new ProviderRpcError(RpcErrorCode.unauthorized, cls.reason, {
    queuebitRule: cls.rule,
    explanation: cls.reason,
    remedy,
  });
}
