import { erc20Abi, parseGwei, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fromWire, signTx, type FrameTxReceipt, type Profile } from "@queuebit/frames";
import type { LeanPoolClient, NodeClient, SidecarClient } from "@queuebit/rpc";
import { submitStandardLane } from "./submit";
import { findNetwork, type Network } from "../shared/chains";
import type { AccountStatus, RouteView, SendPreview } from "../shared/views";
import type { AccountPlans } from "./account";
import {
  ACTIVATION_GAS,
  CLONE_GAS,
  VAULT_SIGNER_FLOAT,
  ZERO,
  accountSalt,
  activationCalldata,
  buildPlan,
  createRoleSignerCalldata,
  initConfigFor,
  initTokens,
  payerConflict,
  roleSalt,
  type AccountPlan,
  type TokenInit,
} from "./account";
import { roleSignerFactoryAbi } from "../generated/contracts";
import type { SetupState } from "../shared/types";
import type { ActivityStore } from "./activity";
import {
  describeReceipt,
  ethAmount,
  intentTitle,
  pendingSteps,
  type ActivityCall,
  type ActivityEntry,
  type Labels,
} from "./activity";
import { bumpFees, FrameEngine, type EngineRpc } from "./engine";
import type { KeyringController } from "./keyring";
import { PolicyReader, type AccountChainState } from "./policy";
import { decideRoute, routeCopy, usdNumber, type Call, type RouteDecision } from "./routing";
import {
  PQ_FALLBACK_REASONS,
  PQ_MIN_BALANCE,
  PqEverydayError,
  describePq,
  type PqEveryday,
  type PqEverydayRecord,
  type PqEverydayState,
} from "./leanpool";
import { AaError, AaPayments, aaNetwork } from "./aa/payments";
import { BundlerClient } from "./aa/userop";

export interface ChainIo {
  publicClient(chainId: number): PublicClient;
  node(chainId: number): NodeClient;
  /** A sidecar client by URL (devnets that take standard-lane transactions through their sidecar). */
  sidecar?(url: string): SidecarClient;
  /** 4337 backend: the chain's bundler (defaults to the network's `bundlerUrl`). */
  bundler?(chainId: number): BundlerClient;
  /** A LeanPool node client by URL (defaults to JSON-RPC over HTTP). */
  leanpool?(url: string): LeanPoolClient;
}

export interface PaymentsDeps {
  io: ChainIo;
  keyring: KeyringController;
  plans: AccountPlans;
  activity: ActivityStore;
  getLimits(): Promise<SetupState>;
  now: () => number;
  /** The post-quantum everyday key (LeanPool), when this build has it. */
  pq?: PqEveryday;
}

/**
 * The chosen tokens for `chainId`, checked against the chain before they are frozen into the address: each must be a
 * contract whose `decimals()` matches what the user saw (a wrong decimals would misprice every payment).
 */
export async function checkedInitTokens(
  client: PublicClient,
  setup: SetupState,
  chainId: number,
): Promise<TokenInit[]> {
  const list = initTokens(setup.tokens?.[String(chainId)] ?? []);
  for (const t of list) {
    const d = await client
      .readContract({ address: t.token, abi: erc20Abi, functionName: "decimals" })
      .catch(() => undefined);
    if (d === undefined || Number(d) !== t.decimals) {
      throw new PaymentsError(
        "bad-token",
        `The token ${t.token.slice(0, 6)}…${t.token.slice(-4)} isn't what QueueBit expected on this network (its decimals don't match). Remove it from "Tokens you'll spend".`,
      );
    }
  }
  return list;
}

/** A request the routing engine did not clear for the everyday key; carries the copy for the UI and the dapp. */
export class RouteError extends Error {
  constructor(
    readonly decision: RouteDecision,
    readonly view: RouteView,
  ) {
    super(view.copy.detail);
    this.name = "RouteError";
  }
}

export class PaymentsError extends Error {
  constructor(
    readonly reason:
      | "unsupported"
      | "tank-low"
      | "not-activated"
      | "not-admitted"
      | "unknown-entry"
      | "not-pending"
      | "no-vault"
      | "no-plan"
      | "bad-token"
      | "payer-conflict"
      | "frozen"
      | "no-account"
      | "no-recovery"
      | "bad-amount"
      | "top-up-failed"
      | "pq-fee-low"
      | "pq-refused",
    message: string,
  ) {
    super(message);
    this.name = "PaymentsError";
  }
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const toCalls = (calls: ActivityCall[]): Call[] =>
  calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }));
const toActivityCalls = (calls: Call[]): ActivityCall[] =>
  calls.map((c) => ({ target: c.target, value: c.value.toString(), data: c.data }));

export function routeView(decision: RouteDecision, state: AccountChainState): RouteView {
  return {
    route: decision.route,
    rules: decision.rules,
    amountUsd: usdNumber(decision.amountUsd),
    ...(decision.leftAfterUsd !== undefined ? { leftAfterUsd: usdNumber(decision.leftAfterUsd) } : {}),
    copy: routeCopy(decision, state.policy, short),
    ...(decision.simulationReason ? { simulationReason: decision.simulationReason } : {}),
  };
}

/**
 * Everyday payments on the frame backend: the account (counterfactual address, activation), the routing check and
 * the FrameEngine, and activity tracking. One queue per wallet so two sends never race for a nonce.
 */
export class Payments {
  private readonly engines = new Map<number, FrameEngine>();
  private readonly policies = new Map<number, PolicyReader>();
  private queue: Promise<unknown> = Promise.resolve();
  /** The 4337 backend (chains whose network entry says `backend: "4337"`). */
  readonly aa: AaPayments;
  private readonly bundlers = new Map<number, BundlerClient>();

  constructor(private readonly d: PaymentsDeps) {
    this.aa = new AaPayments({
      io: {
        publicClient: (c) => d.io.publicClient(c),
        sendRawTransaction: (c, raw) => d.io.publicClient(c).sendRawTransaction({ serializedTransaction: raw }),
        bundler: (c) => this.bundler(c),
      },
      keyring: d.keyring,
      plans: d.plans,
      activity: d.activity,
      getLimits: d.getLimits,
      now: d.now,
      tokens: (client, setup, chainId) => checkedInitTokens(client, setup, chainId),
    });
  }

  bundler(chainId: number): BundlerClient {
    const custom = this.d.io.bundler?.(chainId);
    if (custom) return custom;
    let b = this.bundlers.get(chainId);
    if (!b) {
      const url = aaNetwork(chainId)?.bundlerUrl;
      if (!url) throw new PaymentsError("unsupported", "This network has no bundler.");
      b = new BundlerClient(url);
      this.bundlers.set(chainId, b);
    }
    return b;
  }

  /** Runs `fn`, turning a 4337-backend error into the PaymentsError the UI and the router already handle. */
  private async aaCall<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof AaError) {
        const reason = e.reason === "account-low" ? "tank-low" : e.reason;
        throw new PaymentsError(reason as PaymentsError["reason"], e.message);
      }
      throw e;
    }
  }

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private policy(chainId: number): PolicyReader {
    let p = this.policies.get(chainId);
    if (!p) {
      p = new PolicyReader(() => this.d.io.publicClient(chainId));
      this.policies.set(chainId, p);
    }
    return p;
  }

  engine(chainId: number): FrameEngine {
    let e = this.engines.get(chainId);
    if (!e) {
      const node = this.d.io.node(chainId);
      const client = this.d.io.publicClient(chainId);
      const rpc: EngineRpc = {
        getTransactionCount: (a, tag) => node.getTransactionCount(a, tag),
        baseFee: async () => (await client.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n,
        simulate: (raw) => node.simulateFrameTransaction(raw),
        sendRawTransaction: (raw, tx, hash) =>
          tx && hash
            ? submitStandardLane({
                net: findNetwork(chainId)!,
                raw,
                tx,
                expectedHash: hash,
                node,
                sidecar: this.d.io.sidecar?.bind(this.d.io),
              })
            : node.sendRawTransaction(raw),
        getTransactionReceipt: (h) => node.getTransactionReceipt(h),
      };
      e = new FrameEngine(rpc, (profile, tx) => this.signHot(profile, tx));
      this.engines.set(chainId, e);
    }
    return e;
  }

  private signHot(profile: Profile, tx: Parameters<typeof signTx>[1]) {
    return this.d.keyring.withHotKeys(async (k) =>
      signTx(profile, await signTx(profile, tx, k.everyday, 0), k.feeTank, 1),
    );
  }

  /** The frame network with QueueBit account contracts, or an explanation. */
  private network(chainId: number): Network & { deployment: NonNullable<Network["deployment"]> } {
    const net = findNetwork(chainId);
    if (!net || net.backend !== "frame" || !net.profileId) {
      throw new PaymentsError("unsupported", "Payments on this network arrive with the compatible-account update.");
    }
    if (!net.deployment) {
      throw new PaymentsError(
        "unsupported",
        `QueueBit's account contracts aren't on ${net.name} yet, so the account can't be activated there.`,
      );
    }
    return net as Network & { deployment: NonNullable<Network["deployment"]> };
  }

  /**
   * The account plan for `chainId`, or undefined before onboarding computed it. The plan is computed exactly once, at
   * the end of onboarding (`computePlan`), after the Vault is paired and the limits are chosen: nothing reads the
   * limits before that, so the address can never be frozen with stale limits (M1 review "plan frozen on first
   * account:status").
   */
  async plan(chainId: number): Promise<AccountPlan | undefined> {
    return this.d.plans.get(chainId);
  }

  /**
   * Computes (or, while nothing depends on it yet, recomputes) the counterfactual account from the paired Vault, the
   * optional Recovery key and the chosen limits. The Vault and Recovery signer addresses come from the factory's own
   * `predictRoleSigner` (what `initialize` derives). Refuses to move an address that may already hold money or is
   * being activated.
   */
  async computePlan(chainId: number): Promise<AccountPlan> {
    if (aaNetwork(chainId) || findNetwork(chainId)?.backend === "4337")
      return this.aaCall(() => this.aa.computePlan(chainId));
    const net = this.network(chainId);
    const accounts = await this.d.keyring.accounts();
    if (!accounts) throw new PaymentsError("unsupported", "No account yet.");
    const setup = await this.d.getLimits();
    if (!setup.vault) throw new PaymentsError("no-vault", "Pair your Vault first: the account address depends on it.");
    const existing = await this.d.plans.get(chainId);
    // Only a Recovery key whose recovery-test code verified is bound into the account (ux-spec §3.1.4: the ceremony
    // ends with the test). A key that was scanned but never tested stays out, exactly as the Done screen says.
    const recovery = setup.recovery?.testedAt ? setup.recovery : undefined;
    const salt = accountSalt(accounts.everyday, setup.vault.pk, recovery?.pk, chainId);
    const rsalt = roleSalt(salt);
    // initialize refuses these (BadAddress): say why before an address is shown.
    const conflict = payerConflict({
      hotKey: accounts.everyday,
      tank: accounts.feeTank,
      ...(setup.vault.payer ? { vaultPayer: setup.vault.payer } : {}),
      ...(recovery?.payer ? { recoveryPayer: recovery.payer } : {}),
    });
    if (conflict) throw new PaymentsError("payer-conflict", conflict);
    const tokens = await checkedInitTokens(this.d.io.publicClient(chainId), setup, chainId);
    const config = initConfigFor({
      hotKey: accounts.everyday,
      tank: accounts.feeTank,
      deployment: net.deployment,
      vault: setup.vault,
      ...(recovery ? { recovery } : {}),
      salt: rsalt,
      dailyLimitUsd: setup.dailyLimitUsd,
      perPaymentUsd: setup.perPaymentUsd,
      recipientMode: setup.recipientMode ?? "open",
      tokens,
    });
    const draft = buildPlan(chainId, net.deployment, config, { vaultSigner: ZERO }, salt, this.d.now());
    if (existing && existing.address === draft.address) return existing;
    if (existing) {
      const client = this.d.io.publicClient(chainId);
      const [code, bal] = await Promise.all([
        client.getCode({ address: existing.address }),
        client.getBalance({ address: existing.address }),
      ]);
      if (existing.activation || (code && code !== "0x") || bal > 0n) {
        throw new PaymentsError(
          "frozen",
          "Your account address is already in use, so its setup can't change any more. Change limits from Limits instead.",
        );
      }
    }
    const client = this.d.io.publicClient(chainId);
    const predict = (role: 1 | 2, p: { salt: Hex; pk: Hex; verifier: Address; payerKey: Address }) =>
      client.readContract({
        address: net.deployment.roleSignerFactory,
        abi: roleSignerFactoryAbi,
        functionName: "predictRoleSigner",
        args: [p.salt, role, draft.address, p.pk, p.verifier, p.payerKey],
      }) as Promise<Address>;
    const vaultSigner = await predict(1, config.vault);
    const recoverySigner = recovery ? await predict(2, config.recovery) : undefined;
    const plan = buildPlan(
      chainId,
      net.deployment,
      config,
      { vaultSigner, ...(recoverySigner ? { recoverySigner } : {}) },
      salt,
      this.d.now(),
    );
    await this.d.plans.put(plan);
    return plan;
  }

  private async requirePlan(chainId: number): Promise<AccountPlan> {
    if (findNetwork(chainId)?.backend === "4337") {
      if (!aaNetwork(chainId)) {
        throw new PaymentsError(
          "unsupported",
          `QueueBit's compatible-account contracts aren't on ${findNetwork(chainId)!.name} yet.`,
        );
      }
    } else this.network(chainId);
    const plan = await this.plan(chainId);
    if (!plan)
      throw new PaymentsError("no-plan", "Finish setting up QueueBit first: pair your Vault and choose your limits.");
    return plan;
  }

  private async activationGasPrice(chainId: number): Promise<bigint> {
    const gp = await this.d.io.publicClient(chainId).getGasPrice();
    const min = parseGwei("1");
    return gp * 2n > min ? gp * 2n : min;
  }

  async status(chainId: number): Promise<AccountStatus> {
    const accounts = await this.d.keyring.accounts();
    if (!accounts) throw new PaymentsError("unsupported", "No account yet.");
    const net = findNetwork(chainId);
    let plan: AccountPlan | undefined;
    let unsupportedReason: string | undefined;
    try {
      plan = await this.requirePlan(chainId);
    } catch (e) {
      unsupportedReason = (e as Error).message;
    }
    const base: AccountStatus = {
      chainId,
      supported: plan !== undefined,
      ...(unsupportedReason ? { unsupportedReason } : {}),
      address: plan?.address ?? accounts.everyday,
      deployed: false,
      ...(plan?.activation ? { activation: plan.activation } : {}),
      tank: accounts.feeTank,
      tankWei: "0",
      accountWei: "0",
      activationCostWei: "0",
      limits: { capUsd: 0, perTxMaxUsd: 0, availableUsd: 0 },
      frozen: false,
      bunker: false,
      vault: plan ? "paired" : "none",
      ...(plan ? { vaultSigner: plan.vaultSigner } : {}),
      ...(plan?.recoverySigner ? { recoverySigner: plan.recoverySigner } : {}),
      recipientMode: "open",
      ethUsdPrice: 0,
      readAt: this.d.now(),
    };
    if (!net) return base;
    try {
      const client = this.d.io.publicClient(chainId);
      const [tankWei, accountWei] = await Promise.all([
        client.getBalance({ address: accounts.feeTank }),
        client.getBalance({ address: base.address }),
      ]);
      base.tankWei = tankWei.toString();
      base.accountWei = accountWei.toString();
      if (!plan) return base;
      if (plan.backend === "4337") return await this.aa.status(chainId, base, plan);
      const state = await this.policy(chainId).state(plan);
      base.deployed = state.deployed;
      base.limits = {
        capUsd: usdNumber(state.policy.capUsd),
        perTxMaxUsd: usdNumber(state.policy.perTxMaxUsd),
        availableUsd: usdNumber(state.policy.availableUsd),
        ...(state.fullAt ? { fullAt: state.fullAt } : {}),
      };
      base.frozen = state.policy.frozen;
      base.bunker = state.policy.bunker;
      base.recipientMode = state.recipientMode;
      if (state.frozenUntil) base.frozenUntil = state.frozenUntil;
      base.ethUsdPrice = usdNumber(state.ethUsdPrice);
      if (!state.deployed) {
        const gp = await this.activationGasPrice(chainId);
        base.activationCostWei = ((ACTIVATION_GAS + CLONE_GAS) * gp + VAULT_SIGNER_FLOAT).toString();
      }
    } catch (e) {
      base.error = "Can't reach the network right now. Showing the last known state.";
      void e;
    }
    return base;
  }

  /**
   * Deploys the account through the factory with its frozen init config: a legacy transaction from the fee-tank key
   * (the factory is permissionless and the init data is in the CREATE2 hash, so who sends it does not matter).
   */
  activate(chainId: number): Promise<ActivityEntry> {
    if (findNetwork(chainId)?.backend === "4337")
      return this.serialized(() => this.aaCall(() => this.aa.activate(chainId)));
    return this.serialized(async () => {
      const plan = await this.requirePlan(chainId);
      const client = this.d.io.publicClient(chainId);
      const accounts = (await this.d.keyring.accounts())!;
      const policy = this.policy(chainId);
      if (await policy.isDeployed(plan.address))
        throw new PaymentsError("not-pending", "Your account is already active.");
      const data = activationCalldata(plan);
      const gasPrice = await this.activationGasPrice(chainId);
      // Two plain transactions from the tank: the account (its address commits to the Vault's key), then the Vault
      // signer clone initialize derived, with a float it pays its own fees from (deployed now so the first Vault
      // approval needs no extra step; anyone may deploy it, IMPLEMENTATION-NOTES "Bound signers").
      const net = this.network(chainId);
      const signerCode = await client.getCode({ address: plan.vaultSigner });
      const needSigner = !signerCode || signerCode === "0x";
      const cost = ACTIVATION_GAS * gasPrice + (needSigner ? CLONE_GAS * gasPrice + VAULT_SIGNER_FLOAT : 0n);
      const tankWei = await client.getBalance({ address: accounts.feeTank });
      if (tankWei < cost) {
        throw new PaymentsError("tank-low", `Your fee tank needs at least ${ethAmount(cost)} to pay for activation.`);
      }
      // Simulate first: an eth_call of the exact call from the tank.
      await client.call({ account: accounts.feeTank, to: plan.factory, data, gas: ACTIVATION_GAS });
      const nonce = await client.getTransactionCount({ address: accounts.feeTank, blockTag: "pending" });
      const signerData = createRoleSignerCalldata(plan, "vault");
      const [raw, rawSigner] = await this.d.keyring.withHotKeys(async (k) => {
        const tank = privateKeyToAccount(k.feeTank);
        return Promise.all([
          tank.signTransaction({
            type: "legacy",
            chainId,
            nonce,
            gasPrice,
            gas: ACTIVATION_GAS,
            to: plan.factory,
            data,
            value: 0n,
          }),
          needSigner
            ? tank.signTransaction({
                type: "legacy",
                chainId,
                nonce: nonce + 1,
                gasPrice,
                gas: CLONE_GAS,
                to: net.deployment.roleSignerFactory,
                data: signerData,
                value: VAULT_SIGNER_FLOAT,
              })
            : Promise.resolve(undefined),
        ]);
      });
      const hash = await this.d.io.node(chainId).sendRawTransaction(raw);
      const vaultSignerTx = rawSigner ? await this.d.io.node(chainId).sendRawTransaction(rawSigner) : undefined;
      const now = this.d.now();
      await this.d.plans.put({
        ...plan,
        activation: { txHash: hash, sentAt: now, ...(vaultSignerTx ? { vaultSignerTx } : {}) },
      });
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
        detail: "Sets your daily limit and links your Vault on the network. Paid by your fee tank.",
        steps: [
          { label: "Create account with your limits", status: "pending" },
          { label: "Set up your Vault on the network", status: needSigner ? "pending" : "done" },
        ],
        createdAt: now,
        updatedAt: now,
      };
      await this.d.activity.add(entry);
      return entry;
    });
  }

  private labels(tank: Address): Labels {
    return { name: (a) => (a.toLowerCase() === tank.toLowerCase() ? "your fee tank" : undefined) };
  }

  /** Static check, then (only if it looks like an everyday payment) the signed-and-simulated transaction. */
  private async evaluate(chainId: number, calls: Call[]) {
    const net = this.network(chainId);
    const plan = await this.requirePlan(chainId);
    const state = await this.policy(chainId).state(plan);
    const classified = await this.policy(chainId).classify(plan, state, calls);
    let decision = decideRoute(state.policy, classified);
    let prepared: Awaited<ReturnType<FrameEngine["prepare"]>> | undefined;
    if (decision.route === "hot") {
      prepared = await this.engine(chainId).prepare({
        chainId,
        profileId: net.profileId!,
        account: plan.address,
        hotKey: state.hotKey,
        tank: state.tank,
        calls,
        declaredUsd: decision.amountUsd,
        maxPriorityFeePerGas: state.maxPriorityFeePerGas,
        maxFeeWeiPerTx: state.maxFeeWeiPerTx,
      });
      decision = decideRoute(state.policy, classified, prepared.verdict);
    }
    return { plan, state, decision, prepared };
  }

  private effects(calls: Call[], tank: Address): string[] {
    const labels = this.labels(tank);
    return calls.map((c) => {
      const who = labels.name?.(c.target) ? `${labels.name(c.target)} (${short(c.target)})` : short(c.target);
      if (c.data === "0x") return `Send ${ethAmount(c.value)} to ${who}`;
      return `Call ${who}${c.value > 0n ? ` with ${ethAmount(c.value)}` : ""} (data ${c.data.slice(0, 10)}…)`;
    });
  }

  async preview(chainId: number, calls: Call[]): Promise<SendPreview> {
    const plan = await this.requirePlan(chainId);
    if (plan.backend === "4337") {
      const { state, decision, prepared } = await this.aaCall(() => this.aa.evaluate(plan, calls));
      const bal = prepared ? await this.aa.accountBalance(plan) : 0n;
      return {
        chainId,
        backend: "4337",
        route: routeView(decision, state),
        ...(prepared && prepared.maxCostWei > 0n
          ? { feeWei: prepared.feeWei.toString(), maxCostWei: prepared.maxCostWei.toString() }
          : {}),
        effects: this.effects(calls, state.tank),
        ...(prepared && bal < prepared.maxCostWei + calls.reduce((a, c) => a + c.value, 0n)
          ? { tankTooLow: true }
          : {}),
        ethUsdPrice: usdNumber(state.ethUsdPrice),
      };
    }
    const { state, decision, prepared } = await this.evaluate(chainId, calls);
    const tankWei = await this.d.io.publicClient(chainId).getBalance({ address: state.tank });
    const pq = decision.route === "hot" ? await this.pqLane(chainId, plan) : undefined;
    return {
      chainId,
      route: routeView(decision, state),
      ...(prepared ? { feeWei: prepared.feeWei.toString(), maxCostWei: prepared.maxCostWei.toString() } : {}),
      effects: this.effects(calls, state.tank),
      ...(prepared && !pq?.record && tankWei < prepared.maxCostWei ? { tankTooLow: true } : {}),
      ...(pq ? { signingKey: pq.view } : {}),
      ethUsdPrice: usdNumber(state.ethUsdPrice),
    };
  }

  /** Sends an everyday payment. Refuses anything the router does not clear (RouteError) and never sends unsimulated. */
  send(
    chainId: number,
    calls: Call[],
    meta: { origin?: string; batchId?: string; forceEveryday?: boolean } = {},
  ): Promise<ActivityEntry> {
    if (findNetwork(chainId)?.backend === "4337") {
      return this.serialized(() =>
        this.aaCall(async () => {
          const plan = await this.requirePlan(chainId);
          const { state, decision, prepared } = await this.aa.evaluate(plan, calls);
          if (decision.route !== "hot" || !prepared) throw new RouteError(decision, routeView(decision, state));
          return this.aa.submit(plan, state, decision, prepared, calls, meta, this.labels(state.tank));
        }),
      );
    }
    return this.serialized(async () => {
      const { plan, state, decision, prepared } = await this.evaluate(chainId, calls);
      if (decision.route !== "hot" || !prepared) throw new RouteError(decision, routeView(decision, state));
      // The post-quantum everyday key, when it is installed, preferred, funded and its LeanPool node answers. The
      // payment was just checked as an everyday transaction (same body, same limits: `_hotExecute`); only the key and
      // the lane differ. If the node can't take it, the checked everyday transaction goes out instead, and says so.
      let fallbackNote: string | undefined;
      const pq = meta.forceEveryday ? undefined : await this.pqLane(chainId, plan);
      if (pq?.record) {
        try {
          return await this.sendPq(chainId, plan.address, state.tank, calls, decision, prepared, pq.record, meta);
        } catch (e) {
          // Only what failed before the node got the payment may go out with the everyday key (nothing to pay twice);
          // a refusal is the user's to see.
          if (!(e instanceof PqEverydayError) || !PQ_FALLBACK_REASONS.has(e.reason)) {
            throw new PaymentsError("pq-refused", (e as Error).message);
          }
          fallbackNote =
            e.reason === "node-down"
              ? "LeanPool isn't answering, so this payment used your regular everyday key."
              : e.message;
        }
      } else if (pq?.view.kind === "everyday") {
        fallbackNote = pq.view.fallback;
      }
      const tankWei = await this.d.io.publicClient(chainId).getBalance({ address: state.tank });
      if (tankWei < prepared.maxCostWei) {
        throw new PaymentsError("tank-low", "Your fee tank is empty. Everyday payments need it to pay network fees.");
      }
      const sentAtBlock = await this.d.io.publicClient(chainId).getBlockNumber();
      const hash = await this.engine(chainId).submit(prepared);
      const now = this.d.now();
      const acalls = toActivityCalls(calls);
      const entry: ActivityEntry = {
        id: crypto.randomUUID(),
        chainId,
        kind: "payment",
        ...(meta.origin ? { origin: meta.origin } : {}),
        ...(meta.batchId ? { batchId: meta.batchId } : {}),
        account: plan.address,
        tank: state.tank,
        calls: acalls,
        declaredUsd: decision.amountUsd.toString(),
        rules: decision.rules,
        status: "confirming",
        hash,
        replaced: [],
        nonce: prepared.nonce.toString(),
        wire: prepared.wire,
        fees: {
          maxFeePerGas: prepared.fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: prepared.fees.maxPriorityFeePerGas.toString(),
        },
        sentAtBlock: sentAtBlock.toString(),
        headline: `Sending ${intentTitle(acalls, this.labels(state.tank))}`,
        detail: `Network fee about ${ethAmount(prepared.feeWei)} from your fee tank.`,
        steps: pendingSteps(acalls),
        feeWei: prepared.feeWei.toString(),
        ...(fallbackNote ? { fallbackNote } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await this.d.activity.add(entry);
      return entry;
    });
  }

  // ------------------------------------------------------------------------- post-quantum everyday key ----

  /**
   * Whether the next everyday payment on `chainId` goes through the quantum-safe key: `record` when it does; else
   * `view.fallback` says why not (only when the user turned it on), so the preview and the activity can tell them.
   */
  private async pqLane(
    chainId: number,
    plan: AccountPlan,
  ): Promise<{ record?: PqEverydayRecord; view: NonNullable<SendPreview["signingKey"]> } | undefined> {
    if (!this.d.pq) return undefined;
    const net = findNetwork(chainId);
    let st: PqEverydayState;
    try {
      st = await this.d.pq.state(net, plan.address);
    } catch {
      return undefined;
    }
    if (st.state !== "on" || !st.record.preferred) return undefined;
    if (!st.nodeOk)
      return {
        view: {
          kind: "everyday",
          fallback: "LeanPool isn't answering, so this payment uses your regular everyday key.",
        },
      };
    if (BigInt(st.balanceWei) < PQ_MIN_BALANCE) {
      return {
        view: {
          kind: "everyday",
          fallback:
            "Your quantum-safe key's fee balance is low, so this payment uses your regular everyday key. Top it up in Security.",
        },
      };
    }
    return { record: st.record, view: { kind: "quantum-safe", feeBalanceWei: st.balanceWei } };
  }

  private async sendPq(
    chainId: number,
    account: Address,
    tank: Address,
    calls: Call[],
    decision: RouteDecision,
    prepared: NonNullable<Awaited<ReturnType<Payments["evaluate"]>>["prepared"]>,
    record: PqEverydayRecord,
    meta: { origin?: string; batchId?: string },
  ): Promise<ActivityEntry> {
    const net = findNetwork(chainId)!;
    const busy = new Set(
      (await this.d.activity.pending())
        .filter((e) => e.lane === "leanpool" && e.pqSigner?.toLowerCase() === record.signer.toLowerCase())
        .map((e) => e.nonce.split(":")[0]!),
    );
    const sent = await this.d.pq!.submit({
      net,
      record,
      declaredUsd: decision.amountUsd,
      calls,
      twin: prepared.wire,
      fees: prepared.fees,
      busyLanes: busy,
    });
    const now = this.d.now();
    const acalls = toActivityCalls(calls);
    const entry: ActivityEntry = {
      id: crypto.randomUUID(),
      chainId,
      kind: "payment",
      ...(meta.origin ? { origin: meta.origin } : {}),
      ...(meta.batchId ? { batchId: meta.batchId } : {}),
      account,
      tank,
      calls: acalls,
      declaredUsd: decision.amountUsd.toString(),
      rules: decision.rules,
      hash: sent.poolId,
      replaced: [],
      nonce: `${sent.nonceKey}:${sent.nonceSeq}`,
      wire: sent.wire,
      fees: {
        maxFeePerGas: prepared.fees.maxFeePerGas.toString(),
        maxPriorityFeePerGas: prepared.fees.maxPriorityFeePerGas.toString(),
      },
      lane: "leanpool",
      poolId: sent.poolId,
      pqNodeUrl: record.nodeUrl,
      pqSigner: record.signer,
      sentAtBlock: (await this.d.io.publicClient(chainId).getBlockNumber()).toString(),
      ...describePq({ calls: acalls, declaredUsd: decision.amountUsd.toString() }, { stage: "pooled" }, null, {
        labels: this.labels(tank),
      }),
      ...(sent.unconfirmed
        ? {
            detail:
              "LeanPool didn't confirm it received this payment. QueueBit is following it; it won't be sent twice.",
          }
        : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.d.activity.add(entry);
    return entry;
  }

  /** A post-quantum payment: follows it on its LeanPool node, then reads the mined receipt. */
  private async refreshPq(e: ActivityEntry): Promise<ActivityEntry | undefined> {
    if (!this.d.pq || !e.poolId || !e.pqNodeUrl) return undefined;
    const st = await this.d.pq.track(e.pqNodeUrl, e.poolId);
    const labels = this.labels(e.tank);
    if (!st) {
      // The node no longer knows it (a restart): the signer's nonce lane tells whether it was included.
      const [lane, seq] = e.nonce.split(":");
      if (!lane || !seq || !e.pqSigner || this.d.now() - e.createdAt < 10 * 60_000) return undefined;
      const next = await this.d.pq.laneNonce(findNetwork(e.chainId)!, e.pqSigner, BigInt(lane));
      return this.d.activity.update(e.id, {
        ...(next > BigInt(seq)
          ? {
              status: "confirmed" as const,
              headline: `Paid ${intentTitle(e.calls, labels)}`,
              detail: "Included on-chain (LeanPool lost its record after a restart, so the details aren't available).",
            }
          : {
              status: "failed" as const,
              headline: "Not sent: LeanPool lost this payment",
              detail: "Its node restarted before the payment was batched. Nothing was paid; send it again.",
            }),
        steps: e.steps,
      });
    }
    let receipt: FrameTxReceipt | null = null;
    let feeWei: bigint | undefined;
    if ((st.stage === "mined" || st.stage === "reverted") && st.txHash) {
      receipt = await this.engine(e.chainId).receipt(st.txHash);
      if (!receipt) return undefined;
      const gasUsed =
        receipt.gasUsed ?? receipt.frameReceipts.reduce((a, f) => a + f.gasUsed.execution + f.gasUsed.state, 0n);
      feeWei = gasUsed * BigInt(e.fees!.maxFeePerGas);
      if (receipt.blockNumber !== undefined) {
        const block = await this.d.io.publicClient(e.chainId).getBlock({ blockNumber: receipt.blockNumber });
        const eff = (block.baseFeePerGas ?? 0n) + BigInt(e.fees!.maxPriorityFeePerGas);
        if (eff < BigInt(e.fees!.maxFeePerGas)) feeWei = gasUsed * eff;
      }
    }
    const next = describePq(e, st, receipt, { ...(feeWei !== undefined ? { feeWei } : {}), labels });
    const final = next.status !== "confirming";
    // Waiting for more than ~6 blocks: say so (the node may be slow, censoring, or down).
    let stuck = false;
    if (!final && e.sentAtBlock) {
      stuck = (await this.d.io.publicClient(e.chainId).getBlockNumber()) - BigInt(e.sentAtBlock) >= 6n;
    }
    const batch = st.batch ? { pqBatch: st.batch } : {};
    if (!final && next.detail === e.detail && stuck === Boolean(e.stuck) && !st.batch?.proofHash) return undefined;
    return this.d.activity.update(e.id, {
      ...next,
      ...batch,
      stuck,
      ...(st.txHash && final ? { hash: st.txHash } : {}),
      ...(feeWei !== undefined ? { feeWei: feeWei.toString() } : {}),
      ...(receipt?.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
    });
  }

  /** Speed up (+10 % on both fees, same nonce, new signatures) or cancel (zero-value payment to the fee tank). */
  replace(id: string, mode: "speed-up" | "cancel"): Promise<ActivityEntry> {
    return this.serialized(async () => {
      const entry = await this.d.activity.get(id);
      if (!entry) throw new PaymentsError("unknown-entry", "That payment isn't in your activity.");
      if (entry.backend === "4337") {
        throw new PaymentsError(
          "unsupported",
          "Speed up and cancel aren't available for compatible accounts yet: the bundler retries on its own.",
        );
      }
      if (entry.lane === "leanpool") {
        throw new PaymentsError(
          "unsupported",
          "Quantum-safe payments are batched by LeanPool and can't be sped up or cancelled; they usually land within a minute.",
        );
      }
      if (entry.kind === "activation" || !entry.fees || (entry.status !== "confirming" && entry.status !== "sending")) {
        throw new PaymentsError("not-pending", "This payment is no longer waiting.");
      }
      const net = this.network(entry.chainId);
      const plan = await this.requirePlan(entry.chainId);
      const state = await this.policy(entry.chainId).state(plan);
      const calls = mode === "cancel" ? [{ target: entry.tank, value: 0n, data: "0x" as Hex }] : toCalls(entry.calls);
      const fees = bumpFees({
        maxFeePerGas: BigInt(entry.fees.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(entry.fees.maxPriorityFeePerGas),
      });
      const prepared = await this.engine(entry.chainId).prepare({
        chainId: entry.chainId,
        profileId: net.profileId!,
        account: plan.address,
        hotKey: state.hotKey,
        tank: state.tank,
        calls,
        declaredUsd: mode === "cancel" ? 0n : BigInt(entry.declaredUsd),
        nonce: BigInt(entry.nonce),
        fees,
        maxPriorityFeePerGas: state.maxPriorityFeePerGas,
        maxFeeWeiPerTx: state.maxFeeWeiPerTx,
      });
      if (!prepared.verdict.admitted) {
        throw new PaymentsError(
          "not-admitted",
          prepared.verdict.reason ?? "The network would not accept the replacement.",
        );
      }
      // A speed-up re-signs the same payment; if its body would fail now (the limit or an allowed list changed), the
      // replacement would only burn a fee from the tank. A cancel keeps going: its point is to use up the nonce.
      if (mode === "speed-up" && !prepared.verdict.bodyOk) {
        throw new PaymentsError(
          "not-admitted",
          "Your account would refuse this payment now, so speeding it up would only cost a network fee. Cancel it instead.",
        );
      }
      const hash = await this.engine(entry.chainId).submit(prepared);
      const next = await this.d.activity.update(id, {
        ...(mode === "cancel" ? { kind: "cancel" as const, headline: "Cancelling…" } : {}),
        hash,
        replaced: [...entry.replaced, entry.hash],
        wire: prepared.wire,
        fees: {
          maxFeePerGas: prepared.fees.maxFeePerGas.toString(),
          maxPriorityFeePerGas: prepared.fees.maxPriorityFeePerGas.toString(),
        },
        stuck: false,
        sentAtBlock: (await this.d.io.publicClient(entry.chainId).getBlockNumber()).toString(),
      });
      return next!;
    });
  }

  /** Polls receipts for every pending entry; returns the entries that changed. */
  async refreshPending(): Promise<ActivityEntry[]> {
    const changed: ActivityEntry[] = [];
    for (const e of await this.d.activity.pending()) {
      try {
        const u = await this.refreshOne(e);
        if (u) changed.push(u);
      } catch {
        // Network trouble: try again on the next poll.
      }
    }
    return changed;
  }

  private async refreshOne(e: ActivityEntry): Promise<ActivityEntry | undefined> {
    const client = this.d.io.publicClient(e.chainId);
    if (e.kind === "vault") return undefined; // tracked by the Vault flow
    if (e.backend === "4337" && e.kind !== "activation") {
      const u = await this.aa.refreshOne(e, this.labels(e.tank));
      return u ? this.d.activity.update(e.id, u) : undefined;
    }
    if (e.kind === "activation") {
      const r = await client.getTransactionReceipt({ hash: e.hash }).catch(() => null);
      if (!r) return undefined;
      const plan = await this.d.plans.get(e.chainId);
      const signerHash = plan?.activation?.vaultSignerTx;
      const rs = signerHash ? await client.getTransactionReceipt({ hash: signerHash }).catch(() => null) : null;
      if (signerHash && !rs) return undefined;
      const ok = r.status === "success";
      const signerOk = !signerHash || rs?.status === "success";
      return this.d.activity.update(e.id, {
        status: ok && signerOk ? "confirmed" : "failed",
        headline:
          ok && signerOk
            ? "Account activated"
            : ok
              ? "Account active; Vault setup failed"
              : "Activation failed; nothing changed",
        detail: ok
          ? signerOk
            ? "Your daily limit is now enforced by the network, and your Vault can approve."
            : "The Vault signer wasn't deployed. QueueBit retries before your first Vault approval."
          : "Your fee tank paid the network fee. Try again.",
        steps:
          e.backend === "4337"
            ? [{ label: "Create account with your limits and your Vault", status: ok ? "done" : "failed" }]
            : [
                { label: "Create account with your limits", status: ok ? "done" : "failed" },
                { label: "Set up your Vault on the network", status: signerOk ? "done" : "failed" },
              ],
        feeWei: (r.gasUsed * r.effectiveGasPrice + (rs ? rs.gasUsed * rs.effectiveGasPrice : 0n)).toString(),
        blockNumber: r.blockNumber.toString(),
      });
    }
    if (e.lane === "leanpool") return this.refreshPq(e);
    const engine = this.engine(e.chainId);
    if (!e.wire) return undefined;
    const account = fromWire(e.wire).sender;
    const nonce = BigInt(e.nonce);
    for (const hash of [e.hash, ...e.replaced]) {
      const r = await engine.receipt(hash);
      if (!r) continue;
      engine.clearInFlight(account, nonce);
      const gasUsed = r.gasUsed ?? r.frameReceipts.reduce((s, f) => s + f.gasUsed.execution + f.gasUsed.state, 0n);
      let perGas = BigInt(e.fees!.maxFeePerGas);
      if (r.blockNumber !== undefined) {
        const block = await client.getBlock({ blockNumber: r.blockNumber });
        const eff = (block.baseFeePerGas ?? 0n) + BigInt(e.fees!.maxPriorityFeePerGas);
        if (eff < perGas) perGas = eff;
      }
      const feeWei = gasUsed * perGas;
      const bodyFailed = r.frameReceipts.slice(2).some((f) => f.status !== "success");
      let availableUsdAfter: bigint | undefined;
      if (bodyFailed) {
        const plan = await this.d.plans.get(e.chainId);
        if (plan) availableUsdAfter = (await this.policy(e.chainId).state(plan)).policy.availableUsd;
      }
      const replacedByOther = hash !== e.hash;
      const outcome = describeReceipt(replacedByOther ? { ...e, kind: "payment" } : e, r, {
        feeWei,
        ...(availableUsdAfter !== undefined ? { availableUsdAfter } : {}),
        labels: this.labels(e.tank),
      });
      return this.d.activity.update(e.id, {
        ...outcome,
        feeWei: feeWei.toString(),
        ...(r.blockNumber !== undefined ? { blockNumber: r.blockNumber.toString() } : {}),
        stuck: false,
      });
    }
    // No receipt for any of our hashes. Reconcile the nonce against the chain (plan §30 §4.5): if a block that is
    // already one behind the head counts past this nonce, another transaction took the slot (the same account on
    // another device, or a replacement this wallet no longer knows). One block behind, so a receipt the node has not
    // indexed yet is never mistaken for someone else's transaction.
    const head = await client.getBlockNumber();
    if (head > 0n && (await client.getTransactionCount({ address: account, blockNumber: head - 1n })) > nonce) {
      engine.clearInFlight(account, nonce);
      return this.d.activity.update(e.id, {
        status: "replaced",
        headline: "Replaced: nothing was sent from here",
        detail:
          "Another payment from this account used this slot, possibly from another device. Nothing was sent from this browser.",
        steps: e.steps.map((s) => ({ ...s, status: "skipped" as const })),
        stuck: false,
      });
    }
    if (e.sentAtBlock) {
      const stuck = head - BigInt(e.sentAtBlock) >= 3n;
      if (stuck !== Boolean(e.stuck)) return this.d.activity.update(e.id, { stuck });
    }
    return undefined;
  }

  /** After an SW restart: in-flight nonces from the pending activity (plan §30 §4.5). */
  async rehydrate(): Promise<void> {
    for (const e of await this.d.activity.pending()) {
      if (e.wire && e.lane !== "leanpool")
        this.engine(e.chainId).markInFlight(fromWire(e.wire).sender, BigInt(e.nonce));
    }
  }
}
