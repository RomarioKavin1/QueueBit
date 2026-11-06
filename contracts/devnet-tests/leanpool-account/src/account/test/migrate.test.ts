import { describe, expect, test } from "bun:test";
import { decodeFunctionData, erc20Abi, keccak256, toHex } from "viem";
import type { Address } from "viem";
import { artifact } from "../../core/artifacts.ts";
import { KIND, ROLE } from "../config.ts";
import type { AccountDeployment } from "../config.ts";
import { classifyCode, eoa7702Plan, initializeData, moveCalls, saPlan, sweepValue, upgradeCall } from "../migrate.ts";
import { factoryInit } from "../sdk.ts";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const d: AccountDeployment = { registry: a(1), hub: a(2), keystore: a(3), implementation: a(4), factory: a(5), hook: a(6), recovery: a(7) };
const target = {
  salt: keccak256(toHex("salt")),
  policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator: a(9) },
  keys: [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: keccak256(toHex("vk")) }],
};
const T = a(0x77);

describe("classifyCode", () => {
  test("EOA, 7702 delegation, contract", () => {
    expect(classifyCode("0x")).toEqual({ kind: "eoa" });
    expect(classifyCode(undefined)).toEqual({ kind: "eoa" });
    expect(classifyCode(`0xef0100${a(4).slice(2)}`)).toEqual({ kind: "7702", delegate: a(4) });
    expect(classifyCode("0x6080604052")).toEqual({ kind: "contract" });
    expect(classifyCode(`0xef0100${a(4).slice(2)}00`)).toEqual({ kind: "contract" }); // not 23 bytes
  });
});

describe("moveCalls", () => {
  test("tokens first, zero balances skipped, ETH last through createAccount", () => {
    const calls = moveCalls(d, target, T, [{ token: a(0x10), balance: 5n }, { token: a(0x11), balance: 0n }, { token: a(0x12), balance: 7n }], 123n);
    expect(calls.map((c) => c.to)).toEqual([a(0x10), a(0x12), d.factory]);
    expect(calls.slice(0, 2).every((c) => c.value === 0n)).toBe(true);
    const t0 = decodeFunctionData({ abi: erc20Abi, data: calls[0].data });
    expect(t0.functionName).toBe("transfer");
    expect(t0.args).toEqual([T, 5n]);
    const last = decodeFunctionData({ abi: artifact("LeanAccountFactory").abi, data: calls[2].data });
    expect(last.functionName).toBe("createAccount");
    expect(calls[2].value).toBe(123n);
    expect((last.args as any)[0]).toBe(target.salt);
    expect((last.args as any)[1].validator.toLowerCase()).toBe(d.keystore);
  });

  test("ETH only: one call", () => {
    expect(moveCalls(d, target, T, [], 1n)).toHaveLength(1);
  });
});

describe("upgradeCall", () => {
  test("a self-call to upgradeToAndCall(implementation, initialize(...)) with the factory's modules", () => {
    const acct = a(0xaa);
    const c = upgradeCall(d, acct, target);
    expect(c.to).toBe(acct);
    expect(c.value).toBe(0n);
    const outer = decodeFunctionData({ abi: artifact("LeanAccount").abi, data: c.data });
    expect(outer.functionName).toBe("upgradeToAndCall");
    expect((outer.args as any)[0]).toBe(d.implementation);
    expect((outer.args as any)[1]).toBe(initializeData(d, target));
    const init = decodeFunctionData({ abi: artifact("LeanAccount").abi, data: (outer.args as any)[1] });
    const f = factoryInit(d, target);
    expect(init.functionName).toBe("initialize");
    expect((init.args as any)[0]).toBe(f.validator);
    expect((init.args as any)[1]).toBe(f.validatorInit);
    expect((init.args as any)[2]).toBe(f.hook);
  });
});

describe("sweepValue", () => {
  test("balance minus the max fee; refuses when it cannot cover it", () => {
    expect(sweepValue(1_000_000n, 100n, 2n)).toBe(999_800n);
    expect(() => sweepValue(200n, 100n, 2n)).toThrow();
  });
});

describe("saPlan", () => {
  const lean = a(4);
  test("an ERC-1967 proxy whose implementation is UUPS upgrades in place", () => {
    expect(saPlan(a(0x50), true, lean)).toBe("upgrade");
  });
  test("no proxy, or a proxy whose implementation is not UUPS, moves", () => {
    expect(saPlan(null, false, lean)).toBe("move");
    expect(saPlan(a(0x50), false, lean)).toBe("move");
  });
  test("a proxy already on LeanAccount is refused", () => {
    expect(() => saPlan(lean, true, lean)).toThrow("already a LeanAccount");
    expect(() => saPlan(`0x${lean.slice(2).toUpperCase()}` as Address, true, lean)).toThrow();
  });
});

describe("eoa7702Plan", () => {
  const lean = a(4);
  const delegated = (to: Address) => `0xef0100${to.slice(2)}` as const;
  test("a plain EOA, or one delegated elsewhere, delegates + initializes", () => {
    expect(eoa7702Plan("0x", false, lean)).toBe("delegate");
    expect(eoa7702Plan(delegated(a(0x99)), false, lean)).toBe("delegate");
  });
  test("delegated to LeanAccount but never initialized (a refused relayer): initialize only", () => {
    expect(eoa7702Plan(delegated(lean), false, lean)).toBe("initialize");
  });
  test("already a LeanAccount, or a contract: refused", () => {
    expect(() => eoa7702Plan(delegated(lean), true, lean)).toThrow("already a LeanAccount");
    expect(() => eoa7702Plan("0x6080", false, lean)).toThrow("migrateSA");
  });
});
