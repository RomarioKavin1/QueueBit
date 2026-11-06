import type { Address, Hex } from "viem";

/** The account backend. LeanAccount is EIP-8141 frame-native only (kept as a field so stored alerts stay readable). */
export type Backend = "frame";

/** A log as `eth_getLogs` (or a receipt) returns it. Quantities may be hex strings or already numbers. */
export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex | bigint | number;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: Hex | number;
  transactionIndex?: Hex | number;
  removed?: boolean;
  /** ethrex adds the block timestamp to each log. */
  blockTimestamp?: Hex | number;
}

/** What one watcher instance watches. Addresses only (no labels, no other PII). */
export interface WatchTargets {
  chainId: number;
  /** LeanAccounts. `backend` is optional and can only be "frame". */
  accounts: { address: Address; backend?: Backend }[];
  /**
   * The account's shared modules (KeystoreValidator, SpendingLimitHook, GuardianRecovery: devnet/deploy's addresses).
   * Their events carry `account` as the first indexed topic; only watched accounts' events are kept.
   */
  modules?: Address[];
}

/** Where a decoded event came from. */
export interface EventMeta {
  chainId: number;
  account: Address;
  backend: Backend;
  /** The contract that emitted the log (the account itself or a shared module). */
  emitter: Address;
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  /** Block timestamp (seconds) when known. */
  timestamp?: number;
}

/** A keystore policy (KeystoreValidator.Policy). */
export interface PolicyState {
  adminThreshold: number;
  spendThreshold: number;
  requirePQ: boolean;
  aggregator: Address;
}

/** Events the rules act on (LeanAccount and its modules). */
export type AccountEvent =
  // KeystoreValidator
  | { type: "keyAdded"; keyId: Hex; kind: number; weight: number; roles: number }
  | { type: "keyRemoved"; keyId: Hex }
  | { type: "keyUpdated"; keyId: Hex }
  | ({ type: "policySet" } & PolicyState)
  | { type: "sessionTokenSet"; keyId: Hex; token: Address; perTxCap: bigint }
  // SpendingLimitHook (`token` absent = ETH)
  | { type: "dailyCapSet"; keyId: Hex; token?: Address; cap: bigint }
  | { type: "sessionSpend"; keyId: Hex; token?: Address; amount: bigint; spentToday: bigint }
  // GuardianRecovery (`readyAt` 0 until the guardians' threshold is reached)
  | { type: "recoveryApproved"; id: Hex; guardian: Address; approvals: number; readyAt: number }
  | { type: "recovered"; id: Hex }
  | { type: "recoveryCancelled"; id: Hex }
  // LeanAccount
  | { type: "moduleInstalled"; moduleType: number; module: Address }
  | { type: "moduleUninstalled"; moduleType: number; module: Address }
  | { type: "upgraded"; impl: Address };

export type WatchedEvent = EventMeta & { event: AccountEvent };
