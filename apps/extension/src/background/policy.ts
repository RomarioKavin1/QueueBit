import type { Address, Hex, PublicClient } from "viem";
import { accountAbi } from "../generated/contracts";
import { planConfig, type AccountPlan } from "./account";
import { callShape, type Call, type ClassifiedCall, type PolicySnapshot } from "./routing";

/**
 * Reads the account's own policy from chain (plan §30 §5.1 `cachedPolicy`): hot config, bucket, prices, allowed
 * recipients/tokens and sessions. Before activation the same facts come from the frozen init config, which is exactly
 * what `initialize` will write (only the fee tank is an allowed recipient, ETH at the init price).
 */

const ETH: Address = "0x0000000000000000000000000000000000000000";

export interface AccountChainState {
  deployed: boolean;
  policy: PolicySnapshot;
  /** USD-6 per ETH (the account's static price). 0 = ETH not hot-spendable. */
  ethUsdPrice: bigint;
  /** Unix seconds when the bucket is full again (`getBucket().fullAt`). */
  fullAt?: number;
  maxFeeWeiPerTx: bigint;
  maxPriorityFeePerGas: bigint;
  hotKey: Address;
  tank: Address;
}

interface HotConfigResult {
  hotKey: Address;
  hotFrozen: boolean;
  bunker: boolean;
  tank: Address;
  perTxMaxUsd: bigint;
  maxFeeWeiPerTx: bigint;
  maxPriorityFeePerGas: bigint;
  frozenUntil: number;
}

export class PolicyReader {
  constructor(private readonly client: () => PublicClient) {}

  private read<T>(address: Address, functionName: string, args: readonly unknown[] = []): Promise<T> {
    return this.client().readContract({ address, abi: accountAbi, functionName, args } as never) as Promise<T>;
  }

  async isDeployed(address: Address): Promise<boolean> {
    const code = await this.client().getCode({ address });
    return code !== undefined && code !== "0x";
  }

  async state(plan: AccountPlan): Promise<AccountChainState> {
    const cfg = planConfig(plan);
    if (!(await this.isDeployed(plan.address))) {
      return {
        deployed: false,
        policy: {
          deployed: false,
          frozen: false,
          bunker: false,
          capUsd: cfg.capUsdPerDay,
          availableUsd: cfg.capUsdPerDay,
          perTxMaxUsd: cfg.perTxMaxUsd,
        },
        ethUsdPrice: cfg.ethUsdPrice,
        maxFeeWeiPerTx: cfg.maxFeeWeiPerTx,
        maxPriorityFeePerGas: cfg.maxPriorityFeePerGas,
        hotKey: cfg.hotKey,
        tank: cfg.tank,
      };
    }
    const [hot, bucket, eth] = await Promise.all([
      this.read<HotConfigResult>(plan.address, "getHotConfig"),
      this.read<readonly [bigint, number, bigint, number]>(plan.address, "getBucket"),
      this.read<{ allowed: boolean; usdPerToken: bigint }>(plan.address, "getToken", [ETH]),
    ]);
    const [available, , cap, fullAt] = bucket;
    return {
      deployed: true,
      policy: {
        deployed: true,
        frozen: hot.hotFrozen,
        bunker: hot.bunker,
        ...(hot.hotFrozen ? { frozenUntil: Number(hot.frozenUntil) } : {}),
        capUsd: cap,
        availableUsd: available,
        perTxMaxUsd: hot.perTxMaxUsd,
      },
      ethUsdPrice: eth.allowed ? eth.usdPerToken : 0n,
      fullAt: Number(fullAt),
      maxFeeWeiPerTx: hot.maxFeeWeiPerTx,
      maxPriorityFeePerGas: hot.maxPriorityFeePerGas,
      hotKey: hot.hotKey,
      tank: hot.tank,
    };
  }

  /** The policy facts of each call, mirroring `_hotCall` (LeakedAccountImpl). */
  async classify(plan: AccountPlan, state: AccountChainState, calls: Call[]): Promise<ClassifiedCall[]> {
    const cfg = planConfig(plan);
    const isTarget = async (a: Address) =>
      state.deployed ? this.read<boolean>(plan.address, "isTarget", [a]) : a.toLowerCase() === cfg.tank.toLowerCase();
    const token = async (t: Address) =>
      state.deployed
        ? this.read<{ allowed: boolean; decimals: number; usdPerToken: bigint }>(plan.address, "getToken", [t])
        : { allowed: false, decimals: 18, usdPerToken: 0n };
    const out: ClassifiedCall[] = [];
    for (const call of calls) {
      const s = callShape(call);
      if (s.kind === "eth-transfer") {
        out.push({
          call,
          kind: s.kind,
          recipient: s.recipient,
          amount: s.amount,
          assetAllowed: state.ethUsdPrice > 0n,
          recipientAllowed: await isTarget(s.recipient),
          sessionMatch: false,
          usd: quote(s.amount, state.ethUsdPrice, 18),
        });
      } else if (s.kind === "token-transfer") {
        const t = await token(s.token!);
        out.push({
          call,
          kind: s.kind,
          recipient: s.recipient,
          amount: s.amount,
          token: s.token!,
          assetAllowed: t.allowed,
          recipientAllowed: await isTarget(s.recipient),
          sessionMatch: false,
          usd: t.allowed ? quote(s.amount, t.usdPerToken, Number(t.decimals)) : 0n,
        });
      } else {
        let sessionMatch = false;
        if (state.deployed && call.data.length >= 10) {
          const selector = call.data.slice(0, 10) as Hex;
          const sess = await this.read<{ allowanceUsd: bigint; expiry: number }>(plan.address, "getSession", [
            call.target,
            selector,
          ]);
          sessionMatch = Number(sess.expiry) * 1000 > Date.now();
        }
        out.push({
          call,
          kind: s.kind,
          recipient: s.recipient,
          amount: s.amount,
          assetAllowed: state.ethUsdPrice > 0n || call.value === 0n,
          recipientAllowed: false,
          sessionMatch,
          usd: quote(call.value, state.ethUsdPrice, 18),
        });
      }
    }
    return out;
  }
}

/** `Math.mulDiv(amount, usdPerToken, 10**decimals, Ceil)` (LeakedAccountBase._quote). */
export function quote(amount: bigint, usdPerToken: bigint, decimals: number): bigint {
  const d = 10n ** BigInt(decimals);
  return (amount * usdPerToken + d - 1n) / d;
}
