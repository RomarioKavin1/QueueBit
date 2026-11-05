import { concat, getAddress, numberToHex, sha256, toHex, type Address, type Hex } from "viem";
import { httpTransport, type Transport } from "@leaked/rpc";
import type { Network } from "./types.js";

/** Anon-RPC 0.4.0 `fetch(url, { …, anonOptions: { isolationKey } })` (SPEC §9.3). */
export interface AnonRequestInit extends RequestInit {
  anonOptions?: { isolationKey?: string };
}
export type AnonFetch = (input: string | URL, init?: AnonRequestInit) => Promise<Response>;

/**
 * `sha256(address ‖ chainId)`: one Anon-RPC isolation key per account and chain (§6.2; the anon-rpc wallet guide
 * recommends one key per account). The private-balance sync uses this key.
 */
export function isolationKeyFor(account: Address, chainId: bigint): Hex {
  return sha256(concat([getAddress(account), numberToHex(chainId, { size: 32 })]));
}

/** A key used once: every PoolPayer withdrawal goes out on its own circuit (a new identity per unshield, §6.2). */
export function freshIsolationKey(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export interface AnonNetworkOptions {
  /** The Anon-RPC worker's `fetch` (extension harness, offscreen document). */
  fetch: AnonFetch;
  isolationKey: string;
  /**
   * Called with the isolation key of every request, before it is sent: the hook the extension uses to audit that
   * requests carry a key (plan §8.1, "≥ 95 % of extension RPC calls carry an isolationKey").
   */
  onRequest?: (info: { url: string; isolationKey: string }) => void;
}

/**
 * The Host `network`: every request goes through the anonymizing fetch with `anonOptions.isolationKey` set. A caller
 * that passes its own `anonOptions` cannot drop or replace the key (the merge keeps ours), so unlinkability cannot be
 * weakened per request.
 */
export function anonNetwork(opts: AnonNetworkOptions): Network & { readonly isolationKey: string } {
  if (!opts.isolationKey) throw new Error("isolationKey required");
  return {
    isolationKey: opts.isolationKey,
    fetch(input, init) {
      const url = typeof input === "string" ? input : input.toString();
      opts.onRequest?.({ url, isolationKey: opts.isolationKey });
      const given = (init as AnonRequestInit | undefined)?.anonOptions;
      return opts.fetch(input, { ...init, anonOptions: { ...given, isolationKey: opts.isolationKey } });
    },
  };
}

/**
 * No anonymity: the platform fetch. For the local devnet and tests only (Anon-RPC specifiers live on mainnet/Sepolia,
 * §0); the UI must label reads made this way.
 */
export function directNetwork(f: typeof fetch = globalThis.fetch): Network & { readonly anonymous: false } {
  return { anonymous: false, fetch: (input, init) => f(input, init) };
}

/** A JSON-RPC transport (`@leaked/rpc`) whose HTTP goes through a Host `network`. */
export function networkTransport(url: string, network: Network, timeoutMs?: number): Transport {
  return httpTransport(url, {
    fetch: ((input: string | URL, init?: RequestInit) => network.fetch(input, init)) as typeof fetch,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}
