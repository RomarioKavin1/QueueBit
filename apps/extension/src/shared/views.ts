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
  deployed: boolean;
  activation?: { txHash: Hex; sentAt: number };
  tank: Address;
  tankWei: string;
  accountWei: string;
  /** The fee tank needs at least this to send the activation. */
  activationCostWei: string;
  limits: { capUsd: number; perTxMaxUsd: number; availableUsd: number; fullAt?: number };
  frozen: boolean;
  bunker: boolean;
  /** "stand-in": a public devnet key acts as the Vault until pairing exists (M4). */
  vault: "stand-in" | "none";
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
