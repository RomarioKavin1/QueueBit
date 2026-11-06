import { parseGwei, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { fromWire, signTx, type Profile } from "@leaked/frames";
import type { NodeClient } from "@leaked/rpc";
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
  roleSalt,
  type AccountPlan,
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

export interface ChainIo {
  publicClient(chainId: number): PublicClient;
  node(chainId: number): NodeClient;
}

export interface PaymentsDeps {
  io: ChainIo;
  keyring: KeyringController;
  plans: AccountPlans;
  activity: ActivityStore;
  getLimits(): Promise<SetupState>;
  now: () => number;
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
      | "frozen",
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

  constructor(private readonly d: PaymentsDeps) {}

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
        sendRawTransaction: (raw) => node.sendRawTransaction(raw),
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

  /** The frame network with LEAKED account contracts, or an explanation. */
  private network(chainId: number): Network & { deployment: NonNullable<Network["deployment"]> } {
    const net = findNetwork(chainId);
    if (!net || net.backend !== "frame" || !net.profileId) {
      throw new PaymentsError("unsupported", "Payments on this network arrive with the compatible-account update.");
    }
    if (!net.deployment) {
      throw new PaymentsError(
        "unsupported",
        `LEAKED's account contracts aren't on ${net.name} yet, so the account can't be activated there.`,
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
    this.network(chainId);
    const plan = await this.plan(chainId);
    if (!plan)
      throw new PaymentsError("no-plan", "Finish setting up LEAKED first: pair your Vault and choose your limits.");
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
    const { state, decision, prepared } = await this.evaluate(chainId, calls);
    const tankWei = await this.d.io.publicClient(chainId).getBalance({ address: state.tank });
    return {
      chainId,
      route: routeView(decision, state),
      ...(prepared ? { feeWei: prepared.feeWei.toString(), maxCostWei: prepared.maxCostWei.toString() } : {}),
      effects: this.effects(calls, state.tank),
      ...(prepared && tankWei < prepared.maxCostWei ? { tankTooLow: true } : {}),
      ethUsdPrice: usdNumber(state.ethUsdPrice),
    };
  }

  /** Sends an everyday payment. Refuses anything the router does not clear (RouteError) and never sends unsimulated. */
  send(chainId: number, calls: Call[], meta: { origin?: string; batchId?: string } = {}): Promise<ActivityEntry> {
    return this.serialized(async () => {
      const { plan, state, decision, prepared } = await this.evaluate(chainId, calls);
      if (decision.route !== "hot" || !prepared) throw new RouteError(decision, routeView(decision, state));
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
        createdAt: now,
        updatedAt: now,
      };
      await this.d.activity.add(entry);
      return entry;
    });
  }

  /** Speed up (+10 % on both fees, same nonce, new signatures) or cancel (zero-value payment to the fee tank). */
  replace(id: string, mode: "speed-up" | "cancel"): Promise<ActivityEntry> {
    return this.serialized(async () => {
      const entry = await this.d.activity.get(id);
      if (!entry) throw new PaymentsError("unknown-entry", "That payment isn't in your activity.");
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
            : "The Vault signer wasn't deployed. LEAKED retries before your first Vault approval."
          : "Your fee tank paid the network fee. Try again.",
        steps: [
          { label: "Create account with your limits", status: ok ? "done" : "failed" },
          { label: "Set up your Vault on the network", status: signerOk ? "done" : "failed" },
        ],
        feeWei: (r.gasUsed * r.effectiveGasPrice + (rs ? rs.gasUsed * rs.effectiveGasPrice : 0n)).toString(),
        blockNumber: r.blockNumber.toString(),
      });
    }
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
      if (e.wire) this.engine(e.chainId).markInFlight(fromWire(e.wire).sender, BigInt(e.nonce));
    }
  }
}
