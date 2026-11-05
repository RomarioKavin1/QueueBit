import { hexToBigInt, numberToHex, type Address, type Hex } from "viem";
import type { CallRequest, HostProvider, LogFilter, RawLog } from "./types.js";

/** An EIP-1193 `request` (a viem client, the Anon-RPC-backed transport, or a Helios provider all have one). */
export interface Eip1193Like {
  request(args: { method: string; params?: readonly unknown[] }): Promise<unknown>;
}

/**
 * Light-client-verified reads (plan §6.3: "Anon-RPC = origin privacy; Helios = correctness"). The provider routes
 * `call`/`getBalance`/`getStorageAt`/`getCode` here when present, so the sync's root checks (`currentRoot()`,
 * `roots(i)`, `latestRoot()`) are verified even though `eth_getLogs` never is.
 */
export interface VerifiedReads {
  readonly kind: string;
  call(call: CallRequest, block?: bigint): Promise<Hex>;
  getBalance(address: Address, block?: bigint): Promise<bigint>;
  getStorageAt(address: Address, slot: Hex, block?: bigint): Promise<Hex>;
  getCode(address: Address, block?: bigint): Promise<Hex>;
}

const tag = (block?: bigint): Hex | "latest" => (block === undefined ? "latest" : numberToHex(block));
const callObj = (c: CallRequest) => ({
  to: c.to,
  data: c.data,
  ...(c.from ? { from: c.from } : {}),
  ...(c.value ? { value: numberToHex(c.value) } : {}),
});

function readsOver(kind: string, p: Eip1193Like): VerifiedReads {
  return {
    kind,
    call: async (c, b) => (await p.request({ method: "eth_call", params: [callObj(c), tag(b)] })) as Hex,
    getBalance: async (a, b) =>
      hexToBigInt((await p.request({ method: "eth_getBalance", params: [a, tag(b)] })) as Hex),
    getStorageAt: async (a, s, b) => (await p.request({ method: "eth_getStorageAt", params: [a, s, tag(b)] })) as Hex,
    getCode: async (a, b) => (await p.request({ method: "eth_getCode", params: [a, tag(b)] })) as Hex,
  };
}

/**
 * Helios hook: wraps a synced Helios provider (`@a16z/helios` `createHeliosProvider(...)` after `waitSynced()`,
 * created by the extension in its offscreen document with its `executionRpc` behind the Anon-RPC fetch). This
 * package does not depend on Helios: it ships a 10+ MB WASM, needs a beacon light-client API and a recent
 * checkpoint, and is not available on the 8141 devnet (no beacon chain), so it is injected. `eth_getLogs` is
 * deliberately not routed through it (Helios serves only the last 8,191 blocks of logs, §6.3).
 */
export function heliosVerifiedReads(helios: Eip1193Like): VerifiedReads {
  return readsOver("helios", helios);
}

export interface HostProviderOptions {
  /** The (anonymized) execution RPC. */
  rpc: Eip1193Like;
  /** Omit for unverified reads (the devnet mode: "reads unverified (devnet)"). */
  verifiedReads?: VerifiedReads;
}

/** The Host `provider`: raw RPC for logs, gas and nonces; verified reads when a light client is attached. */
export function createHostProvider(opts: HostProviderOptions): HostProvider {
  const rpc = opts.rpc;
  const raw = readsOver("rpc", rpc);
  const reads = opts.verifiedReads ?? raw;
  const q = async <T>(method: string, params: readonly unknown[] = []) => (await rpc.request({ method, params })) as T;
  return {
    readsVerified: opts.verifiedReads !== undefined,
    getChainId: async () => hexToBigInt(await q<Hex>("eth_chainId")),
    getBlockNumber: async () => hexToBigInt(await q<Hex>("eth_blockNumber")),
    async getLogs(f: LogFilter): Promise<RawLog[]> {
      const params = {
        address: f.address,
        fromBlock: numberToHex(f.fromBlock),
        toBlock: numberToHex(f.toBlock),
        ...(f.events ? { topics: [f.events] } : {}),
      };
      const logs = await q<
        { address: Address; topics: Hex[]; data: Hex; blockNumber: Hex; logIndex: Hex; transactionHash?: Hex }[]
      >("eth_getLogs", [params]);
      return logs.map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: hexToBigInt(l.blockNumber),
        logIndex: Number(hexToBigInt(l.logIndex)),
        ...(l.transactionHash ? { transactionHash: l.transactionHash } : {}),
      }));
    },
    getBalance: (a, b) => reads.getBalance(a, b),
    getCode: (a, b) => reads.getCode(a, b),
    getStorageAt: (a, s, b) => reads.getStorageAt(a, s, b),
    call: (c, b) => reads.call(c, b),
    getTransactionCount: async (a) => Number(hexToBigInt(await q<Hex>("eth_getTransactionCount", [a, "pending"]))),
    estimateGas: async (c) => hexToBigInt(await q<Hex>("eth_estimateGas", [callObj(c)])),
    getGasPrice: async () => hexToBigInt(await q<Hex>("eth_gasPrice")),
    request: (req) => rpc.request(req),
  };
}

/** An EIP-1193 `request` over a `@leaked/rpc`-style transport. */
export function eip1193FromTransport(t: {
  request<T>(method: string, params?: readonly unknown[]): Promise<T>;
}): Eip1193Like {
  return { request: ({ method, params }) => t.request(method, params ?? []) };
}
