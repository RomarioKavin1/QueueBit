import type { Address, Hex } from "viem";
import { findNetwork, getNetwork, toHexChainId } from "../shared/chains";
import type { KV } from "../shared/kv";
import type { ApprovalView, SendRequest, UiApi, UiType } from "../shared/messages";
import type { Approval, ApprovalTx, WalletState } from "../shared/types";
import { ProviderRpcError, RpcErrorCode, userRejected } from "../shared/errors";
import { AccountPlans } from "./account";
import { ActivityStore, callsStatusCode, type ActivityEntry } from "./activity";
import { ApprovalBroker, ApprovalStore, TooManyPendingError, type ApprovalWindows } from "./approvals";
import { bucketFromStatus } from "./bucket";
import { KeyringController, KeyringError, type KeyringOptions } from "./keyring";
import { Payments, PaymentsError, RouteError, type ChainIo } from "./payments";
import { PermissionsStore } from "./permissions";
import {
  routeProviderRequest,
  type CallsStatus,
  type ProviderRequest,
  type RequestContext,
  type RouterDeps,
} from "./router";
import type { Call } from "./routing";
import { SettingsStore } from "./settings";

export interface WalletEnv {
  local: KV;
  session: KV;
  windows: ApprovalWindows;
  readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown>;
  getBalance(chainId: number, address: Address): Promise<bigint>;
  /** Push an event to connected dapp ports; `origin` filters to one site. */
  emit(event: "chainChanged" | "accountsChanged", data: unknown, origin?: string): void;
  /** Frame-backend RPC per chain (FrameEngine, account reads). */
  io?: ChainIo;
  /** Open the full app at a hash route (wallet_showCallsStatus, Vault hand-off). */
  openApp?(hash: string): Promise<void>;
  keyring?: KeyringOptions;
  now?: () => number;
}

/**
 * The service worker's composition root: every controller reads and writes storage, so nothing important lives only in
 * SW memory (plan §30 §2.2). Pure enough to run in unit tests with in-memory KVs.
 */
export class Wallet {
  readonly keyring: KeyringController;
  readonly settings: SettingsStore;
  readonly permissions: PermissionsStore;
  readonly approvals: ApprovalBroker;
  readonly plans: AccountPlans;
  readonly activity: ActivityStore;
  readonly payments: Payments | undefined;
  private readonly now: () => number;

  constructor(private readonly env: WalletEnv) {
    this.now = env.now ?? Date.now;
    this.keyring = new KeyringController(env.local, env.session, { now: this.now, ...env.keyring });
    this.settings = new SettingsStore(env.local);
    this.permissions = new PermissionsStore(env.local, this.now);
    this.approvals = new ApprovalBroker(new ApprovalStore(env.session, this.now), env.windows, this.now);
    this.plans = new AccountPlans(env.local);
    this.activity = new ActivityStore(env.local, this.now);
    this.payments = env.io
      ? new Payments({
          io: env.io,
          keyring: this.keyring,
          plans: this.plans,
          activity: this.activity,
          getLimits: () => this.settings.getSetup(),
          now: this.now,
        })
      : undefined;
  }

  private pay(): Payments {
    if (!this.payments) throw new Error("Payments are not available in this context.");
    return this.payments;
  }

  /** The address a site sees on `chainId`: the native account where LEAKED has one, else the everyday key. */
  async accountFor(chainId: number): Promise<Address | undefined> {
    const plan = this.payments ? await this.payments.plan(chainId).catch(() => undefined) : undefined;
    return plan?.address ?? (await this.keyring.accounts())?.everyday;
  }

  private async chainOfOrigin(origin: string): Promise<number> {
    return (await this.permissions.chainOf(origin)) ?? (await this.settings.get()).selectedChainId;
  }

  async state(): Promise<WalletState> {
    const [record, unlocked, settings, setup] = await Promise.all([
      this.keyring.record(),
      this.keyring.isUnlocked(),
      this.settings.get(),
      this.settings.getSetup(),
    ]);
    return {
      initialized: record !== undefined,
      unlocked,
      ...(record ? { accounts: record.accounts } : {}),
      settings,
      setup,
    };
  }

  private routerDeps(): RouterDeps {
    return {
      permissions: this.permissions,
      getChainId: async () => (await this.settings.get()).selectedChainId,
      setOriginChain: (origin, chainId) => this.setOriginChain(origin, chainId),
      hasKeyring: () => this.keyring.isInitialized(),
      isUnlocked: () => this.keyring.isUnlocked(),
      getAccount: (chainId) => this.accountFor(chainId),
      requestTransaction: (ctx, chainId, tx) => this.requestTransaction(ctx, chainId, tx),
      callsStatus: (origin, id) => this.callsStatus(origin, id),
      batchIdTaken: async (origin, id) => (await this.activity.findByBatchId(id, origin)) !== undefined,
      capabilities: (chainId) => this.capabilities(chainId),
      showActivity: async (id) => {
        await this.env.openApp?.(`#activity/${encodeURIComponent(id)}`);
      },
      requestConnect: async ({ origin, requestId, embedded }, chainId) => {
        try {
          return await this.approvals.request(
            {
              kind: "connect",
              origin,
              chainId,
              firstVisit: await this.permissions.isFirstVisit(origin),
              ...(embedded ? { embedded: true } : {}),
            },
            requestId,
          );
        } catch (err) {
          if (err instanceof TooManyPendingError) throw new ProviderRpcError(RpcErrorCode.limitExceeded, err.message);
          throw err;
        }
      },
      readRpc: this.env.readRpc,
    };
  }

  async handleProvider(ctx: RequestContext, req: ProviderRequest): Promise<unknown> {
    await this.autoLockCheck();
    return routeProviderRequest(ctx, req, this.routerDeps());
  }

  /** Snapshot sent to a port on (re)connect. */
  async providerState(origin: string): Promise<{ chainId: `0x${string}`; accounts: string[] }> {
    const chainId = toHexChainId(await this.chainOfOrigin(origin));
    const accounts = (await routeProviderRequest(
      { origin, requestId: "state" },
      { method: "eth_accounts" },
      this.routerDeps(),
    )) as string[];
    return { chainId, accounts };
  }

  /**
   * The wallet's own network (popup pill, Settings). Connected sites keep their own chain (per-origin chain); only
   * sites that are not connected follow, and they learn it on their next request.
   */
  async switchChain(chainId: number): Promise<void> {
    await this.settings.update({ selectedChainId: chainId });
  }

  /** `wallet_switchEthereumChain` from a connected site: moves that site only. */
  async setOriginChain(origin: string, chainId: number): Promise<void> {
    const before = await this.chainOfOrigin(origin);
    const accountBefore = await this.accountFor(before);
    await this.permissions.setChain(origin, chainId);
    if (before === chainId) return;
    this.env.emit("chainChanged", toHexChainId(chainId), origin);
    const accountAfter = await this.accountFor(chainId);
    if (accountAfter && accountAfter !== accountBefore && (await this.keyring.isUnlocked())) {
      this.env.emit("accountsChanged", [accountAfter], origin);
    }
  }

  async autoLockCheck(): Promise<void> {
    const { autoLockMinutes } = await this.settings.get();
    if (await this.keyring.autoLockIfIdle(autoLockMinutes)) await this.emitAccountsToAll([]);
  }

  private async emitAccountsToAll(accounts: Address[]): Promise<void> {
    for (const p of await this.permissions.list()) this.env.emit("accountsChanged", accounts, p.origin);
  }

  private async onUnlocked(): Promise<void> {
    for (const p of await this.permissions.list()) {
      const account = await this.accountFor(await this.chainOfOrigin(p.origin));
      if (account) this.env.emit("accountsChanged", [account], p.origin);
    }
  }

  // ---- transactions from sites ----

  private async requestTransaction(
    ctx: RequestContext,
    chainId: number,
    tx: ApprovalTx,
  ): Promise<{ hash: Hex; activityId: string; batchId?: string }> {
    const net = findNetwork(chainId);
    if (!net || net.backend !== "frame") {
      throw new ProviderRpcError(
        RpcErrorCode.unsupportedMethod,
        `Payments on ${net?.name ?? "this network"} arrive with the compatible-account update (M2).`,
        { leakedRule: "BACKEND-NOT-READY" },
      );
    }
    let record: Approval;
    try {
      record = await this.approvals.requestRecord(
        {
          kind: "transaction",
          origin: ctx.origin,
          chainId,
          firstVisit: false,
          tx,
          ...(ctx.embedded ? { embedded: true } : {}),
        },
        ctx.requestId,
      );
    } catch (err) {
      if (err instanceof TooManyPendingError) throw new ProviderRpcError(RpcErrorCode.limitExceeded, err.message);
      throw err;
    }
    if (record.status === "approved" && record.result) return record.result;
    if (record.denial) {
      throw new ProviderRpcError(RpcErrorCode.unauthorized, record.denial.explanation, record.denial);
    }
    throw userRejected("The user rejected the transaction.");
  }

  private async callsStatus(origin: string, id: string): Promise<CallsStatus | null> {
    const entry =
      (await this.activity.findByBatchId(id, origin)) ??
      (/^0x[0-9a-fA-F]{64}$/u.test(id) ? await this.activity.findByHash(id as Hex) : undefined);
    if (!entry || entry.origin !== origin) return null;
    let e: ActivityEntry = entry;
    if (e.status === "confirming" || e.status === "sending") {
      await this.payments?.refreshPending();
      e = (await this.activity.get(entry.id)) ?? entry;
    }
    const status = callsStatusCode(e);
    let receipts: unknown[] | undefined;
    if (status !== 100 && e.status !== "cancelled") {
      const r = await this.env.readRpc(e.chainId, "eth_getTransactionReceipt", [e.hash]).catch(() => null);
      if (r) receipts = [r];
    }
    return {
      version: "2.0.0",
      id,
      chainId: toHexChainId(e.chainId),
      status,
      atomic: true,
      ...(receipts ? { receipts } : {}),
    };
  }

  private async capabilities(chainId: number): Promise<Record<string, unknown>> {
    const net = getNetwork(chainId);
    if (net.backend !== "frame" || !this.payments) return { atomic: { status: "unsupported" } };
    const leaked: Record<string, unknown> = { backend: "frame" };
    try {
      const s = await this.payments.status(chainId);
      leaked.activated = s.deployed;
      if (s.deployed) {
        leaked.capUsd = s.limits.capUsd;
        leaked.capRemainingUsd = s.limits.availableUsd;
        leaked.perPaymentUsd = s.limits.perTxMaxUsd;
      }
    } catch {
      // capabilities stay minimal when the network is unreachable
    }
    return { atomic: { status: "supported" }, leaked };
  }

  /** The approval window's route + fee for a transaction request (records why, if it can't be instant). */
  private async approvalPreview(id: string) {
    const a = await this.approvals.store.get(id);
    if (!a || a.kind !== "transaction" || !a.tx) throw new Error("No such request.");
    const preview = await this.pay().preview(a.chainId, toCalls(a.tx.calls));
    if (preview.route.route !== "hot") {
      const leakedRule = preview.route.rules[0] ?? "ROUTE-NEEDS-VAULT";
      await this.approvals.store.update(id, {
        routeDenial: {
          leakedRule,
          explanation: `${preview.route.copy.headline}. ${preview.route.copy.detail}`,
          ...(preview.route.copy.remedy ? { remedy: preview.route.copy.remedy } : {}),
        },
      });
    } else if (a.routeDenial) {
      await this.approvals.store.update(id, { routeDenial: undefined });
    }
    return preview;
  }

  private async send(req: SendRequest): Promise<ActivityEntry> {
    const chainId = req.chainId ?? (await this.settings.get()).selectedChainId;
    return this.pay().send(chainId, [{ target: req.to, value: BigInt(req.valueWei), data: "0x" }]);
  }

  async approvalView(id: string): Promise<ApprovalView | null> {
    const approval = await this.approvals.store.get(id);
    if (!approval) return null;
    const knownSite = await this.permissions.knownSite(approval.origin);
    const account = (await this.keyring.accounts()) ? await this.accountFor(approval.chainId) : undefined;
    return {
      approval,
      ...(knownSite ? { knownSite } : {}),
      alreadyConnected: await this.permissions.isPermitted(approval.origin),
      ...(account ? { account } : {}),
    };
  }

  async resolveApproval(id: string, approved: boolean): Promise<void> {
    const approval = await this.approvals.store.get(id);
    if (!approval || approval.status !== "pending") return;
    if (approval.kind === "transaction") return this.resolveTransaction(approval, approved);
    if (approved) {
      const account = await this.accountFor(approval.chainId);
      if (!account || !(await this.keyring.isUnlocked())) {
        throw new KeyringError("locked", "Unlock LEAKED before connecting.");
      }
      await this.permissions.grant(approval.origin, [account], approval.chainId);
      this.env.emit("accountsChanged", [account], approval.origin);
    }
    await this.approvals.resolve(id, approved ? "approved" : "rejected");
  }

  private async resolveTransaction(approval: Approval, approved: boolean): Promise<void> {
    if (!approved) {
      // Closing a "needs your Vault" screen is not the user saying no: the site learns why (4100 + leakedRule).
      await this.approvals.resolve(
        approval.id,
        "rejected",
        approval.routeDenial ? { denial: approval.routeDenial } : {},
      );
      return;
    }
    if (!(await this.keyring.isUnlocked())) throw new KeyringError("locked", "Unlock LEAKED before approving.");
    try {
      const entry = await this.pay().send(approval.chainId, toCalls(approval.tx!.calls), {
        origin: approval.origin,
        ...(approval.tx!.batchId ? { batchId: approval.tx!.batchId } : {}),
      });
      await this.approvals.resolve(approval.id, "approved", {
        result: { activityId: entry.id, hash: entry.hash, ...(entry.batchId ? { batchId: entry.batchId } : {}) },
      });
      void this.trackSoon();
    } catch (err) {
      if (err instanceof RouteError) {
        await this.approvals.resolve(approval.id, "rejected", {
          denial: {
            leakedRule: err.view.rules[0] ?? "ROUTE-NEEDS-VAULT",
            explanation: `${err.view.copy.headline}. ${err.view.copy.detail}`,
            ...(err.view.copy.remedy ? { remedy: err.view.copy.remedy } : {}),
          },
        });
        return;
      }
      throw err;
    }
  }

  /** Poll pending payments for a few minutes after a send (the popup also polls while open). */
  private tracking = false;
  async trackSoon(): Promise<void> {
    if (this.tracking || !this.payments) return;
    this.tracking = true;
    try {
      for (let i = 0; i < 90; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        await this.payments.refreshPending();
        if ((await this.activity.pending()).length === 0) break;
      }
    } finally {
      this.tracking = false;
    }
  }

  /** Dispatch for extension-page messages. Every call counts as user activity for auto-lock. */
  async handleUi<K extends UiType>(type: K, payload: UiApi[K]["req"]): Promise<UiApi[K]["res"]> {
    await this.autoLockCheck();
    await this.keyring.touch();
    const p = payload as never;
    const h = this.uiHandlers as unknown as Record<UiType, (p: unknown) => Promise<unknown>>;
    const handler = h[type];
    if (!handler) throw new Error(`Unknown message ${String(type)}`);
    return (await handler(p)) as UiApi[K]["res"];
  }

  private readonly uiHandlers: { [K in UiType]: (p: UiApi[K]["req"]) => Promise<UiApi[K]["res"]> } = {
    "state:get": () => this.state(),
    "keyring:create": async ({ password, revealWords }) => {
      const { mnemonic } = await this.keyring.create(password);
      return revealWords === true ? { mnemonic } : {};
    },
    "keyring:import": async ({ mnemonic, password }) => {
      await this.keyring.import(mnemonic, password);
      return null;
    },
    "keyring:unlock": async ({ password }) => {
      await this.keyring.unlock(password);
      await this.onUnlocked();
      return null;
    },
    "keyring:lock": async () => {
      await this.keyring.lock();
      await this.emitAccountsToAll([]);
      return null;
    },
    "keyring:changePassword": async ({ oldPassword, newPassword }) => {
      await this.keyring.changePassword(oldPassword, newPassword);
      return null;
    },
    "keyring:reset": async () => {
      await this.emitAccountsToAll([]);
      await this.keyring.reset();
      await this.permissions.revokeAll();
      await this.settings.clearSetup();
      await this.plans.clear();
      await this.activity.clear();
      return null;
    },
    "settings:update": async (patch) => {
      if (patch.selectedChainId !== undefined) await this.switchChain(patch.selectedChainId);
      return this.settings.update(patch);
    },
    "setup:update": (patch) => this.settings.updateSetup(patch),
    "wallet:balance": async ({ chainId }) => {
      const id = chainId ?? (await this.settings.get()).selectedChainId;
      const account = await this.accountFor(id);
      if (!account) throw new KeyringError("missing", "No account yet.");
      const net = getNetwork(id);
      const wei = await this.env.getBalance(id, account);
      return { chainId: id, wei: wei.toString(), ...net.currency, fetchedAt: this.now() };
    },
    "wallet:bucket": async () => {
      const status = await this.pay().status((await this.settings.get()).selectedChainId);
      return bucketFromStatus(status, await this.settings.getSetup());
    },
    "permissions:list": () => this.permissions.list(),
    "permissions:revoke": async ({ origin }) => {
      if (await this.permissions.revoke(origin)) this.env.emit("accountsChanged", [], origin);
      return null;
    },
    "approval:get": ({ id }) => this.approvalView(id),
    "approval:resolve": async ({ id, approved }) => {
      await this.resolveApproval(id, approved);
      return null;
    },
    "approval:preview": ({ id }) => this.approvalPreview(id),
    "account:status": async ({ chainId }) => this.pay().status(chainId ?? (await this.settings.get()).selectedChainId),
    "account:activate": async ({ chainId }) => {
      const entry = await this.pay().activate(chainId ?? (await this.settings.get()).selectedChainId);
      void this.trackSoon();
      return entry;
    },
    "send:preview": async (req) =>
      this.pay().preview(req.chainId ?? (await this.settings.get()).selectedChainId, [
        { target: req.to, value: BigInt(req.valueWei), data: "0x" },
      ]),
    "send:submit": async (req) => {
      const entry = await this.send(req);
      void this.trackSoon();
      return entry;
    },
    "activity:list": async () => {
      if (this.payments && (await this.activity.pending()).length > 0) await this.payments.refreshPending();
      return this.activity.list();
    },
    "activity:replace": async ({ id, mode }) => {
      const entry = await this.pay().replace(id, mode);
      void this.trackSoon();
      return entry;
    },
  };
}

function toCalls(calls: ApprovalTx["calls"]): Call[] {
  return calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }));
}

export { PaymentsError, RouteError };
