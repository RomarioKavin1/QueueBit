import { describe, expect, it } from "vitest";
import { decodeAbiParameters, decodeFunctionData, type Address } from "viem";
import { leanAccountAbi, setGuardiansCalls } from "../src/index.js";
import { D } from "./fixture.js";

const ACCOUNT = "0x00000000000000000000000000000000000acc01" as Address;

const G1 = "0x00000000000000000000000000000000000000A1" as Address;
const G2 = "0x00000000000000000000000000000000000000A2" as Address;

const decodeInit = (data: `0x${string}`) =>
  decodeAbiParameters([{ type: "address[]" }, { type: "uint8" }, { type: "uint32" }], data);

describe("setGuardiansCalls: the owner changes guardians on an account that exists", () => {
  it("installs the recovery executor with the guardians, threshold and delay (one admin call to the account)", () => {
    const calls = setGuardiansCalls(D, ACCOUNT, { installed: false, guardians: [G1, G2], threshold: 2, delay: 3600 });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.to).toBe(ACCOUNT);
    const c = decodeFunctionData({ abi: leanAccountAbi, data: calls[0]!.data! });
    expect(c.functionName).toBe("installModule");
    expect(c.args![0]).toBe(2n); // ERC-7579 EXECUTOR
    expect(c.args![1]).toBe(D.recovery);
    const [gs, threshold, delay] = decodeInit(c.args![2] as `0x${string}`);
    expect(gs).toEqual([G1, G2]);
    expect(threshold).toBe(2);
    expect(delay).toBe(3600);
  });

  it("reinstalls when recovery is already installed (a fresh guardian set; pending recoveries die with the old one)", () => {
    const calls = setGuardiansCalls(D, ACCOUNT, { installed: true, guardians: [G1], threshold: 1 });
    expect(calls.map((c) => decodeFunctionData({ abi: leanAccountAbi, data: c.data! }).functionName)).toEqual([
      "uninstallModule",
      "installModule",
    ]);
    const [, , delay] = decodeInit(
      decodeFunctionData({ abi: leanAccountAbi, data: calls[1]!.data! }).args![2] as `0x${string}`,
    );
    expect(delay).toBe(2 * 86_400); // the default, as at creation
  });

  it("removes every guardian with only the uninstall", () => {
    const calls = setGuardiansCalls(D, ACCOUNT, { installed: true, guardians: [], threshold: 0 });
    expect(calls).toHaveLength(1);
    expect(decodeFunctionData({ abi: leanAccountAbi, data: calls[0]!.data! }).functionName).toBe("uninstallModule");
  });

  it("refuses a threshold the distinct guardians can't reach", () => {
    expect(() => setGuardiansCalls(D, ACCOUNT, { installed: false, guardians: [G1, G1], threshold: 2 })).toThrow(
      /threshold/u,
    );
    expect(() => setGuardiansCalls(D, ACCOUNT, { installed: false, guardians: [G1], threshold: 0 })).toThrow(
      /threshold/u,
    );
  });
});
