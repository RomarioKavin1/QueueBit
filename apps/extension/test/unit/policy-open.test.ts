import { encodeFunctionData, erc20Abi, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { describe, expect, it } from "vitest";
import { buildPlan, initConfigFor, accountSalt, roleSalt, USD } from "../../src/background/account";
import { PolicyReader } from "../../src/background/policy";
import { decideRoute } from "../../src/background/routing";
import { registerPermitCall } from "../../src/background/signing";
import { accountAbi } from "../../src/generated/contracts";

/**
 * Routing with the account's recipient mode (IMPLEMENTATION-NOTES "Account: Open recipient mode"): in Open (the
 * default) an ETH send or an allowed token's `transfer` to ANY non-zero address within the limits is an everyday
 * payment; Strict keeps the recipient list; approvals and other calls still need a session in both. ERC-2612
 * pre-approvals (`registerPermit`) are everyday batches priced at the permit's value.
 */
const HOT = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as Address;
const TANK = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as Address;
const FRESH = "0x9999999999999999999999999999999999999999" as Address;
const USDC = "0x00000000000000000000000000000000000000c0" as Address;
const dep = {
  factory: "0x12e7A64982e85868C345165bD149d6bE55fcA345" as Address,
  accountImpl: "0xa23d5438Ef67E35829C2E0B03aD13eC3B108C520" as Address,
  roleSignerFactory: "0x6E721ac3171b611eE9E2FD3e989B7B2563B3A578" as Address,
  c13Verifier: "0xf67f51B70d6e751db52E9Ab8C20e5430dBB04715" as Address,
  stakingRegistry: "0x8464135c8F25Da09e49BC8782676a84730C318bC" as Address,
};
const vaultPk = `0x${"11".repeat(32)}` as Hex;
const salt = accountSalt(HOT, vaultPk, undefined, 1337);
const plan = buildPlan(
  1337,
  dep,
  initConfigFor({
    hotKey: HOT,
    tank: TANK,
    deployment: dep,
    vault: { schemeId: "0x00", pk: vaultPk, payer: TANK } as never,
    salt: roleSalt(salt),
    dailyLimitUsd: 500,
    perPaymentUsd: 200,
  }),
  { vaultSigner: TANK },
  salt,
  1,
);

function reader(mode: 0 | 1) {
  const client = {
    getCode: async () => "0x6000",
    readContract: async ({ functionName, args }: { functionName: string; args?: readonly unknown[] }) => {
      switch (functionName) {
        case "getHotConfig":
          return {
            hotKey: HOT,
            hotFrozen: false,
            bunker: false,
            tank: TANK,
            perTxMaxUsd: 200n * USD,
            maxFeeWeiPerTx: 1n,
            maxPriorityFeePerGas: 1n,
            frozenUntil: 0,
          };
        case "getBucket":
          return [500n * USD, 0, 500n * USD, 0];
        case "recipientMode":
          return mode;
        case "getToken": {
          const t = (args?.[0] as string).toLowerCase();
          if (t === USDC.toLowerCase()) return { allowed: true, decimals: 6, usdPerToken: USD };
          if (t === "0x0000000000000000000000000000000000000000")
            return { allowed: true, decimals: 18, usdPerToken: 3000n * USD };
          return { allowed: false, decimals: 18, usdPerToken: 0n };
        }
        case "isTarget":
          return (args?.[0] as string).toLowerCase() === TANK.toLowerCase();
        case "getSession":
          return { allowanceUsd: 0n, expiry: 0 };
        default:
          throw new Error(functionName);
      }
    },
  } as unknown as PublicClient;
  return new PolicyReader(() => client);
}

async function route(mode: 0 | 1, calls: Array<{ target: Address; value: bigint; data: Hex }>) {
  const r = reader(mode);
  const state = await r.state(plan);
  return decideRoute(state.policy, await r.classify(plan, state, calls));
}

const usdcTransfer = (to: Address, amount: bigint) => ({
  target: USDC,
  value: 0n,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
});

describe("recipient mode in routing", () => {
  it("Open: ETH to a fresh address within the limit is instant", async () => {
    const d = await route(0, [{ target: FRESH, value: parseEther("0.01"), data: "0x" }]);
    expect(d).toMatchObject({ route: "hot", rules: ["ROUTE-HOT-OK"], amountUsd: 30n * USD });
  });

  it("Open: an allowed token's transfer to a fresh address is instant; over the per-payment limit needs the Vault", async () => {
    expect((await route(0, [usdcTransfer(FRESH, 50n * USD)])).route).toBe("hot");
    const over = await route(0, [usdcTransfer(FRESH, 250n * USD)]);
    expect(over).toMatchObject({ route: "needs-vault", rules: ["ROUTE-NEEDS-VAULT", "PER-PAYMENT-LIMIT"] });
  });

  it("Open: approvals, zero-value calls and unknown contracts still need the Vault", async () => {
    const approve = {
      target: USDC,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [FRESH, 1n] }),
    };
    expect((await route(0, [approve])).rules).toContain("TARGET-NOT-ALLOWED");
    expect((await route(0, [{ target: FRESH, value: 0n, data: "0x" }])).rules).toContain("TARGET-NOT-ALLOWED");
  });

  it("Strict: a fresh recipient needs the Vault; the fee tank (allowed at activation) stays instant", async () => {
    const d = await route(1, [{ target: FRESH, value: parseEther("0.01"), data: "0x" }]);
    expect(d).toMatchObject({ route: "needs-vault", notAllowed: { what: "recipient", address: FRESH } });
    expect((await route(1, [{ target: TANK, value: parseEther("0.01"), data: "0x" }])).route).toBe("hot");
  });

  it("an ERC-2612 pre-approval counts its value against the limit and needs an allowed token", async () => {
    const call = (token: Address, value: bigint) =>
      registerPermitCall(plan.address, {
        kind: "register-permit",
        rule: "SIG-PERMIT-2612",
        token,
        spender: FRESH,
        value,
        deadline: 9n,
      });
    expect(await route(0, [call(USDC, 120n * USD)])).toMatchObject({ route: "hot", amountUsd: 120n * USD });
    expect((await route(0, [call(USDC, 900n * USD)])).rules).toContain("CAP-EXCEEDED");
    const other = "0x00000000000000000000000000000000000000d0" as Address;
    expect((await route(0, [call(other, 1n)])).rules).toContain("TOKEN-NOT-ALLOWED");
    void accountAbi;
  });
});
