import { decodeFunctionData, type Address } from "viem";
import { describe, expect, it } from "vitest";
import {
  AccountPlans,
  accountSalt,
  activationCalldata,
  buildPlan,
  initConfigFor,
  planConfig,
  predictAccount,
  USD,
} from "../../src/background/account";
import { accountAbi, accountFactoryAbi } from "../../src/generated/contracts";
import { MemoryKV } from "../../src/shared/kv";

const HOT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const TANK = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const VAULT = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const dep = {
  factory: "0x12e7A64982e85868C345165bD149d6bE55fcA345" as Address,
  accountImpl: "0x6770518a08E18eB6dAf13fFf2C7B675375F6A8da" as Address,
  vaultStandIn: VAULT,
};

describe("the counterfactual account", () => {
  const cfg = initConfigFor({ hotKey: HOT, tank: TANK, vaultSigner: VAULT, dailyLimitUsd: 500, perPaymentUsd: 200 });

  it("sets the ux-spec defaults in InitConfig (limit, fee tank allowlisted, ETH price)", () => {
    expect(cfg).toMatchObject({
      hotKey: HOT,
      tank: TANK,
      vaultSigner: VAULT,
      capUsdPerDay: 500n * USD,
      perTxMaxUsd: 200n * USD,
      selfPay: false,
      ethUsdPrice: 3000n * USD,
      recoverySigner: "0x0000000000000000000000000000000000000000",
    });
  });

  it("is deterministic, chain-bound, and its activation calls the factory with the frozen init data", async () => {
    const a = buildPlan(1337, dep, cfg, 1);
    const b = buildPlan(1337, dep, cfg, 2);
    expect(a.address).toBe(b.address);
    expect(accountSalt(cfg, 1337)).not.toBe(accountSalt(cfg, 3151908));
    expect(buildPlan(1337, dep, { ...cfg, capUsdPerDay: 1n }, 1).address).not.toBe(a.address);
    expect(predictAccount(dep.factory, a.salt, dep.accountImpl, a.initData)).toBe(a.address);
    const init = decodeFunctionData({ abi: accountAbi, data: a.initData });
    expect(init.functionName).toBe("initialize");
    const act = decodeFunctionData({ abi: accountFactoryAbi, data: activationCalldata(a) });
    expect(act.args).toEqual([a.salt, dep.accountImpl, a.initData]);
    expect(planConfig(a)).toEqual(cfg);
    const store = new AccountPlans(new MemoryKV());
    await store.put(a);
    expect((await store.get(1337))?.address).toBe(a.address);
  });
});
