import type { Address, Hex } from "viem";
import type { Route, RouteCopy, RuleId } from "../background/routing";

/** JSON-safe views the service worker hands to extension pages (runtime messaging cannot carry bigints). */

export interface AccountStatus {
  chainId: number;
  /** LEAKED can create a native account here (frame backend with a deployment). */
  supported: boolean;
  unsupportedReason?: string;
  /** The address sites see on this chain. */
  address: Address;
  /** "4337": a compatible account (everyday fees come from the account's own balance). */
  backend?: "frame" | "4337";
  deployed: boolean;
  activation?: { txHash: Hex; sentAt: number };
  tank: Address;
  tankWei: string;
  accountWei: string;
  /** The fee tank needs at least this to send the activation. */
  activationCostWei: string;
  limits: { capUsd: number; perTxMaxUsd: number; availableUsd: number; fullAt?: number };
  frozen: boolean;
  frozenUntil?: number;
  bunker: boolean;
  /** "paired": the account's address commits to the paired Vault; "none": setup is not finished. */
  vault: "paired" | "none";
  vaultSigner?: Address;
  recoverySigner?: Address;
  recipientMode: "open" | "strict";
  ethUsdPrice: number;
  readAt: number;
  /** Set when the network could not be read; the other fields are then best effort. */
  error?: string;
}

export interface RouteView {
  route: Route;
  rules: RuleId[];
  amountUsd: number;
  leftAfterUsd?: number;
  copy: RouteCopy;
  simulationReason?: string;
}

export interface SendPreview {
  chainId: number;
  /** "4337": the fee comes from the account's own balance, not a fee tank. */
  backend?: "4337";
  route: RouteView;
  /** Expected network fee, paid by the fee tank (wei). Absent when not simulated (e.g. needs the Vault). */
  feeWei?: string;
  maxCostWei?: string;
  /** Plain-language lines describing what the payment does (one per call). */
  effects: string[];
  /** The fee tank can't cover the worst-case fee (E-05). */
  tankTooLow?: boolean;
  ethUsdPrice: number;
}

/** What a scanned pairing code says, for the "check the last 8 characters" step (ux-spec §3.1.2). */
export interface PairPreview {
  role: "vault" | "recovery";
  pk: Hex;
  last8: string;
  schemeId: Hex;
  schemeName: string;
  /** The scheme is behind an experimental flag (leanSphincs-s). */
  experimental?: string;
  payer?: Address;
  stored: boolean;
}

/** The account's limits and lists for the Limits screen (JSON-safe). */
export interface PolicyView {
  deployed: boolean;
  capUsd: number;
  perTxMaxUsd: number;
  availableUsd: number;
  recipientMode: "open" | "strict";
  timelockDelaySec: number;
  vaultAvailableUsd: number;
  tokens: Array<{ token: Address; allowed: boolean; decimals: number; usdPerToken: number; symbol: string }>;
  sessions: Array<{ target: Address; selector: Hex; allowanceUsd: number; expiry: number; label: string }>;
  tankWei: string;
}

export interface SignerView {
  role: "vault" | "recovery";
  address: Address;
  deployed: boolean;
  balanceWei: string;
  staked: boolean;
  schemeName: string;
  pkLast8: string;
  /** How approvals with this key reach the network, in plain words, plus the reason codes. */
  lane: { ok: boolean; text: string; rules: string[] };
}
