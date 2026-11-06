/**
 * Private balance (ux-spec §3.11, plan §40 §1.5): the types the service worker persists and the full app renders.
 * Amounts are wei as decimal strings (storage and runtime messages are JSON).
 */
export type Hex = `0x${string}`;

/** Where Privacy Pools v1 and PoolPayer live on a network. */
export interface PrivacyNetworkConfig {
  chainId: number;
  entrypoint: Hex;
  /** v1: the native-ETH pool. */
  pool: Hex;
  /** The ERC-8421 paymaster that pays a withdrawal's network fee out of the withdrawal itself, at cost. */
  poolPayer: Hex;
  /** The pool's deployment block (decimal): the note sync starts here. */
  deployBlock: string;
  /** The BUDGET-010 alt-mempool node the PoolPayer withdrawal is sent to (its VERIFY step is ~307k gas). */
  sidecarUrl: string;
  /**
   * Which deposits the pool's reviewer (the ASP) approved. `pool-order`: the reviewer approves deposits in the order
   * they were made (the local devnet, where the tests are the reviewer); the labels are checked against
   * `Entrypoint.latestRoot()` exactly either way. 0xbow's published list is not implemented yet.
   */
  asp: "pool-order";
  savedAt: number;
}

export type NoteStatusView = "approved" | "pending" | "ragequit";

export interface NoteView {
  depositIndex: number;
  secretIndex: number;
  valueWei: string;
  status: NoteStatusView;
}

export type PrivacyStep = "preparing" | "paying" | "proving" | "submitted" | "done" | "failed";

export interface PrivacyOp {
  id: string;
  /** `exit`: the public exit (ragequit) of one note back to the account, sent as an owner payment. */
  kind: "shield" | "unshield" | "exit";
  chainId: number;
  amountWei: string;
  createdAt: number;
  updatedAt: number;
  step: PrivacyStep;
  deposit?: {
    depositIndex: number;
    /** Public once deposited (`Deposited.precommitment`); the ledger entry is made from it when the payment lands. */
    precommitment?: string;
    /** `Poseidon(nullifier)`: public when the note is spent; lets the sync follow the spend without the note key. */
    nullifierHash?: string;
    tx: { to: Hex; data: Hex; valueWei: string };
    route?: "owner";
    activityId?: string;
    txHash?: Hex;
  };
  withdraw?: {
    depositIndex: number;
    secretIndex: number;
    /** The fresh address that receives the withdrawal (derived from the change note's key). */
    recipient?: Hex;
    feeWei?: string;
    hash?: Hex;
    /** The alt-mempool node's last status (`New`, `Pending`, `Submitted`, `OnChain`, …). */
    mempool?: string;
    receivedWei?: string;
    provingStartedAt?: number;
    provedMs?: number;
    /** The withdrawal's node calls: on their own Anon-RPC circuit, or direct on a network without Anon-RPC. */
    circuit?: "anonymous" | "direct";
  };
  /** Public exit: which note, the payment that sends `pool.ragequit`, and its result. */
  exit?: {
    depositIndex: number;
    secretIndex: number;
    provingStartedAt?: number;
    provedMs?: number;
    /** The owner payment that sends `pool.ragequit`. */
    activityId?: string;
    txHash?: Hex;
  };
  error?: { code: string; message: string; retry: boolean };
}

export interface SyncProgress {
  status: "idle" | "syncing" | "failed";
  fromBlock?: string;
  scannedTo?: string;
  toBlock?: string;
  at?: number;
  error?: string;
}

/** What the Private balance page renders (built by the service worker). */
export interface PrivacyView {
  chainId: number;
  /** `unavailable`: nothing to show but the reason (no pool on this network, account not created). */
  availability: { ok: true } | { ok: false; reason: string; action?: "settings" | "activate" };
  config?: PrivacyNetworkConfig;
  account?: Hex;
  approvedWei: string;
  pendingWei: string;
  notes: NoteView[];
  sync: SyncProgress;
  /** The largest single withdrawal possible now (one note per withdrawal). */
  maxWithdrawWei: string;
  op?: PrivacyOp;
  history: PrivacyOp[];
  /** Honest proving-time estimate from this browser's own measured proofs (none measured: undefined). */
  proofEstimateMs?: number;
  connection: { anonymous: boolean; text: string };
  readsVerified: boolean;
  /**
   * Where the balance's pool state and reviewer (ASP) list come from, for the sync-source badge: the node (host
   * only), whether its reads are light-client checked, the ASP source, and the block the last sync reached.
   */
  syncSource?: { node: string; verified: boolean; asp: string; scannedTo?: string };
}
