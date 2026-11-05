import {
  concatHex,
  encodeAbiParameters,
  encodeFunctionData,
  getContractAddress,
  keccak256,
  parseEther,
  type Address,
  type Hex,
} from "viem";
import { accountAbi, accountFactoryAbi, erc1967ProxyCreationCode } from "../generated/contracts";
import type { AccountDeployment } from "../shared/chains";
import { StorageKeys, type KV } from "../shared/kv";

/** USD amounts on chain have 6 decimals (`capUsdPerDay`, `quoteUsd`, …). */
export const USD = 1_000_000n;

/**
 * Account defaults (ux-spec §3.1.3 and plan §10.3.2 `InitConfig`), fixed when the counterfactual address is first
 * computed. The address is a CREATE2 function of the whole init config, so it is frozen then and never recomputed
 * from later setting changes (a changed limit after that point is a Vault action, plan §30 §7).
 */
export const ACCOUNT_DEFAULTS = {
  /** USD-6 per 1 ETH, the account's own static price (risk R12: the pre-check uses the account's price, never an API). */
  ethUsdPrice: 3_000n * USD,
  /** The most a single everyday transaction may cost in network fees (the tank's worst case per over-limit attempt). */
  maxFeeWeiPerTx: parseEther("0.01"),
  maxPriorityFeePerGas: 2_000_000_000n,
  maxHotFrames: 4,
  /** Daily allowance of instant Vault spends; anything larger waits (timelock). */
  timelockThresholdUsd: 1_000n * USD,
  /** 0 = the contract default (48 h). */
  timelockDelay: 0,
} as const;

export const ACCOUNT_VERSION = "leaked.account.1";

export interface InitConfig {
  hotKey: Address;
  vaultSigner: Address;
  recoverySigner: Address;
  tank: Address;
  capUsdPerDay: bigint;
  perTxMaxUsd: bigint;
  maxFeeWeiPerTx: bigint;
  maxPriorityFeePerGas: bigint;
  maxHotFrames: number;
  selfPay: boolean;
  timelockDelay: number;
  timelockThresholdUsd: bigint;
  ethUsdPrice: bigint;
}

/** What the account address is computed from; stored per chain (bigints as decimal strings). */
export interface AccountPlan {
  chainId: number;
  address: Address;
  factory: Address;
  implementation: Address;
  salt: Hex;
  initData: Hex;
  config: Record<keyof InitConfig, string | number | boolean>;
  createdAt: number;
  /** Set once the deployment transaction is known (the account may also be deployed by anyone else). */
  activation?: { txHash: Hex; sentAt: number };
}

const ZERO: Address = "0x0000000000000000000000000000000000000000";

/** Salt = keccak(hotKey, vault, recovery, version, chainId) (plan §30 §8 salt scheme, plus the chain id). */
export function accountSalt(c: Pick<InitConfig, "hotKey" | "vaultSigner" | "recoverySigner">, chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "string" }, { type: "uint256" }],
      [c.hotKey, c.vaultSigner, c.recoverySigner, ACCOUNT_VERSION, BigInt(chainId)],
    ),
  );
}

export function encodeInitialize(c: InitConfig): Hex {
  return encodeFunctionData({ abi: accountAbi, functionName: "initialize", args: [c] });
}

/** `AccountFactory.predictAccount`, computed locally: CREATE2(factory, salt, ERC1967Proxy ‖ abi.encode(impl, data)). */
export function predictAccount(factory: Address, salt: Hex, implementation: Address, initData: Hex): Address {
  const bytecode = concatHex([
    erc1967ProxyCreationCode,
    encodeAbiParameters([{ type: "address" }, { type: "bytes" }], [implementation, initData]),
  ]);
  return getContractAddress({ opcode: "CREATE2", from: factory, salt, bytecode });
}

export function initConfigFor(opts: {
  hotKey: Address;
  tank: Address;
  vaultSigner: Address;
  dailyLimitUsd: number;
  perPaymentUsd: number;
}): InitConfig {
  return {
    hotKey: opts.hotKey,
    vaultSigner: opts.vaultSigner,
    recoverySigner: ZERO,
    tank: opts.tank,
    capUsdPerDay: BigInt(Math.round(opts.dailyLimitUsd * 100)) * (USD / 100n),
    perTxMaxUsd: BigInt(Math.round(opts.perPaymentUsd * 100)) * (USD / 100n),
    maxFeeWeiPerTx: ACCOUNT_DEFAULTS.maxFeeWeiPerTx,
    maxPriorityFeePerGas: ACCOUNT_DEFAULTS.maxPriorityFeePerGas,
    maxHotFrames: ACCOUNT_DEFAULTS.maxHotFrames,
    selfPay: false,
    timelockDelay: ACCOUNT_DEFAULTS.timelockDelay,
    timelockThresholdUsd: ACCOUNT_DEFAULTS.timelockThresholdUsd,
    ethUsdPrice: ACCOUNT_DEFAULTS.ethUsdPrice,
  };
}

export function buildPlan(
  chainId: number,
  deployment: AccountDeployment,
  config: InitConfig,
  now: number,
): AccountPlan {
  const salt = accountSalt(config, chainId);
  const initData = encodeInitialize(config);
  return {
    chainId,
    address: predictAccount(deployment.factory, salt, deployment.accountImpl, initData),
    factory: deployment.factory,
    implementation: deployment.accountImpl,
    salt,
    initData,
    config: Object.fromEntries(
      Object.entries(config).map(([k, v]) => [k, typeof v === "bigint" ? v.toString() : v]),
    ) as AccountPlan["config"],
    createdAt: now,
  };
}

export function planConfig(plan: AccountPlan): InitConfig {
  const c = plan.config;
  return {
    hotKey: c.hotKey as Address,
    vaultSigner: c.vaultSigner as Address,
    recoverySigner: c.recoverySigner as Address,
    tank: c.tank as Address,
    capUsdPerDay: BigInt(c.capUsdPerDay as string),
    perTxMaxUsd: BigInt(c.perTxMaxUsd as string),
    maxFeeWeiPerTx: BigInt(c.maxFeeWeiPerTx as string),
    maxPriorityFeePerGas: BigInt(c.maxPriorityFeePerGas as string),
    maxHotFrames: Number(c.maxHotFrames),
    selfPay: Boolean(c.selfPay),
    timelockDelay: Number(c.timelockDelay),
    timelockThresholdUsd: BigInt(c.timelockThresholdUsd as string),
    ethUsdPrice: BigInt(c.ethUsdPrice as string),
  };
}

/** Account plans per chain id, in storage.local. */
export class AccountPlans {
  constructor(private readonly kv: KV) {}

  async all(): Promise<Record<string, AccountPlan>> {
    return (await this.kv.get<Record<string, AccountPlan>>(StorageKeys.accountPlans)) ?? {};
  }

  async get(chainId: number): Promise<AccountPlan | undefined> {
    return (await this.all())[String(chainId)];
  }

  async put(plan: AccountPlan): Promise<void> {
    await this.kv.set(StorageKeys.accountPlans, { ...(await this.all()), [String(plan.chainId)]: plan });
  }

  async clear(): Promise<void> {
    await this.kv.remove(StorageKeys.accountPlans);
  }
}

/** The legacy transaction the fee-tank key sends to activate the account: `factory.createAccount(salt, impl, data)`. */
export function activationCalldata(plan: AccountPlan): Hex {
  return encodeFunctionData({
    abi: accountFactoryAbi,
    functionName: "createAccount",
    args: [plan.salt, plan.implementation, plan.initData],
  });
}

/** Gas for the activation (measured 2.37M on the local devnet, `contracts/devnet-tests/account`); with headroom. */
export const ACTIVATION_GAS = 3_500_000n;
