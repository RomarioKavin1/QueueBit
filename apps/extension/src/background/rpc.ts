import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { createFrameRpc, type FrameRpc, type NodeClient } from "@leaked/rpc";
import { getNetwork } from "../shared/chains";

/**
 * RPC (direct HTTPS to the fixed endpoints, or the local devnet in a local-devnet build; the private connection via
 * Anon-RPC replaces the transport in M6, plan §30 §9.6). One viem client and one frame-RPC client per chain.
 */
const clients = new Map<number, PublicClient>();
const frames = new Map<number, FrameRpc>();

export function publicClient(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const net = getNetwork(chainId);
    c = createPublicClient({ transport: http(net.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
    clients.set(chainId, c);
  }
  return c;
}

export function frameRpc(chainId: number): FrameRpc {
  let f = frames.get(chainId);
  if (!f) {
    const net = getNetwork(chainId);
    f = createFrameRpc(net.rpcUrl, { timeoutMs: 20_000, ...(net.sidecarUrl ? { sidecarUrl: net.sidecarUrl } : {}) });
    frames.set(chainId, f);
  }
  return f;
}

export function nodeClient(chainId: number): NodeClient {
  return frameRpc(chainId).node;
}

export async function readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
  // The method name was checked against the read whitelist by the router before reaching here.
  const request = publicClient(chainId).request as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  return request({ method, params });
}

export async function getBalance(chainId: number, address: Address): Promise<bigint> {
  return publicClient(chainId).getBalance({ address });
}
