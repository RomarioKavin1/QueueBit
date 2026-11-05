import type { SetupState } from "../shared/types";
import type { AccountStatus } from "../shared/views";

/**
 * The rolling 24-hour everyday bucket the LimitMeter shows (ux-spec §3.2 "LimitMeter semantics"), from the account's
 * `getBucket() returns (available, lastUpdate, cap, fullAt)`. The refill is continuous, so "frees up at" is `fullAt`:
 * when everything spent in the last 24 h is available again. Prices and limits come from the account itself, never an
 * external API (risk R12).
 */
export interface BucketReading {
  capUsd: number;
  usedUsd: number;
  availableUsd: number;
  perTxMaxUsd: number;
  /** When the used part is back (the bucket is full again), if anything is used. */
  nextRefill?: { usd: number; at: number };
  /**
   * `none`: the account is not active on this network, so nothing is enforced yet (the amber "No daily limit yet"
   * card); the cap/per-payment values are the limits the activation will set. `chain`: read from the account.
   */
  source: "none" | "chain";
  frozen?: boolean;
  readAt: number;
}

export function bucketFromStatus(status: AccountStatus, setup: SetupState): BucketReading {
  if (!status.deployed) {
    // The limits the activation will set are the frozen plan's (`status.limits`, from the init config), not the
    // setup form's: the plan is fixed when the address is first computed and does not follow later edits. Fall back to
    // the setup intent where no plan exists yet (unsupported network, or the network could not be read).
    const planned = status.supported && status.limits.capUsd > 0;
    const capUsd = planned ? status.limits.capUsd : setup.dailyLimitUsd;
    return {
      capUsd,
      usedUsd: 0,
      availableUsd: capUsd,
      perTxMaxUsd: planned ? status.limits.perTxMaxUsd : setup.perPaymentUsd,
      source: "none",
      readAt: status.readAt,
    };
  }
  const { capUsd, availableUsd, perTxMaxUsd, fullAt } = status.limits;
  const usedUsd = Math.max(0, capUsd - availableUsd);
  return {
    capUsd,
    usedUsd,
    availableUsd,
    perTxMaxUsd,
    ...(usedUsd > 0 && fullAt ? { nextRefill: { usd: usedUsd, at: fullAt * 1000 } } : {}),
    source: "chain",
    frozen: status.frozen,
    readAt: status.readAt,
  };
}
