import { decodeFunctionData, type Address, type Hex } from "viem";
import { describe, expect, it } from "vitest";
import {
  AccountPlans,
  RECIPIENT_MODE,
  accountSalt,
  activationCalldata,
  buildPlan,
  createRoleSignerCalldata,
  initConfigFor,
  planConfig,
  predictAccount,
  roleSalt,
  USD,
  ZERO,
} from "../../src/background/account";
import { accountAbi, accountFactoryAbi, roleSignerFactoryAbi } from "../../src/generated/contracts";
import { MemoryKV } from "../../src/shared/kv";

const HOT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const TANK = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const PAYER = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC" as Address;
const VAULT_PK = `0x${"11".repeat(32)}` as Hex;
const RECOVERY_PK = `0x${"22".repeat(32)}` as Hex;
const SCHEME = "0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054" as Hex;
const dep = {
  factory: "0x602D0b1A46d6fc77A8690691844Fe0F9a7Be7316" as Address,
  accountImpl: "0x6770518a08E18eB6dAf13fFf2C7B675375F6A8da" as Address,
  roleSignerFactory: "0xc9de1A8cBf55331acF4180bF30f64045e75C364E" as Address,
  c13Verifier: "0xAD7432C0BFd52Dd1c62774701005eeAbBc224152" as Address,
  stakingRegistry: "0x8464135c8F25Da09e49BC8782676a84730C318bC" as Address,
};
const signers = { vaultSigner: "0x00000000000000000000000000000000000000c1" as Address };

describe("the counterfactual account (bound InitConfig)", () => {
  const salt = accountSalt(HOT, VAULT_PK, RECOVERY_PK, 1337);
  const cfg = initConfigFor({
    hotKey: HOT,
    tank: TANK,
    deployment: dep,
    vault: { schemeId: SCHEME, pk: VAULT_PK, payer: PAYER },
    recovery: { schemeId: SCHEME, pk: RECOVERY_PK },
    salt: roleSalt(salt),
    dailyLimitUsd: 500,
    perPaymentUsd: 200,
  });

  it("commits to the Vault's and the Recovery key's quantum-safe keys; Open recipients by default", () => {
    expect(cfg).toMatchObject({
      hotKey: HOT,
      tank: TANK,
      roleSignerFactory: dep.roleSignerFactory,
      vault: { pk: VAULT_PK, verifier: dep.c13Verifier, payerKey: PAYER },
      // The Recovery signer has no classical fee key (the companion pairs none): Path A only.
      recovery: { pk: RECOVERY_PK, verifier: dep.c13Verifier, payerKey: ZERO },
      vaultSigner: ZERO,
      recoverySigner: ZERO,
      capUsdPerDay: 500n * USD,
      perTxMaxUsd: 200n * USD,
      selfPay: false,
      ethUsdPrice: 3000n * USD,
      recipientMode: RECIPIENT_MODE.open,
    });
  });

  it("is deterministic, bound to the chain and the Vault key; activation and clone deployment use the frozen data", async () => {
    const a = buildPlan(1337, dep, cfg, signers, salt, 1);
    const b = buildPlan(1337, dep, cfg, signers, salt, 2);
    expect(a.address).toBe(b.address);
    expect(accountSalt(HOT, VAULT_PK, undefined, 1337)).not.toBe(salt);
    expect(accountSalt(HOT, VAULT_PK, RECOVERY_PK, 3151908)).not.toBe(salt);
    expect(accountSalt(HOT, `0x${"33".repeat(32)}`, RECOVERY_PK, 1337)).not.toBe(salt);
    expect(buildPlan(1337, dep, { ...cfg, capUsdPerDay: 1n }, signers, salt, 1).address).not.toBe(a.address);
    expect(predictAccount(dep.factory, a.salt, dep.accountImpl, a.initData)).toBe(a.address);
    const init = decodeFunctionData({ abi: accountAbi, data: a.initData });
    expect(init.functionName).toBe("initialize");
    expect((init.args as readonly [{ vault: { pk: Hex } }])[0].vault.pk).toBe(VAULT_PK);
    const act = decodeFunctionData({ abi: accountFactoryAbi, data: activationCalldata(a) });
    expect(act.args).toEqual([a.salt, dep.accountImpl, a.initData]);
    const clone = decodeFunctionData({ abi: roleSignerFactoryAbi, data: createRoleSignerCalldata(a, "vault") });
    expect(clone.functionName).toBe("createRoleSigner");
    expect(clone.args).toEqual([cfg.vault.salt, 1, a.address, VAULT_PK, dep.c13Verifier, PAYER]);
    expect(planConfig(a)).toEqual(cfg);
    const store = new AccountPlans(new MemoryKV());
    await store.put(a);
    expect((await store.get(1337))?.address).toBe(a.address);
  });
});
