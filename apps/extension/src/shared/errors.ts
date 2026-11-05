/**
 * EIP-1193 provider errors (plan §30 §3.1; codes from EIP-1193 and JSON-RPC 2.0).
 */
export const RpcErrorCode = {
  userRejected: 4001,
  unauthorized: 4100,
  unsupportedMethod: 4200,
  disconnected: 4900,
  chainDisconnected: 4901,
  /** MetaMask convention for "unrecognised chain"; wagmi/viem key their add-chain fallback on it. */
  unrecognizedChain: 4902,
  invalidParams: -32602,
  methodNotFound: -32601,
  internal: -32603,
  /** EIP-1474 "Limit exceeded": too many requests waiting for the user. */
  limitExceeded: -32005,
} as const;

export interface SerializedRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class ProviderRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = "ProviderRpcError";
    this.code = code;
    this.data = data;
  }

  toJSON(): SerializedRpcError {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data };
  }
}

export const userRejected = (what = "The user rejected the request.") =>
  new ProviderRpcError(RpcErrorCode.userRejected, what);

export const unauthorized = (message: string) => new ProviderRpcError(RpcErrorCode.unauthorized, message);

export function serializeError(err: unknown): SerializedRpcError {
  if (err instanceof ProviderRpcError) return err.toJSON();
  if (typeof err === "object" && err !== null && "code" in err && typeof err.code === "number") {
    const e = err as { code: number; message?: unknown; data?: unknown };
    // Errors from the upstream node (eth_call reverts etc.) keep their code and data.
    return {
      code: e.code,
      message: typeof e.message === "string" ? e.message : "Request failed",
      ...(e.data !== undefined ? { data: e.data } : {}),
    };
  }
  // Never forward internal error text (it could carry local state); give a generic message.
  return { code: RpcErrorCode.internal, message: "Internal error in LEAKED." };
}
