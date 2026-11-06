import type { Address } from "viem";
import { DEFAULT_CHAIN_ID } from "./chains";

export type Theme = "system" | "light" | "dark";

export interface Settings {
  selectedChainId: number;
  /** Auto-lock after this many idle minutes (plan §30 §2.4 default 15). */
  autoLockMinutes: number;
  theme: Theme;
  /**
   * Private connection (Anon-RPC, ux-spec §3.13): default on. Where no Anon-RPC worker exists (the devnet) or this
   * build has none, requests go direct whatever this says, and Settings explains why.
   */
  anonRpc: boolean;
}

export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60, 240];

export const DEFAULT_SETTINGS: Settings = {
  selectedChainId: DEFAULT_CHAIN_ID,
  autoLockMinutes: 15,
  theme: "system",
  anonRpc: true,
};

/** Onboarding and checklist state (no account settings: those live on-chain). */
export interface SetupState {
  completedAt?: number;
  /** The backup words were shown and confirmed (or the wallet was restored from them). */
  backupConfirmedAt?: number;
}

export const DEFAULT_SETUP: SetupState = {};

export interface OriginPermission {
  origin: string;
  accounts: Address[];
  grantedAt: number;
  /**
   * The chain this site is on (ux-spec review M1: per-origin chain). Requests from the site are bound to it;
   * `wallet_switchEthereumChain` changes it for this site only. Missing on M0 records: the wallet's selected chain.
   */
  chainId?: number;
}

export interface KnownSite {
  origin: string;
  firstSeenAt: number;
  lastConnectedAt?: number;
}

export type ApprovalKind = "connect" | "transaction";

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  kind: ApprovalKind;
  origin: string;
  chainId: number;
  /** Dapp request ids attached to this approval (a replay after an SW restart re-attaches by id). */
  requestIds: string[];
  status: ApprovalStatus;
  createdAt: number;
  resolvedAt?: number;
  windowId?: number;
  /** Set when a service-worker restart found this approval still pending (ux-spec E-90). */
  resumedAt?: number;
  /** First time this site asks to connect (from the local known-sites list). */
  firstVisit: boolean;
  /** The request came from a frame embedded in another page (`MessageSender.frameId !== 0`), not the page itself. */
  embedded?: boolean;
  /** Embedded requests: the origin of the page the frame is in (shown next to the requesting origin). */
  topOrigin?: string;
  /** `transaction` approvals: what the site asked to send. */
  tx?: ApprovalTx;
  /** Why the site's session didn't send it (the network refused it, an embedded frame…), shown on the screen. */
  sessionMiss?: string;
  /** Set when an approved transaction was sent (the dapp request returns it). */
  result?: { activityId: string; hash: `0x${string}`; batchId?: string };
  /** Set when the request ended without sending because it can't be sent (dapp gets 4100). */
  denial?: { queuebitRule: string; explanation: string; remedy?: string };
}

export interface ApprovalTx {
  source: "eth_sendTransaction" | "wallet_sendCalls";
  /** wei values as decimal strings */
  calls: Array<{ target: Address; value: string; data: `0x${string}` }>;
  /** wallet_sendCalls: the app-supplied id, if any. */
  batchId?: string;
}

export interface WalletState {
  initialized: boolean;
  unlocked: boolean;
  accounts?: { everyday: Address; setup: Address };
  settings: Settings;
  setup: SetupState;
}

export interface BalanceResult {
  chainId: number;
  wei: string;
  symbol: string;
  decimals: number;
  fetchedAt: number;
}
