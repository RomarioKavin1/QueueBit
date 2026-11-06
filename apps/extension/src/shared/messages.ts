import type { BucketReading } from "../background/bucket";
import type { ActivityEntry } from "../background/activity";
import type { SerializedRpcError } from "./errors";
import type { AccountStatus, SendPreview, PairPreview, PolicyView, SignerView } from "./views";
import type { QueuedView, VaultRequestRecord } from "../background/vault";
import type { VaultActionRequest } from "../background/vaultActions";
import type { Approval, BalanceResult, KnownSite, OriginPermission, Settings, SetupState, WalletState } from "./types";

/**
 * Typed message passing (plan §30 §2.3).
 *
 * 1. Extension pages ⇄ service worker: `chrome.runtime.sendMessage` with `{channel: UI_CHANNEL, type, payload}`.
 *    The service worker only serves these to senders whose URL is an extension page (never content scripts).
 * 2. Content script ⇄ service worker: one `chrome.runtime.connect({name: PROVIDER_PORT})` per frame.
 * 3. Inpage ⇄ content script: `window.postMessage` tagged with `INPAGE_TARGET` / `CONTENT_TARGET`.
 */
export const UI_CHANNEL = "leaked-ui";
export const PROVIDER_PORT = "leaked-provider";
export const INPAGE_TARGET = "leaked-inpage";
export const CONTENT_TARGET = "leaked-content";

export interface ApprovalView {
  approval: Approval;
  knownSite?: KnownSite;
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
  "pair:recoveryTest": { req: { text: string }; res: { ok: true; last8: string } };
  "pair:forgetRecovery": { req: undefined; res: null };
  /** Computes the counterfactual account from the paired Vault, the Recovery key and the limits (end of onboarding). */
  "account:computePlan": { req: { chainId?: number }; res: AccountStatus };
  /** A dapp payment the router sent to the Vault: the request stays pending until the phone's approval is sent. */
  "approval:toVault": { req: { id: string }; res: VaultRequestRecord };
  "vault:create": { req: { chainId?: number; action: VaultActionRequest }; res: VaultRequestRecord };
  "vault:get": { req: { id: string }; res: VaultRequestRecord | null };
  "vault:list": { req: undefined; res: VaultRequestRecord[] };
  /** The scanned `ur:leaked-signature` CBOR (hex): verified, simulated and submitted, or an error with its E-code. */
  "vault:submit": { req: { id: string; signature: `0x${string}` }; res: VaultRequestRecord };
  "vault:cancel": { req: { id: string }; res: null };
  "vault:queue": { req: { chainId?: number }; res: QueuedView[] };
  "vault:executeQueued": { req: { chainId?: number; opId: `0x${string}` }; res: { hash: `0x${string}` } };
  "vault:policy": { req: { chainId?: number }; res: PolicyView };
  "vault:signers": { req: { chainId?: number }; res: SignerView[] };
  /** The next everyday key's address (for "Replace everyday key"). */
  "security:nextEverydayKey": { req: undefined; res: { index: number; address: `0x${string}` } };
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

export interface InpageToContent {
  target: typeof CONTENT_TARGET;
  request: PortRequest;
}

export interface ContentToInpage {
  target: typeof INPAGE_TARGET;
  message: PortMessageFromSw;
}
