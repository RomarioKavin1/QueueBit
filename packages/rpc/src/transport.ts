/** A JSON-RPC 2.0 call over some channel. */
export interface Transport {
  readonly url: string;
  request<T = unknown>(method: string, params?: readonly unknown[]): Promise<T>;
}

/**
 * A failed JSON-RPC call.
 *  - `code`: the node's numeric error code, or `"UNREACHABLE"` (network failure or timeout) or `"BAD_RESPONSE"` (no
 *    JSON-RPC answer, e.g. an HTTP 502 page from a proxy).
 *  - `data`: the error's `data` member, if the node sent one.
 */
export class RpcError extends Error {
  constructor(
    readonly code: number | "UNREACHABLE" | "BAD_RESPONSE",
    message: string,
    readonly url: string,
    readonly method: string,
    readonly data?: unknown,
  ) {
    super(`${method} on ${url}: ${message}`);
    this.name = "RpcError";
  }

  /** The node's own message, without the method/url prefix. */
  get reason(): string {
    return this.message.slice(`${this.method} on ${this.url}: `.length);
  }
}

export interface HttpTransportOptions {
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  /** Per-request timeout; default 30 s. */
  timeoutMs?: number;
}

/** JSON-RPC 2.0 over HTTP POST. */
export function httpTransport(url: string, options: HttpTransportOptions = {}): Transport {
  const doFetch = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let nextId = 1;
  return {
    url,
    async request<T>(method: string, params: readonly unknown[] = []): Promise<T> {
      const id = nextId++;
      let res: Response;
      try {
        res = await doFetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", ...options.headers },
          body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        throw new RpcError("UNREACHABLE", (e as Error).message, url, method);
      }
      let body: { result?: unknown; error?: { code?: unknown; message?: unknown; data?: unknown } };
      try {
        body = (await res.json()) as typeof body;
      } catch {
        throw new RpcError("BAD_RESPONSE", `HTTP ${res.status} without a JSON body`, url, method);
      }
      if (body === null || typeof body !== "object") {
        throw new RpcError("BAD_RESPONSE", `HTTP ${res.status}: not a JSON-RPC response`, url, method);
      }
      if (body.error) {
        const code = typeof body.error.code === "number" ? body.error.code : "BAD_RESPONSE";
        throw new RpcError(code, String(body.error.message ?? "unknown error"), url, method, body.error.data);
      }
      if (!("result" in body)) {
        throw new RpcError("BAD_RESPONSE", `HTTP ${res.status}: neither result nor error`, url, method);
      }
      return body.result as T;
    },
  };
}

// `explainRejection` is from @forshtat/hegota-support (MIT, Copyright (c) 2026 Alex Forshtat), src/rpc/rejection.ts
// at 2377188. See THIRD_PARTY.md.

export interface Rejection {
  /** `OP-011` banned opcode, `STO` storage access, `UNKNOWN` for anything else. */
  rule: "OP-011" | "STO" | "UNKNOWN";
  /** The node's text, unchanged. */
  message: string;
}

/** Maps a node's rejection text (the sidecar or ethrex) to a rule family of the mempool rules. */
export function explainRejection(message: string): Rejection {
  if (/banned opcode|BannedOpcode/i.test(message)) return { rule: "OP-011", message };
  if (/StorageReadNonSender|accessed 0x[0-9a-f]+ slot/i.test(message)) return { rule: "STO", message };
  return { rule: "UNKNOWN", message };
}
