import type { LeanIo } from "@queuebit/extension/src/background/lean/account";
import { getNetwork } from "@queuebit/extension/src/shared/chains";
import { createFrameRpc, createLeanPoolClient, httpTransport, type FrameRpc, type LeanPoolClient } from "@queuebit/rpc";
import { createPublicClient, http, type Address, type PublicClient } from "viem";
import type { EngineConfig } from "./protocol";

/**
 * Network clients for the engine: the same three as the extension's (apps/extension/src/background/rpc.ts) — the node,
 * the ERC-8421 alt-mempool sidecar and the LeanPool node — but with run-time overrides, so /test can point at a local
 * LeanPool node or devnet without a rebuild. Every public devnet endpoint answers CORS `*`, and so does the LeanPool
 * node, so the page calls them directly.
 */
export class WebIo {
  private clients = new Map<number, PublicClient>();
  private frames = new Map<number, FrameRpc>();
  private leanpools = new Map<number, LeanPoolClient>();

  constructor(private config: EngineConfig = {}) {}

  setConfig(config: EngineConfig): void {
    this.config = config;
    this.clients.clear();
    this.frames.clear();
    this.leanpools.clear();
  }

  endpoints(chainId: number) {
    const net = getNetwork(chainId);
    const pick = (v: string | undefined, d: string) => (v && v.trim() ? v.trim().replace(/\/+$/u, "") : d);
    return {
      rpcUrl: pick(this.config.rpcUrl, net.rpcUrl),
      sidecarUrl: pick(this.config.sidecarUrl, net.sidecarUrl),
      leanpoolUrl: pick(this.config.leanpoolUrl, net.leanpoolUrl),
    };
  }

  publicClient = (chainId: number): PublicClient => {
    let c = this.clients.get(chainId);
    if (!c) {
      c = createPublicClient({ transport: http(this.endpoints(chainId).rpcUrl, { timeout: 15_000, retryCount: 1 }) });
      this.clients.set(chainId, c);
    }
    return c;
  };

  private frameRpc(chainId: number): FrameRpc {
    let f = this.frames.get(chainId);
    if (!f) {
      const e = this.endpoints(chainId);
      f = createFrameRpc(e.rpcUrl, { timeoutMs: 20_000, sidecarUrl: e.sidecarUrl });
      this.frames.set(chainId, f);
    }
    return f;
  }

  leanpool = (chainId: number): LeanPoolClient => {
    let c = this.leanpools.get(chainId);
    if (!c) {
      c = createLeanPoolClient(httpTransport(this.endpoints(chainId).leanpoolUrl, { timeoutMs: 20_000 }));
      this.leanpools.set(chainId, c);
    }
    return c;
  };

  readonly lean: LeanIo = {
    publicClient: (id) => this.publicClient(id),
    node: (id) => this.frameRpc(id).node,
    sidecar: (id) => this.frameRpc(id).sidecar,
    leanpool: (id) => this.leanpool(id),
  };

  readRpc = async (chainId: number, method: string, params: unknown[]): Promise<unknown> => {
    const request = this.publicClient(chainId).request as (a: {
      method: string;
      params: unknown[];
    }) => Promise<unknown>;
    return request({ method, params });
  };

  getBalance = (chainId: number, address: Address): Promise<bigint> =>
    this.publicClient(chainId).getBalance({ address });
}
