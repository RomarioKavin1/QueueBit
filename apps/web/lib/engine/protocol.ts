/**
 * The page ⇄ engine-worker protocol. The engine is the extension's `Wallet` (apps/extension/src/background/wallet.ts)
 * running in a Web Worker: pages talk to it with the same typed `UiApi` messages the extension's popup and app use,
 * plus the dapp provider (`provider`) so sessions can be exercised without a real dapp.
 */
import type { UiApi, UiType } from "@queuebit/extension/src/shared/messages";

/** Run-time endpoint overrides (persisted by the worker). Empty: the network table's value. */
export interface EngineConfig {
  rpcUrl?: string;
  sidecarUrl?: string;
  leanpoolUrl?: string;
}

export type ToEngine =
  | { id: number; kind: "ui"; type: UiType; payload: unknown }
  | { id: number; kind: "provider"; origin: string; method: string; params?: unknown }
  | { id: number; kind: "config:get" }
  | { id: number; kind: "config:set"; config: EngineConfig }
  | { id: number; kind: "network" }
  | { id: number; kind: "storage:dump" }
  | { id: number; kind: "storage:wipe" };

export interface EngineError {
  message: string;
  /** KeyringError / AccountError / OwnerKeyError reason, for UI branching. */
  reason?: string;
  /** Provider (EIP-1193) error code. */
  code?: number;
}

export type FromEngine =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: EngineError }
  /** A dapp request needs a decision (the extension would open its approval window). */
  | { event: "approval"; approvalId: string }
  /** chainChanged / accountsChanged for simulated dapps. */
  | { event: "provider"; name: string; data: unknown; origin?: string }
  | { event: "ready"; network: NetworkInfo };

/** What the page shows about the network the engine talks to. */
export interface NetworkInfo {
  chainId: number;
  name: string;
  rpcUrl: string;
  sidecarUrl: string;
  leanpoolUrl: string;
  aggregator?: string;
  explorerTxUrl?: string;
  localDevnet: boolean;
  deployment?: Record<string, unknown>;
  tokens: Array<{ token: string; symbol: string; decimals: number }>;
}

export type { UiApi, UiType };
