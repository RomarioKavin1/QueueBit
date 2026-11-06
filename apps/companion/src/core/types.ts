import type { Address, Hex } from "viem";

export interface AddressBookEntry {
  id: string;
  name: string;
  address: Address;
  /** Chain ids this entry applies to; empty = every chain. */
  chains: number[];
  addedAt: number;
}

export interface TokenSetting {
  allowed: boolean;
  decimals: number;
  usdPerToken: bigint;
  /** ms since epoch, when this phone signed it. */
  signedAt: number;
}

/**
 * What this phone itself last signed for an account (plan §20 §4.3 item 3): the trusted side of the "from → to" of a
 * limit change and of the "settings changed since this phone last signed" check (ux-spec E-74). Only changes that
 * take effect immediately are recorded as settings; queued ones are not (they may still be cancelled).
 */
export interface AccountSnapshot {
  account: Address;
  chainId: number;
  /** The role signers seen sending for this account. */
  signers: Address[];
  settings: Partial<
    Record<"capUsdPerDay" | "perTxMaxUsd" | "maxFeeWeiPerTx" | "timelockDelay" | "timelockThresholdUsd", bigint>
  > & {
    maxHotFrames?: number;
  };
  /**
   * What the browser reported (advisory key 12) at the time this phone last signed for the account. Untrusted: it only
   * serves the E-74 tripwire ("changed since this phone last signed"), never a "from" value or a loosening decision.
   */
  reported?: Partial<
    Record<"capUsdPerDay" | "perTxMaxUsd" | "maxFeeWeiPerTx" | "timelockDelay" | "timelockThresholdUsd", bigint>
  >;
  tokens: Record<string, TokenSetting>;
  updatedAt: number;
}

export type Mode = "vault" | "recovery";

export interface DeviceContext {
  mode: Mode;
  /** The key this phone signs with in this mode. */
  publicKey: Hex;
  /** Vault mode: a prepared replacement key (rotation); requests for it are accepted too. */
  nextPublicKey?: Hex;
  schemeId: Hex;
  /** The Path-B fee-payment (payer) address of this mode's key (the Vault's, or the Recovery key's). */
  payerAddress?: Address;
  addressBook: AddressBookEntry[];
  snapshots: AccountSnapshot[];
  /** For tests. */
  now?: number;
}
