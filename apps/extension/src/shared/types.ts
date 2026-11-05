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
}

export interface KnownSite {
  origin: string;
  firstSeenAt: number;
  lastConnectedAt?: number;
}

export type ApprovalKind = "connect";
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
