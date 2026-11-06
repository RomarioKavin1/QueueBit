import type { Address, Hex } from "viem";

/** JSON-safe views the service worker hands to extension pages (runtime messaging cannot carry bigints). */

export interface AccountStatus {
  chainId: number;
  /** This network has QueueBit's account contracts. */
  supported: boolean;
  unsupportedReason?: string;
  /** The account's address (counterfactual until created). */
  address?: Address;
  deployed: boolean;
  accountWei?: string;
  /** The setup key: pays for creating the account and for moves. */
  setupKey: Address;
  setupWei?: string;
  /** The setup key needs about this to create the account. */
  activationCostWei?: string;
  activation?: { hash: Hex; sentAt: number };
  /** Signatures the owner key can still safely make. */
  ownerSignaturesLeft: number;
  leanpoolUrl: string;
  /** The LeanPool node whose batches the account accepts. */
  aggregator?: Address;
  guardians?: Address[];
  readAt: number;
  /** Set when something could not be read; the other fields are then best effort. */
  error?: string;
}

export interface SendPreview {
  chainId: number;
  /** owner: the owner key signs (quantum-safe, through LeanPool); session: a session key signs, no prompt. */
  signer: "owner" | "session";
  /** session: the site the session is for. */
  sessionOrigin?: string;
  /** Why a site's request needs the owner (no session, or what the session doesn't cover). */
  sessionMiss?: string;
  valueWei: string;
  /** The most the network fee can be (the account must hold value + this). */
  maxFeeWei: string;
  balanceWei: string;
  enough: boolean;
  deployed: boolean;
  /** Plain-language lines describing what the payment does (one per call). */
  effects: string[];
}

export interface KeyView {
  id: Hex;
  kind: string;
  quantumSafe: boolean;
  admin: boolean;
  spend: boolean;
  session: boolean;
  weight: number;
  validUntil?: number;
  expired: boolean;
  /** Sessions: the most ETH per payment (wei). */
  perTxWei: string;
  /** This browser's owner key. */
  isOwnerKey: boolean;
  address?: Address;
}

export interface RecoveryView {
  id: Hex;
  approvals: number;
  /** Unix seconds: when anyone can carry it out. */
  readyAt: number;
  lastGuardian: Address;
}

export interface KeysView {
  chainId: number;
  deployed: boolean;
  keys: KeyView[];
  guardians: Array<{ address: Address; active: boolean }>;
  recoveries: RecoveryView[];
  ownerSignaturesLeft: number;
  ownerSignatureBudget: number;
}

export interface MigrationPreview {
  kind: "eoa" | "safe" | "smart-account";
  mode: "move" | "7702-delegate" | "7702-initialize" | "safe-move" | "account-upgrade" | "account-move";
  source: Address;
  destination: Address;
  ethWei: string;
  tokens: Array<{ token: Address; symbol?: string; amount: string }>;
  warning?: string;
  steps: string[];
  safe?: { owners: Address[]; threshold: number };
}
