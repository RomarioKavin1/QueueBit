import { decodeFunctionData, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { accountAbi } from "../generated/contracts";
import { planConfig, type AccountPlan } from "./account";
import { callShape, type Call, type ClassifiedCall, type PolicySnapshot } from "./routing";

/**
 * Reads the account's own policy from chain (plan §30 §5.1 `cachedPolicy`): hot config, bucket, prices, allowed
 * recipients/tokens and sessions. Before activation the same facts come from the frozen init config, which is exactly
 * what `initialize` will write (only the fee tank is an allowed recipient, ETH at the init price).
 */

const ETH: Address = "0x0000000000000000000000000000000000000000";
const REGISTER_PERMIT = toFunctionSelector("registerPermit(address,address,uint256,uint256)");

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
  /** Open: everyday ETH sends / allowed-token transfers may go to any address (within the limits). */
  recipientMode: "open" | "strict";
  frozenUntil?: number;
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
        recipientMode: cfg.recipientMode === 1 ? "strict" : "open",
      };
    }
    const [hot, bucket, eth, mode] = await Promise.all([
      this.read<HotConfigResult>(plan.address, "getHotConfig"),
      this.read<readonly [bigint, number, bigint, number]>(plan.address, "getBucket"),
      this.read<{ allowed: boolean; usdPerToken: bigint }>(plan.address, "getToken", [ETH]),
      this.read<number>(plan.address, "recipientMode"),
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
      recipientMode: Number(mode) === 0 ? "open" : "strict",
      ...(hot.hotFrozen ? { frozenUntil: Number(hot.frozenUntil) } : {}),
    };
  }

  /** The policy facts of each call, mirroring `_hotCall` (LeakedAccountImpl). */
  async classify(plan: AccountPlan, state: AccountChainState, calls: Call[]): Promise<ClassifiedCall[]> {
    const cfg = planConfig(plan);
    return classifyCalls(
      {
        account: plan.address,
        permitTarget: plan.address,
        state,
        isTarget: (a) =>
          state.deployed
            ? this.read<boolean>(plan.address, "isTarget", [a])
            : Promise.resolve(a.toLowerCase() === cfg.tank.toLowerCase()),
        token: async (t) => {
          if (state.deployed) return this.read<TokenFacts>(plan.address, "getToken", [t]);
          // Before activation: exactly what initialize will write (InitConfig.tokens).
          const init = (cfg.tokens ?? []).find((x) => x.token.toLowerCase() === t.toLowerCase());
          return init
            ? { allowed: true, decimals: init.decimals, usdPerToken: init.usdPerToken }
            : { allowed: false, decimals: 18, usdPerToken: 0n };
        },
        sessionLive: async (target, selector) => {
          if (!state.deployed) return false;
          const sess = await this.read<{ allowanceUsd: bigint; expiry: number }>(plan.address, "getSession", [
            target,
            selector,
          ]);
          return Number(sess.expiry) * 1000 > Date.now();
        },
      },
      calls,
    );
  }
}

export interface TokenFacts {
  allowed: boolean;
  decimals: number;
  usdPerToken: bigint;
}

/** What `classifyCalls` reads, per backend (the native account, or the 7579 policy hook). */
export interface PolicySource {
  account: Address;
  /** Where `registerPermit(token, spender, value, deadline)` is called: the account (native) or the hook (4337). */
  permitTarget: Address;
  state: Pick<AccountChainState, "recipientMode" | "ethUsdPrice" | "deployed">;
  isTarget(a: Address): Promise<boolean>;
  token(t: Address): Promise<TokenFacts>;
  sessionLive(target: Address, selector: Hex): Promise<boolean>;
}

/** The policy facts of each call (both backends share the rules: plan §30 §5, IMPLEMENTATION-NOTES M7 mirrors). */
export async function classifyCalls(src: PolicySource, calls: Call[]): Promise<ClassifiedCall[]> {
  const { state } = src;
  // Open mode (the default): a plain ETH send or an allowed token's `transfer` may go to any non-zero address
  // within the limits (IMPLEMENTATION-NOTES "Account: Open recipient mode"); Strict keeps the recipient list.
  const recipientOk = async (a: Address) =>
    (state.recipientMode === "open" && a.toLowerCase() !== ETH) || (await src.isTarget(a));
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
        recipientAllowed: s.amount > 0n ? await recipientOk(s.recipient) : await src.isTarget(s.recipient),
        sessionMatch: false,
        usd: quote(s.amount, state.ethUsdPrice, 18),
      });
    } else if (s.kind === "token-transfer") {
      const t = await src.token(s.token!);
      out.push({
        call,
        kind: s.kind,
        recipient: s.recipient,
        amount: s.amount,
        token: s.token!,
        assetAllowed: t.allowed,
        recipientAllowed: await recipientOk(s.recipient),
        sessionMatch: false,
        usd: t.allowed ? quote(s.amount, t.usdPerToken, Number(t.decimals)) : 0n,
      });
    } else if (
      call.target.toLowerCase() === src.permitTarget.toLowerCase() &&
      call.data.toLowerCase().startsWith(REGISTER_PERMIT)
    ) {
      // An ERC-2612 pre-approval: the account debits the permit's value from the daily limit itself.
      const { args } = decodeFunctionData({ abi: accountAbi, data: call.data });
      const [tokenAddr, , value] = args as unknown as readonly [Address, Address, bigint, bigint];
      const t = await src.token(tokenAddr);
      out.push({
        call,
        kind: "permit-registration",
        recipient: tokenAddr,
        amount: value,
        token: tokenAddr,
        assetAllowed: t.allowed,
        recipientAllowed: true,
        sessionMatch: false,
        usd: t.allowed ? quote(value, t.usdPerToken, Number(t.decimals)) : 0n,
      });
    } else {
      const sessionMatch =
        state.deployed && call.data.length >= 10
          ? await src.sessionLive(call.target, call.data.slice(0, 10) as Hex)
          : false;
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

/** `Math.mulDiv(amount, usdPerToken, 10**decimals, Ceil)` (LeakedAccountBase._quote). */
export function quote(amount: bigint, usdPerToken: bigint, decimals: number): bigint {
  const d = 10n ** BigInt(decimals);
  return (amount * usdPerToken + d - 1n) / d;
}
