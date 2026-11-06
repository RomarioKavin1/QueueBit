import { describe, expect, it } from "vitest";
import { decodeFunctionData, erc20Abi, type Address } from "viem";
import {
  classifyCode,
  eoa7702Plan,
  factoryAbi,
  initializeData,
  leanAccountAbi,
  moveCalls,
  saPlan,
  sweepValue,
  upgradeCall,
} from "../src/index.js";
import { D, TARGET } from "./fixture.js";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const T = a(0x77);

describe("classifyCode", () => {
  it("EOA, 7702 delegation, contract", () => {
    expect(classifyCode("0x")).toEqual({ kind: "eoa" });
    expect(classifyCode(undefined)).toEqual({ kind: "eoa" });
    expect(classifyCode(`0xef0100${D.implementation.slice(2)}`)).toEqual({ kind: "7702", delegate: D.implementation });
    expect(classifyCode("0x6080604052")).toEqual({ kind: "contract" });
    expect(classifyCode(`0xef0100${D.implementation.slice(2)}00`)).toEqual({ kind: "contract" });
  });
});

describe("moveCalls", () => {
  it("tokens first, zero balances skipped, ETH last through createAccount", () => {
    const calls = moveCalls(
      D,
      TARGET,
      T,
      [
        { token: a(0x10), balance: 5n },
        { token: a(0x11), balance: 0n },
        { token: a(0x12), balance: 7n },
      ],
      123n,
    );
    expect(calls.map((c) => c.to)).toEqual([a(0x10), a(0x12), D.factory]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data! }).args).toEqual([T, 5n]);
    const last = decodeFunctionData({ abi: factoryAbi, data: calls[2]!.data! });
    expect(last.functionName).toBe("createAccount");
    expect(calls[2]!.value).toBe(123n);
  });
});

describe("upgradeCall", () => {
  it("a self-call to upgradeToAndCall(implementation, initialize(...))", () => {
    const acct = a(0xaa);
    const c = upgradeCall(D, acct, TARGET);
    expect(c.to).toBe(acct);
    const outer = decodeFunctionData({ abi: leanAccountAbi, data: c.data! });
    expect(outer.functionName).toBe("upgradeToAndCall");
    expect((outer.args![0] as Address).toLowerCase()).toBe(D.implementation);
    expect(outer.args![1]).toBe(initializeData(D, TARGET));
  });
});

describe("plans", () => {
  const lean = D.implementation;
  it("smart accounts: upgrade when UUPS behind ERC-1967, else move; already LeanAccount refused", () => {
    expect(saPlan(a(0x50), true, lean)).toBe("upgrade");
    expect(saPlan(null, false, lean)).toBe("move");
    expect(saPlan(a(0x50), false, lean)).toBe("move");
    expect(() => saPlan(lean, true, lean)).toThrow("already a LeanAccount");
  });
  it("7702: delegate, initialize only, or refuse", () => {
    const delegated = (to: Address) => `0xef0100${to.slice(2)}` as const;
    expect(eoa7702Plan("0x", false, lean)).toBe("delegate");
    expect(eoa7702Plan(delegated(a(0x99)), false, lean)).toBe("delegate");
    expect(eoa7702Plan(delegated(lean), false, lean)).toBe("initialize");
    expect(() => eoa7702Plan(delegated(lean), true, lean)).toThrow("already a LeanAccount");
    expect(() => eoa7702Plan("0x6080", false, lean)).toThrow("smart account");
  });
  it("sweepValue keeps the last tx's fee", () => {
    expect(sweepValue(1_000_000n, 100n, 2n)).toBe(999_800n);
    expect(() => sweepValue(200n, 100n, 2n)).toThrow();
  });
});
