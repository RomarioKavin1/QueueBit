import type { Address } from "viem";
import type { SetupState } from "../shared/types";

/**
 * The rolling 24-hour everyday bucket the LimitMeter shows (ux-spec §3.2 "LimitMeter semantics").
 */
export interface BucketReading {
  capUsd: number;
  usedUsd: number;
  availableUsd: number;
  perTxMaxUsd: number;
  /** Earliest spend that expires out of the 24 h window, if any. */
  nextRefill?: { usd: number; at: number };
  /**
   * `placeholder`: the account is not deployed, so there is no on-chain bucket yet; values are the limits chosen at
   * setup with nothing used. `chain`: read from the account (M1+).
   */
  source: "placeholder" | "chain";
  readAt: number;
}

export interface BucketSource {
  /**
   * TODO(M1): implement against the account view `getBucket() returns (available, lastUpdate, cap)` and
   * `getHotConfig()` (10-contracts §10.11), read through the private connection, and derive `nextRefill` from
   * `HotExecuted(txSigHash, usdDebited, available)` events over the last 24 h (30-extension §6.5). Prices come from
   * the account's own config, never an external API (risk R12).
   */
  getBucket(account: Address, chainId: number): Promise<BucketReading>;
}

/** M0 source: no account is deployed yet, so the bucket is the setup intent with nothing used. */
export function placeholderBucketSource(getSetup: () => Promise<SetupState>, now = Date.now): BucketSource {
  return {
    async getBucket() {
      const setup = await getSetup();
      return {
        capUsd: setup.dailyLimitUsd,
        usedUsd: 0,
        availableUsd: setup.dailyLimitUsd,
        perTxMaxUsd: setup.perPaymentUsd,
        source: "placeholder",
        readAt: now(),
      };
    },
  };
}
