import {
  decodeAbiParameters,
  decodeFunctionData,
  encodeAbiParameters,
  hashTypedData,
  keccak256,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it } from "vitest";
import {
  aaAccountAddress,
  aaInitFor,
  aaSalt,
  bootstrapInitCode,
  encodeHookInit,
  predictAaAccount,
} from "../../src/background/aa/config";
import { callGasFloor } from "../../src/background/aa/payments";
import {
  buildAaVaultAction,
  execCallsHash,
  executorDigest,
  pqSigOf,
  withPqSig,
} from "../../src/background/aa/executor";
import {
  MODE_BATCH,
  MODE_SINGLE,
  decodeRevert,
  executeCalldata,
  validatorNonceKey,
} from "../../src/background/aa/userop";
import { USD, initTokens, payerConflict } from "../../src/background/account";
import { msaBootstrapAbi, policyHookAbi, roleExecutorAbi } from "../../src/generated/contracts";
import type { AaDeployment } from "../../src/shared/chains";
import type { CurrentPolicy } from "../../src/background/vaultActions";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const DEP: AaDeployment = {
  entryPoint: "0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108",
  factory: a(1),
  msaImpl: a(2),
  bootstrap: a(3),
  validator: a(4),
  hook: a(5),
  executor: a(6),
  c13Verifier: a(7),
};
const ACCOUNT = a(0xacc);
const PK = `0x${"11".repeat(32)}` as Hex;
const CUR: CurrentPolicy = {
  capUsd: 500n * USD,
  perTxMaxUsd: 200n * USD,
  maxFeeWeiPerTx: 10n ** 16n,
  maxPriorityFeePerGas: 2_000_000_000n,
  maxHotFrames: 8,
  recipientMode: "open",
  vaultAvailableUsd: 1000n * USD,
  timelockDelay: 172_800,
  tokens: {},
  sessions: {},
};

describe("4337 account config", () => {
  it("installs validator, executor and hook through Bootstrap.initMSA, with tokens and the tank allowlisted", () => {
    const init = aaInitFor({
      hotKey: a(0x40),
      tank: a(0x7a),
      dep: DEP,
      vault: { schemeId: PK, pk: PK },
      dailyLimitUsd: 500,
      perPaymentUsd: 200,
      tokens: [{ token: a(0x05dc), decimals: 6, usdPerToken: USD }],
    });
    const code = bootstrapInitCode(DEP, init);
    const [bootstrap, call] = decodeAbiParameters([{ type: "address" }, { type: "bytes" }], code);
    expect(bootstrap).toBe(DEP.bootstrap);
    const { functionName, args } = decodeFunctionData({ abi: msaBootstrapAbi, data: call });
    expect(functionName).toBe("initMSA");
    const [validators, executors, hook] = args as unknown as [
      Array<{ module: Address }>,
      Array<{ module: Address }>,
      { module: Address; data: Hex },
    ];
    expect(validators.map((v) => v.module)).toEqual([DEP.validator]);
    expect(executors.map((v) => v.module)).toEqual([DEP.executor]);
    expect(hook.module).toBe(DEP.hook);
    expect(hook.data).toBe(encodeHookInit(init.hook));
    expect(init.hook.targets).toEqual([a(0x7a)]);
    expect(init.hook.capUsdPerDay).toBe(500n * USD);
    expect(init.executor.recoveryPk).toBe(`0x${"0".repeat(64)}`);
  });

  it("the salt commits to the keys, the chain and the backend version", () => {
    const s = aaSalt(a(1), PK, undefined, 31337);
    expect(aaSalt(a(1), PK, undefined, 31337)).toBe(s);
    expect(aaSalt(a(1), PK, PK.replace("11", "22") as Hex, 31337)).not.toBe(s);
    expect(aaSalt(a(1), PK, undefined, 1)).not.toBe(s);
  });
});

describe("initialize rules shared by both backends", () => {
  it("payers are never the hot key or the tank, and the two roles differ", () => {
    expect(payerConflict({ hotKey: a(1), tank: a(2), vaultPayer: a(3), recoveryPayer: a(4) })).toBeUndefined();
    expect(payerConflict({ hotKey: a(1), tank: a(2), vaultPayer: a(1) })).toMatch(/Vault's fee-payment key/u);
    expect(payerConflict({ hotKey: a(1), tank: a(2), recoveryPayer: a(2) })).toMatch(/Recovery key's/u);
    expect(payerConflict({ hotKey: a(1), tank: a(2), vaultPayer: a(3), recoveryPayer: a(3) })).toMatch(
      /same fee-payment/u,
    );
  });

  it("tokens: de-duplicated, priced, at most 16", () => {
    expect(
      initTokens([
        { token: a(9), decimals: 6, usdPerToken: "1000000" },
        { token: a(9), decimals: 6, usdPerToken: "1" },
      ]),
    ).toEqual([{ token: a(9), decimals: 6, usdPerToken: 1_000_000n }]);
    expect(() => initTokens([{ token: a(9), decimals: 6, usdPerToken: "0" }])).toThrow();
    expect(() =>
      initTokens(Array.from({ length: 17 }, (_, i) => ({ token: a(100 + i), decimals: 18, usdPerToken: "1" }))),
    ).toThrow();
  });
});

describe("user operations", () => {
  const exec = parseAbi(["function execute(bytes32 mode, bytes executionCalldata)"]);
  it("one call is execute(single, target ‖ value ‖ data); several are execute(batch, abi.encode(Execution[]))", () => {
    const one = decodeFunctionData({
      abi: exec,
      data: executeCalldata([{ target: a(0xbeef), value: 5n, data: "0x" }]),
    });
    expect(one.args[0]).toBe(MODE_SINGLE);
    expect(one.args[1]).toBe(`${a(0xbeef)}${"0".repeat(63)}5`.toLowerCase());
    const two = decodeFunctionData({
      abi: exec,
      data: executeCalldata([
        { target: a(1), value: 1n, data: "0x" },
        { target: a(2), value: 0n, data: "0x1234" },
      ]),
    });
    expect(two.args[0]).toBe(MODE_BATCH);
    const [list] = decodeAbiParameters(
      [{ type: "tuple[]", components: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }] }],
      two.args[1],
    );
    expect(list).toHaveLength(2);
  });

  it("the validator sits in the nonce key's top 20 bytes", () => {
    const key = validatorNonceKey(a(4));
    expect((key << 64n) >> 96n).toBe(4n);
  });

  it("decodes module reverts in plain words", () => {
    const err = "0x" + keccak256(new TextEncoder().encode("OverCap(uint256,uint256)")).slice(2, 10);
    const data = (err + encodeAbiParameters([{ type: "uint256" }, { type: "uint256" }], [3n, 2n]).slice(2)) as Hex;
    expect(decodeRevert(data)).toBe("OverCap(3,2)");
  });
});

describe("QueueBitRoleExecutor requests (tx-type 3)", () => {
  const domain = {
    name: "QueueBitRoleExecutor",
    version: "1",
    chainId: 31337,
    verifyingContract: DEP.executor,
  } as const;

  it("a send within the Vault's instant allowance is vaultExec; the digest is VaultExec over callsHash", () => {
    const b = buildAaVaultAction(
      ACCOUNT,
      DEP,
      { type: "send", calls: [{ target: a(0xcafe), value: "10", data: "0x" }], usd6: "300000000" },
      CUR,
      7n,
    );
    expect(b.fn).toBe("vaultExec");
    expect(pqSigOf(b.calldata)).toBe("0x");
    const calls = [{ target: a(0xcafe), value: 10n, data: "0x" as Hex }];
    const want = hashTypedData({
      domain,
      types: {
        VaultExec: [
          { name: "account", type: "address" },
          { name: "nonce", type: "uint256" },
          { name: "callsHash", type: "bytes32" },
          { name: "usdValue", type: "uint256" },
        ],
      },
      primaryType: "VaultExec",
      message: { account: ACCOUNT, nonce: 7n, callsHash: execCallsHash(calls), usdValue: 300_000_000n },
    });
    expect(executorDigest(31337, DEP.executor, b.calldata)).toEqual({ fn: "vaultExec", digest: want });
    // The signature slot round-trips and does not change the digest.
    const signed = withPqSig(b.calldata, "0xabcd");
    expect(pqSigOf(signed)).toBe("0xabcd");
    expect(executorDigest(31337, DEP.executor, signed).digest).toBe(want);
  });

  it("a large send is queued (KIND_SPEND) with the calls kept for executeQueued", () => {
    const b = buildAaVaultAction(
      ACCOUNT,
      DEP,
      { type: "send", calls: [{ target: a(1), value: "1", data: "0x" }], usd6: "2000000000" },
      CUR,
      0n,
    );
    expect(b.fn).toBe("vaultQueue");
    expect(b.queued?.kind).toBe(0);
  });

  it("tightening is an instant vaultExec of hook.setCap(account, …); raising is queued as a loosen", () => {
    const tight = buildAaVaultAction(ACCOUNT, DEP, { type: "setLimits", dailyUsd: 100, perPaymentUsd: 50 }, CUR, 0n);
    expect(tight.fn).toBe("vaultExec");
    const { args } = decodeFunctionData({ abi: roleExecutorAbi, data: tight.calldata });
    const [, calls] = args as unknown as [Address, Array<{ target: Address; data: Hex }>];
    expect(calls[0]!.target.toLowerCase()).toBe(DEP.hook);
    const set = decodeFunctionData({ abi: policyHookAbi, data: calls[0]!.data });
    expect(set.functionName).toBe("setCap");
    expect((set.args?.[0] as string).toLowerCase()).toBe(ACCOUNT);
    expect(set.args?.[1]).toBe(100n * USD);
    const loose = buildAaVaultAction(ACCOUNT, DEP, { type: "setLimits", dailyUsd: 2000, perPaymentUsd: 200 }, CUR, 0n);
    expect(loose.fn).toBe("vaultQueue");
    expect(loose.queued?.kind).toBe(1);
  });

  it("cancels go to the role that asks (recoveryCancel for the Recovery key)", () => {
    const opId = `0x${"aa".repeat(32)}` as Hex;
    const b = buildAaVaultAction(ACCOUNT, DEP, { type: "cancel", opId, title: "x", by: "recovery" }, CUR, 3n);
    expect(b.fn).toBe("recoveryCancel");
    expect(b.role).toBe("recovery");
    expect(executorDigest(31337, DEP.executor, b.calldata).fn).toBe("recoveryCancel");
  });

  it("linking a Recovery key is executor.setRecoveryKey(account, pk)", () => {
    const b = buildAaVaultAction(ACCOUNT, DEP, { type: "setRecoveryKey", pk: PK }, CUR, 0n);
    const { args } = decodeFunctionData({ abi: roleExecutorAbi, data: b.calldata });
    const [, calls] = args as unknown as [Address, Array<{ target: Address; data: Hex }>];
    expect(calls[0]!.target.toLowerCase()).toBe(DEP.executor);
    expect(decodeFunctionData({ abi: roleExecutorAbi, data: calls[0]!.data }).functionName).toBe("setRecoveryKey");
  });
});

describe("the account address is computed locally", () => {
  const INIT: Hex = "0x1234";
  const SALT = aaSalt(a(0xa0), PK, undefined, 31337);
  const fake = (answer: Address) => ({ readContract: async () => answer }) as never;

  it("CREATE2 of MSAProxy ‖ (impl, initializeAccount(initCode)) from the factory; the RPC's getAddress must agree", async () => {
    const local = aaAccountAddress(DEP, SALT, INIT);
    expect(local).toMatch(/^0x[0-9a-fA-F]{40}$/u);
    expect(aaAccountAddress({ ...DEP, msaImpl: a(9) }, SALT, INIT)).not.toBe(local);
    expect(aaAccountAddress(DEP, SALT, "0x5678")).not.toBe(local);
    await expect(predictAaAccount(fake(local.toLowerCase() as Address), DEP, SALT, INIT)).resolves.toBe(local);
  });

  it("an RPC that answers another address fails closed", async () => {
    await expect(predictAaAccount(fake(a(0xbad)), DEP, SALT, INIT)).rejects.toThrow(/doesn't match/u);
  });
});

describe("the bundler's gas estimate", () => {
  it("callGasLimit is never below our own measurement of execute (×1.2 + 30k)", () => {
    expect(callGasFloor(100_000n)).toBe(150_000n);
  });
});
