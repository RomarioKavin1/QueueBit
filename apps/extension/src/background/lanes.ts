/**
 * Path A / Path B selection for Vault and Recovery transactions (plan §30 §5.2 rows 6–8, §5.3 "the advertised budget
 * problem", §6.3; decision "Path A scheme options after the M3 benchmark").
 *
 *  - Path A: the quantum-safe signature is checked inside VERIFY (`relay`), so no classical fee-payer key is
 *    involved. It fits a mempool only when the scheme's VERIFY gas plus the role signer's own overhead fits that
 *    mempool's verification budget: the stock 100,000 for leanSphincs-s (measured 84,465), or the BUDGET-010 staked
 *    budget (1,000,000 on the patched sidecar) for C13 (measured 151,701) when the signer is staked there.
 *  - Path B: the phone's pinned ECDSA payer key approves fees in VERIFY and the quantum-safe signature is checked in
 *    execution (`executePQ`); always fits the standard lane (measured 36,213).
 *
 * Pure: the caller measures the budgets (`skandha_config.budgets`, else the stock constant) and the stake.
 */

/** ethrex's combined prefix limit and the stock sidecar's flat budget (devnet review). */
export const STOCK_VERIFY_BUDGET = 100_000n;
/** The PQRoleSigner glue around the verifier call in VERIFY: clone hop, args, frame walk, SIGDATACOPY, APPROVE. */
export const ROLE_SIGNER_VERIFY_OVERHEAD = 45_000n;
/** Signature costs the sidecar attributes to the sender (secp256k1 2,800, ARBITRARY 100). */
export const SIG_COST = { secp256k1: 2_800n, arbitrary: 100n } as const;
/** Path B VERIFY limit (G1: 36,213 used): 90,000 + 2,800 + 100 fits the 100,000 budget. */
export const PATH_B_VERIFY_GAS = 90_000n;

export interface LaneBudgets {
  /** The standard lane (ethrex `eth_sendRawTransaction`): the combined 100k prefix limit. */
  standard: bigint;
  /** A BUDGET-010 sidecar, when configured and reachable. */
  staked?: { unstaked: bigint; staked: bigint };
}

export interface PathInput {
  /** `IPQVerifier.verifyGasEstimate()` of the signer's scheme. */
  schemeVerifyGas: bigint;
  /** The signer has a pinned payer key (Path B possible). Recovery signers have none. */
  hasPayer: boolean;
  /** The signer is staked in the registry the staked lane reads (stake ≥ minimum, no withdrawal pending). */
  signerStaked: boolean;
  budgets: LaneBudgets;
}

export type PathChoice =
  | {
      ok: true;
      path: "A" | "B";
      /** standard = ethrex public mempool; staked = the BUDGET-010 sidecar (`eth_sendFrameTransaction`). */
      lane: "standard" | "staked";
      verifyGas: bigint;
      rules: string[];
    }
  | { ok: false; rules: string[]; reason: string };

/** The VERIFY gas Path A needs for this scheme (the limit is set with headroom below). */
export const pathANeed = (schemeVerifyGas: bigint): bigint => schemeVerifyGas + ROLE_SIGNER_VERIFY_OVERHEAD;

export function choosePath(p: PathInput): PathChoice {
  const need = pathANeed(p.schemeVerifyGas);
  const limitFor = (budget: bigint) => {
    const room = budget - SIG_COST.arbitrary;
    const wanted = (need * 3n) / 2n;
    return wanted < room ? wanted : room;
  };
  // 1. Path A on the standard lane: only a scheme whose check fits the stock 100k (leanSphincs-s).
  if (need + SIG_COST.arbitrary <= p.budgets.standard) {
    return { ok: true, path: "A", lane: "standard", verifyGas: limitFor(p.budgets.standard), rules: ["ROUTE-PATH-A"] };
  }
  // 2. Path A on the staked lane (BUDGET-010) when the signer is staked there.
  const staked = p.budgets.staked;
  if (staked && p.signerStaked && need + SIG_COST.arbitrary <= staked.staked) {
    return { ok: true, path: "A", lane: "staked", verifyGas: limitFor(staked.staked), rules: ["ROUTE-PATH-A"] };
  }
  // 3. Path B on the standard lane.
  if (p.hasPayer && PATH_B_VERIFY_GAS + SIG_COST.secp256k1 + SIG_COST.arbitrary <= p.budgets.standard) {
    return {
      ok: true,
      path: "B",
      lane: "standard",
      verifyGas: PATH_B_VERIFY_GAS,
      rules: ["ROUTE-PATH-B", "PRE-Q-DAY-NOTICE"],
    };
  }
  return {
    ok: false,
    rules: ["ROUTE-NO-LANE"],
    reason: !staked
      ? "This key can only be used through the staked lane, and no staked lane is configured for this network."
      : !p.signerStaked
        ? "This key can only be used through the staked lane, and its signer isn't staked there yet."
        : "This key's signature check is too large for every available lane.",
  };
}

/** `skandha_config.budgets` of a BUDGET-010 sidecar (absent on the stock sidecar). */
export function parseBudgets(config: unknown): LaneBudgets["staked"] | undefined {
  const b = (
    config as { budgets?: { rule?: string; maxVerifyGasPerEntity?: unknown; maxVerifyGasStakedEntity?: unknown } }
  )?.budgets;
  if (!b || b.rule !== "BUDGET-010") return undefined;
  const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? BigInt(v) : undefined);
  const unstaked = n(b.maxVerifyGasPerEntity);
  const staked = n(b.maxVerifyGasStakedEntity);
  return unstaked && staked ? { unstaked, staked } : undefined;
}

/** A staked-lane simulation by ethrex refuses a > 100k prefix; that one violation is expected on the staked lane. */
export function onlyBudgetViolation(violation: string | null | undefined): boolean {
  return !!violation && /prefix gas budget|MAX_VERIFY_GAS|exceeds .*100000/iu.test(violation);
}
