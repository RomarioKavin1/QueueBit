import { createPublicClient, http, type Address, type PublicClient } from "viem";
import {
  createFrameRpc,
  createLeanPoolClient,
  httpTransport,
  type FrameRpc,
  type LeanPoolClient,
  type NodeClient,
  type SidecarClient,
} from "@queuebit/rpc";
import { getNetwork } from "../shared/chains";
import type { LeanIo } from "./lean/account";

/**
 * RPC: direct HTTPS to the fixed endpoints of the network table (or the local devnet in a local-devnet build), one
 * client of each kind per chain: the node (viem and frame-aware), the alt-mempool sidecar and the LeanPool node.
 */
const clients = new Map<number, PublicClient>();
const frames = new Map<number, FrameRpc>();
const leanpools = new Map<number, LeanPoolClient>();

export function publicClient(chainId: number): PublicClient {
  let c = clients.get(chainId);
  if (!c) {
    const net = getNetwork(chainId);
    c = createPublicClient({ transport: http(net.rpcUrl, { timeout: 15_000, retryCount: 1 }) });
    clients.set(chainId, c);
  }
  return c;
}

function frameRpc(chainId: number): FrameRpc {
  let f = frames.get(chainId);
  if (!f) {
    const net = getNetwork(chainId);
    f = createFrameRpc(net.rpcUrl, { timeoutMs: 20_000, sidecarUrl: net.sidecarUrl });
    frames.set(chainId, f);
  }
  return f;
}

export function nodeClient(chainId: number): NodeClient {
  return frameRpc(chainId).node;
}

export function sidecarClient(chainId: number): SidecarClient {
  return frameRpc(chainId).sidecar;
}

export function leanpoolClient(chainId: number): LeanPoolClient {
  let c = leanpools.get(chainId);
  if (!c) {
    c = createLeanPoolClient(httpTransport(getNetwork(chainId).leanpoolUrl, { timeoutMs: 20_000 }));
    leanpools.set(chainId, c);
  }
  return c;
}

export const leanIo: LeanIo = {
  publicClient,
  node: nodeClient,
  sidecar: sidecarClient,
  leanpool: leanpoolClient,
};

export async function readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
  // The method name was checked against the read whitelist by the router before reaching here.
  const request = publicClient(chainId).request as (args: { method: string; params: unknown[] }) => Promise<unknown>;
  return request({ method, params });
}

export async function getBalance(chainId: number, address: Address): Promise<bigint> {
  return publicClient(chainId).getBalance({ address });
}
