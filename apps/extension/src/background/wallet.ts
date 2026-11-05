import type { Address } from "viem";
import { getNetwork, toHexChainId } from "../shared/chains";
import type { KV } from "../shared/kv";
import type { ApprovalView, UiApi, UiType } from "../shared/messages";
import type { WalletState } from "../shared/types";
import { ProviderRpcError, RpcErrorCode } from "../shared/errors";
import { ApprovalBroker, ApprovalStore, TooManyPendingError, type ApprovalWindows } from "./approvals";
import { placeholderBucketSource, type BucketSource } from "./bucket";
import { KeyringController, KeyringError, type KeyringOptions } from "./keyring";
import { PermissionsStore } from "./permissions";
import { routeProviderRequest, type ProviderRequest, type RequestContext, type RouterDeps } from "./router";
import { SettingsStore } from "./settings";

export interface WalletEnv {
  local: KV;
  session: KV;
  windows: ApprovalWindows;
  readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown>;
  getBalance(chainId: number, address: Address): Promise<bigint>;
  /** Push an event to connected dapp ports; `origin` filters to one site. */
  emit(event: "chainChanged" | "accountsChanged", data: unknown, origin?: string): void;
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
  readonly bucket: BucketSource;
  private readonly now: () => number;

  constructor(private readonly env: WalletEnv) {
    this.now = env.now ?? Date.now;
    this.keyring = new KeyringController(env.local, env.session, { now: this.now, ...env.keyring });
    this.settings = new SettingsStore(env.local);
    this.permissions = new PermissionsStore(env.local, this.now);
    this.approvals = new ApprovalBroker(new ApprovalStore(env.session, this.now), env.windows, this.now);
    this.bucket = placeholderBucketSource(() => this.settings.getSetup(), this.now);
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
      setChainId: (chainId) => this.switchChain(chainId),
      hasKeyring: () => this.keyring.isInitialized(),
      isUnlocked: () => this.keyring.isUnlocked(),
      getAccount: async () => (await this.keyring.accounts())?.everyday,
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
    const chainId = toHexChainId((await this.settings.get()).selectedChainId);
    const accounts = (await routeProviderRequest(
      { origin, requestId: "state" },
      { method: "eth_accounts" },
      this.routerDeps(),
    )) as string[];
    return { chainId, accounts };
  }

  async switchChain(chainId: number): Promise<void> {
    const before = (await this.settings.get()).selectedChainId;
    await this.settings.update({ selectedChainId: chainId });
    if (before !== chainId) this.env.emit("chainChanged", toHexChainId(chainId));
  }

  async autoLockCheck(): Promise<void> {
    const { autoLockMinutes } = await this.settings.get();
    if (await this.keyring.autoLockIfIdle(autoLockMinutes)) await this.emitAccountsToAll([]);
  }

  private async emitAccountsToAll(accounts: Address[]): Promise<void> {
    for (const p of await this.permissions.list()) this.env.emit("accountsChanged", accounts, p.origin);
  }

  private async onUnlocked(): Promise<void> {
    const account = (await this.keyring.accounts())?.everyday;
    if (account) await this.emitAccountsToAll([account]);
  }

  async approvalView(id: string): Promise<ApprovalView | null> {
    const approval = await this.approvals.store.get(id);
    if (!approval) return null;
    const knownSite = await this.permissions.knownSite(approval.origin);
    return {
      approval,
      ...(knownSite ? { knownSite } : {}),
      alreadyConnected: await this.permissions.isPermitted(approval.origin),
    };
  }

  async resolveApproval(id: string, approved: boolean): Promise<void> {
    const approval = await this.approvals.store.get(id);
    if (!approval || approval.status !== "pending") return;
    if (approved) {
      const account = (await this.keyring.accounts())?.everyday;
      if (!account || !(await this.keyring.isUnlocked())) {
        throw new KeyringError("locked", "Unlock LEAKED before connecting.");
      }
      await this.permissions.grant(approval.origin, [account]);
      this.env.emit("accountsChanged", [account], approval.origin);
    }
    await this.approvals.resolve(id, approved ? "approved" : "rejected");
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
      return null;
    },
    "settings:update": async (patch) => {
      if (patch.selectedChainId !== undefined) await this.switchChain(patch.selectedChainId);
      return this.settings.update(patch);
    },
    "setup:update": (patch) => this.settings.updateSetup(patch),
    "wallet:balance": async ({ chainId }) => {
      const account = (await this.keyring.accounts())?.everyday;
      if (!account) throw new KeyringError("missing", "No account yet.");
      const id = chainId ?? (await this.settings.get()).selectedChainId;
      const net = getNetwork(id);
      const wei = await this.env.getBalance(id, account);
      return { chainId: id, wei: wei.toString(), ...net.currency, fetchedAt: this.now() };
    },
    "wallet:bucket": async () => {
      const account = (await this.keyring.accounts())?.everyday;
      if (!account) throw new KeyringError("missing", "No account yet.");
      return this.bucket.getBucket(account, (await this.settings.get()).selectedChainId);
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
  };
}
