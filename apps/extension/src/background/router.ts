import type { Address } from "viem";
import { findNetwork, toHexChainId } from "../shared/chains";
import { ProviderRpcError, RpcErrorCode, unauthorized, userRejected } from "../shared/errors";
import type { ApprovalOutcome } from "./approvals";
import type { PermissionsStore } from "./permissions";

/**
 * The dapp-facing JSON-RPC method table, M0 subset (plan §30 §3.2). Everything not handled here answers EIP-1193
 * `4200 unsupported method` with a message saying which milestone brings it; `leaked_*` is internal and never served
 * to pages (`-32601`).
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
}

export interface RouterDeps {
  permissions: PermissionsStore;
  getChainId(): Promise<number>;
  setChainId(chainId: number): Promise<void>;
  hasKeyring(): Promise<boolean>;
  isUnlocked(): Promise<boolean>;
  /** The account a dapp sees. M0: the everyday key's address (see `accountsForDapp`). */
  getAccount(): Promise<Address | undefined>;
  requestConnect(origin: string, requestId: string, chainId: number): Promise<ApprovalOutcome>;
  readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown>;
}

/** Read methods forwarded to the selected network's RPC (M0 subset of the plan's whitelist). */
export const READ_METHODS = new Set(["eth_blockNumber", "eth_call", "eth_getBalance"]);

/** Which later milestone fills in a method (plan §30 §10.2), for the 4200 message. */
const LATER: Record<string, string> = {
  eth_sendTransaction: "M1 (native accounts) / M2 (compatible accounts)",
  wallet_sendCalls: "M1/M2",
  wallet_getCallsStatus: "M1/M2",
  wallet_showCallsStatus: "M1/M2",
  wallet_getCapabilities: "M1/M2",
  personal_sign: "M3",
  eth_signTypedData_v4: "M3",
  wallet_requestExecutionPermissions: "M5",
  wallet_revokeExecutionPermission: "M5",
  wallet_getGrantedExecutionPermissions: "M5",
  wallet_getSupportedExecutionPermissions: "M5",
  wallet_requestPermissions: "a later milestone",
  wallet_getPermissions: "a later milestone",
  wallet_revokePermissions: "a later milestone",
  wallet_watchAsset: "a later milestone",
};

/** Methods LEAKED will never offer (plan §30 §3.2, ux-spec E-41/E-53). */
const NEVER: Record<string, string> = {
  eth_sign: "LEAKED never signs raw hashes.",
  eth_signTransaction: "A smart account has no raw transaction to hand back.",
  eth_signTypedData: "Use eth_signTypedData_v4.",
  eth_signTypedData_v1: "Use eth_signTypedData_v4.",
  eth_signTypedData_v3: "Use eth_signTypedData_v4.",
  wallet_addEthereumChain: "LEAKED uses a fixed list of networks so a site can't point it at a fake one.",
  wallet_prepareCalls: "LEAKED never hands signing digests to pages.",
  wallet_sendPreparedCalls: "LEAKED never hands signing digests to pages.",
};

export function unsupported(method: string): ProviderRpcError {
  const never = NEVER[method];
  if (never) {
    return new ProviderRpcError(RpcErrorCode.unsupportedMethod, `LEAKED does not support ${method}. ${never}`, {
      method,
    });
  }
  const when = LATER[method];
  return new ProviderRpcError(
    RpcErrorCode.unsupportedMethod,
    when
      ? `LEAKED does not support ${method} yet; it arrives in ${when}.`
      : `LEAKED does not support ${method} in this version.`,
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

/** Accounts a dapp may see right now: only if connected and unlocked (locked wallets answer `[]`). */
async function accountsForDapp(origin: string, deps: RouterDeps): Promise<Address[]> {
  if (!(await deps.permissions.isPermitted(origin))) return [];
  if (!(await deps.isUnlocked())) return [];
  const account = await deps.getAccount();
  // M0: the dapp sees the everyday key's address. Plan §30 §3.3 says the dapp must see the smart account; that address
  // needs the account factory (M1), and this line switches to it then.
  return account ? [account] : [];
}

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

export async function routeProviderRequest(
  ctx: RequestContext,
  req: ProviderRequest,
  deps: RouterDeps,
): Promise<unknown> {
  const { method } = req;
  if (typeof method !== "string" || method.length === 0) {
    throw new ProviderRpcError(RpcErrorCode.invalidParams, "Missing method.");
  }
  if (method.startsWith("leaked_")) {
    throw new ProviderRpcError(RpcErrorCode.methodNotFound, `The method ${method} does not exist / is not available.`);
  }
  const params = paramsArray(req.params);

  switch (method) {
    case "eth_chainId":
      return toHexChainId(await deps.getChainId());

    case "net_version":
      return String(await deps.getChainId());

    case "eth_accounts":
      return accountsForDapp(ctx.origin, deps);

    case "eth_requestAccounts": {
      const existing = await accountsForDapp(ctx.origin, deps);
      if (existing.length > 0) return existing;
      const outcome = await deps.requestConnect(ctx.origin, ctx.requestId, await deps.getChainId());
      if (outcome !== "approved") throw userRejected("The user rejected the connection request.");
      const accounts = await accountsForDapp(ctx.origin, deps);
      // Approval requires an unlocked wallet; if it auto-locked in between, the request is not fulfilled.
      if (accounts.length === 0) throw userRejected("LEAKED is locked.");
      return accounts;
    }

    case "wallet_switchEthereumChain": {
      const chainId = parseChainId(params);
      if (!findNetwork(chainId)) {
        throw new ProviderRpcError(
          RpcErrorCode.unrecognizedChain,
          `LEAKED doesn't support chain ${toHexChainId(chainId)}. It uses a fixed list of networks.`,
          { chainId: toHexChainId(chainId) },
        );
      }
      if (!(await deps.permissions.isPermitted(ctx.origin))) {
        throw unauthorized("Connect to LEAKED (eth_requestAccounts) before switching networks.");
      }
      if (chainId !== (await deps.getChainId())) await deps.setChainId(chainId);
      return null;
    }

    default:
      if (READ_METHODS.has(method)) return deps.readRpc(await deps.getChainId(), method, params);
      throw unsupported(method);
  }
}
