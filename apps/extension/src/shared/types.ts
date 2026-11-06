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

/** A quantum-safe key a phone showed the browser (`ur:leaked-pq-key`). */
export interface PairedKeyRecord {
  schemeId: `0x${string}`;
  pk: `0x${string}`;
  /**
   * The role's Path-B fee-payment address on the phone. Vault: from the pairing code. Recovery: from the v2
   * recovery-test code (the witness covers it), else from the Recovery key code; `InitConfig.recovery.payerKey`.
   */
  payer?: Address;
  at: number;
}

/**
 * A token the user chose during onboarding ("Tokens you'll spend"): it goes into `InitConfig.tokens` with a static,
 * Vault-pinned price (USD with 6 decimals per whole token, as a decimal string), so everyday payments and ERC-2612
 * pre-approvals work from the first day. Changing it later is a Vault action.
 */
export interface TokenChoice {
  token: Address;
  symbol: string;
  decimals: number;
  /** USD-6 per one whole token, decimal string (e.g. "1000000" = $1.00). */
  usdPerToken: string;
  /** The user confirmed the pinned price on screen. */
  confirmedAt: number;
}

/** The recovery test's request id, chosen by the browser (single use, shown to the phone as a code). */
export interface RecoveryChallengeRecord {
  requestId: string;
  pk: `0x${string}`;
  issuedAt: number;
}

/**
 * Choices made during onboarding (ux-spec §3.1). They become the account's `InitConfig` when the address is computed
 * at the end of onboarding (`account:computePlan`); after that they only describe what was set, and changes are
 * Vault actions.
 */
export interface SetupState {
  dailyLimitUsd: number;
  perPaymentUsd: number;
  /** Open (default): everyday payments may go to any address within the limits; Strict: allowed recipients only. */
  recipientMode: "open" | "strict";
  /** Fee tank is allowlisted at setup (decision 2026-11-06): top-ups are everyday payments, not Vault approvals. */
  feeTankAllowlisted: true;
  vault?: PairedKeyRecord;
  /** The Recovery key's public key, scanned during the ceremony; `testedAt` once its recovery-test code verified. */
  recovery?: PairedKeyRecord & { testedAt?: number };
  guardian?: { address: Address; name?: string; requestedAt: number };
  /** Tokens for `InitConfig.tokens`, per chain id (addresses differ per network). */
  tokens?: Record<string, TokenChoice[]>;
  /** The outstanding recovery-test challenge (consumed by the first test code that verifies against it). */
  recoveryChallenge?: RecoveryChallengeRecord;
  recoverySkippedAt?: number;
  guardianSkippedAt?: number;
  completedAt?: number;
}

export const DEFAULT_SETUP: SetupState = {
  dailyLimitUsd: 500,
  perPaymentUsd: 200,
  recipientMode: "open",
  feeTankAllowlisted: true,
};

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

export type ApprovalKind = "connect" | "transaction" | "sign-in" | "permit";

/** A signature request a site made (M3): what the approval window shows and what is signed on approval. */
export interface ApprovalSignature {
  method: "personal_sign" | "eth_signTypedData_v4";
  /** personal_sign: params[0] as sent (hex or text). */
  raw?: string;
  /** personal_sign: the readable text. */
  text?: string;
  /** eth_signTypedData_v4: the typed data JSON as sent. */
  typedJson?: string;
  /** SIWE fields, when the message is EIP-4361. */
  siwe?: { domain: string; statement?: string; uri?: string; expirationTime?: string; nonce?: string };
  /** SIWE: the message's domain is the requesting site (else E-50, never signed). */
  domainOk?: boolean;
  /** First sign-in from this site (not on the in-extension allowed sign-in list). */
  firstSignIn?: boolean;
  /** Typed data: the app's domain name and contract, for the screen. */
  appDomain?: { name?: string; verifyingContract?: string; chainId?: number };
  /** Typed data: `primaryType`, so a sign-in screen can say what kind of message it is (a vote, a login, …). */
  primaryType?: string;
  /** ERC-2612 permit: the pre-approval the account will register (bigints as decimal strings). */
  permit?: {
    token: Address;
    spender: Address;
    value: string;
    deadline: string;
    symbol?: string;
    decimals?: number;
    /** Absent: ERC-2612. Permit2 `PermitSingle` ("permit2") or `PermitTransferFrom` ("permit2-transfer"). */
    standard?: "permit2" | "permit2-transfer";
    /** Permit2: the signed nonce; PermitSingle: `expiration` (the allowance's end; `deadline` is `sigDeadline`). */
    nonce?: string;
    expiration?: string;
    /** Permit2: the live allowance selector that admits the spender (`0x00000000` for an allowed app). */
    sessionSelector?: `0x${string}`;
  };
}
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
  /** `sign-in` / `permit` approvals. */
  sig?: ApprovalSignature;
  /** Set when an approved transaction was sent (the dapp request returns it). */
  result?: { activityId: string; hash: `0x${string}`; batchId?: string; signature?: `0x${string}` };
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
