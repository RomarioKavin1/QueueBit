import { createPublicClient, http, type Address, type PublicClient } from "viem";
import { getNetwork } from "../shared/chains";

/**
 * Read-only RPC (M0: direct HTTPS to the fixed endpoints; the private connection via Anon-RPC replaces the transport
 * in M6, plan §30 §9.6). One viem client per chain.
 */
const clients = new Map<number, PublicClient>();

export function publicClient(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const net = getNetwork(chainId);
    c = createPublicClient({ transport: http(net.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
    clients.set(chainId, c);
  }
  return c;
}

export async function readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
  // The method name was checked against the read whitelist by the router before reaching here.
  const request = publicClient(chainId).request as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  return request({ method, params });
}

export async function getBalance(chainId: number, address: Address): Promise<bigint> {
  return publicClient(chainId).getBalance({ address });
}
