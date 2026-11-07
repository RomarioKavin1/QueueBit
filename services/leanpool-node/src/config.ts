// Node configuration, from the environment (no files of keys or deployments: a container passes them in).
import { getAddress, isHex } from "viem";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface NodeConfig {
  host: string;
  port: number;
  /** ethrex JSON-RPC: chain reads, the registry's legacy txs, receipts. */
  rpcUrl: string;
  /** This node's ERC-8421 alt-mempool sidecar (eth_sendFrameTransaction). */
  sidecarUrl: string;
  chainId: number;
  /** The DepsRegistry roots are posted to. */
  registry: Address;
  /** The node's ECDSA key. ECDSA mode: the aggregator identity (bond, postRoot, attachProof). PQ mode (`pq`): only
   * the gas payer of the PQAggregator's signed calls; it authorizes nothing. Secret. */
  privateKey: Hex;
  /** PQ mode: the aggregator identity is this PQAggregator contract, and roots and proof hashes are authorized by its
   * SPHINCS- C13 key (LEANPOOL_PQ_KEY, hex, or LEANPOOL_PQ_KEY_FILE; secret, never logged). */
  pq: { aggregator: Address; key?: string; keyFile?: string } | null;
  aggregate: boolean;
  /** Also run the rolling recursive aggregate (CPU heavy; off by default). */
  rolling: boolean;
  peers: string[];
  batchMs: number;
  /** STARKs are kept here so their on-chain hashes stay checkable after a restart. */
  dataDir: string;
  /** Bond the aggregator up to this much when it is below the registry's minimum (wei; 0 = never bond). */
  autoBondWei: bigint;
  /** Optional: a LeanPool ERC-8286 keystore whose PQ keys this node accepts for multi-signer txs. */
  keystore: Address | null;
  /** Largest JSON-RPC request body accepted (a mode 1 wrapper carries a ~200 KB STARK). */
  maxBodyBytes: number;
  /** Legacy gas price for the registry txs (the devnet's base fee is tiny). */
  legacyGasPrice: bigint;
}

const req = (env: NodeJS.ProcessEnv, k: string): string => {
  const v = env[k];
  if (!v) throw new Error(`${k} is required`);
  return v;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): NodeConfig {
  const key = req(env, "LEANPOOL_PRIVATE_KEY");
  if (!isHex(key) || key.length !== 66) throw new Error("LEANPOOL_PRIVATE_KEY must be a 32-byte hex key");
  privateKeyToAccount(key); // throws on an invalid key
  const aggregate = env.LEANPOOL_AGGREGATE === "1" || env.LEANPOOL_AGGREGATE === "true";
  if (env.LEANPOOL_PQ_AGGREGATOR && !env.LEANPOOL_PQ_KEY && !env.LEANPOOL_PQ_KEY_FILE)
    throw new Error("LEANPOOL_PQ_AGGREGATOR needs LEANPOOL_PQ_KEY or LEANPOOL_PQ_KEY_FILE (the C13 secret key)");
  return {
    host: env.LEANPOOL_HOST ?? "127.0.0.1",
    port: Number(env.LEANPOOL_PORT ?? "8701"),
    rpcUrl: req(env, "LEANPOOL_RPC_URL"),
    sidecarUrl: req(env, "LEANPOOL_SIDECAR_URL"),
    chainId: Number(env.LEANPOOL_CHAIN_ID ?? "1337"),
    registry: getAddress(req(env, "LEANPOOL_REGISTRY")),
    privateKey: key,
    pq: env.LEANPOOL_PQ_AGGREGATOR
      ? {
          aggregator: getAddress(env.LEANPOOL_PQ_AGGREGATOR),
          ...(env.LEANPOOL_PQ_KEY ? { key: env.LEANPOOL_PQ_KEY } : {}),
          ...(env.LEANPOOL_PQ_KEY_FILE ? { keyFile: env.LEANPOOL_PQ_KEY_FILE } : {}),
        }
      : null,
    aggregate,
    rolling: env.LEANPOOL_ROLLING === "1",
    peers: (env.LEANPOOL_PEERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    batchMs: Number(env.LEANPOOL_BATCH_MS ?? "4000"),
    dataDir: env.LEANPOOL_DATA_DIR ?? "./data",
    autoBondWei: BigInt(env.LEANPOOL_AUTO_BOND_WEI ?? "0"),
    keystore: env.LEANPOOL_KEYSTORE ? getAddress(env.LEANPOOL_KEYSTORE) : null,
    maxBodyBytes: Number(env.LEANPOOL_MAX_BODY_BYTES ?? String(2 * 1024 * 1024)),
    legacyGasPrice: BigInt(env.LEANPOOL_LEGACY_GAS_PRICE ?? "2000000"),
  };
}
