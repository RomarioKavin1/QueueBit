import type { BucketReading } from "../background/bucket";
import type { ActivityEntry } from "../background/activity";
import type { SerializedRpcError } from "./errors";
import type { AccountStatus, SendPreview, PairPreview, PolicyView, SignerView } from "./views";
import type { QueuedView, VaultRequestRecord } from "../background/vault";
import type { VaultActionRequest } from "../background/vaultActions";
import type { SiteWarning } from "./sites";
import type { Approval, BalanceResult, KnownSite, OriginPermission, Settings, SetupState, WalletState } from "./types";
import type { AlertRecord } from "../background/watcher/alerts";
import type { PairingView } from "../background/watcher/pairing";
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

export interface UiApi {
  "state:get": { req: undefined; res: WalletState };
  /** The backup words leave the service worker only when the user asked to see them (`revealWords`). */
  "keyring:create": { req: { password: string; revealWords?: boolean }; res: { mnemonic?: string } };
  "keyring:import": { req: { mnemonic: string; password: string }; res: null };
  /** Checklist › Back up your everyday words: the words, after the password is typed again. */
  "keyring:revealWords": { req: { password: string }; res: { mnemonic: string } };
  "keyring:unlock": { req: { password: string }; res: null };
  "keyring:lock": { req: undefined; res: null };
  "keyring:changePassword": { req: { oldPassword: string; newPassword: string }; res: null };
  "keyring:reset": { req: undefined; res: null };
  "settings:update": { req: Partial<Settings>; res: Settings };
  "setup:update": { req: Partial<SetupState>; res: SetupState };
  "wallet:balance": { req: { chainId?: number }; res: BalanceResult };
  "wallet:bucket": { req: undefined; res: BucketReading };
  "permissions:list": { req: undefined; res: OriginPermission[] };
  "permissions:revoke": { req: { origin: string }; res: null };
  "approval:get": { req: { id: string }; res: ApprovalView | null };
  "approval:resolve": { req: { id: string; approved: boolean; alwaysAllow?: boolean }; res: null };
  /** Transaction approvals: the route and fee for what the site asked (simulates; can take a few seconds). */
  "approval:preview": { req: { id: string }; res: SendPreview };
  "account:status": { req: { chainId?: number }; res: AccountStatus };
  "account:activate": { req: { chainId?: number }; res: ActivityEntry };
  "send:preview": { req: SendRequest; res: SendPreview };
  "send:submit": { req: SendRequest; res: ActivityEntry };
  "activity:list": { req: undefined; res: ActivityEntry[] };
  "activity:replace": { req: { id: string; mode: "speed-up" | "cancel" }; res: ActivityEntry };
  /**
   * Pairing (ux-spec §3.1.2, §3.1.4): the service worker decodes the scanned / pasted code itself. `confirm: false`
   * only previews (the 8-character check); `confirm: true` stores it.
   */
  "pair:vault": { req: { text: string; confirm: boolean }; res: PairPreview };
  "pair:recovery": { req: { text: string; confirm: boolean }; res: PairPreview };
  /** The phone's recovery-test code: its signature must verify against the Recovery key scanned before (E-23). */
  "pair:recoveryTest": { req: { text: string }; res: { ok: true; last8: string; payer?: `0x${string}` } };
  /** A fresh, single-use request id for the recovery test, as a `ur:queuebit-recovery-challenge` code for the phone. */
  "pair:recoveryChallenge": { req: undefined; res: { text: string; requestId: string } };
  /** "Tokens you'll spend": validate (decimals on-chain) and store the choice for `chainId`. */
  "setup:setTokens": {
    req: { chainId: number; tokens: Array<{ token: `0x${string}`; usd: number; decimals: number; symbol: string }> };
    res: SetupState;
  };
  "pair:forgetRecovery": { req: undefined; res: null };
  /** Computes the counterfactual account from the paired Vault, the Recovery key and the limits (end of onboarding). */
  "account:computePlan": { req: { chainId?: number }; res: AccountStatus };
  /** A dapp payment the router sent to the Vault: the request stays pending until the phone's approval is sent. */
  "approval:toVault": { req: { id: string }; res: VaultRequestRecord };
  "vault:create": { req: { chainId?: number; action: VaultActionRequest }; res: VaultRequestRecord };
  "vault:get": { req: { id: string }; res: VaultRequestRecord | null };
  "vault:list": { req: undefined; res: VaultRequestRecord[] };
  /** The scanned `ur:queuebit-signature` CBOR (hex): verified, simulated and submitted, or an error with its E-code. */
  "vault:submit": { req: { id: string; signature: `0x${string}` }; res: VaultRequestRecord };
  "vault:cancel": { req: { id: string }; res: null };
  "vault:queue": { req: { chainId?: number }; res: QueuedView[] };
  "vault:executeQueued": { req: { chainId?: number; opId: `0x${string}` }; res: { hash: `0x${string}` } };
  "vault:policy": { req: { chainId?: number }; res: PolicyView };
  "vault:signers": { req: { chainId?: number }; res: SignerView[] };
  /** "Fee balance › Top up": what moving `amountWei` from the account to a role signer's fee balance would do. */
  "vault:topUpPreview": {
    req: { chainId?: number; role: "vault" | "recovery"; amountWei: string };
    res: SendPreview & { tank: `0x${string}`; signer: `0x${string}` };
  };
  /** Everyday payment account → fee tank (counts against the limit), then tank → signer. Waits for both. */
  "vault:topUp": {
    req: { chainId?: number; role: "vault" | "recovery"; amountWei: string };
    res: { paymentHash: `0x${string}`; hash?: `0x${string}`; balanceWei: string };
  };
  /** The next everyday key's address (for "Replace everyday key"). */
  "security:nextEverydayKey": { req: undefined; res: { index: number; address: `0x${string}` } };

  // ---- Private balance (ux-spec §3.11, plan §40 §1) ----
  "privacy:view": { req: { chainId?: number }; res: PrivacyView };
  /** Root-checked note sync (progress is written to storage as it goes). */
  "privacy:sync": { req: { chainId?: number }; res: PrivacyView };
  /** Starts Move to private (shield) or Move to public (unshield, to a fresh address via PoolPayer). */
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
  /** The phone's scanned `ur:queuebit-signature` (CBOR hex) for the operation's note-key request. */
  "privacy:answer": { req: { chainId?: number; opId: string; signature: `0x${string}` }; res: PrivacyView };
  "privacy:retry": { req: { chainId?: number; opId: string }; res: PrivacyView };
  "privacy:cancel": { req: { chainId?: number; opId: string }; res: PrivacyView };
  "privacy:dismiss": { req: { chainId?: number }; res: PrivacyView };
  /** Advance the operation (after its Vault payment was approved on the hand-off page). */
  "privacy:run": { req: { chainId?: number }; res: PrivacyView };
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

  // ---- Alerts (watcher light mode + a paired self-hosted watcher; plan §30 §6.5, §40 §5) ----
  "alerts:list": { req: undefined; res: AlertRecord[] };
  "alerts:read": { req: { ids?: string[] }; res: AlertRecord[] };
  /** Check now (also what the 60 s alarm does). */
  "alerts:poll": { req: undefined; res: { added: number } };
  "watcher:status": {
    req: { chainId?: number };
    res: { lastPollAt?: number; lastError?: string; cursor?: string; paired?: PairingView };
  };
  /** A self-hosted watcher's pairing code `{url, topic, keyId, hmacKey}`; `confirm: false` only checks it. */
  "watcher:pair": { req: { text: string; confirm: boolean }; res: PairingView };
  "watcher:unpair": { req: undefined; res: null };
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
