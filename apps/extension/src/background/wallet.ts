import { concatHex, erc20Abi, hexToBytes, isAddress, type Address, type Hex } from "viem";
import { schemeById } from "@leaked/pq-signer";
import {
  UR_TYPES,
  UrReceiver,
  encodeRecoveryChallenge,
  randomUuid,
  recoveryTestChallenge,
  singlePartUr,
} from "@leaked/ur";
import { findNetwork, getNetwork, toHexChainId } from "../shared/chains";
import type { KV } from "../shared/kv";
import type { ApprovalView, SendRequest, UiApi, UiType } from "../shared/messages";
import type { Approval, ApprovalTx, TokenChoice, WalletState } from "../shared/types";
import { ProviderRpcError, RpcErrorCode, userRejected } from "../shared/errors";
import { AccountPlans, MAX_INIT_TOKENS, payerConflict } from "./account";
import { ActivityStore, callsStatusCode, type ActivityEntry } from "./activity";
import { ApprovalBroker, ApprovalStore, TooManyPendingError, type ApprovalWindows } from "./approvals";
import { bucketFromStatus } from "./bucket";
import { KeyringController, KeyringError, type KeyringOptions } from "./keyring";
import { Payments, PaymentsError, RouteError, type ChainIo } from "./payments";
import type { SidecarClient } from "@leaked/rpc";
import { accountAbi, policyHookAbi, roleSignerFactoryAbi } from "../generated/contracts";
import { ROLE_ID, type AccountPlan } from "./account";
import { choosePath } from "./lanes";
import { permitMismatch, registerPermitCall, type SignatureClass } from "./signing";
import {
  messageText,
  parseSiwe,
  personalMessage,
  registeredMarker,
  signPersonal7739,
  signTyped7739,
  siweDomainMatches,
  typedDigest,
  validatorDomain,
} from "./signin";
import { aaNetwork } from "./aa/payments";
import { VaultError, VaultFlow, last8 } from "./vault";
import type { VaultActionRequest } from "./vaultActions";
import type { PairPreview, PolicyView, SignerView } from "../shared/views";
import type { ApprovalSignature } from "../shared/types";
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

/** How long the recovery-test code this browser shows stays valid. */
export const RECOVERY_CHALLENGE_TTL_MS = 30 * 60_000;
/** "Tokens you'll spend": a price below the preset's ÷ this is refused (it would loosen the limit by that factor). */
export const MIN_PRESET_PRICE_RATIO = 100;

export interface WalletEnv {
  local: KV;
  session: KV;
  windows: ApprovalWindows;
  readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown>;
  getBalance(chainId: number, address: Address): Promise<bigint>;
  /** Push an event to connected dapp ports; `origin` filters to one site. */
  emit(event: "chainChanged" | "accountsChanged", data: unknown, origin?: string): void;
  /** Frame-backend RPC per chain (FrameEngine, account reads). */
  io?: ChainIo & { sidecar?(url: string): SidecarClient };
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
  readonly vault: VaultFlow | undefined;
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
    this.vault = env.io
      ? new VaultFlow({
          io: env.io,
          kv: env.local,
          keyring: this.keyring,
          plans: this.plans,
          activity: this.activity,
          now: this.now,
        })
      : undefined;
  }

  private vf(): VaultFlow {
    if (!this.vault) throw new Error("Vault approvals are not available in this context.");
    return this.vault;
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
      requestSignature: (ctx, chainId, req) => this.requestSignature(ctx, chainId, req),
      callsStatus: (origin, id) => this.callsStatus(origin, id),
      batchIdTaken: async (origin, id) => (await this.activity.findByBatchId(id, origin)) !== undefined,
      capabilities: (chainId) => this.capabilities(chainId),
      showActivity: async (id) => {
        await this.env.openApp?.(`#activity/${encodeURIComponent(id)}`);
      },
      requestConnect: async ({ origin, requestId, embedded, topOrigin }, chainId) => {
        try {
          return await this.approvals.request(
            {
              kind: "connect",
              origin,
              chainId,
              firstVisit: await this.permissions.isFirstVisit(origin),
              ...(embedded ? { embedded: true } : {}),
              ...(topOrigin ? { topOrigin } : {}),
            },
            requestId,
          );
        } catch (err) {
          if (err instanceof TooManyPendingError) throw new ProviderRpcError(RpcErrorCode.limitExceeded, err.message);
          throw err;
        }
      },
      readRpc: (chainId, method, params) => this.readRpc(chainId, method, params),
    };
  }

  /**
   * Read methods for sites. On the 4337 backend a site holds a userOpHash (what eth_sendTransaction returned):
   * `eth_getTransactionReceipt` for it is answered with the bundle transaction's receipt (plan §30 §3.2, as Ambire
   * and Safe do), with `transactionHash` set to the userOpHash the site knows.
   */
  private async readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    if (
      method === "eth_getTransactionReceipt" &&
      typeof params[0] === "string" &&
      findNetwork(chainId)?.backend === "4337"
    ) {
      const e = await this.activity.findByHash(params[0] as Hex);
      if (e?.backend === "4337") {
        if (e.status === "confirming" || e.status === "sending") await this.payments?.refreshPending();
        const cur = (await this.activity.get(e.id)) ?? e;
        if (!cur.txHash) return null;
        const r = (await this.env.readRpc(chainId, method, [cur.txHash])) as Record<string, unknown> | null;
        return r ? { ...r, transactionHash: params[0], status: cur.status === "confirmed" ? "0x1" : "0x0" } : null;
      }
    }
    return this.env.readRpc(chainId, method, params);
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
    if (!net || (net.backend === "4337" && !aaNetwork(chainId))) {
      throw new ProviderRpcError(
        RpcErrorCode.unsupportedMethod,
        `LEAKED's account contracts aren't on ${net?.name ?? "this network"} yet.`,
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
          ...(ctx.embedded ? { embedded: true, ...(ctx.topOrigin ? { topOrigin: ctx.topOrigin } : {}) } : {}),
        },
        ctx.requestId,
      );
    } catch (err) {
      if (err instanceof TooManyPendingError) throw new ProviderRpcError(RpcErrorCode.limitExceeded, err.message);
      throw err;
    }
    if (record.status === "approved" && record.result) return record.result;
    // A screen that could only explain why (needs the Vault, blocked) ends with that reason however it was closed.
    const denial = record.denial ?? record.routeDenial;
    if (denial) throw new ProviderRpcError(RpcErrorCode.unauthorized, denial.explanation, denial);
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
      // 4337: the bundle transaction's receipt (from eth_getUserOperationReceipt), plan §30 §3.2 column U.
      const txHash = e.backend === "4337" ? e.txHash : e.hash;
      const r = txHash
        ? await this.env.readRpc(e.chainId, "eth_getTransactionReceipt", [txHash]).catch(() => null)
        : null;
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
    if ((net.backend === "4337" && !aaNetwork(chainId)) || !this.payments) return { atomic: { status: "unsupported" } };
    // Both backends batch atomically: one hotExecute frame, or one 7579 batch `execute`.
    const leaked: Record<string, unknown> = { backend: net.backend };
    try {
      const s = await this.payments.status(chainId);
      // Only what a site needs to choose a flow. The limit and what is left of it today are not exposed: they are a
      // cross-site signal (any connected site could watch another site's spending), M1 review.
      leaked.activated = s.deployed;
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

  // ---- signatures from sites (M3: scoped ERC-1271) ----

  private async requestSignature(
    ctx: RequestContext,
    chainId: number,
    req: { method: "personal_sign" | "eth_signTypedData_v4"; raw: unknown; cls: SignatureClass },
  ): Promise<Hex> {
    const net = findNetwork(chainId);
    if (!net || (net.backend === "4337" && !aaNetwork(chainId))) {
      throw new ProviderRpcError(
        RpcErrorCode.unsupportedMethod,
        `LEAKED's account contracts aren't on ${net?.name ?? "this network"} yet.`,
      );
    }
    const account = await this.accountFor(chainId);
    if (!account) throw new ProviderRpcError(RpcErrorCode.unauthorized, "No account yet.");
    const sig: ApprovalSignature = { method: req.method };
    let kind: "sign-in" | "permit" = "sign-in";
    let routeDenial: Approval["routeDenial"];
    if (req.method === "personal_sign") {
      const raw = req.raw as string;
      sig.raw = raw;
      sig.text = messageText(raw);
      const siwe = parseSiwe(sig.text);
      if (siwe) {
        sig.siwe = {
          domain: siwe.domain,
          ...(siwe.statement ? { statement: siwe.statement } : {}),
          ...(siwe.uri ? { uri: siwe.uri } : {}),
          ...(siwe.expirationTime ? { expirationTime: siwe.expirationTime } : {}),
          ...(siwe.nonce ? { nonce: siwe.nonce } : {}),
        };
        sig.domainOk = siweDomainMatches(siwe.domain, ctx.origin);
        if (!sig.domainOk) {
          // ux-spec E-50: the screen only offers Cancel, and the site learns the rule whichever way it is closed.
          routeDenial = {
            leakedRule: "SIG-DOMAIN-NOT-ALLOWED",
            explanation: `This sign-in message says it's for ${siwe.domain}, but the request came from ${ctx.origin}. LEAKED didn't sign it.`,
          };
        }
      }
    } else {
      const json = typeof req.raw === "string" ? req.raw : JSON.stringify(req.raw);
      sig.typedJson = json;
      const td = JSON.parse(json) as {
        domain?: { name?: string; verifyingContract?: string; chainId?: unknown };
        primaryType?: string;
      };
      sig.appDomain = {
        ...(td.domain?.name ? { name: td.domain.name } : {}),
        ...(td.domain?.verifyingContract ? { verifyingContract: td.domain.verifyingContract } : {}),
        ...(td.domain?.chainId !== undefined ? { chainId: Number(td.domain.chainId) } : {}),
      };
      if (typeof td.primaryType === "string") sig.primaryType = td.primaryType.slice(0, 64);
      if (req.cls.kind === "register-permit") {
        // Before any window: a permit the account could never record as asked (another owner or chain) is refused
        // outright, else the pre-approval would be mined, count against the limit, and still be "not registered".
        const why = permitMismatch(td, account, chainId);
        if (why) {
          throw new ProviderRpcError(RpcErrorCode.unauthorized, why, {
            leakedRule: "SIG-PERMIT-MISMATCH",
            explanation: why,
            remedy: "Ask the site for a permit for the connected account on this network.",
          });
        }
        kind = "permit";
        let symbol: string | undefined;
        let decimals: number | undefined;
        try {
          const c = this.env.io!.publicClient(chainId);
          [symbol, decimals] = await Promise.all([
            c.readContract({ address: req.cls.token, abi: erc20Abi, functionName: "symbol" }) as Promise<string>,
            c.readContract({ address: req.cls.token, abi: erc20Abi, functionName: "decimals" }).then(Number),
          ]);
        } catch {
          // unknown token metadata: raw units
        }
        sig.permit = {
          token: req.cls.token,
          spender: req.cls.spender,
          value: req.cls.value.toString(),
          deadline: req.cls.deadline.toString(),
          ...(symbol ? { symbol } : {}),
          ...(decimals !== undefined ? { decimals } : {}),
        };
      }
    }
    if (kind === "sign-in") sig.firstSignIn = !(await this.signInSites()).includes(ctx.origin);
    let record: Approval;
    try {
      record = await this.approvals.requestRecord(
        {
          kind,
          origin: ctx.origin,
          chainId,
          firstVisit: false,
          sig,
          ...(routeDenial ? { routeDenial } : {}),
          ...(ctx.embedded ? { embedded: true, ...(ctx.topOrigin ? { topOrigin: ctx.topOrigin } : {}) } : {}),
        },
        ctx.requestId,
      );
    } catch (err) {
      if (err instanceof TooManyPendingError) throw new ProviderRpcError(RpcErrorCode.limitExceeded, err.message);
      throw err;
    }
    if (record.status === "approved" && record.result?.signature) return record.result.signature;
    const denial = record.denial ?? record.routeDenial;
    if (denial) throw new ProviderRpcError(RpcErrorCode.unauthorized, denial.explanation, denial);
    throw userRejected("The user rejected the signature request.");
  }

  private async signInSites(): Promise<string[]> {
    return (await this.env.local.get<string[]>("leaked:signInSites")) ?? [];
  }

  private async resolveSignature(
    approval: Approval,
    approved: boolean,
    opts: { alwaysAllow?: boolean },
  ): Promise<void> {
    if (!approved) {
      await this.approvals.resolve(
        approval.id,
        "rejected",
        approval.routeDenial ? { denial: approval.routeDenial } : {},
      );
      return;
    }
    if (!(await this.keyring.isUnlocked())) throw new KeyringError("locked", "Unlock LEAKED before signing.");
    const sig = approval.sig!;
    const account = await this.accountFor(approval.chainId);
    if (!account) throw new KeyringError("missing", "No account yet.");
    if (approval.kind === "sign-in") {
      if (sig.siwe && !sig.domainOk) {
        // Enforced here, not only by the screen: a message naming another site is never signed (plan §30 §9.1).
        await this.approvals.resolve(approval.id, "rejected", {
          denial: approval.routeDenial ?? {
            leakedRule: "SIG-DOMAIN-NOT-ALLOWED",
            explanation: `This sign-in message says it's for ${sig.siwe.domain}, but the request came from ${approval.origin}. LEAKED didn't sign it.`,
          },
        });
        return;
      }
      const aa = aaNetwork(approval.chainId);
      const raw = await this.keyring.withHotKeys((k) =>
        sig.method === "personal_sign"
          ? signPersonal7739(
              k.everyday,
              account,
              approval.chainId,
              personalMessage(sig.raw ?? ""),
              ...(aa ? [validatorDomain(account, approval.chainId, false)] : []),
            )
          : signTyped7739(
              k.everyday,
              account,
              approval.chainId,
              JSON.parse(sig.typedJson!),
              ...(aa ? [validatorDomain(account, approval.chainId, true)] : []),
            ),
      );
      // 7579 hosts route ERC-1271 to a validator named by the signature's first 20 bytes.
      const signature = aa ? concatHex([aa.aa.validator, raw]) : raw;
      if (opts.alwaysAllow) {
        const sites = await this.signInSites();
        if (!sites.includes(approval.origin))
          await this.env.local.set("leaked:signInSites", [...sites, approval.origin]);
      }
      await this.approvals.resolve(approval.id, "approved", {
        result: { activityId: "", hash: "0x", signature },
      });
      return;
    }
    // permit: register the ERC-2612 digest on-chain in an everyday batch (it counts against the daily limit), wait
    // for it to be mined, then hand the site the registered-hash marker.
    const p = sig.permit!;
    const aaNet = aaNetwork(approval.chainId);
    const call = registerPermitCall(aaNet ? aaNet.aa.hook : account, {
      kind: "register-permit",
      rule: "SIG-PERMIT-2612",
      token: p.token,
      spender: p.spender,
      value: BigInt(p.value),
      deadline: BigInt(p.deadline),
    });
    let entry: ActivityEntry;
    try {
      entry = await this.pay().send(approval.chainId, [call], { origin: approval.origin });
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
    await this.approvals.store.update(approval.id, { result: { activityId: entry.id, hash: entry.hash } });
    for (let i = 0; i < 90; i++) {
      await this.payments!.refreshPending();
      const e = await this.activity.get(entry.id);
      if (e && e.status !== "confirming" && e.status !== "sending") {
        entry = e;
        break;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    const digest = typedDigest(JSON.parse(sig.typedJson!));
    const expiry = (await (aaNet
      ? this.env.io!.publicClient(approval.chainId).readContract({
          address: aaNet.aa.hook,
          abi: policyHookAbi,
          functionName: "registeredHashExpiry",
          args: [account, digest],
        })
      : this.env.io!.publicClient(approval.chainId).readContract({
          address: account,
          abi: accountAbi,
          functionName: "registeredHashExpiry",
          args: [digest],
        }))) as number;
    if (entry.status !== "confirmed" || Number(expiry) === 0) {
      await this.approvals.resolve(approval.id, "rejected", {
        denial: {
          leakedRule: "SIG-PERMIT-NOT-REGISTERED",
          explanation:
            entry.status !== "confirmed"
              ? "The pre-approval didn't go through, so nothing was signed."
              : "Your account recorded a different permit than the one the site asked for (its nonce or token domain differ), so nothing was signed.",
        },
      });
      return;
    }
    await this.approvals.resolve(approval.id, "approved", {
      result: {
        activityId: entry.id,
        hash: entry.hash,
        signature: aaNet ? concatHex([aaNet.aa.validator, registeredMarker(digest)]) : registeredMarker(digest),
      },
    });
  }

  // ---- pairing (ux-spec §3.1.2, §3.1.4) ----

  private readUr(text: string, type: (typeof UR_TYPES)[keyof typeof UR_TYPES]) {
    const rx = new UrReceiver([type]);
    let last: ReturnType<UrReceiver["receive"]> | undefined;
    for (const line of text.split(/\s+/u)) {
      if (!line) continue;
      last = rx.receive(line);
      if (last.status === "complete") return last.decoded;
      if (last.status === "error") throw new VaultError("E-24", `That code can't be read: ${last.error.message}`);
    }
    throw new VaultError(
      "E-24",
      last?.status === "progress"
        ? `That's only part of the code (${last.received} of ${last.total}). Paste every part.`
        : "That isn't a LEAKED code. Show the code from the Vault app.",
    );
  }

  private async pair(role: "vault" | "recovery", text: string, confirm: boolean): Promise<PairPreview> {
    const d = this.readUr(text, UR_TYPES.pqKey);
    if (d.type !== UR_TYPES.pqKey) throw new VaultError("E-24", "That isn't a pairing code.");
    const k = d.value;
    if (k.role !== ROLE_ID[role]) {
      throw new VaultError(
        "E-25",
        role === "vault"
          ? "That's a Recovery key code. Show the Vault's pairing code (Vault app › Pair with a browser)."
          : "That's the Vault's pairing code. Show the Recovery key code from the ceremony.",
      );
    }
    const scheme = schemeById(k.schemeId);
    if (!scheme)
      throw new VaultError("E-22", "This Vault uses a key type this version doesn't support. Update LEAKED.");
    if (role === "vault" && !k.payer)
      throw new VaultError("E-22", "This pairing code has no fee-payment key. Update the Vault app.");
    const setup = await this.settings.getSetup();
    if (role === "recovery" && setup.vault && setup.vault.pk.toLowerCase() === k.pk.toLowerCase()) {
      throw new VaultError("E-23", "That's your Vault's key. The Recovery key must be a different key.");
    }
    if (confirm) {
      const plan = await this.plans.get((await this.settings.get()).selectedChainId);
      if (plan && (await this.planInUse(plan))) {
        throw new VaultError(
          "frozen",
          "Your account is already active; its Vault can only be replaced with the Recovery key.",
        );
      }
      await this.settings.setPaired(role, {
        schemeId: k.schemeId,
        pk: k.pk,
        ...(k.payer ? { payer: k.payer as Address } : {}),
        at: this.now(),
      });
    }
    return {
      role,
      pk: k.pk,
      last8: last8(k.pk),
      schemeId: k.schemeId,
      schemeName: scheme.name,
      ...(scheme.experimental && scheme.warning ? { experimental: scheme.warning } : {}),
      ...(k.payer ? { payer: k.payer as Address } : {}),
      stored: confirm,
    };
  }

  private async planInUse(plan: AccountPlan): Promise<boolean> {
    if (plan.activation) return true;
    if (!this.env.io) return false;
    const c = this.env.io.publicClient(plan.chainId);
    const code = await c.getCode({ address: plan.address }).catch(() => undefined);
    return !!code && code !== "0x";
  }

  /**
   * The browser picks the recovery test's request id (single use): the phone signs over it, so a test code recorded
   * earlier, or made for another browser, can never be replayed here. A new challenge replaces the old one.
   */
  private challengeLock: Promise<unknown> = Promise.resolve();
  private recoveryChallenge(): Promise<{ text: string; requestId: string }> {
    // Serialized: two page requests at once (React StrictMode) must not each store a different challenge.
    const run = this.challengeLock.then(() => this.issueRecoveryChallenge());
    this.challengeLock = run.catch(() => undefined);
    return run;
  }

  private async issueRecoveryChallenge(): Promise<{ text: string; requestId: string }> {
    const setup = await this.settings.getSetup();
    if (!setup.recovery) throw new VaultError("E-23", "Scan the Recovery key code first.");
    // The outstanding one while it is unused and fresh (the page may ask twice); a used one is gone (single use).
    const cur = setup.recoveryChallenge;
    const reuse =
      cur &&
      cur.pk.toLowerCase() === setup.recovery.pk.toLowerCase() &&
      this.now() - cur.issuedAt < RECOVERY_CHALLENGE_TTL_MS / 2;
    const requestId = reuse ? cur.requestId : randomUuid();
    if (!reuse) await this.settings.setRecoveryChallenge({ requestId, pk: setup.recovery.pk, issuedAt: this.now() });
    return {
      requestId,
      text: singlePartUr(
        UR_TYPES.recoveryChallenge,
        encodeRecoveryChallenge({ requestId, recoveryPk: setup.recovery.pk }),
      ),
    };
  }

  private async recoveryTest(text: string): Promise<{ ok: true; last8: string; payer?: Address }> {
    const d = this.readUr(text, UR_TYPES.recoveryTest);
    if (d.type !== UR_TYPES.recoveryTest) throw new VaultError("E-24", "That isn't a recovery test code.");
    const t = d.value;
    const setup = await this.settings.getSetup();
    const want = setup.recovery?.pk;
    if (!want) throw new VaultError("E-23", "Scan the Recovery key code first.");
    if (t.recoveryPk.toLowerCase() !== want.toLowerCase()) {
      throw new VaultError(
        "E-23",
        "The Recovery key on the phone doesn't match the one scanned. Start the recovery setup again.",
      );
    }
    // Replay protection: only the answer to the challenge this browser showed, once, within 30 minutes.
    const ch = setup.recoveryChallenge;
    if (
      !ch ||
      ch.requestId !== t.requestId ||
      ch.pk.toLowerCase() !== want.toLowerCase() ||
      this.now() - ch.issuedAt > RECOVERY_CHALLENGE_TTL_MS
    ) {
      throw new VaultError(
        "E-61",
        "That test code wasn't made for the code this screen shows. On the phone, scan this screen's test code first, then show the phone's answer.",
      );
    }
    // A test that names a Recovery payer address (key 6) must name the one the pairing code carried, if any.
    if (t.payer && setup.recovery?.payer && t.payer.toLowerCase() !== setup.recovery.payer.toLowerCase()) {
      throw new VaultError(
        "E-23",
        "The Recovery key's fee-payment address on the phone doesn't match the one scanned. Start the recovery setup again.",
      );
    }
    const scheme = schemeById(t.schemeId);
    // v1 challenge, or v2 when the test carries the payer (the witness then covers that address too).
    const challenge = recoveryTestChallenge(t.schemeId, t.recoveryPk, t.requestId, t.payer);
    if (!scheme || !t.ok || !scheme.verify(hexToBytes(t.recoveryPk), hexToBytes(challenge), hexToBytes(t.witness))) {
      throw new VaultError("E-62", "The test signature didn't check out. Run the test again on the phone.");
    }
    // The v2 payer is signed by the Recovery key itself: it becomes InitConfig.recovery.payerKey (Path B for
    // Recovery, no stake needed). A pairing-code payer without a v2 test is not trusted on its own.
    const payer = (t.payer as Address | undefined) ?? undefined;
    const accounts = await this.keyring.accounts();
    if (payer && accounts) {
      const conflict = payerConflict({
        hotKey: accounts.everyday,
        tank: accounts.feeTank,
        ...(setup.vault?.payer ? { vaultPayer: setup.vault.payer } : {}),
        recoveryPayer: payer,
      });
      if (conflict) throw new VaultError("E-23", conflict);
    }
    const { payer: _scanned, ...rest } = setup.recovery!;
    void _scanned;
    await this.settings.setPaired("recovery", { ...rest, ...(payer ? { payer } : {}) }, this.now());
    await this.settings.setRecoveryChallenge(undefined);
    return { ok: true, last8: last8(t.recoveryPk), ...(payer ? { payer } : {}) };
  }

  /** "Tokens you'll spend" (onboarding): each token must be a contract with the decimals shown; prices are pinned. */
  private async setTokens(req: UiApi["setup:setTokens"]["req"]) {
    const net = getNetwork(req.chainId);
    const plan = await this.plans.get(req.chainId);
    if (plan && (await this.planInUse(plan))) {
      throw new VaultError("frozen", "Your account is already active; change tokens from Limits with your Vault.");
    }
    if (req.tokens.length > MAX_INIT_TOKENS) throw new Error(`At most ${MAX_INIT_TOKENS} tokens.`);
    const list: TokenChoice[] = [];
    for (const t of req.tokens) {
      if (!isAddress(t.token)) throw new Error("Not a token address.");
      if (!Number.isFinite(t.usd) || t.usd <= 0 || t.usd > 1_000_000 || Math.round(t.usd * 1e6) < 1)
        throw new Error(`Set a price above $0 for ${t.symbol}.`);
      // A price far below the real one loosens the daily limit by the same factor (the account counts the token at
      // this price). The floor is loose on purpose (prices drift); the page warns well before it.
      const preset = net.tokenPresets.find((p) => p.token.toLowerCase() === t.token.toLowerCase());
      if (preset && t.usd < preset.usd / MIN_PRESET_PRICE_RATIO) {
        throw new Error(
          `$${t.usd} for ${t.symbol} is under 1% of the $${preset.usd} LEAKED suggests. At that price your daily limit would let ${Math.round(preset.usd / t.usd)}× more ${t.symbol} through. Use a price close to the real one.`,
        );
      }
      if (this.env.io) {
        const d = await this.env.io
          .publicClient(net.chainId)
          .readContract({ address: t.token, abi: erc20Abi, functionName: "decimals" })
          .catch(() => undefined);
        if (d === undefined || Number(d) !== t.decimals)
          throw new Error(`${t.symbol} isn't a token with ${t.decimals} decimals on ${net.name}.`);
      }
      list.push({
        token: t.token,
        symbol: t.symbol.slice(0, 16),
        decimals: t.decimals,
        usdPerToken: String(Math.round(t.usd * 1e6)),
        confirmedAt: this.now(),
      });
    }
    return this.settings.setTokens(req.chainId, list);
  }

  // ---- Limits / Security views ----

  private async policyView(chainId: number): Promise<PolicyView> {
    const status = await this.pay().status(chainId);
    const base: PolicyView = {
      deployed: status.deployed,
      capUsd: status.limits.capUsd,
      perTxMaxUsd: status.limits.perTxMaxUsd,
      availableUsd: status.limits.availableUsd,
      recipientMode: status.recipientMode,
      timelockDelaySec: 172_800,
      vaultAvailableUsd: 0,
      tokens: [],
      sessions: [],
      tankWei: status.tankWei,
    };
    if (!status.deployed) return base;
    const p = await this.vf().currentPolicy(chainId);
    const plan = (await this.plans.get(chainId))!;
    const client = this.env.io!.publicClient(chainId);
    base.timelockDelaySec = p.timelockDelay;
    base.vaultAvailableUsd = Number(p.vaultAvailableUsd) / 1e6;
    for (const [token, t] of Object.entries(p.tokens)) {
      if (!t.allowed) continue;
      let symbol = token === "0x0000000000000000000000000000000000000000" ? "ETH" : `${token.slice(0, 6)}…`;
      if (symbol !== "ETH") {
        symbol = await client
          .readContract({ address: token as Address, abi: erc20Abi, functionName: "symbol" })
          .catch(() => symbol);
      }
      base.tokens.push({
        token: token as Address,
        allowed: true,
        decimals: t.decimals,
        usdPerToken: Number(t.usdPerToken) / 1e6,
        symbol,
      });
    }
    const events = await client
      .getContractEvents({ address: plan.address, abi: accountAbi, eventName: "SessionConfigured", fromBlock: 0n })
      .catch(() => []);
    const latest = new Map<
      string,
      { target: Address; selector: Hex; allowanceUsd: number; expiry: number; label: string }
    >();
    for (const e of events) {
      const a = e.args as unknown as { target: Address; selector: Hex; allowanceUsd: bigint; expiry: number };
      latest.set(`${a.target.toLowerCase()}:${a.selector}`, {
        target: a.target,
        selector: a.selector,
        allowanceUsd: Number(a.allowanceUsd) / 1e6,
        expiry: Number(a.expiry),
        label: `${a.target.slice(0, 6)}…${a.target.slice(-4)}`,
      });
    }
    base.sessions = [...latest.values()].filter((x) => x.allowanceUsd > 0 && x.expiry * 1000 > this.now());
    return base;
  }

  private async signerViews(chainId: number): Promise<SignerView[]> {
    const plan = await this.plans.get(chainId);
    if (!plan) return [];
    if (plan.backend === "4337") return this.aaSignerViews(chainId, plan);
    const out: SignerView[] = [];
    const budgets = await this.vf().budgets(chainId);
    for (const role of ["vault", "recovery"] as const) {
      if (role === "recovery" && !plan.recoverySigner) continue;
      const s = await this.vf().signerState(chainId, role);
      const choice = choosePath({
        schemeVerifyGas: s.verifyGasEstimate,
        hasPayer: s.payerKey !== "0x0000000000000000000000000000000000000000",
        signerStaked: s.staked,
        budgets,
      });
      const scheme = schemeById(s.schemeId);
      out.push({
        role,
        address: s.address,
        deployed: s.deployed,
        balanceWei: s.balance.toString(),
        staked: s.staked,
        schemeName: scheme?.name ?? "unknown",
        pkLast8: last8(s.pk),
        lane: choice.ok
          ? {
              ok: true,
              text:
                choice.path === "A"
                  ? `Quantum-safe signature checked before the fee is paid (${choice.lane === "staked" ? "staked lane" : "standard lane"}).`
                  : "Quantum-safe signature checked on-chain; the fee step uses a classical key on your phone (standard lane).",
              rules: choice.rules,
            }
          : {
              ok: false,
              text:
                role === "recovery"
                  ? "Can't send approvals on this network yet: Recovery approvals need the staked lane, and this key's signer has no stake there. Your Vault can cancel scheduled changes meanwhile."
                  : `Can't send approvals right now: ${choice.reason}`,
              rules: choice.rules,
            },
      });
    }
    return out;
  }

  /** 4337: the Vault and the Recovery key are PQ keys stored by LeakedRoleExecutor; the fee tank relays approvals. */
  private async aaSignerViews(chainId: number, plan: AccountPlan): Promise<SignerView[]> {
    const client = this.env.io!.publicClient(chainId);
    const code = await client.getCode({ address: plan.address });
    if (!code || code === "0x") return [];
    const roles = await this.vf().aa.roles(chainId, plan.address);
    const scheme = schemeById(await this.vf().aa.schemeId(chainId, roles.verifier));
    const tank = (await this.keyring.accounts())!.feeTank;
    const tankWei = (await client.getBalance({ address: tank })).toString();
    const out: SignerView[] = [];
    for (const role of ["vault", "recovery"] as const) {
      const pk = role === "vault" ? roles.vaultPk : roles.recoveryPk;
      if (/^0x0+$/u.test(pk)) continue;
      out.push({
        role,
        address: this.vf().aa.dep(chainId).executor,
        deployed: true,
        balanceWei: tankWei,
        staked: false,
        schemeName: scheme?.name ?? "unknown",
        pkLast8: last8(pk),
        lane: {
          ok: true,
          text: "Quantum-safe signature checked on-chain by your account's Vault module; your fee tank sends it (no classical key on the phone).",
          rules: ["ROUTE-VAULT-EXECUTOR"],
        },
      });
    }
    return out;
  }

  /** Effects of a confirmed Vault approval that the extension must mirror (the new everyday key, a linked Recovery key). */
  private async afterVault(): Promise<void> {
    if (!this.vault) return;
    const changed = await this.vault.refresh();
    for (const r of changed) {
      if (r.status !== "confirmed") continue;
      if (r.action.action === "vaultSetHotKey" && r.hotIndex !== undefined && (await this.keyring.isUnlocked())) {
        await this.keyring.useEverydayIndex(r.hotIndex);
      }
    }
  }

  async resolveApproval(id: string, approved: boolean, opts: { alwaysAllow?: boolean } = {}): Promise<void> {
    const approval = await this.approvals.store.get(id);
    if (!approval || approval.status !== "pending") return;
    if (approval.kind === "transaction") return this.resolveTransaction(approval, approved);
    if (approval.kind === "sign-in" || approval.kind === "permit")
      return this.resolveSignature(approval, approved, opts);
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
        await this.afterVault().catch(() => undefined);
        const vaultBusy = (await this.vault?.list())?.some((r) => r.status === "sending") ?? false;
        if ((await this.activity.pending()).length === 0 && !vaultBusy) break;
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
    "approval:resolve": async ({ id, approved, alwaysAllow }) => {
      await this.resolveApproval(id, approved, alwaysAllow ? { alwaysAllow } : {});
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
    "pair:vault": ({ text, confirm }) => this.pair("vault", text, confirm),
    "pair:recovery": ({ text, confirm }) => this.pair("recovery", text, confirm),
    "pair:recoveryTest": ({ text }) => this.recoveryTest(text),
    "pair:recoveryChallenge": () => this.recoveryChallenge(),
    "setup:setTokens": (req) => this.setTokens(req),
    "pair:forgetRecovery": async () => {
      await this.settings.setPaired("recovery", undefined);
      return null;
    },
    "account:computePlan": async ({ chainId }) => {
      const id = chainId ?? (await this.settings.get()).selectedChainId;
      await this.pay().computePlan(id);
      return this.pay().status(id);
    },
    "vault:create": async ({ chainId, action }) => {
      const id = chainId ?? (await this.settings.get()).selectedChainId;
      return this.afterCreate(await this.vf().create(id, await this.prepareAction(id, action)));
    },
    "approval:toVault": async ({ id }) => {
      const a = await this.approvals.store.get(id);
      if (!a || a.kind !== "transaction" || a.status !== "pending" || !a.tx) throw new Error("No such request.");
      const preview = await this.pay().preview(a.chainId, toCalls(a.tx.calls));
      return this.afterCreate(
        await this.vf().create(
          a.chainId,
          { type: "send", calls: a.tx.calls, usd6: String(Math.round(preview.route.amountUsd * 1e6)) },
          { origin: a.origin, approvalId: a.id },
        ),
      );
    },
    "vault:get": async ({ id }) => {
      if ((await this.vf().get(id))?.status === "sending") await this.afterVault().catch(() => undefined);
      return (await this.vf().get(id)) ?? null;
    },
    "vault:list": async () => {
      await this.afterVault().catch(() => undefined);
      return this.vf().list();
    },
    "vault:submit": async ({ id, signature }) => {
      const r = await this.vf().submit(id, signature);
      if (r.approvalId && r.hash) {
        // The dapp's eth_sendTransaction / wallet_sendCalls resolves with the Vault transaction's hash.
        await this.approvals
          .resolve(r.approvalId, "approved", { result: { activityId: r.id, hash: r.hash } })
          .catch(() => undefined);
      }
      void this.trackSoon();
      return r;
    },
    "vault:cancel": async ({ id }) => {
      await this.vf().cancelRequest(id);
      return null;
    },
    "vault:queue": async ({ chainId }) => {
      await this.afterVault().catch(() => undefined);
      return this.vf().queue(chainId ?? (await this.settings.get()).selectedChainId);
    },
    "vault:executeQueued": async ({ chainId, opId }) => ({
      hash: await this.vf().executeQueued(chainId ?? (await this.settings.get()).selectedChainId, opId),
    }),
    "vault:policy": async ({ chainId }) => this.policyView(chainId ?? (await this.settings.get()).selectedChainId),
    "vault:signers": async ({ chainId }) => this.signerViews(chainId ?? (await this.settings.get()).selectedChainId),
    "security:nextEverydayKey": async () => {
      const index = (await this.keyring.everydayIndex()) + 1;
      return { index, address: await this.keyring.everydayAt(index) };
    },
  };

  /**
   * A new request withdrew every older waiting one for the same signer (plan §30 §6.3). A dapp whose payment was
   * waiting on one of those learns it ended without a transaction, instead of hanging on a code that is now refused.
   */
  private async afterCreate(rec: Awaited<ReturnType<VaultFlow["create"]>>) {
    for (const r of await this.vf().list()) {
      if (r.error?.code !== "superseded" || !r.approvalId || r.approvalId === rec.approvalId) continue;
      await this.approvals
        .resolve(r.approvalId, "rejected", {
          denial: {
            leakedRule: "ROUTE-NEEDS-VAULT",
            explanation: "A newer Vault request replaced this one before the phone's approval was sent.",
          },
        })
        .catch(() => undefined);
    }
    return rec;
  }

  /**
   * Fills in what only the service worker knows before a Vault request is built: a later Recovery key's signer
   * address (linked with `vaultSetRecoverySigner`).
   */
  private async prepareAction(chainId: number, action: VaultActionRequest): Promise<VaultActionRequest> {
    if (action.type !== "setRecoverySigner") return action;
    const plan = await this.plans.get(chainId);
    const setup = await this.settings.getSetup();
    if (!plan || !setup.recovery) throw new VaultError("no-recovery", "Scan your Recovery key code first.");
    if (!setup.recovery.testedAt) {
      throw new VaultError(
        "no-recovery",
        "Finish the Recovery key test first (re-enter 6 words on the phone and scan its test code), so a key with a typo is never linked.",
      );
    }
    // 4337: the executor stores the Recovery key's PQ key itself (`setRecoveryKey`), no signer contract.
    if (plan.backend === "4337") return { type: "setRecoveryKey", pk: setup.recovery.pk };
    const net = findNetwork(chainId)!;
    const params = {
      salt: plan.salt,
      pk: setup.recovery.pk,
      verifier: net.deployment!.c13Verifier,
      // The v2 recovery test's payer (signed by the Recovery key): Path B for Recovery, no stake needed.
      payerKey: setup.recovery.payer ?? ("0x0000000000000000000000000000000000000000" as Address),
    };
    const signer = (await this.env.io!.publicClient(chainId).readContract({
      address: net.deployment!.roleSignerFactory,
      abi: roleSignerFactoryAbi,
      functionName: "predictRoleSigner",
      args: [params.salt, 2, plan.address, params.pk, params.verifier, params.payerKey],
    })) as Address;
    await this.plans.put({ ...plan, recoverySigner: signer, recoveryParams: params });
    return { type: "setRecoverySigner", signer };
  }
}

function toCalls(calls: ApprovalTx["calls"]): Call[] {
  return calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }));
}

export { PaymentsError, RouteError };
