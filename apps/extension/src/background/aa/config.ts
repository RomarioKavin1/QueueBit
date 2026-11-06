import { encodeAbiParameters, encodeFunctionData, keccak256, type Address, type Hex, type PublicClient } from "viem";
import { msaBootstrapAbi, msaFactoryAbi } from "../../generated/contracts";
import type { AaDeployment } from "../../shared/chains";
import {
  ACCOUNT_DEFAULTS,
  RECIPIENT_MODE,
  USD,
  ZERO,
  type AccountPlan,
  type PairedKey,
  type RecipientModeName,
  type TokenInit,
} from "../account";

/**
 * The compatible account (plan §30 §8, backend U): the reference ERC-7579 MSA (`MSAAdvanced` with an EntryPoint v0.8
 * shim) created by `MSAFactory.createAccount(salt, initCode)`, whose `initCode` delegatecalls `Bootstrap.initMSA` to
 * install LeakedHotValidator (type 1), LeakedRoleExecutor (type 2) and LeakedPolicyHook (type 4, the global hook) in
 * one transaction. The address is a CREATE2 function of the whole init code (the Vault's and the Recovery key's PQ
 * public keys, the limits, the tokens), so, as on the native account, it is frozen when it is computed.
 *
 * Host choice (IMPLEMENTATION-NOTES "Extension M2"): the reference MSA over Safe7579 (needs a keyless 0xdEaD owner,
 * does not bubble module reverts, +29k gas per hot op) and Kernel v3.3 (hot ERC-1271 must be off, so no sign-in).
 */

export const AA_VERSION = "leaked.account.4337.1";

/** `ILeakedModules.HookInit` (field order = the Solidity struct). */
export interface HookInit {
  hotKey: Address;
  capUsdPerDay: bigint;
  perTxMaxUsd: bigint;
  /** Bound on one hot userOp's prefund: (verification + call + preVerification gas) × maxFeePerGas. */
  maxFeeWei: bigint;
  maxPriorityFeePerGas: bigint;
  ethUsdPrice: bigint;
  tokens: TokenInit[];
  targets: Address[];
  recipientMode: number;
}

/** `ILeakedModules.ExecutorInit`. */
export interface ExecutorInit {
  hook: Address;
  verifier: Address;
  vaultPk: Hex;
  recoveryPk: Hex;
  timelockDelay: number;
  timelockThresholdUsd: bigint;
  guardians: Address[];
}

export interface AaInit {
  hook: HookInit;
  executor: ExecutorInit;
}

const HOOK_INIT = [
  {
    type: "tuple",
    components: [
      { name: "hotKey", type: "address" },
      { name: "capUsdPerDay", type: "uint256" },
      { name: "perTxMaxUsd", type: "uint256" },
      { name: "maxFeeWei", type: "uint256" },
      { name: "maxPriorityFeePerGas", type: "uint256" },
      { name: "ethUsdPrice", type: "uint256" },
      {
        name: "tokens",
        type: "tuple[]",
        components: [
          { name: "token", type: "address" },
          { name: "decimals", type: "uint8" },
          { name: "usdPerToken", type: "uint256" },
        ],
      },
      { name: "targets", type: "address[]" },
      { name: "recipientMode", type: "uint8" },
    ],
  },
] as const;

const EXECUTOR_INIT = [
  {
    type: "tuple",
    components: [
      { name: "hook", type: "address" },
      { name: "verifier", type: "address" },
      { name: "vaultPk", type: "bytes32" },
      { name: "recoveryPk", type: "bytes32" },
      { name: "timelockDelay", type: "uint48" },
      { name: "timelockThresholdUsd", type: "uint256" },
      { name: "guardians", type: "address[]" },
    ],
  },
] as const;

export const encodeHookInit = (h: HookInit): Hex => encodeAbiParameters(HOOK_INIT, [h]);
export const encodeExecutorInit = (e: ExecutorInit): Hex => encodeAbiParameters(EXECUTOR_INIT, [e]);

/** `MSAFactory.createAccount`'s `initCode`: abi.encode(bootstrap, Bootstrap.initMSA(validators, executors, hook, [])). */
export function bootstrapInitCode(dep: AaDeployment, init: AaInit): Hex {
  const initCall = encodeFunctionData({
    abi: msaBootstrapAbi,
    functionName: "initMSA",
    args: [
      [{ module: dep.validator, data: "0x" }],
      [{ module: dep.executor, data: encodeExecutorInit(init.executor) }],
      { module: dep.hook, data: encodeHookInit(init.hook) },
      [],
    ],
  });
  return encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [dep.bootstrap, initCall]);
}

const ZERO32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
const usd6 = (usd: number) => BigInt(Math.round(usd * 100)) * (USD / 100n);

/** The everyday prefund bound: what one hot userOp may draw from the account (cf. the tank's `maxFeeWeiPerTx`). */
export const AA_MAX_FEE_WEI = 10_000_000_000_000_000n; // 0.01 ETH

export function aaInitFor(opts: {
  hotKey: Address;
  tank: Address;
  dep: AaDeployment;
  vault: PairedKey;
  recovery?: PairedKey;
  dailyLimitUsd: number;
  perPaymentUsd: number;
  recipientMode?: RecipientModeName;
  tokens?: TokenInit[];
  timelockDelay?: number;
}): AaInit {
  return {
    hook: {
      hotKey: opts.hotKey,
      capUsdPerDay: usd6(opts.dailyLimitUsd),
      perTxMaxUsd: usd6(opts.perPaymentUsd),
      maxFeeWei: AA_MAX_FEE_WEI,
      maxPriorityFeePerGas: ACCOUNT_DEFAULTS.maxPriorityFeePerGas,
      ethUsdPrice: ACCOUNT_DEFAULTS.ethUsdPrice,
      tokens: opts.tokens ?? [],
      // The fee tank is allowlisted at setup (it relays Vault approvals): topping it up is an everyday payment.
      targets: [opts.tank],
      recipientMode: RECIPIENT_MODE[opts.recipientMode ?? "open"],
    },
    executor: {
      hook: opts.dep.hook,
      verifier: opts.dep.c13Verifier,
      vaultPk: opts.vault.pk,
      recoveryPk: opts.recovery?.pk ?? ZERO32,
      timelockDelay: opts.timelockDelay ?? ACCOUNT_DEFAULTS.timelockDelay,
      timelockThresholdUsd: ACCOUNT_DEFAULTS.timelockThresholdUsd,
      guardians: [],
    },
  };
}

/** Salt = keccak(hotKey, vault pk, recovery pk, version, chainId), as the native account (another version string). */
export function aaSalt(hotKey: Address, vaultPk: Hex, recoveryPk: Hex | undefined, chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "string" }, { type: "uint256" }],
      [hotKey, vaultPk, recoveryPk ?? ZERO32, AA_VERSION, BigInt(chainId)],
    ),
  );
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v.toString()}n` : v);
const reviver = (_k: string, v: unknown) => (typeof v === "string" && /^\d+n$/u.test(v) ? BigInt(v.slice(0, -1)) : v);

/** `MSAFactory.getAddress(salt, initCode)` (eth_call: the proxy creation code lives in the factory). */
export async function predictAaAccount(client: PublicClient, dep: AaDeployment, salt: Hex, initCode: Hex) {
  return (await client.readContract({
    address: dep.factory,
    abi: msaFactoryAbi,
    functionName: "getAddress",
    args: [salt, initCode],
  })) as Address;
}

export function buildAaPlan(
  chainId: number,
  dep: AaDeployment,
  init: AaInit,
  salt: Hex,
  address: Address,
  now: number,
): AccountPlan {
  return {
    chainId,
    backend: "4337",
    address,
    factory: dep.factory,
    implementation: dep.msaImpl,
    salt,
    initData: bootstrapInitCode(dep, init),
    config: JSON.stringify(init, replacer),
    // No role-signer contracts on this backend: the executor checks the PQ signatures (the Vault is its `vaultPk`).
    vaultSigner: ZERO,
    createdAt: now,
  };
}

export function aaPlanInit(plan: AccountPlan): AaInit {
  return JSON.parse(plan.config, reviver) as AaInit;
}

/** `MSAFactory.createAccount(salt, initCode)`: the tank sends it (a plain tx; a first userOp with initCode would need a staked factory, ERC-7562 [STO-022]). */
export function aaActivationCalldata(plan: AccountPlan): Hex {
  return encodeFunctionData({ abi: msaFactoryAbi, functionName: "createAccount", args: [plan.salt, plan.initData] });
}

/** 826,665 gas measured on anvil (devnet/deploy smoke); with headroom. */
export const AA_ACTIVATION_GAS = 1_500_000n;
