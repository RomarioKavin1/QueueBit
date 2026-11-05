// Adapted from @forshtat/hegota-support (MIT, Copyright (c) 2026 Alex Forshtat), src/profiles/types.ts at 2377188.
// Changes: `sigHashElision`, the `nonce` and `feeBudget` envelope fields (the current EIP-8141 text), readonly
// tables. See THIRD_PARTY.md.
import type { Address } from "viem";

/**
 * A profile is everything that can differ between two networks that run EIP-8141: the wire layout of the
 * transaction, how the signature hash elides signatures, the numeric values of modes, scopes and schemes, and the
 * predeploy addresses. All code in this package takes a profile as an explicit argument; there is no default and no
 * global current profile.
 *
 * A profile is immutable once a network depends on it. When a network changes its rules, add a new profile and mark
 * the old one `legacy`; never edit the old one (the pinned test vectors fail if you do).
 */
export interface Profile {
  /** Equal to the file name in `src/profiles/` and the key in the registry. */
  readonly id: string;
  readonly title: string;
  /** `legacy`: the network it describes is gone or superseded, but the profile stays usable. */
  readonly status: "current" | "legacy";
  readonly supersededBy?: string;
  readonly devnet: {
    readonly description: string;
    /** The chain this profile is selected for (`profileForChain`); absent for a spec-only profile. */
    readonly chainId?: number;
    /** The execution-client build (or spec revision) the profile was checked against. */
    readonly client: string;
  };
  /** EIP number -> the revision or note this profile follows. */
  readonly eips: Readonly<Record<string, string>>;

  /** Type byte of the transaction (`0x06` for frame transactions). */
  readonly txType: number;
  /** Frame mode name -> value. */
  readonly frameModes: Readonly<Record<string, number>>;
  /** Approval scope name -> value (the low bits of a frame's flags and `APPROVE`'s `scope` operand). */
  readonly approveScopes: Readonly<Record<string, number>>;
  /** Other flag bits by name (e.g. `ATOMIC_BATCH`). */
  readonly flagBits: Readonly<Record<string, number>>;
  /** Signature scheme name -> value. */
  readonly sigSchemes: Readonly<Record<string, number>>;
  /** The caller of DEFAULT and VERIFY frames (`ENTRY_POINT`). */
  readonly entryPoint: Address;
  /**
   * Predeployed contracts by EIP constant name (`NONCE_MANAGER`, `RECENT_ROOT_ADDRESS`, `EXPIRY_VERIFIER`). Networks
   * place these differently from the EIP text, so they belong to the profile. Absent means not known there.
   */
  readonly predeploys: Readonly<Record<string, Address>>;

  /**
   * What the signature hash puts in place of the `signature` bytes of an entry whose `msg` is empty:
   *  - `empty`: the empty byte string (ethrex devnets);
   *  - `length`: the byte length as an RLP unsigned integer (EIP-8141 text since 2026-10, "Signature Hash").
   */
  readonly sigHashElision: "empty" | "length";

  /** Top-level field order of the RLP payload. */
  readonly envelope: readonly EnvelopeField[];
}

/**
 * The fields of the RLP payload, in the order a profile lists them.
 *
 *  - `nonceKeys` + `nonceSeq`: EIP-8250 keyed nonces; `nonce`: one linear nonce (the transaction's `nonceSeq`, with
 *    `nonceKeys` `[0]`);
 *  - `fees`: one nested list `[max_priority_fee_per_gas, max_fee_per_gas, max_fee_per_blob_gas]`;
 *  - `maxPriorityFeePerGas`, `maxFeePerGas`, `maxFeePerBlobGas`: the same three as separate top-level items;
 *  - `feeBudget`: the current EIP's `fees = [max_fee, max_priority_fee_per_gas]`, where `max_fee` is a total wei
 *    budget for execution, state and blob gas (`FeeParams.maxFee`).
 */
export type EnvelopeField =
  | "chainId"
  | "nonce"
  | "nonceKeys"
  | "nonceSeq"
  | "sender"
  | "frames"
  | "signatures"
  | "fees"
  | "feeBudget"
  | "maxPriorityFeePerGas"
  | "maxFeePerGas"
  | "maxFeePerBlobGas"
  | "blobVersionedHashes"
  | "recentRootReferences";
