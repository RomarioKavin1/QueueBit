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
import { accountAbi, accountFactoryAbi, erc1967ProxyCreationCode, roleSignerFactoryAbi } from "../generated/contracts";
import type { AccountDeployment } from "../shared/chains";
import { StorageKeys, type KV } from "../shared/kv";

/** USD amounts on chain have 6 decimals (`capUsdPerDay`, `quoteUsd`, …). */
export const USD = 1_000_000n;

/**
 * Account defaults (ux-spec §3.1.3 and plan §10.3.2 `InitConfig`), fixed when the counterfactual address is
 * computed at the end of onboarding. The address is a CREATE2 function of the whole init config (including the
 * Vault's and the Recovery key's quantum-safe public keys), so it is frozen then; a limit changed after that point is
 * a Vault action (plan §30 §7).
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

export const ACCOUNT_VERSION = "queuebit.account.2";

/** `RecipientMode` (IQueueBitAccount): Open = everyday payments to anyone within the limit; Strict = allowlist only. */
export const RECIPIENT_MODE = { open: 0, strict: 1 } as const;
export type RecipientModeName = keyof typeof RECIPIENT_MODE;

/** Role ids of `RoleSignerFactory` / `PQRoleSigner`. */
export const ROLE_ID = { vault: 1, recovery: 2 } as const;

/** `IQueueBitAccount.RoleSignerParams`: the `createRoleSigner` arguments of a bound role signer, minus role/account. */
export interface RoleSignerParams {
  salt: Hex;
  pk: Hex;
  verifier: Address;
  payerKey: Address;
}

/** `IQueueBitAccount.InitConfig` (field order = the Solidity struct). */
export interface InitConfig {
  hotKey: Address;
  roleSignerFactory: Address;
  vault: RoleSignerParams;
  recovery: RoleSignerParams;
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
  recipientMode: number;
  /** Appended (2026-11-06): ≤ 16 priced ERC-20s allowed from initialize (the account's `TokenInit`). */
  tokens: TokenInit[];
}

/** `IQueueBitAccount.TokenInit` / `IQueueBitModules.TokenInit`: USD-6 per whole token, as `vaultSetToken`. */
export interface TokenInit {
  token: Address;
  decimals: number;
  usdPerToken: bigint;
}

/** The account (and the hook) refuse more than this at initialize (`TooManyTokens`). */
export const MAX_INIT_TOKENS = 16;

/**
 * The initialize rules for the role payer keys (IMPLEMENTATION-NOTES "Account: initial tokens, recovery payer key"):
 * a payer is never the hot key or the tank, and the Vault's and the Recovery's differ. Returns user-facing copy.
 */
export function payerConflict(o: { hotKey: Address; tank: Address; vaultPayer?: Address; recoveryPayer?: Address }) {
  const eq = (a?: Address, b?: Address) => !!a && !!b && a.toLowerCase() === b.toLowerCase();
  for (const [p, who] of [
    [o.vaultPayer, "Vault"],
    [o.recoveryPayer, "Recovery key"],
  ] as const) {
    if (eq(p, o.hotKey) || eq(p, o.tank))
      return `The ${who}'s fee-payment key is one of this browser's keys. Pair the ${who} again from its own device.`;
  }
  if (eq(o.vaultPayer, o.recoveryPayer))
    return "The Vault and the Recovery key use the same fee-payment key. Set up the Recovery key from its own words.";
  return undefined;
}

/** Tokens for initialize from the onboarding choice: sorted, de-duplicated, at most 16, prices > 0. */
export function initTokens(
  list: ReadonlyArray<{ token: Address; decimals: number; usdPerToken: string | bigint }>,
): TokenInit[] {
  const seen = new Set<string>();
  const out: TokenInit[] = [];
  for (const t of list) {
    const k = t.token.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    const usdPerToken = BigInt(t.usdPerToken);
    if (usdPerToken <= 0n || t.decimals < 0 || t.decimals > 36) throw new Error(`Bad token price for ${t.token}`);
    out.push({ token: t.token, decimals: t.decimals, usdPerToken });
  }
  if (out.length > MAX_INIT_TOKENS) throw new Error(`At most ${MAX_INIT_TOKENS} tokens.`);
  return out;
}

/** A quantum-safe key a phone announced (`ur:queuebit-pq-key`), as the extension stores it. */
export interface PairedKey {
  schemeId: Hex;
  pk: Hex;
  /** The role's Path-B fee-payment key on its device (Vault: pairing code; Recovery: v2 test code). */
  payer?: Address;
}

/** What the account address is computed from; stored per chain (bigints as decimal strings). */
export interface AccountPlan {
  chainId: number;
  /** "4337": a compatible (ERC-7579) account; absent = the native frame account. */
  backend?: "4337";
  address: Address;
  factory: Address;
  implementation: Address;
  salt: Hex;
  initData: Hex;
  /** JSON of the InitConfig (bigints as strings), see `planConfig`. */
  config: string;
  /** The role signers `initialize` derives (RoleSignerFactory.predictRoleSigner), for the clone deployment. */
  vaultSigner: Address;
  recoverySigner?: Address;
  /** A Recovery key linked after activation (`vaultSetRecoverySigner`): its clone's arguments (not in InitConfig). */
  recoveryParams?: RoleSignerParams;
  createdAt: number;
  /** Set once the deployment transaction is known (the account may also be deployed by anyone else). */
  activation?: { txHash: Hex; sentAt: number; vaultSignerTx?: Hex };
}

export const ZERO: Address = "0x0000000000000000000000000000000000000000";
const ZERO32: Hex = "0x0000000000000000000000000000000000000000000000000000000000000000";
const NO_SIGNER: RoleSignerParams = { salt: ZERO32, pk: ZERO32, verifier: ZERO, payerKey: ZERO };

/**
 * Salt = keccak(hotKey, vault pk, recovery pk, version, chainId) (plan §30 §8 salt scheme; IMPLEMENTATION-NOTES
 * "Account: Open recipient mode": the salt hashes the Vault's public key, not a signer address).
 */
export function accountSalt(hotKey: Address, vaultPk: Hex, recoveryPk: Hex | undefined, chainId: number): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }, { type: "string" }, { type: "uint256" }],
      [hotKey, vaultPk, recoveryPk ?? ZERO32, ACCOUNT_VERSION, BigInt(chainId)],
    ),
  );
}

/** The role signers' CREATE2 salt input (any bytes32; one per account so two accounts never share a clone). */
export function roleSalt(accountSalt: Hex): Hex {
  return keccak256(encodeAbiParameters([{ type: "string" }, { type: "bytes32" }], ["queuebit.roles.1", accountSalt]));
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

const usd6 = (usd: number) => BigInt(Math.round(usd * 100)) * (USD / 100n);

export function initConfigFor(opts: {
  hotKey: Address;
  tank: Address;
  deployment: AccountDeployment;
  vault: PairedKey;
  recovery?: PairedKey;
  salt: Hex;
  dailyLimitUsd: number;
  perPaymentUsd: number;
  recipientMode?: RecipientModeName;
  timelockDelay?: number;
  tokens?: TokenInit[];
}): InitConfig {
  const verifier = opts.deployment.c13Verifier;
  return {
    hotKey: opts.hotKey,
    roleSignerFactory: opts.deployment.roleSignerFactory,
    vault: { salt: opts.salt, pk: opts.vault.pk, verifier, payerKey: opts.vault.payer ?? ZERO },
    recovery: opts.recovery
      ? { salt: opts.salt, pk: opts.recovery.pk, verifier, payerKey: opts.recovery.payer ?? ZERO }
      : NO_SIGNER,
    vaultSigner: ZERO,
    recoverySigner: ZERO,
    tank: opts.tank,
    capUsdPerDay: usd6(opts.dailyLimitUsd),
    perTxMaxUsd: usd6(opts.perPaymentUsd),
    maxFeeWeiPerTx: ACCOUNT_DEFAULTS.maxFeeWeiPerTx,
    maxPriorityFeePerGas: ACCOUNT_DEFAULTS.maxPriorityFeePerGas,
    maxHotFrames: ACCOUNT_DEFAULTS.maxHotFrames,
    selfPay: false,
    timelockDelay: opts.timelockDelay ?? ACCOUNT_DEFAULTS.timelockDelay,
    timelockThresholdUsd: ACCOUNT_DEFAULTS.timelockThresholdUsd,
    ethUsdPrice: ACCOUNT_DEFAULTS.ethUsdPrice,
    recipientMode: RECIPIENT_MODE[opts.recipientMode ?? "open"],
    tokens: opts.tokens ?? [],
  };
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? `${v.toString()}n` : v);
const reviver = (_k: string, v: unknown) => (typeof v === "string" && /^\d+n$/u.test(v) ? BigInt(v.slice(0, -1)) : v);

export function buildPlan(
  chainId: number,
  deployment: AccountDeployment,
  config: InitConfig,
  signers: { vaultSigner: Address; recoverySigner?: Address },
  salt: Hex,
  now: number,
): AccountPlan {
  const initData = encodeInitialize(config);
  return {
    chainId,
    address: predictAccount(deployment.factory, salt, deployment.accountImpl, initData),
    factory: deployment.factory,
    implementation: deployment.accountImpl,
    salt,
    initData,
    config: JSON.stringify(config, replacer),
    vaultSigner: signers.vaultSigner,
    ...(signers.recoverySigner ? { recoverySigner: signers.recoverySigner } : {}),
    createdAt: now,
  };
}

export function planConfig(plan: AccountPlan): InitConfig {
  return JSON.parse(plan.config, reviver) as InitConfig;
}

/** `RoleSignerFactory.createRoleSigner` for one of the plan's derived signers (anyone may send it; the tank does). */
/** The `createRoleSigner` arguments (minus role/account) of the plan's Vault or Recovery signer. */
export function roleParams(plan: AccountPlan, role: keyof typeof ROLE_ID): RoleSignerParams {
  const c = planConfig(plan);
  if (role === "vault") return c.vault;
  return plan.recoveryParams ?? c.recovery;
}

export function createRoleSignerCalldata(plan: AccountPlan, role: keyof typeof ROLE_ID): Hex {
  const p = roleParams(plan, role);
  return encodeFunctionData({
    abi: roleSignerFactoryAbi,
    functionName: "createRoleSigner",
    args: [p.salt, ROLE_ID[role], plan.address, p.pk, p.verifier, p.payerKey],
  });
}

/** Account plans per chain id, in storage.local. */
export class AccountPlans {
  constructor(private readonly kv: KV) {}

  async all(): Promise<Record<string, AccountPlan>> {
    return (await this.kv.get<Record<string, AccountPlan>>(StorageKeys.accountPlans)) ?? {};
  }

  async get(chainId: number): Promise<AccountPlan | undefined> {
    const p = (await this.all())[String(chainId)];
    // Plans from before the Vault was paired (M1's stand-in) have an object config; they are not usable.
    return p && typeof p.config === "string" ? p : undefined;
  }

  async put(plan: AccountPlan): Promise<void> {
    await this.kv.set(StorageKeys.accountPlans, { ...(await this.all()), [String(plan.chainId)]: plan });
  }

  async remove(chainId: number): Promise<void> {
    const all = await this.all();
    delete all[String(chainId)];
    await this.kv.set(StorageKeys.accountPlans, all);
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

/** Gas for the activation (2,504,524 measured with two derived signers on the local devnet); with headroom. */
export const ACTIVATION_GAS = 3_500_000n;
/** Gas for a role-signer clone deployment (575,946 measured, G1); with headroom. */
export const CLONE_GAS = 1_000_000n;
/** ETH the tank gives the Vault signer at deployment: it pays its own network fees (about 0.001 ETH per approval). */
export const VAULT_SIGNER_FLOAT = parseEther("0.02");
/**
 * ETH for a Recovery signer: its fees (Path B with the Recovery's own payer key), or the 0.01 ETH minimum stake of
 * the staked lane when it has no payer key (Path A only).
 */
export const RECOVERY_SIGNER_FLOAT = parseEther("0.03");
