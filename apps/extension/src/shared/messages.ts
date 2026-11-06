import type { Hex } from "viem";
import type { ActivityEntry } from "../background/activity";
import type { SessionRecord, SessionRequest } from "../background/lean/sessions";
import type { SerializedRpcError } from "./errors";
import type { AccountStatus, KeysView, MigrationPreview, SendPreview } from "./views";
import type { SiteWarning } from "./sites";
import type { Approval, BalanceResult, KnownSite, OriginPermission, Settings, SetupState, WalletState } from "./types";
import type { AnonStatus } from "./offscreen";
import type { PrivacyNetworkConfig, PrivacyOp, PrivacyView } from "./privacy";

/**
 * Typed message passing (plan §30 §2.3).
 *
 * 1. Extension pages ⇄ service worker: `chrome.runtime.sendMessage` with `{channel: UI_CHANNEL, type, payload}`.
 *    The service worker only serves these to senders whose URL is an extension page (never content scripts).
 * 2. Content script ⇄ service worker: one `chrome.runtime.connect({name: PROVIDER_PORT})` per frame.
 * 3. Inpage ⇄ content script: `window.postMessage` tagged with `INPAGE_TARGET` / `CONTENT_TARGET`.
 */
export const UI_CHANNEL = "queuebit-ui";
export const PROVIDER_PORT = "queuebit-provider";
export const INPAGE_TARGET = "queuebit-inpage";
export const CONTENT_TARGET = "queuebit-content";

export interface ApprovalView {
  approval: Approval;
  knownSite?: KnownSite;
  /** The request's site (or the page embedding it) is on a bundled scam-site list, or has a lookalike name. */
  siteWarning?: SiteWarning;
  alreadyConnected: boolean;
  /** The address the site sees on the approval's chain. */
  account?: `0x${string}`;
}

export interface SendRequest {
  chainId?: number;
  to: `0x${string}`;
  /** wei, decimal string */
  valueWei: string;
}

/** A move into the account ("Move to quantum-safe"). Imported keys are used for this move only, never stored. */
export interface MigrationRequest {
  chainId?: number;
  kind: "eoa" | "safe" | "smart-account";
  /** The address to move from (EOA: derived from the key when omitted). */
  address?: `0x${string}`;
  /** EOA: keep the address with EIP-7702 instead of moving (not quantum-safe: the old key keeps working). */
  keepAddress?: boolean;
  /** The EOA's key; a Safe's owner keys; a smart account's owner key. */
  keys: `0x${string}`[];
  /**
   * EOA only: the address's own wallet (an injected EIP-1193 wallet) signs and sends the move, so no key is imported.
   * `address` is then required and `keys` is empty.
   */
  external?: boolean;
}

/** A Safe transaction (JSON-safe: numbers as decimal strings). */
export interface SafeTxJson {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: `0x${string}`;
  refundReceiver: `0x${string}`;
  nonce: string;
}

/** A Safe's move for its owners to sign in their own wallets (`eth_signTypedData_v4` with `typedData`). */
export interface SafeMove {
  chainId: number;
  safe: `0x${string}`;
  owners: `0x${string}`[];
  threshold: number;
  destination: `0x${string}`;
  steps: string[];
  tx: SafeTxJson;
  /** The SafeTx's EIP-712 hash (what every owner signs). */
  hash: `0x${string}`;
  /** The typed data as eth_signTypedData_v4 takes it (a JSON string). */
  typedData: string;
}

/** A transaction an external wallet sends for a move (JSON-safe: wei and gas as decimal strings). */
export interface ExternalCall {
  to: `0x${string}`;
  valueWei: string;
  data: `0x${string}`;
  /** Suggested legacy gas and price, so the fee stays inside what the sweep left for it. */
  gas?: string;
  gasPrice?: string;
}

export interface UiApi {
  "state:get": { req: undefined; res: WalletState };
  /** The backup words leave the service worker only when the user asked to see them (`revealWords`). */
  "keyring:create": { req: { password: string; revealWords?: boolean }; res: { mnemonic?: string } };
  "keyring:import": { req: { mnemonic: string; password: string }; res: null };
  /** Back up your words: the words, after the password is typed again. */
  "keyring:revealWords": { req: { password: string }; res: { mnemonic: string } };
  "keyring:unlock": { req: { password: string }; res: null };
  /** A passkey wallet: `entropy` is the passkey's 32-byte WebAuthn PRF output (hex) at PASSKEY_PRF_SALT. */
  "keyring:createFromPasskey": { req: { entropy: Hex; credentialId: string }; res: null };
  "keyring:unlockWithPasskey": { req: { entropy: Hex }; res: null };
  "keyring:revealWordsWithPasskey": { req: { entropy: Hex }; res: { mnemonic: string } };
  /** The passkey a passkey wallet needs; null for a password wallet (or none). */
  "keyring:passkeyInfo": { req: undefined; res: { credentialId: string } | null };
  "keyring:lock": { req: undefined; res: null };
  "keyring:changePassword": { req: { oldPassword: string; newPassword: string }; res: null };
  "keyring:reset": { req: undefined; res: null };
  "settings:update": { req: Partial<Settings>; res: Settings };
  "setup:update": { req: Partial<SetupState>; res: SetupState };
  "wallet:balance": { req: { chainId?: number }; res: BalanceResult };
  "permissions:list": { req: undefined; res: OriginPermission[] };
  "permissions:revoke": { req: { origin: string }; res: null };
  "approval:get": { req: { id: string }; res: ApprovalView | null };
  "approval:resolve": { req: { id: string; approved: boolean; alwaysAllow?: boolean }; res: null };
  /** Transaction approvals: who signs and the most the network fee can be. */
  "approval:preview": { req: { id: string }; res: SendPreview };

  // ---- the account ----
  /** Computes (once) and reads the account: its address, whether it exists, the setup key's balance. */
  "account:status": { req: { chainId?: number }; res: AccountStatus };
  /** Before the account exists: who can help recover it (the address is bound to them). */
  "account:setGuardians": {
    req: { chainId?: number; guardians: `0x${string}`[]; threshold: number };
    res: AccountStatus;
  };
  /** The setup key creates the account. */
  "account:activate": { req: { chainId?: number }; res: ActivityEntry };
  "send:preview": { req: SendRequest; res: SendPreview };
  "send:submit": { req: SendRequest; res: ActivityEntry };
  "activity:list": { req: undefined; res: ActivityEntry[] };

  // ---- sessions ----
  "sessions:list": { req: { chainId?: number }; res: SessionRecord[] };
  /** The owner adds a session key (one admin transaction through LeanPool). */
  "sessions:create": { req: SessionRequest; res: SessionRecord };
  /** The owner removes it now. */
  "sessions:revoke": { req: { id: `0x${string}` }; res: SessionRecord };

  // ---- keys & recovery ----
  "keys:view": { req: { chainId?: number }; res: KeysView };
  /** Deletes expired keys from the account (one transaction). */
  "keys:prune": { req: { chainId?: number; ids: `0x${string}`[] }; res: ActivityEntry };
  /** Cancels a guardian recovery nobody here asked for (the owner signs). */
  "keys:cancelRecovery": { req: { chainId?: number; id: `0x${string}` }; res: ActivityEntry };

  // ---- move to quantum-safe ----
  "migrate:preview": { req: MigrationRequest; res: MigrationPreview };
  "migrate:run": { req: MigrationRequest; res: { hashes: `0x${string}`[] } };
  /**
   * An EOA move its own wallet sends (`external: true`): the token transfers, in order. The ETH goes last, from
   * `migrate:sweep`, once the transfers have landed (they spend some of it on fees).
   */
  "migrate:calls": {
    req: MigrationRequest;
    res: { chainId: number; source: `0x${string}`; destination: `0x${string}`; calls: ExternalCall[] };
  };
  /** A Safe's move, for its owners to sign in their own wallets (no keys in QueueBit). */
  "migrate:safeTx": { req: { chainId?: number; address: `0x${string}` }; res: SafeMove };
  /**
   * The Safe's execTransaction once enough owners signed: each signature is checked against the Safe's owners and its
   * on-chain SafeTx hash. A connected owner sends it.
   */
  "migrate:safeExec": {
    req: {
      chainId?: number;
      safe: `0x${string}`;
      tx: SafeTxJson;
      signatures: { owner: `0x${string}`; signature: `0x${string}` }[];
    };
    res: ExternalCall;
  };
  /** The move's last transaction: the rest of the ETH to the account (creating it), less the fee and a margin. */
  "migrate:sweep": { req: MigrationRequest; res: ExternalCall & { leftoverWei: string } };

  // ---- Private balance (ux-spec §3.11, plan §40 §1) ----
  "privacy:view": { req: { chainId?: number }; res: PrivacyView };
  /** Root-checked note sync (progress is written to storage as it goes). */
  "privacy:sync": { req: { chainId?: number }; res: PrivacyView };
  /** Starts Move to private (shield), Move to public (unshield, to a fresh address via PoolPayer) or a public exit. */
  "privacy:start": {
    req: {
      chainId?: number;
      kind: PrivacyOp["kind"];
      amountWei: string;
      /** `exit`: the note to take back publicly. */
      note?: { depositIndex: number; secretIndex: number };
    };
    res: PrivacyView;
  };
  "privacy:retry": { req: { chainId?: number; opId: string }; res: PrivacyView };
  "privacy:cancel": { req: { chainId?: number; opId: string }; res: PrivacyView };
  "privacy:dismiss": { req: { chainId?: number }; res: PrivacyView };
  "privacy:saveConfig": {
    req: {
      chainId?: number;
      entrypoint: string;
      pool: string;
      poolPayer: string;
      deployBlock: string;
      sidecarUrl?: string;
    };
    res: PrivacyNetworkConfig;
  };
  /** Settings › Private connection: whether Anon-RPC can be used on the network, and why not. */
  "privacy:connection": { req: { chainId?: number }; res: AnonStatus & { enabled: boolean } };
}

export type UiType = keyof UiApi;

export interface UiMessage<K extends UiType = UiType> {
  channel: typeof UI_CHANNEL;
  type: K;
  payload: UiApi[K]["req"];
}

export interface UiError {
  message: string;
  /** Machine-readable reason (e.g. KeyringError.reason) for UI branching. */
  reason?: string;
}

export type UiResponse<K extends UiType = UiType> =
  { ok: true; result: UiApi[K]["res"] } | { ok: false; error: UiError };

export function isUiMessage(m: unknown): m is UiMessage {
  return (
    typeof m === "object" &&
    m !== null &&
    (m as UiMessage).channel === UI_CHANNEL &&
    typeof (m as UiMessage).type === "string"
  );
}

// ---- provider port ----

export interface PortRequest {
  id: string;
  method: string;
  params?: unknown;
  /** Embedded frames only: the top-level page's origin, from the content script (`location.ancestorOrigins`). */
  topOrigin?: string;
}

export type PortResponse = { id: string; result: unknown } | { id: string; error: SerializedRpcError };

export type ProviderEvent =
  | { event: "chainChanged"; data: `0x${string}` }
  | { event: "accountsChanged"; data: string[] }
  /** Sent once on every (re)connect so the page can catch up on changes it missed while disconnected. */
  | { event: "state"; data: { chainId: `0x${string}`; accounts: string[] } };

export type PortMessageFromSw = PortResponse | ProviderEvent;

// ---- window.postMessage between inpage and content script ----

/** Sent over the private MessageChannel (after the handshake below), never on `window`. */
export interface InpageToContent {
  target: typeof CONTENT_TARGET;
  request: PortRequest;
}

export interface ContentToInpage {
  target: typeof INPAGE_TARGET;
  message: PortMessageFromSw;
}

/**
 * The only messages on `window` (M0 review: other extensions' content scripts and page scripts see every window
 * message). The provider says `hello` with a fresh nonce; the bridge answers once per document with a MessagePort
 * (`channel` echoes the nonce) and from then on requests, responses and events travel on that port only. `ready`:
 * the bridge started after the provider's first hello, so the provider says hello again.
 */
export type Handshake =
  | { target: typeof CONTENT_TARGET; hello: string }
  | { target: typeof INPAGE_TARGET; channel: string }
  | { target: typeof INPAGE_TARGET; ready: true };
