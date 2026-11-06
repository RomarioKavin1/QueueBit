import { describe, expect, it } from "vitest";
import { choosePath, onlyBudgetViolation, parseBudgets, STOCK_VERIFY_BUDGET } from "../../src/background/lanes";

/** Path A / B selection by the measured budgets (plan §30 §5.2 rows 6–8, §5.3). */
const C13 = 120_000n; // C13Verifier.VERIFY_GAS_ESTIMATE
const LEAN = 50_000n; // LeanSphincsSVerifier.VERIFY_GAS_ESTIMATE
const stock = { standard: STOCK_VERIFY_BUDGET };
const budget010 = { standard: STOCK_VERIFY_BUDGET, staked: { unstaked: 100_000n, staked: 1_000_000n } };

describe("choosePath", () => {
  it("C13 Vault on the stock mempool: Path B (payer key in VERIFY), with the pre-Q-day notice", () => {
    const c = choosePath({ schemeVerifyGas: C13, hasPayer: true, signerStaked: false, budgets: stock });
    expect(c).toMatchObject({ ok: true, path: "B", lane: "standard", verifyGas: 90_000n });
    expect(c.rules).toEqual(["ROUTE-PATH-B", "PRE-Q-DAY-NOTICE"]);
  });

  it("leanSphincs-s fits the stock 100k: Path A anywhere, limit 99,900 (+100 ARBITRARY = 100,000)", () => {
    const c = choosePath({ schemeVerifyGas: LEAN, hasPayer: true, signerStaked: false, budgets: stock });
    expect(c).toMatchObject({ ok: true, path: "A", lane: "standard", verifyGas: 99_900n });
  });

  it("C13 on a BUDGET-010 sidecar: Path A only once the signer is staked there", () => {
    expect(choosePath({ schemeVerifyGas: C13, hasPayer: true, signerStaked: false, budgets: budget010 })).toMatchObject(
      { path: "B" },
    );
    const a = choosePath({ schemeVerifyGas: C13, hasPayer: true, signerStaked: true, budgets: budget010 });
    expect(a).toMatchObject({ ok: true, path: "A", lane: "staked" });
    if (a.ok) expect(a.verifyGas).toBeGreaterThanOrEqual(165_000n);
  });

  it("a Recovery signer (no payer key) needs the staked lane, and says why when it can't have it", () => {
    const none = choosePath({ schemeVerifyGas: C13, hasPayer: false, signerStaked: false, budgets: stock });
    expect(none).toMatchObject({ ok: false, rules: ["ROUTE-NO-LANE"] });
    if (!none.ok) expect(none.reason).toMatch(/no staked lane/u);
    const unstaked = choosePath({ schemeVerifyGas: C13, hasPayer: false, signerStaked: false, budgets: budget010 });
    if (!unstaked.ok) expect(unstaked.reason).toMatch(/isn't staked/u);
    expect(choosePath({ schemeVerifyGas: C13, hasPayer: false, signerStaked: true, budgets: budget010 })).toMatchObject(
      {
        path: "A",
        lane: "staked",
      },
    );
  });

  it("reads skandha_config.budgets only from a BUDGET-010 sidecar", () => {
    expect(
      parseBudgets({
        budgets: { rule: "BUDGET-010", maxVerifyGasPerEntity: 100000, maxVerifyGasStakedEntity: 1000000 },
      }),
    ).toEqual({
      unstaked: 100_000n,
      staked: 1_000_000n,
    });
    expect(parseBudgets({ minStake: "1" })).toBeUndefined();
    expect(
      parseBudgets({ budgets: { rule: "X", maxVerifyGasPerEntity: 1, maxVerifyGasStakedEntity: 2 } }),
    ).toBeUndefined();
  });

  it("tolerates only ethrex's 100k-prefix verdict on the staked lane", () => {
    expect(onlyBudgetViolation("Frame transaction prefix gas budget (frames + sig cost) exceeds MAX_VERIFY_GAS")).toBe(
      true,
    );
    expect(onlyBudgetViolation("validation frame 0: reverted")).toBe(false);
    expect(onlyBudgetViolation(null)).toBe(false);
  });
});
