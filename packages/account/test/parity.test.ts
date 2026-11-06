import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256 } from "viem";
import { encodeMultiSend, moveCalls, multiSendSafeTx, predictAccount, safeTxTypedData } from "../src/index.js";
import { D, MULTISEND, SAFE, TARGET, TOKEN } from "./fixture.js";

// contracts/test/account/SdkParity.t.sol pins the same constants against the real factory and a real Safe v1.4.1,
// and runs the migration these bytes describe end to end.
describe("SDK = contracts", () => {
  const target = predictAccount(D, TARGET);
  const calls = moveCalls(D, TARGET, target, [{ token: TOKEN, balance: 5n * 10n ** 18n }], 10n ** 18n);
  const tx = multiSendSafeTx(MULTISEND, calls, 0n);

  it("predicts the factory's counterfactual address", () => {
    expect(target).toBe("0x7FFCFa3A2Cb400AA5F8201a9f687800723E4885f");
  });
  it("packs MultiSend exactly as the Forge test executes it", () => {
    expect(keccak256(encodeMultiSend(calls))).toBe(
      "0x357ef6153c692f2e109e91744ff69339c971ba4dbee47a0b35fb203c3ab2047f",
    );
  });
  it("hashes the SafeTx as Safe.getTransactionHash does", () => {
    expect(hashTypedData(safeTxTypedData(1337, SAFE, tx))).toBe(
      "0xa2d91144baabe69130353cefffb84e23fc076ed68130d5af9883452314291ef5",
    );
  });
});
