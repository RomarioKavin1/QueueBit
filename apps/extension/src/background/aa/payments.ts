import { parseGwei, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint08Abi } from "viem/account-abstraction";
import { policyHookAbi } from "../../generated/contracts";
import { findNetwork, type AaDeployment, type Network } from "../../shared/chains";
import type { SetupState } from "../../shared/types";
import type { AccountStatus } from "../../shared/views";
import { payerConflict, type AccountPlan, type AccountPlans, type TokenInit } from "../account";
import {
  ethAmount,
  feeAmount,
  intentTitle,
  pendingSteps,
  type ActivityCall,
  type ActivityEntry,
  type ActivityStore,
} from "../activity";
import type { KeyringController } from "../keyring";
import { classifyCalls, type AccountChainState, type TokenFacts } from "../policy";
import { decideRoute, usdNumber, type Call, type RouteDecision, type SimulationVerdict } from "../routing";
import {
  AA_ACTIVATION_GAS,
  aaActivationCalldata,
  aaInitFor,
  aaPlanInit,
  aaSalt,
  buildAaPlan,
  bootstrapInitCode,
  predictAaAccount,
} from "./config";
import type { BundlerClient } from "./userop";
import {
  BundlerError,
  decodeRevert,
  executeCalldata,
  maxPrefund,
  revertData,
  serializeOp,
  userOpHash,
  validatorNonceKey,
  handleOpsCalldata,
  type Op,
  type UserOpReceipt,
} from "./userop";

/**
 * Everyday payments on the 4337 backend (plan §30 §3.2 column U): the same routing rules as the native account, read
 * from LeakedPolicyHook; an ERC-4337 v0.8 user operation signed by the everyday key, gas estimated by the bundler,
 * the exact signed bytes simulated (`eth_call handleOps` + the account's `execute` from the EntryPoint) and only then
 * sent with `eth_sendUserOperation`. The account pays its own network fee from its balance, bounded by the hook's
 * `maxFeeWei` (the native account's fee tank plays that role there); the fee tank only relays Vault approvals.
 */

export interface AaIo {
  publicClient(chainId: number): PublicClient;
  sendRawTransaction(chainId: number, raw: Hex): Promise<Hex>;
  bundler(chainId: number): BundlerClient;
}

export interface AaDeps {
  io: AaIo;
  keyring: KeyringController;
  plans: AccountPlans;
  activity: ActivityStore;
  getLimits(): Promise<SetupState>;
  now: () => number;
  /** The tokens to freeze into the account (checked on-chain), from the onboarding choice. */
  tokens(client: PublicClient, setup: SetupState, chainId: number): Promise<TokenInit[]>;
}

export class AaError extends Error {
  constructor(
    readonly reason:
      "unsupported" | "no-vault" | "no-plan" | "frozen" | "tank-low" | "not-pending" | "account-low" | "payer-conflict",
    message: string,
  ) {
    super(message);
    this.name = "AaError";
  }
}

export interface AaPrepared {
  op: Op;
  hash: Hex;
  verdict: SimulationVerdict;
  /** Expected fee (wei) and the worst case the account may be charged (the prefund). */
  feeWei: bigint;
  maxCostWei: bigint;
}

const ETH: Address = "0x0000000000000000000000000000000000000000";
const GWEI = 1_000_000_000n;

export const aaNetwork = (chainId: number): (Network & { aa: AaDeployment; bundlerUrl: string }) | undefined => {
  const n = findNetwork(chainId);
  return n?.backend === "4337" && n.aa && n.bundlerUrl ? (n as never) : undefined;
};

export class AaPayments {
  constructor(private readonly d: AaDeps) {}

  private net(chainId: number) {
    const n = aaNetwork(chainId);
    if (!n) {
      throw new AaError(
        "unsupported",
        `LEAKED's compatible-account contracts aren't on ${findNetwork(chainId)?.name ?? "this network"} yet.`,
      );
    }
    return n;
  }

  // ---- the account ----

  async computePlan(chainId: number): Promise<AccountPlan> {
    const net = this.net(chainId);
    const accounts = await this.d.keyring.accounts();
    if (!accounts) throw new AaError("unsupported", "No account yet.");
    const setup = await this.d.getLimits();
    if (!setup.vault) throw new AaError("no-vault", "Pair your Vault first: the account address depends on it.");
    const recovery = setup.recovery?.testedAt ? setup.recovery : undefined;
    const conflict = payerConflict({
      hotKey: accounts.everyday,
      tank: accounts.feeTank,
      ...(setup.vault.payer ? { vaultPayer: setup.vault.payer } : {}),
      ...(recovery?.payer ? { recoveryPayer: recovery.payer } : {}),
    });
    if (conflict) throw new AaError("payer-conflict", conflict);
    const client = this.d.io.publicClient(chainId);
    const tokens = await this.d.tokens(client, setup, chainId);
    const init = aaInitFor({
      hotKey: accounts.everyday,
      tank: accounts.feeTank,
      dep: net.aa,
      vault: setup.vault,
      ...(recovery ? { recovery } : {}),
      dailyLimitUsd: setup.dailyLimitUsd,
      perPaymentUsd: setup.perPaymentUsd,
      recipientMode: setup.recipientMode ?? "open",
      tokens,
    });
    const salt = aaSalt(accounts.everyday, setup.vault.pk, recovery?.pk, chainId);
    const address = await predictAaAccount(client, net.aa, salt, bootstrapInitCode(net.aa, init));
    const existing = await this.d.plans.get(chainId);
    if (existing && existing.address === address) return existing;
    if (existing) {
      const [code, bal] = await Promise.all([
        client.getCode({ address: existing.address }),
        client.getBalance({ address: existing.address }),
      ]);
      if (existing.activation || (code && code !== "0x") || bal > 0n) {
        throw new AaError(
          "frozen",
          "Your account address is already in use, so its setup can't change any more. Change limits from Limits instead.",
        );
      }
    }
    const plan = buildAaPlan(chainId, net.aa, init, salt, address, this.d.now());
    await this.d.plans.put(plan);
    return plan;
  }

  private async deployed(client: PublicClient, a: Address): Promise<boolean> {
    const code = await client.getCode({ address: a });
    return code !== undefined && code !== "0x";
  }

  /** The hook's view of the account (or, before activation, what the init code will install). */
  async state(plan: AccountPlan): Promise<AccountChainState> {
    const net = this.net(plan.chainId);
    const client = this.d.io.publicClient(plan.chainId);
    const init = aaPlanInit(plan);
    const tank = (await this.d.keyring.accounts())?.feeTank ?? ETH;
    if (!(await this.deployed(client, plan.address))) {
      return {
        deployed: false,
        policy: {
          deployed: false,
          frozen: false,
          bunker: false,
          capUsd: init.hook.capUsdPerDay,
          availableUsd: init.hook.capUsdPerDay,
          perTxMaxUsd: init.hook.perTxMaxUsd,
        },
        ethUsdPrice: init.hook.ethUsdPrice,
        maxFeeWeiPerTx: init.hook.maxFeeWei,
        maxPriorityFeePerGas: init.hook.maxPriorityFeePerGas,
        hotKey: init.hook.hotKey,
        tank,
        recipientMode: init.hook.recipientMode === 1 ? "strict" : "open",
      };
    }
    const read = <T>(functionName: string, args: readonly unknown[] = []) =>
      client.readContract({
        address: net.aa.hook,
        abi: policyHookAbi,
        functionName,
        args: [plan.address, ...args],
      } as never) as Promise<T>;
    const [hot, bucket, freeze, eth, mode] = await Promise.all([
      read<{ hotKey: Address; perTxMaxUsd: bigint; maxFeeWei: bigint; maxPriorityFeePerGas: bigint }>("hotView"),
      read<readonly [bigint, number, bigint]>("getBucket"),
      read<readonly [boolean, number, boolean]>("getFreeze"),
      read<TokenFacts>("getToken", [ETH]),
      read<number>("recipientMode"),
    ]);
    const [available, , cap] = bucket;
    const [frozen, until, bunker] = freeze;
    return {
      deployed: true,
      policy: {
        deployed: true,
        frozen,
        bunker,
        ...(frozen ? { frozenUntil: Number(until) } : {}),
        capUsd: cap,
        availableUsd: available,
        perTxMaxUsd: hot.perTxMaxUsd,
      },
      ethUsdPrice: eth.allowed ? eth.usdPerToken : 0n,
      maxFeeWeiPerTx: hot.maxFeeWei,
      maxPriorityFeePerGas: hot.maxPriorityFeePerGas,
      hotKey: hot.hotKey,
      tank,
      recipientMode: Number(mode) === 0 ? "open" : "strict",
      ...(frozen ? { frozenUntil: Number(until) } : {}),
    };
  }

  classify(plan: AccountPlan, state: AccountChainState, calls: Call[]) {
    const net = this.net(plan.chainId);
    const client = this.d.io.publicClient(plan.chainId);
    const init = aaPlanInit(plan);
    const read = <T>(functionName: string, args: readonly unknown[]) =>
      client.readContract({
        address: net.aa.hook,
        abi: policyHookAbi,
        functionName,
        args: [plan.address, ...args],
      } as never) as Promise<T>;
    return classifyCalls(
      {
        account: plan.address,
        permitTarget: net.aa.hook,
        state,
        isTarget: (a) =>
          state.deployed
            ? read<boolean>("isTarget", [a])
            : Promise.resolve(init.hook.targets.some((t) => t.toLowerCase() === a.toLowerCase())),
        token: async (t) => {
          if (state.deployed) return read<TokenFacts>("getToken", [t]);
          const x = init.hook.tokens.find((y) => y.token.toLowerCase() === t.toLowerCase());
          return x
            ? { allowed: true, decimals: x.decimals, usdPerToken: x.usdPerToken }
            : { allowed: false, decimals: 18, usdPerToken: 0n };
        },
        sessionLive: async (target, selector) => {
          const s = await read<{ allowanceUsd: bigint; expiry: number }>("getSession", [target, selector]);
          return Number(s.expiry) * 1000 > Date.now();
        },
      },
      calls,
    );
  }

  private async gasPrice(chainId: number): Promise<bigint> {
    const gp = await this.d.io.publicClient(chainId).getGasPrice();
    const min = parseGwei("1");
    return gp * 2n > min ? gp * 2n : min;
  }

  async status(chainId: number, base: AccountStatus, plan: AccountPlan): Promise<AccountStatus> {
    const state = await this.state(plan);
    base.deployed = state.deployed;
    base.limits = {
      capUsd: usdNumber(state.policy.capUsd),
      perTxMaxUsd: usdNumber(state.policy.perTxMaxUsd),
      availableUsd: usdNumber(state.policy.availableUsd),
    };
    base.frozen = state.policy.frozen;
    base.bunker = state.policy.bunker;
    base.recipientMode = state.recipientMode;
    if (state.frozenUntil) base.frozenUntil = state.frozenUntil;
    base.ethUsdPrice = usdNumber(state.ethUsdPrice);
    base.backend = "4337";
    delete base.vaultSigner;
    if (!state.deployed) base.activationCostWei = (AA_ACTIVATION_GAS * (await this.gasPrice(chainId))).toString();
    return base;
  }

  /** `MSAFactory.createAccount(salt, initCode)` from the fee tank: the account and its three modules, one transaction. */
  async activate(chainId: number): Promise<ActivityEntry> {
    const plan = await this.d.plans.get(chainId);
    if (!plan) throw new AaError("no-plan", "Finish setting up LEAKED first: pair your Vault and choose your limits.");
    const client = this.d.io.publicClient(chainId);
    if (await this.deployed(client, plan.address)) throw new AaError("not-pending", "Your account is already active.");
    const accounts = (await this.d.keyring.accounts())!;
    const data = aaActivationCalldata(plan);
    const gasPrice = await this.gasPrice(chainId);
    const tankWei = await client.getBalance({ address: accounts.feeTank });
    if (tankWei < AA_ACTIVATION_GAS * gasPrice) {
      throw new AaError(
        "tank-low",
        `Your fee tank needs at least ${ethAmount(AA_ACTIVATION_GAS * gasPrice)} to pay for activation.`,
      );
    }
    await client.call({ account: accounts.feeTank, to: plan.factory, data, gas: AA_ACTIVATION_GAS });
    const nonce = await client.getTransactionCount({ address: accounts.feeTank, blockTag: "pending" });
    const raw = await this.d.keyring.withHotKeys((k) =>
      privateKeyToAccount(k.feeTank).signTransaction({
        type: "legacy",
        chainId,
        nonce,
        gasPrice,
        gas: AA_ACTIVATION_GAS,
        to: plan.factory,
        data,
        value: 0n,
      }),
    );
    const hash = await this.d.io.sendRawTransaction(chainId, raw);
    const now = this.d.now();
    await this.d.plans.put({ ...plan, activation: { txHash: hash, sentAt: now } });
    const entry: ActivityEntry = {
      id: crypto.randomUUID(),
      chainId,
      kind: "activation",
      account: plan.address,
      tank: accounts.feeTank,
      calls: [],
      declaredUsd: "0",
      rules: [],
      status: "confirming",
      hash,
      replaced: [],
      nonce: nonce.toString(),
      headline: "Activating your account",
      detail: "Creates your account with your limits and installs LEAKED's modules. Paid by your fee tank.",
      steps: [{ label: "Create account with your limits and your Vault", status: "pending" }],
      backend: "4337",
      createdAt: now,
      updatedAt: now,
    };
    await this.d.activity.add(entry);
    return entry;
  }

  // ---- user operations ----

  /** Builds, estimates, signs and simulates the exact op. Never throws for a policy refusal: the verdict says why. */
  async prepare(plan: AccountPlan, state: AccountChainState, calls: Call[]): Promise<AaPrepared> {
    const net = this.net(plan.chainId);
    const client = this.d.io.publicClient(plan.chainId);
    const callData = executeCalldata(calls);
    const fail = (reason: string, admitted = true): AaPrepared["verdict"] => ({ admitted, bodyOk: false, reason });
    const nonce = (await client.readContract({
      address: net.aa.entryPoint,
      abi: entryPoint08Abi,
      functionName: "getNonce",
      args: [plan.address, validatorNonceKey(net.aa.validator)],
    })) as bigint;
    const baseFee = (await client.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n;
    const prio = state.maxPriorityFeePerGas < GWEI ? state.maxPriorityFeePerGas : GWEI;
    let op: Op = {
      sender: plan.address,
      nonce,
      callData,
      callGasLimit: 0n,
      verificationGasLimit: 0n,
      preVerificationGas: 0n,
      maxFeePerGas: 2n * baseFee + prio,
      maxPriorityFeePerGas: prio,
      signature: "0x",
    };
    // 1. The account's own execution (hook preCheck/postCheck included), as the EntryPoint calls it.
    let verdict: SimulationVerdict = { admitted: true, bodyOk: true };
    try {
      await client.call({ account: net.aa.entryPoint, to: plan.address, data: callData });
    } catch (e) {
      verdict = fail(decodeRevert(revertData(e)) ?? "the account refused it");
    }
    // 2. Gas from the bundler.
    try {
      const g = await this.d.io.bundler(plan.chainId).estimate(op, net.aa.entryPoint);
      op = { ...op, ...g };
    } catch (e) {
      const reason = e instanceof BundlerError ? (decodeRevert(e.data) ?? e.message) : (e as Error).message;
      return { op, hash: "0x", verdict: verdict.bodyOk ? fail(reason) : verdict, feeWei: 0n, maxCostWei: 0n };
    }
    if (maxPrefund(op) > state.maxFeeWeiPerTx) {
      return {
        op,
        hash: "0x",
        verdict: fail("Network fees are above what your account allows per payment right now.", false),
        feeWei: 0n,
        maxCostWei: maxPrefund(op),
      };
    }
    // 3. Sign the exact op, then simulate those bytes through the EntryPoint (validation: AA2x/AA3x, the policy).
    const hash = userOpHash(op, plan.chainId, net.aa.entryPoint);
    const signature = await this.d.keyring.withHotKeys((k) => privateKeyToAccount(k.everyday).sign({ hash }));
    op = { ...op, signature };
    const tank = (await this.d.keyring.accounts())!.feeTank;
    try {
      await client.call({ account: tank, to: net.aa.entryPoint, data: handleOpsCalldata(op, tank) });
    } catch (e) {
      verdict = {
        admitted: false,
        bodyOk: verdict.bodyOk,
        reason: decodeRevert(revertData(e)) ?? "the EntryPoint refused it",
      };
    }
    const feeWei = (op.callGasLimit + op.verificationGasLimit / 2n + op.preVerificationGas) * (baseFee + prio);
    return { op, hash, verdict, feeWei, maxCostWei: maxPrefund(op) };
  }

  async evaluate(plan: AccountPlan, calls: Call[]) {
    const state = await this.state(plan);
    const classified = await this.classify(plan, state, calls);
    let decision: RouteDecision = decideRoute(state.policy, classified);
    let prepared: AaPrepared | undefined;
    if (decision.route === "hot") {
      prepared = await this.prepare(plan, state, calls);
      decision = decideRoute(state.policy, classified, prepared.verdict);
    }
    return { state, decision, prepared };
  }

  async accountBalance(plan: AccountPlan): Promise<bigint> {
    return this.d.io.publicClient(plan.chainId).getBalance({ address: plan.address });
  }

  /** Sends a prepared op (cleared by the router). A bundler hash that differs from ours is recorded, not trusted. */
  async submit(
    plan: AccountPlan,
    state: AccountChainState,
    decision: RouteDecision,
    p: AaPrepared,
    calls: Call[],
    meta: { origin?: string; batchId?: string },
    labels: Parameters<typeof intentTitle>[1],
  ): Promise<ActivityEntry> {
    const net = this.net(plan.chainId);
    if ((await this.accountBalance(plan)) < p.maxCostWei) {
      throw new AaError(
        "account-low",
        `Your account needs at least ${ethAmount(p.maxCostWei)} for this payment's network fee. Everyday fees come from your account's own balance on this network.`,
      );
    }
    const returned = await this.d.io.bundler(plan.chainId).send(p.op, net.aa.entryPoint);
    const now = this.d.now();
    const acalls: ActivityCall[] = calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data }));
    const mismatch = returned.toLowerCase() !== p.hash.toLowerCase();
    const entry: ActivityEntry = {
      id: crypto.randomUUID(),
      chainId: plan.chainId,
      kind: "payment",
      ...(meta.origin ? { origin: meta.origin } : {}),
      ...(meta.batchId ? { batchId: meta.batchId } : {}),
      account: plan.address,
      tank: state.tank,
      calls: acalls,
      declaredUsd: decision.amountUsd.toString(),
      rules: decision.rules,
      status: "confirming",
      hash: p.hash,
      replaced: mismatch ? [returned] : [],
      nonce: p.op.nonce.toString(),
      backend: "4337",
      userOp: serializeOp(p.op),
      fees: { maxFeePerGas: p.op.maxFeePerGas.toString(), maxPriorityFeePerGas: p.op.maxPriorityFeePerGas.toString() },
      headline: `Sending ${intentTitle(acalls, labels)}`,
      detail: mismatch
        ? "Sent, but the bundler answered with a different id than LEAKED computed; LEAKED tracks both."
        : `Network fee about ${feeAmount(p.feeWei)} from your account.`,
      steps: pendingSteps(acalls),
      feeWei: p.feeWei.toString(),
      createdAt: now,
      updatedAt: now,
    };
    await this.d.activity.add(entry);
    return entry;
  }

  /** Poll one pending 4337 payment (the userOp receipt from the bundler). */
  async refreshOne(
    e: ActivityEntry,
    labels: Parameters<typeof intentTitle>[1],
  ): Promise<Partial<ActivityEntry> | undefined> {
    const bundler = this.d.io.bundler(e.chainId);
    let r: UserOpReceipt | null = null;
    for (const h of [e.hash, ...e.replaced]) {
      r = await bundler.receipt(h).catch(() => null);
      if (r) break;
    }
    if (!r) return undefined;
    const fee = BigInt(r.actualGasCost);
    const steps = pendingSteps(e.calls).map((s, i) => ({
      ...s,
      status: i < 2 ? ("done" as const) : r!.success ? ("done" as const) : ("failed" as const),
    }));
    const common = {
      txHash: r.receipt.transactionHash,
      blockNumber: BigInt(r.receipt.blockNumber).toString(),
      feeWei: fee.toString(),
      steps,
      stuck: false,
    };
    if (r.success) {
      return {
        ...common,
        status: "confirmed",
        headline: `Paid ${intentTitle(e.calls, labels)}`,
        detail: `Your account paid ${feeAmount(fee)} in network fees.`,
      };
    }
    const why = decodeRevert(r.reason ?? undefined) ?? "";
    const overLimit = /OverCap|OverDailyCap|VaultOverDailyThreshold/u.test(why);
    return {
      ...common,
      status: "failed",
      headline: overLimit
        ? `Blocked: over your daily limit, nothing was sent; your account paid ${feeAmount(fee)}`
        : `Failed: your account refused this payment, nothing was sent; your account paid ${feeAmount(fee)}`,
      detail: overLimit
        ? "Your daily limit changed before this payment was included. Your limit was refreshed."
        : `The account's policy refused it${why ? ` (${why})` : ""}.`,
    };
  }
}
