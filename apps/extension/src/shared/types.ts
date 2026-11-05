import type { Address } from "viem";
import { DEFAULT_CHAIN_ID } from "./chains";

export type Theme = "system" | "light" | "dark";

export interface Settings {
  selectedChainId: number;
  /** Auto-lock after this many idle minutes (plan §30 §2.4 default 15). */
  autoLockMinutes: number;
  theme: Theme;
}

export const AUTO_LOCK_CHOICES = [1, 5, 15, 30, 60, 240];

export const DEFAULT_SETTINGS: Settings = {
  selectedChainId: DEFAULT_CHAIN_ID,
  autoLockMinutes: 15,
  theme: "system",
};

/**
 * Choices made during onboarding. In M0 the limits are the user's intent only: they are written to the account by
 * `initialize(...)` on first deployment (M1), so the UI labels them "not active yet".
 */
export interface SetupState {
  dailyLimitUsd: number;
  perPaymentUsd: number;
  /** Fee tank is allowlisted at setup (decision 2026-11-06): top-ups are everyday payments, not Vault approvals. */
  feeTankAllowlisted: true;
  vaultSkippedAt?: number;
  recoverySkippedAt?: number;
  completedAt?: number;
}

export const DEFAULT_SETUP: SetupState = { dailyLimitUsd: 500, perPaymentUsd: 200, feeTankAllowlisted: true };

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
  /** `transaction` approvals: what the site asked to send. */
  tx?: ApprovalTx;
  /** Set when an approved transaction was sent (the dapp request returns it). */
  result?: { activityId: string; hash: `0x${string}`; batchId?: string };
  /** Set when the request ended without sending because it needs the Vault or is blocked (dapp gets 4100). */
  denial?: { leakedRule: string; explanation: string; remedy?: string };
  /** The route the approval window showed, when it was not an everyday payment: closing it returns this denial. */
  routeDenial?: { leakedRule: string; explanation: string; remedy?: string };
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
  accounts?: { everyday: Address; feeTank: Address };
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
