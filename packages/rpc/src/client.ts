import { hexToBigInt, type Address, type Hex } from "viem";
import {
  parseEthrexReceipt,
  parseSidecarReceipt,
  toWire,
  type EthrexReceiptRpc,
  type FrameTx,
  type FrameTxReceipt,
  type SidecarReceiptRpc,
  type WireFrameTx,
} from "@queuebit/frames";
import type { EthrexFrameTransactionRpc } from "./ethrexJson.js";
import { httpTransport, RpcError, type HttpTransportOptions, type Transport } from "./transport.js";
import type {
  AdmissionRecord,
  ExplorerInfo,
  ExplorerTransaction,
  FrameGasEstimate,
  FrameTxStatus,
  GasPrice,
  Page,
  ReputationEntry,
  SimulationResult,
  SimulationResultRpc,
  SkandhaConfig,
} from "./types.js";

const big = (h: Hex | null | undefined): bigint | null =>
  h === null || h === undefined ? null : h === "0x" ? 0n : hexToBigInt(h);
const bigOr0 = (h: Hex | undefined): bigint => big(h) ?? 0n;

/** Calls `fn`, mapping a JSON-RPC error that means "no such thing" to `null`. */
async function orNull<T>(fn: () => Promise<T>, notFound: (e: RpcError) => boolean): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RpcError && notFound(e)) return null;
    throw e;
  }
}

export type BlockTag = "latest" | "pending" | "safe" | "finalized" | "earliest" | Hex;

/**
 * The execution client (ethrex `eip8141-tracer`): the canonical mempool and chain reads. All methods are reads except
 * `sendRawTransaction`.
 */
export interface NodeClient {
  readonly transport: Transport;
  chainId(): Promise<bigint>;
  clientVersion(): Promise<string>;
  blockNumber(): Promise<bigint>;
  getBalance(address: Address, block?: BlockTag): Promise<bigint>;
  getTransactionCount(address: Address, block?: BlockTag): Promise<bigint>;
  /** Submits `0x06 || rlp` to the canonical mempool; returns the tx hash. */
  sendRawTransaction(raw: Hex): Promise<Hex>;
  /** Dry run: ethrex's admission checks plus a full multi-frame execution. Nothing is submitted. */
  simulateFrameTransaction(raw: Hex, options?: { block?: BlockTag; trace?: boolean }): Promise<SimulationResult>;
  /** The receipt with `frameReceipts`, or null until mined. */
  getTransactionReceipt(hash: Hex): Promise<FrameTxReceipt | null>;
  /** The node's JSON for a frame transaction, or null. `frameTxFromEthrexJson` turns it into a `FrameTx`. */
  getTransactionByHash(hash: Hex): Promise<EthrexFrameTransactionRpc | null>;
  /** The raw `0x06 || rlp` bytes (`debug_getRawTransaction`; the devnet has no `eth_getRawTransactionByHash`). */
  getRawTransaction(hash: Hex): Promise<Hex | null>;
}

export function createNodeClient(transport: Transport): NodeClient {
  const call = <T>(method: string, params: readonly unknown[] = []) => transport.request<T>(method, params);
  return {
    transport,
    chainId: async () => bigOr0(await call<Hex>("eth_chainId")),
    clientVersion: () => call<string>("web3_clientVersion"),
    blockNumber: async () => bigOr0(await call<Hex>("eth_blockNumber")),
    getBalance: async (address, block = "latest") => bigOr0(await call<Hex>("eth_getBalance", [address, block])),
    getTransactionCount: async (address, block = "pending") =>
      bigOr0(await call<Hex>("eth_getTransactionCount", [address, block])),
    sendRawTransaction: (raw) => call<Hex>("eth_sendRawTransaction", [raw]),
    async simulateFrameTransaction(raw, options = {}) {
      const params: unknown[] = [raw];
      if (options.block !== undefined || options.trace) params.push(options.block ?? "latest");
      if (options.trace) params.push({ trace: true });
      const r = await call<SimulationResultRpc>("ethrex_simulateFrameTransaction", params);
      const out: SimulationResult = {
        valid: r.canonicalMempoolValid ?? r.valid ?? false,
        violation: r.canonicalMempoolViolation ?? r.violation ?? null,
        prefixShape: r.prefixShape ?? null,
        payer: r.payer ?? null,
        maxCost: big(r.maxCost),
        gasUsed: big(r.gasUsed),
        frames: r.frames ?? null,
        executionStatus: r.executionStatus ?? null,
        executionError: r.executionError ?? null,
      };
      if ("erc7562Trace" in r) out.erc7562Trace = r.erc7562Trace;
      if ("erc7562TraceError" in r) out.erc7562TraceError = r.erc7562TraceError ?? null;
      return out;
    },
    async getTransactionReceipt(hash) {
      const r = await call<EthrexReceiptRpc | null>("eth_getTransactionReceipt", [hash]);
      return r === null ? null : parseEthrexReceipt(r);
    },
    getTransactionByHash: (hash) => call<EthrexFrameTransactionRpc | null>("eth_getTransactionByHash", [hash]),
    getRawTransaction: (hash) => call<Hex | null>("debug_getRawTransaction", [hash]),
  };
}

/** What `eth_estimateFrameTransactionGas` takes: the wire form; `signatures`, `fees` and nonces may be omitted. */
export type PartialWireFrameTx = Partial<WireFrameTx> & Pick<WireFrameTx, "sender" | "frames">;

/** The Skandha alt-mempool sidecar (`/rpc`). All methods are reads except `sendFrameTransaction`. */
export interface SidecarClient {
  readonly transport: Transport;
  chainId(): Promise<bigint>;
  clientVersion(): Promise<string>;
  /** Submits to the ERC-8421 alt mempool; returns the tx hash. */
  sendFrameTransaction(tx: FrameTx): Promise<Hex>;
  estimateFrameTransactionGas(tx: FrameTx | PartialWireFrameTx): Promise<FrameGasEstimate>;
  /** The mempool entry, or null when this node's mempool does not hold it. */
  getFrameTransactionByHash(hash: Hex): Promise<unknown | null>;
  /** The receipt, or null until mined (the sidecar answers `-32000 transaction receipt not found`). */
  getFrameTransactionReceipt(hash: Hex): Promise<FrameTxReceipt | null>;
  /** The lifecycle status, or null for a hash this node does not know (`-32600 Frame transaction not found`). */
  frameTransactionStatus(hash: Hex): Promise<FrameTxStatus | null>;
  getGasPrice(): Promise<GasPrice>;
  config(): Promise<SkandhaConfig>;
  connectedPeers(): Promise<unknown[]>;
  explorer: {
    /** Fails with -32601 unless the sidecar runs with `--explorer.enable`. */
    info(): Promise<ExplorerInfo>;
    /** The admission report and lifecycle events, or null for an unknown hash. */
    getTransaction(hash: Hex): Promise<ExplorerTransaction | null>;
    listTransactions(query?: { status?: string; cursor?: string; limit?: number }): Promise<Page<unknown>>;
    listAdmissions(query?: { outcome?: string; cursor?: string; limit?: number }): Promise<Page<AdmissionRecord>>;
    listReputation(query?: { cursor?: string; limit?: number }): Promise<Page<ReputationEntry>>;
    peers(): Promise<unknown[]>;
  };
}

const isNotFound = (e: RpcError) => e.code === -32600 && /not found/i.test(e.reason);
const isNoReceipt = (e: RpcError) => e.code === -32000 && /receipt not found/i.test(e.reason);

const isFrameTx = (tx: FrameTx | PartialWireFrameTx): tx is FrameTx => typeof (tx as FrameTx).chainId === "bigint";

export function createSidecarClient(transport: Transport): SidecarClient {
  const call = <T>(method: string, params: readonly unknown[] = []) => transport.request<T>(method, params);
  return {
    transport,
    chainId: async () => bigOr0(await call<Hex>("eth_chainId")),
    clientVersion: () => call<string>("web3_clientVersion"),
    sendFrameTransaction: (tx) => call<Hex>("eth_sendFrameTransaction", [toWire(tx)]),
    async estimateFrameTransactionGas(tx) {
      const r = await call<{
        frames: { execution: Hex; state: Hex }[];
        cumulativeGasUsed: Hex;
        maxFeePerGas: Hex;
        maxPriorityFeePerGas: Hex;
      }>("eth_estimateFrameTransactionGas", [isFrameTx(tx) ? toWire(tx) : tx]);
      return {
        frames: r.frames.map((f) => ({ execution: bigOr0(f.execution), state: bigOr0(f.state) })),
        cumulativeGasUsed: bigOr0(r.cumulativeGasUsed),
        maxFeePerGas: bigOr0(r.maxFeePerGas),
        maxPriorityFeePerGas: bigOr0(r.maxPriorityFeePerGas),
      };
    },
    getFrameTransactionByHash: (hash) => call<unknown | null>("eth_getFrameTransactionByHash", [hash]),
    async getFrameTransactionReceipt(hash) {
      const r = await orNull(
        () => call<SidecarReceiptRpc | null>("eth_getFrameTransactionReceipt", [hash]),
        isNoReceipt,
      );
      return r === null ? null : parseSidecarReceipt(r);
    },
    frameTransactionStatus: (hash) =>
      orNull(() => call<FrameTxStatus>("skandha_frameTransactionStatus", [hash]), isNotFound),
    async getGasPrice() {
      const r = await call<{ maxPriorityFeePerGas: Hex; maxFeePerGas: Hex }>("skandha_getGasPrice");
      return { maxPriorityFeePerGas: bigOr0(r.maxPriorityFeePerGas), maxFeePerGas: bigOr0(r.maxFeePerGas) };
    },
    config: () => call<SkandhaConfig>("skandha_config"),
    connectedPeers: () => call<unknown[]>("skandha_connectedPeers"),
    explorer: {
      info: () => call<ExplorerInfo>("skandha_explorer_info"),
      getTransaction: (hash) =>
        orNull(() => call<ExplorerTransaction>("skandha_explorer_getTransaction", [hash]), isNotFound),
      listTransactions: (query = {}) => call<Page<unknown>>("skandha_explorer_listTransactions", [query]),
      listAdmissions: (query = {}) => call<Page<AdmissionRecord>>("skandha_explorer_listAdmissions", [query]),
      listReputation: (query = {}) => call<Page<ReputationEntry>>("skandha_explorer_listReputation", [query]),
      peers: () => call<unknown[]>("skandha_explorer_peers"),
    },
  };
}

export interface FrameRpc {
  node: NodeClient;
  sidecar: SidecarClient;
}

/**
 * Both endpoints of a devnet deployment. `sidecarUrl` defaults to `<nodeUrl>/rpc`, the layout of
 * https://altmempool.forshtat.com (ethrex at the root, the sidecar at /rpc).
 */
export function createFrameRpc(
  nodeUrl: string,
  options: HttpTransportOptions & { sidecarUrl?: string } = {},
): FrameRpc {
  const { sidecarUrl, ...http } = options;
  return {
    node: createNodeClient(httpTransport(nodeUrl, http)),
    sidecar: createSidecarClient(httpTransport(sidecarUrl ?? `${nodeUrl.replace(/\/+$/, "")}/rpc`, http)),
  };
}

/** The public EIP-8141 devnet (chain 1337). Throwaway: it can be reset. */
export const DEVNET_1337 = {
  chainId: 1337,
  nodeUrl: "https://altmempool.forshtat.com",
  sidecarUrl: "https://altmempool.forshtat.com/rpc",
  gatewayUrl: "https://altmempoolgateway.forshtat.com/rpc",
  entryPoint: "0x00000000000000000000000000000000000000aa",
  stakingRegistry: "0xd51c04d7a0b01124e84de152f4e56d9eecb22d2f",
} as const;
