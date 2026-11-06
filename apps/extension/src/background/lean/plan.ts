import {
  KIND,
  ROLE,
  VALIDATION_BUDGET,
  createAccountCall,
  predictAccount,
  type AccountDeployment,
  type CreateOptions,
} from "@queuebit/account";
import { keccak256, toHex, type Address, type Hex } from "viem";

/**
 * The account a set of backup words makes (pure: the unit tests pin it). One LeanAccount per chain, with the owner key
 * as its only key (ADMIN | SPEND, weight 1), quantum-safe approvals required for admin changes, and the LeanPool
 * node's aggregator as the only one whose batch roots it accepts. The address is bound to all of it (CREATE2 over the
 * whole configuration), so it is computed once and kept.
 */
export const ACCOUNT_SALT: Hex = keccak256(toHex("queuebit.leanaccount.v1"));

export interface PlanInput {
  vk: Hex;
  aggregator: Address;
  guardians?: Address[];
  guardianThreshold?: number;
  salt?: Hex;
}

export function accountOptions(i: PlanInput): CreateOptions {
  if (!/^0x[0-9a-fA-F]{64}$/u.test(i.vk)) throw new Error("The owner key's public key must be 32 bytes.");
  const guardians = i.guardians ?? [];
  const threshold = i.guardianThreshold ?? (guardians.length ? 1 : 0);
  if (guardians.length && (threshold < 1 || threshold > guardians.length))
    throw new Error("Pick how many guardians must agree: at least 1, at most the number of guardians.");
  return {
    salt: i.salt ?? ACCOUNT_SALT,
    policy: { adminThreshold: 1, spendThreshold: 1, requirePQ: true, aggregator: i.aggregator },
    keys: [{ kind: KIND.PQ, weight: 1, roles: ROLE.ADMIN | ROLE.SPEND, a: i.vk }],
    ...(guardians.length ? { guardians, guardianThreshold: threshold } : {}),
  };
}

export interface AccountPlan {
  options: CreateOptions;
  address: Address;
  /** What the setup key sends to create it: `factory.createAccount(salt, init)`. */
  create: { to: Address; value: bigint; data: Hex };
}

export function accountPlan(d: AccountDeployment, i: PlanInput): AccountPlan {
  const options = accountOptions(i);
  return { options, address: predictAccount(d, options), create: createAccountCall(d, options) };
}

/** Frame gas per SENDER frame (execution; state for new storage and accounts): what @queuebit/account defaults to. */
export const SENDER_GAS = 300_000n;
export const SENDER_STATE = 400_000n;

/** The most a frame transaction with `frames` SENDER frames can cost: the account must hold this (plus its value). */
export function frameMaxCost(
  maxFeePerGas: bigint,
  frames: number,
  gas: { execution?: bigint; state?: bigint } = {},
): bigint {
  const perFrame = (gas.execution ?? SENDER_GAS) + (gas.state ?? SENDER_STATE);
  return maxFeePerGas * (VALIDATION_BUDGET + BigInt(frames) * perFrame);
}
