import type { Address, Hex } from "viem";

/** Which account backend an address uses: the frame-native account (EIP-8141) or ERC-4337 + the ERC-7579 modules. */
export type Backend = "frame" | "4337";

/** Queue kinds, by name (`LeakedAccountBase.KIND_*`; the 4337 executor uses the same numbering). */
export type QueueKind = "spend" | "loosen" | "upgrade" | "migrate" | "unknown";

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
  accounts: { address: Address; backend: Backend }[];
  /** 4337 backend: the LeakedPolicyHook and LeakedRoleExecutor module addresses (their events carry `account`). */
  modules?: Address[];
  /** 4337 backend: the EntryPoint (a failed hot userOp leaves `UserOperationRevertReason`). */
  entryPoint?: Address;
  /** Role signers (PQRoleSigner clones) and the account each one serves. */
  roleSigners?: { address: Address; account: Address }[];
}

/** Where a decoded event came from. `ordinal` is the event's position among the watched events of its tx. */
export interface EventMeta {
  chainId: number;
  account: Address;
  backend: Backend;
  /** The contract that emitted the log (the account itself, a module, the EntryPoint or a role signer). */
  emitter: Address;
  blockNumber: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  /** Block timestamp (seconds) when known. */
  timestamp?: number;
}

/** Why a hot (everyday) payment was blocked in execution. */
export type BlockReason = "over-limit" | "per-payment-limit" | "not-allowed" | "paused" | "other" | "unknown";

/** Events the rules act on, normalised across both backends. */
export type AccountEvent =
  | { type: "queued"; opId: Hex; kind: QueueKind; eta: number }
  | { type: "upgradeQueued"; impl: Address; eta: number }
  | { type: "migrationQueued"; to: Address; eta: number }
  | { type: "queueExecuted"; opId: Hex }
  | { type: "queueCancelled"; opId: Hex; by?: Address; byRecovery?: boolean }
  | { type: "frozen"; by: Address | null; until: number }
  | { type: "unfrozen"; by: Address | null }
  | { type: "bunkerEnabled" }
  | { type: "bunkerDisabled" }
  | { type: "hotKeyRotated"; oldKey: Address; newKey: Address }
  /** `newVault` is the new VaultSigner address (frame) or the new vault public-key hash (4337). */
  | { type: "vaultRotationStarted"; newVault: Hex; eta: number }
  | { type: "vaultRotationFinalized"; newVault: Hex }
  | { type: "vaultRotationCancelled"; newVault: Hex }
  | { type: "vaultSignerSet"; signer: Address }
  | { type: "recoverySet" }
  | { type: "guardianSet"; guardian: Address; enabled: boolean }
  | { type: "capUpdated" }
  | { type: "timelockUpdated" }
  | {
      type: "policyChanged";
      what: "token" | "target" | "session" | "value-verifier" | "trusted-verifier" | "fees" | "recipients";
    }
  | { type: "upgraded"; impl: Address }
  | { type: "migrated"; to: Address }
  | { type: "activity"; what: "hot" | "vault" | "session" | "hash-registered" }
  | { type: "roleSignerStake"; what: "staked" | "unlocked" | "withdrawn"; roleSigner: Address }
  /** Derived, not a log: a hot payment whose execution reverted (frame receipt status 0, or a 4337 revert reason). */
  | { type: "hotBlocked"; reason: BlockReason; errorName?: string };

export type WatchedEvent = EventMeta & { event: AccountEvent };
