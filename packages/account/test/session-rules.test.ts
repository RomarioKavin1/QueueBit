import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodeFunctionData, erc20Abi, parseEther, type Address, type Hex } from "viem";
import {
  SENDER_GAS,
  SENDER_STATE,
  SESSION_REFUSED_SELECTORS,
  checkSessionCalls,
  type SessionScope,
} from "../src/index.js";

const SOL = new URL("../../../contracts/src/account/SessionRules.sol", import.meta.url);

/** The selectors `grantsOrMovesUncounted` refuses, read from the Solidity source (`s == 0x…`). */
function solidityRefused(): string[] {
  const src = readFileSync(SOL, "utf8");
  const body = src.slice(src.indexOf("function grantsOrMovesUncounted"));
  return [...body.slice(0, body.indexOf("}")).matchAll(/s == (0x[0-9a-fA-F]{8})/gu)].map((m) => m[1]!.toLowerCase());
}

const ACCOUNT = "0x000000000000000000000000000000000000acc0" as Address;
const KEYSTORE = "0x000000000000000000000000000000000000c5c5" as Address;
const SHOP = "0x0000000000000000000000000000000000005a0b" as Address;
const TOKEN = "0x00000000000000000000000000000000000070c1" as Address;
const OTHER = "0x0000000000000000000000000000000000000b0b" as Address;
const scope: SessionScope = {
  account: ACCOUNT,
  adminTargets: [KEYSTORE],
  targets: [SHOP, TOKEN],
  tokens: [{ token: TOKEN, perTx: 100n }],
  perTxEth: parseEther("0.1"),
};
const transfer = (amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [OTHER, amount] });
const transferFrom = (amount: bigint) =>
  encodeFunctionData({ abi: erc20Abi, functionName: "transferFrom", args: [ACCOUNT, OTHER, amount] });

describe("session rules (the same as SessionRules.sol and KeystoreValidator._allowed)", () => {
  it("the refused selectors are exactly SessionRules.grantsOrMovesUncounted's", () => {
    const sol = solidityRefused();
    expect(sol.length).toBeGreaterThanOrEqual(24);
    expect(Object.keys(SESSION_REFUSED_SELECTORS).sort()).toEqual([...sol].sort());
  });

  it("every refused selector is refused on an allowlisted target", () => {
    for (const sel of Object.keys(SESSION_REFUSED_SELECTORS)) {
      const r = checkSessionCalls(scope, [{ to: SHOP, data: `${sel}${"00".repeat(64)}` as Hex }]);
      expect(r.ok, sel).toBe(false);
    }
  });

  it("transfer / transferFrom only on a capped token, counted per tx; refused on an uncapped target", () => {
    expect(
      checkSessionCalls(scope, [
        { to: TOKEN, data: transfer(60n) },
        { to: TOKEN, data: transferFrom(40n) },
      ]),
    ).toEqual({ ok: true, eth: 0n, tokens: { [TOKEN.toLowerCase()]: 100n } });
    expect(
      checkSessionCalls(scope, [
        { to: TOKEN, data: transfer(60n) },
        { to: TOKEN, data: transfer(41n) },
      ]).ok,
    ).toBe(false);
    // An allowlisted target with no token cap: a transfer there has nothing to count against.
    expect(checkSessionCalls(scope, [{ to: SHOP, data: transfer(1n) }])).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/no limit/u),
    });
    expect(checkSessionCalls(scope, [{ to: SHOP, data: transferFrom(1n) }]).ok).toBe(false);
    // Anything else on a capped token, or a short transfer, is refused.
    expect(checkSessionCalls(scope, [{ to: TOKEN, data: "0x12345678" }]).ok).toBe(false);
    expect(checkSessionCalls(scope, [{ to: TOKEN, data: "0xa9059cbb00" }]).ok).toBe(false);
  });

  it("targets, admin targets and the per-tx ETH cap (summed over the tx)", () => {
    expect(checkSessionCalls(scope, [{ to: SHOP, value: parseEther("0.1") }])).toMatchObject({ ok: true });
    expect(
      checkSessionCalls(scope, [
        { to: SHOP, value: parseEther("0.06") },
        { to: SHOP, value: parseEther("0.05") },
      ]).ok,
    ).toBe(false);
    expect(checkSessionCalls(scope, [{ to: OTHER }]).ok).toBe(false);
    expect(checkSessionCalls(scope, [{ to: ACCOUNT }]).ok).toBe(false);
    expect(checkSessionCalls({ ...scope, targets: [...scope.targets, KEYSTORE] }, [{ to: KEYSTORE }]).ok).toBe(false);
  });

  it("the SENDER frame's default gas is exported for wallets to size the max cost", () => {
    expect(SENDER_GAS).toBe(300_000n);
    expect(SENDER_STATE).toBe(400_000n);
  });
});
