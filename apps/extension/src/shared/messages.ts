import type { BucketReading } from "../background/bucket";
import type { SerializedRpcError } from "./errors";
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
  "approval:resolve": { req: { id: string; approved: boolean }; res: null };
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
