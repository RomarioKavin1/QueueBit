import type { Address, Hex } from "viem";

/**
 * The Kohaku plugin `Host` shape (plan 40 §1.2): `{ network, storage, keystore, provider, externalSyncProvider? }`.
 *
 * LICENSE GATE: `@kohaku-eth/plugins` declares no license (npm `license` field empty, no LICENSE file in the repo;
 * THIRD_PARTY.md), so it is neither a dependency nor copied. These are our own structural types written from the
 * documented shape, member names kept so that an object built here can be handed to a Kohaku plugin once the license
 * is confirmed. Only the members this package uses are typed precisely.
 */
export interface Host {
  network: Network;
  storage: Storage;
  keystore: Keystore;
  provider: HostProvider;
  externalSyncProvider?: ExternalSyncProvider;
}

/** `fetch`-shaped. QueueBit: the Anon-RPC worker's fetch, with an `isolationKey` per account (§6.2). */
export interface Network {
  fetch(input: string | URL, init?: RequestInit): Promise<Response>;
}

/** String KV. The Kohaku contract: "Host SHOULD implement secure, encrypted storage". */
export interface Storage {
  readonly _brand: "Storage";
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

/** Returns a private key at a BIP-32 path. QueueBit: throws for everything except vault-registered delegation paths. */
export interface Keystore {
  deriveAt(path: string): Promise<Hex>;
}

/** A raw log as the sync needs it. */
export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  logIndex: number;
  transactionHash?: Hex;
}

export interface LogFilter {
  address: Address;
  /** `topics[0]` alternatives (OR). */
  events?: Hex[];
  fromBlock: bigint;
  toBlock: bigint;
}

export interface CallRequest {
  to: Address;
  data: Hex;
  from?: Address;
  value?: bigint;
}

/**
 * The `EthereumProvider` members this package uses (Kohaku `@kohaku-eth/provider` names). `call`, `getBalance`,
 * `getStorageAt` and `getCode` are the "correctness" reads that a Helios hook can verify (§6.3); `getLogs` is never
 * verified, which is why sync checks the computed roots against `call` (fail closed).
 */
export interface HostProvider {
  getChainId(): Promise<bigint>;
  getBlockNumber(): Promise<bigint>;
  getLogs(filter: LogFilter): Promise<RawLog[]>;
  getBalance(address: Address, block?: bigint): Promise<bigint>;
  getCode(address: Address, block?: bigint): Promise<Hex>;
  getStorageAt(address: Address, slot: Hex, block?: bigint): Promise<Hex>;
  getTransactionCount(address: Address): Promise<number>;
  call(call: CallRequest, block?: bigint): Promise<Hex>;
  estimateGas(call: CallRequest): Promise<bigint>;
  getGasPrice(): Promise<bigint>;
  request(req: { method: string; params?: readonly unknown[] }): Promise<unknown>;
  /** Whether `call`/`getBalance`/`getStorageAt`/`getCode` are light-client verified. Shown as a badge in the UI. */
  readonly readsVerified: boolean;
}

export interface ExternalRawEvent {
  contractAddress: Hex;
  eventTopic: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  logIndex: Hex;
}

export interface ExternalSyncPoolId {
  chainId: Hex;
  address: Hex;
}

/** Pre-scraped events (0xbow's saga CDN). Logs from here are as unverified as RPC logs; the root check covers them. */
export interface ExternalSyncProvider {
  streamEvents(params: ExternalSyncPoolId & { fromBlock: Hex; toBlock: Hex }): AsyncIterable<ExternalRawEvent>;
  firstCoveredBlock(params: ExternalSyncPoolId): Promise<Hex>;
  lastCoveredBlock(params: ExternalSyncPoolId): Promise<Hex>;
}
