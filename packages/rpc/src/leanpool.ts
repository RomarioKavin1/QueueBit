import type { Address, Hex } from "viem";
import type { Transport } from "./transport.js";

/**
 * A LeanPool node (`services/leanpool-node`): it verifies a post-quantum everyday payment's leanSPHINCS signature,
 * batches it, posts the batch root on-chain, fills the transaction's witness and delivers it to the ERC-8421 alt
 * mempool. The extension sends `{raw, sigs}` and follows the payment by its LeanPool id.
 */
export interface LeanPoolTxStatus {
  /**
   * `pooled`: verified, waiting for a batch · `posted`: its batch root is on-chain, delivery under way · `submitted`:
   * in the alt mempool, not mined yet · `mined` / `reverted`: final · `refused`: the alt mempool refused it.
   */
  stage: "pooled" | "posted" | "submitted" | "mined" | "reverted" | "refused";
  /** The mined transaction's hash (filling the witness changes it from the LeanPool id). */
  txHash?: Hex;
  gasUsed?: string;
  error?: string;
  lastError?: string;
  batch?: { root: Hex; postTx: Hex; block: string; ring: number; proofHash?: Hex };
}

export interface LeanPoolStatus {
  name: string;
  aggregating: boolean;
  /** The aggregator's address: a `LeanPoolHotSigner` names it. */
  nodeId?: Address;
  registry?: Address;
  chainId?: number;
  pool: unknown[];
  bond?: { bonded: string; min: string };
}

export interface LeanPoolClient {
  readonly transport: Transport;
  /** Hands a signed payment to the node. Returns its LeanPool id (the hash before the witness is added). */
  sendTransaction(raw: Hex, sigs: Hex[]): Promise<{ txHash: Hex }>;
  getTx(poolId: Hex): Promise<LeanPoolTxStatus | null>;
  status(): Promise<LeanPoolStatus>;
  /** A batch's recursive STARK by its on-chain hash (anyone can verify it: `queuebit-leanpool-verify-batch`). */
  getStark(proofHash: Hex): Promise<Hex | null>;
}

export function createLeanPoolClient(transport: Transport): LeanPoolClient {
  return {
    transport,
    sendTransaction: (raw, sigs) => transport.request<{ txHash: Hex }>("leanpool_sendTransaction", [{ raw, sigs }]),
    getTx: (poolId) => transport.request<LeanPoolTxStatus | null>("leanpool_getTx", [poolId]),
    status: () => transport.request<LeanPoolStatus>("leanpool_status", []),
    getStark: (proofHash) => transport.request<Hex | null>("leanpool_getStark", [proofHash]),
  };
}

/** A final stage: nothing changes after it. */
export const isFinalLeanPoolStage = (s: LeanPoolTxStatus["stage"]): boolean =>
  s === "mined" || s === "reverted" || s === "refused";
