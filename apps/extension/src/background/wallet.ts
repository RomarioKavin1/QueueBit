import {
  addSessionCalls,
  execTransactionCall,
  grantCalls,
  listGrants,
  readGrant,
  revokeGrantCalls,
  validateGrant,
  guardianRecoveryAbi,
  multiSendSafeTx,
  packSafeSignatures,
  pruneExpiredCall,
  revokeSessionCall,
  safeAbi,
  safeTxTypedData,
  type Call,
  type SafeTx,
} from "@queuebit/account";
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  getAddress,
  hashTypedData,
  hexToBytes,
  isAddress,
  isHex,
  recoverTypedDataAddress,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { Prover, RagequitProver } from "@queuebit/privacy";
import { LOCAL_DEVNET } from "../shared/build";
import { NO_DEPLOYMENT, findNetwork, getNetwork, toHexChainId } from "../shared/chains";
import { ProviderRpcError, RpcErrorCode, userRejected } from "../shared/errors";
import { StorageKeys, type KV } from "../shared/kv";
import type {
  ApprovalView,
  MigrationRequest,
  SafeTxJson,
  SendRequest,
  SignProof,
  TokenBalance,
  UiApi,
  UiType,
} from "../shared/messages";
import { anonStatusFor } from "../shared/offscreen";
import { siteWarning } from "../shared/sites";
import type { Approval, ApprovalTx, WalletState } from "../shared/types";
import type { KeysView, MigrationPreview, SendPreview } from "../shared/views";
import { ActivityStore, callsStatusCode, ethAmount, intentTitle, type ActivityEntry } from "./activity";
import { ApprovalBroker, ApprovalStore, TooManyPendingError, type ApprovalWindows } from "./approvals";
import {
  KeyringController,
  KeyringError,
  PRIVACY_PAYER_PATH,
  SESSION_PATH,
  SETUP_PATH,
  type KeyringOptions,
} from "./keyring";
import { AccountError, AccountService, type LeanIo } from "./lean/account";
import { grantView, mergeGrantSpec, type GrantRequest, type GrantView } from "./lean/grants";
import { readGuardians, readKeys, readRecoveries } from "./lean/keys";
import { quoteLegacy } from "./lean/legacy";
import { planMigration, readMigrationSource, readSafe, runMigration, type MigrationPlan } from "./lean/migrate";
import { OwnerKey, type PqKey } from "./lean/owner";
import {
  SessionStore,
  addSpend,
  sessionCovers,
  sessionIdOf,
  sessionSpec,
  type Coverage,
  type SessionRecord,
} from "./lean/sessions";
import type { OffscreenClient } from "./offscreen";
import { PermissionsStore } from "./permissions";
import { PrivacyController, type PaymentState } from "./privacy/controller";
import {
  routeProviderRequest,
  type CallsStatus,
  type ProviderRequest,
  type RequestContext,
  type RouterDeps,
} from "./router";
import { SettingsStore } from "./settings";

export interface WalletEnv {
  local: KV;
  session: KV;
  windows: ApprovalWindows;
  readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown>;
  getBalance(chainId: number, address: Address): Promise<bigint>;
  /** Push an event to connected dapp ports; `origin` filters to one site. */
  emit(event: "chainChanged" | "accountsChanged", data: unknown, origin?: string): void;
  /** Network clients per chain (node, sidecar, LeanPool node). */
  io?: LeanIo;
  /** Open the full app at a hash route (wallet_showCallsStatus). */
  openApp?(hash: string): Promise<void>;
  keyring?: KeyringOptions;
  /** The owner key's leanSPHINCS implementation (tests pass a stand-in; default: the WASM key). */
  pqKey?: (seed: Uint8Array) => PqKey;
  now?: () => number;
  /** The offscreen document (the withdraw prover). */
  offscreen?: OffscreenClient;
  /** A prover of the host's own (the web app's prover Worker, a Node script); wins over `offscreen`. */
  prover?: () => Prover & RagequitProver;
  /**
   * Every request that signs must carry the password or the passkey again (`proof`, checked here before any key is
   * used), not only an unlocked session. The web app sets it; the extension's pages don't send proofs yet.
   */
  confirmEachSignature?: boolean;
}

const PRIVACY_ORIGIN = "QueueBit Private balance";
/** Execution gas of a grant's and a revoke's SENDER frame (a grant writes a key, its allowlist and caps). */
const GRANT_GAS = 400_000n;
const REVOKE_GAS = 300_000n;

/**
 * The service worker's composition root: every controller reads and writes storage, so nothing important lives only in
 * SW memory (plan §30 §2.2). Pure enough to run in unit tests with in-memory KVs and fake network clients.
 */
export class Wallet {
  readonly keyring: KeyringController;
  readonly settings: SettingsStore;
  readonly permissions: PermissionsStore;
  readonly approvals: ApprovalBroker;
  readonly activity: ActivityStore;
  readonly owner: OwnerKey;
  readonly sessions: SessionStore;
  readonly account: AccountService | undefined;
  readonly privacy: PrivacyController | undefined;
  private readonly now: () => number;

  constructor(private readonly env: WalletEnv) {
    this.now = env.now ?? Date.now;
    this.keyring = new KeyringController(env.local, env.session, { now: this.now, ...env.keyring });
    this.settings = new SettingsStore(env.local);
    this.permissions = new PermissionsStore(env.local, this.now);
    this.approvals = new ApprovalBroker(new ApprovalStore(env.session, this.now), env.windows, this.now);
    this.activity = new ActivityStore(env.local, this.now);
    this.owner = new OwnerKey(env.local, this.keyring, env.pqKey);
    this.sessions = new SessionStore(env.local);
    this.account = env.io
      ? new AccountService({
          kv: env.local,
          io: env.io,
          keyring: this.keyring,
          owner: this.owner,
          activity: this.activity,
          now: this.now,
        })
      : undefined;
    this.privacy = this.account
      ? new PrivacyController({
          kv: env.local,
          session: env.session,
          keyring: this.keyring,
          account: async (chainId) => (await this.account!.record(chainId))?.address,
          pay: async (chainId, call, o) => {
            const e = await this.acct().pay(chainId, [{ to: call.target, value: call.value, data: call.data }], {
              origin: PRIVACY_ORIGIN,
              label: o.label,
              ...(o.gas ? { gas: o.gas } : {}),
            });
            void this.trackSoon();
            return { id: e.id };
          },
          payment: async (id) => {
            await this.refreshActivity();
            const e = await this.activity.get(id);
            return e ? paymentState(e) : undefined;
          },
          noteSigner: async () => ({
            address: await this.keyring.addressOf(PRIVACY_PAYER_PATH),
            signer: {
              // Signed for each request and never kept: the signature is the note's spend key.
              signEnvelope: (envelope) =>
                this.keyring.withKey(PRIVACY_PAYER_PATH, (k) => privateKeyToAccount(k).signTypedData(envelope)),
            },
          }),
          prover: () => {
            if (env.prover) return env.prover();
            if (!env.offscreen) throw new Error("The prover isn't available in this context.");
            return env.offscreen.prover();
          },
          anonStatus: async (chainId) => anonStatusFor(chainId, { harnessBundled: false }),
          localDevnet: LOCAL_DEVNET,
          now: this.now,
        })
      : undefined;
  }

  /** The engine's own check before a signature (see WalletEnv.confirmEachSignature): no proof, no signature. */
  private async consent(proof: SignProof | undefined): Promise<void> {
    if (!this.env.confirmEachSignature) return;
    if (!proof) throw new KeyringError("confirm", "Confirm with your passkey or password to sign.");
    await this.keyring.verify(
      "entropy" in proof ? { entropy: hexToBytes(proof.entropy) } : { password: proof.password },
    );
  }

  // ---- tokens ----

  private async customTokens(chainId: number): Promise<TokenInfo[]> {
    const all = (await this.env.local.get<Record<string, TokenInfo[]>>(StorageKeys.tokens)) ?? {};
    return all[String(chainId)] ?? [];
  }

  private async setCustomTokens(chainId: number, list: TokenInfo[]): Promise<void> {
    const all = (await this.env.local.get<Record<string, TokenInfo[]>>(StorageKeys.tokens)) ?? {};
    await this.env.local.set(StorageKeys.tokens, { ...all, [String(chainId)]: list });
  }

  /** The network's presets, then the ones added here. */
  private async tokens(chainId: number): Promise<Array<TokenInfo & { custom: boolean }>> {
    const presets = getNetwork(chainId).tokens.map((t) => ({
      token: t.token,
      symbol: t.symbol,
      name: t.name,
      decimals: t.decimals,
      custom: false,
    }));
    const known = new Set(presets.map((t) => t.token.toLowerCase()));
    const custom = (await this.customTokens(chainId))
      .filter((t) => !known.has(t.token.toLowerCase()))
      .map((t) => ({ ...t, custom: true }));
    return [...presets, ...custom];
  }

  private async token(chainId: number, address: Address): Promise<TokenInfo & { custom: boolean }> {
    const t = (await this.tokens(chainId)).find((x) => x.token.toLowerCase() === address.toLowerCase());
    if (!t) throw new Error("That token isn't in this wallet: add it first.");
    return t;
  }

  private async tokenBalance(chainId: number, token: Address): Promise<bigint> {
    const account = await this.accountFor(chainId);
    if (!account) return 0n;
    return this.env.io!.publicClient(chainId).readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [account],
    });
  }

  private async tokenList(chainId: number): Promise<TokenBalance[]> {
    const list = await this.tokens(chainId);
    return Promise.all(
      list.map(async (t) => ({
        ...t,
        balance: (await this.tokenBalance(chainId, t.token).catch(() => 0n)).toString(),
      })),
    );
  }

  /** Reads an ERC-20's symbol, name and decimals from the chain, and keeps it in this wallet's list. */
  private async addToken(chainId: number, address: Address): Promise<TokenBalance> {
    if (!isAddress(address, { strict: false })) throw new Error("That isn't a contract address.");
    const token = getAddress(address);
    const existing = (await this.tokens(chainId)).find((t) => t.token.toLowerCase() === token.toLowerCase());
    if (existing) return { ...existing, balance: (await this.tokenBalance(chainId, token).catch(() => 0n)).toString() };
    const c = this.env.io!.publicClient(chainId);
    const read = <T>(functionName: "symbol" | "name" | "decimals") =>
      c.readContract({ address: token, abi: erc20Abi, functionName }) as Promise<T>;
    let info: TokenInfo;
    try {
      const [symbol, decimals, name] = await Promise.all([
        read<string>("symbol"),
        read<number>("decimals"),
        read<string>("name").catch(() => ""),
      ]);
      if (!symbol || decimals > 36) throw new Error("not a token");
      info = { token, symbol: symbol.slice(0, 12), name: (name || symbol).slice(0, 40), decimals: Number(decimals) };
    } catch {
      throw new Error("No ERC-20 token answers at that address on this network.");
    }
    await this.setCustomTokens(chainId, [...(await this.customTokens(chainId)), info]);
    return { ...info, custom: true, balance: (await this.tokenBalance(chainId, token).catch(() => 0n)).toString() };
  }

  /** A send: ETH as the call's value, or a token's `transfer` from the account. */
  private async sendPlan(chainId: number, req: SendRequest) {
    const call = sendCall(req);
    if (!req.token) return { call, amount: BigInt(req.valueWei) };
    const t = await this.token(chainId, req.token);
    const balance = await this.tokenBalance(chainId, t.token);
    return { call, amount: BigInt(req.valueWei), token: t, balance };
  }

  private acct(): AccountService {
    if (!this.account) throw new Error("Accounts are not available in this context.");
    return this.account;
  }

  private priv(): PrivacyController {
    if (!this.privacy) throw new Error("Private balance is not available in this context.");
    return this.privacy;
  }

  private async chainOr(chainId?: number): Promise<number> {
    return chainId ?? (await this.settings.get()).selectedChainId;
  }

  /** The address a site sees on `chainId`: the account (computed once, while unlocked). */
  async accountFor(chainId: number): Promise<Address | undefined> {
    if (!this.account || !findNetwork(chainId)?.deployment) return undefined;
    const rec = await this.account.record(chainId);
    if (rec) return rec.address;
    if (!(await this.keyring.isUnlocked())) return undefined;
    return (await this.account.ensure(chainId).catch(() => undefined))?.address;
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
   * Read methods for sites. An owner payment is known to the site by its LeanPool id (what eth_sendTransaction
   * returned), which differs from the mined transaction's hash (LeanPool fills the witness): `eth_getTransactionReceipt`
   * for it answers with the mined transaction's receipt, `transactionHash` set to the id the site knows.
   */
  private async readRpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    if (method === "eth_getTransactionReceipt" && typeof params[0] === "string") {
      const e = await this.activity.findByHash(params[0] as Hex);
      if (e && e.via === "leanpool" && e.hash.toLowerCase() === params[0].toLowerCase()) {
        if (e.status === "confirming" || e.status === "sending") await this.refreshActivity();
        const cur = (await this.activity.get(e.id)) ?? e;
        if (!cur.txHash) return null;
        const r = (await this.env.readRpc(chainId, method, [cur.txHash])) as Record<string, unknown> | null;
        return r ? { ...r, transactionHash: params[0] } : null;
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
    if (await this.keyring.autoLockIfIdle(autoLockMinutes)) {
      this.onLocked();
      await this.emitAccountsToAll([]);
    }
    // A lock from elsewhere (session cleared, browser restart): keys held in memory must not stay.
    else if (!(await this.keyring.isUnlocked())) this.onLocked();
  }

  private onLocked(): void {
    this.owner.lock();
    this.privacy?.lock();
  }

  private async emitAccountsToAll(accounts: Address[]): Promise<void> {
    for (const p of await this.permissions.list()) this.env.emit("accountsChanged", accounts, p.origin);
  }

  /** The owner key counts at least what each account already did (signatures made on other devices). */
  private async syncOwnerBudget(): Promise<void> {
    if (!this.account || !(await this.owner.record())) return;
    for (const rec of Object.values(await this.account.all()))
      await this.account.syncOwnerCount(rec.chainId, rec.address).catch(() => undefined);
  }

  private async onUnlocked(): Promise<void> {
    // The count sync reads the chain (seconds on a slow node): unlocking doesn't wait for it, signing does.
    this.owner.after(this.syncOwnerBudget().catch(() => undefined));
    for (const p of await this.permissions.list()) {
      const account = await this.accountFor(await this.chainOfOrigin(p.origin));
      if (account) this.env.emit("accountsChanged", [account], p.origin);
    }
  }

  // ---- transactions from sites ----

  /** The site's session that covers `calls`, or why none does (reads the sessions from storage). */
  async matchSession(
    chainId: number,
    origin: string,
    calls: Call[],
  ): Promise<{ session: SessionRecord; coverage: Extract<Coverage, { ok: true }> } | { miss: string }> {
    const rec = await this.account?.record(chainId);
    const d = findNetwork(chainId)?.deployment;
    if (!rec || !d) return { miss: "No account yet." };
    const list = await this.sessions.forOrigin(chainId, rec.address, origin);
    if (!list.length) return { miss: "This site has no session." };
    const sc = calls.map((c) => ({ target: c.to, value: c.value ?? 0n, data: c.data ?? ("0x" as Hex) }));
    let miss = "";
    for (const s of list) {
      const c = sessionCovers(s, sc, this.now(), [d.keystore, d.hook, d.recovery]);
      if (c.ok) return { session: s, coverage: c };
      miss ||= c.reason;
    }
    return { miss };
  }

  /** One at a time per key: session sends of one site check, take a nonce, send and record without interleaving. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private async locked<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const run = prev.catch(() => undefined).then(fn);
    const tail = run.catch(() => undefined);
    this.locks.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  /**
   * Sends `calls` with the site's session if one covers them: under the site's lock, the sessions are re-read, the
   * lane checked, the nonce taken, the tx sent and the day's tally recorded, so two requests can't both pass on the
   * same allowance or nonce. Returns why not otherwise (the owner is asked instead).
   */
  private async sendWithSession(
    chainId: number,
    origin: string,
    calls: Call[],
    o: { batchId?: string } = {},
  ): Promise<{ entry: ActivityEntry } | { miss: string }> {
    return this.locked(`${chainId}:${origin}`, async () => {
      const m = await this.matchSession(chainId, origin, calls);
      if ("miss" in m) return m;
      const s = m.session;
      try {
        const entry = await this.keyring.withKey(SESSION_PATH(s.index), (k) =>
          this.acct().payWithSession(chainId, s, k, calls, { origin, ...o }),
        );
        await this.sessions.update(s.id, { spent: addSpend(s, m.coverage, this.now()) });
        void this.trackSoon();
        return { entry };
      } catch (err) {
        if (err instanceof AccountError) return { miss: err.message };
        throw err;
      }
    });
  }

  private async requestTransaction(
    ctx: RequestContext,
    chainId: number,
    tx: ApprovalTx,
  ): Promise<{ hash: Hex; activityId: string; batchId?: string }> {
    if (!findNetwork(chainId)?.deployment) {
      throw new ProviderRpcError(RpcErrorCode.unsupportedMethod, NO_DEPLOYMENT, { queuebitRule: "NO-DEPLOYMENT" });
    }
    const calls = toCalls(tx.calls);
    // A session is for a site, not for whatever page embeds it: only a top-level request (or a frame of the same
    // site) may use it. A session that covers the request: its key signs, no prompt.
    const topLevel = !ctx.embedded || ctx.topOrigin === ctx.origin;
    let sessionMiss: string | undefined;
    if (topLevel) {
      const r = await this.sendWithSession(chainId, ctx.origin, calls, tx.batchId ? { batchId: tx.batchId } : {});
      if ("entry" in r) {
        const e = r.entry;
        return { hash: e.hash, activityId: e.id, ...(e.batchId ? { batchId: e.batchId } : {}) };
      }
      sessionMiss = r.miss;
    } else {
      sessionMiss = "This request comes from a frame inside another page, so the site's session isn't used.";
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
          ...(sessionMiss ? { sessionMiss } : {}),
          ...(ctx.embedded ? { embedded: true, ...(ctx.topOrigin ? { topOrigin: ctx.topOrigin } : {}) } : {}),
        },
        ctx.requestId,
      );
    } catch (err) {
      if (err instanceof TooManyPendingError) throw new ProviderRpcError(RpcErrorCode.limitExceeded, err.message);
      throw err;
    }
    if (record.status === "approved" && record.result) return record.result;
    if (record.denial) throw new ProviderRpcError(RpcErrorCode.unauthorized, record.denial.explanation, record.denial);
    throw userRejected("The user rejected the transaction.");
  }

  private async callsStatus(origin: string, id: string): Promise<CallsStatus | null> {
    const entry =
      (await this.activity.findByBatchId(id, origin)) ??
      (/^0x[0-9a-fA-F]{64}$/u.test(id) ? await this.activity.findByHash(id as Hex) : undefined);
    if (!entry || entry.origin !== origin) return null;
    let e: ActivityEntry = entry;
    if (e.status === "confirming" || e.status === "sending") {
      await this.refreshActivity();
      e = (await this.activity.get(entry.id)) ?? entry;
    }
    const status = callsStatusCode(e);
    let receipts: unknown[] | undefined;
    if (status !== 100 && e.txHash) {
      const r = await this.env.readRpc(e.chainId, "eth_getTransactionReceipt", [e.txHash]).catch(() => null);
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
    if (!this.account || !findNetwork(chainId)?.deployment) return { atomic: { status: "unsupported" } };
    const queuebit: Record<string, unknown> = {};
    try {
      const rec = await this.account.record(chainId);
      if (rec) queuebit.activated = await this.account.deployed(chainId, rec.address);
    } catch {
      // capabilities stay minimal when the network is unreachable
    }
    return { atomic: { status: "supported" }, queuebit };
  }

  /** What an owner payment of `calls` costs at most, and whether the account can pay it. */
  async preview(chainId: number, calls: Call[], sessionMiss?: string): Promise<SendPreview> {
    const q = await this.acct().quote(chainId, calls);
    return {
      chainId,
      signer: "owner",
      ...(sessionMiss ? { sessionMiss } : {}),
      valueWei: q.value.toString(),
      maxFeeWei: q.maxFee.toString(),
      balanceWei: q.balance.toString(),
      enough: q.enough,
      deployed: q.deployed,
      effects: calls.map((c) =>
        intentTitle([{ target: c.to, value: (c.value ?? 0n).toString(), data: c.data ?? "0x" }]),
      ),
    };
  }

  private async approvalPreview(id: string): Promise<SendPreview> {
    const a = await this.approvals.store.get(id);
    if (!a || a.kind !== "transaction" || !a.tx) throw new Error("No such request.");
    const calls = toCalls(a.tx.calls);
    if (a.sessionMiss) return this.preview(a.chainId, calls, a.sessionMiss);
    const m = await this.matchSession(a.chainId, a.origin, calls);
    return this.preview(a.chainId, calls, "miss" in m ? m.miss : undefined);
  }

  async approvalView(id: string): Promise<ApprovalView | null> {
    const approval = await this.approvals.store.get(id);
    if (!approval) return null;
    const knownSite = await this.permissions.knownSite(approval.origin);
    const account = (await this.keyring.accounts()) ? await this.accountFor(approval.chainId) : undefined;
    const warn = siteWarning(approval.origin) ?? (approval.topOrigin ? siteWarning(approval.topOrigin) : null);
    return {
      approval,
      ...(knownSite ? { knownSite } : {}),
      ...(warn ? { siteWarning: warn } : {}),
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
        throw new KeyringError("locked", "Unlock QueueBit before connecting.");
      }
      await this.permissions.grant(approval.origin, [account], approval.chainId);
      this.env.emit("accountsChanged", [account], approval.origin);
    }
    await this.approvals.resolve(id, approved ? "approved" : "rejected");
  }

  /** The user approved a site's transaction: the owner key signs it and it goes to the LeanPool node. */
  private async resolveTransaction(approval: Approval, approved: boolean): Promise<void> {
    if (!approved) {
      await this.approvals.resolve(approval.id, "rejected");
      return;
    }
    if (!(await this.keyring.isUnlocked())) throw new KeyringError("locked", "Unlock QueueBit before approving.");
    try {
      const entry = await this.acct().pay(approval.chainId, toCalls(approval.tx!.calls), {
        origin: approval.origin,
        ...(approval.tx!.batchId ? { batchId: approval.tx!.batchId } : {}),
      });
      await this.approvals.resolve(approval.id, "approved", {
        result: { activityId: entry.id, hash: entry.hash, ...(entry.batchId ? { batchId: entry.batchId } : {}) },
      });
      void this.trackSoon();
    } catch (err) {
      if (err instanceof AccountError) {
        await this.approvals.resolve(approval.id, "rejected", {
          denial: { queuebitRule: `ACCOUNT-${err.reason.toUpperCase()}`, explanation: err.message },
        });
        return;
      }
      throw err;
    }
  }

  // ---- following what was sent ----

  /** Polls pending activity once and applies what finished (sessions added or removed). */
  async refreshActivity(): Promise<void> {
    if (!this.account) return;
    const done = await this.account.refresh();
    if (!done.length) return;
    for (const s of await this.sessions.list()) {
      const e = done.find((x) => x.id === s.activityId);
      if (!e) continue;
      const ok = e.status === "confirmed";
      if (s.status === "adding") await this.sessions.update(s.id, { status: ok ? "active" : "failed" });
      else if (s.status === "revoking") await this.sessions.update(s.id, { status: ok ? "revoked" : "active" });
    }
  }

  /** Poll pending transactions for a few minutes after a send (the popup also polls while open). */
  private tracking = false;
  async trackSoon(): Promise<void> {
    if (this.tracking || !this.account) return;
    this.tracking = true;
    try {
      for (let i = 0; i < 120; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        await this.refreshActivity().catch(() => undefined);
        if ((await this.activity.pending()).length === 0) break;
      }
    } finally {
      this.tracking = false;
    }
  }

  // ---- sessions ----

  private async createSession(req: UiApi["sessions:create"]["req"]): Promise<SessionRecord> {
    const chainId = await this.chainOr(req.chainId);
    const account = this.acct();
    const d = account.deployment(chainId);
    const rec = await account.ensure(chainId);
    const index = await this.sessions.nextIndex();
    const signer = await this.keyring.addressOf(SESSION_PATH(index));
    const spec = sessionSpec({ ...req, chainId }, signer, Math.floor(this.now() / 1000));
    const host = hostOf(req.origin);
    const entry = await account.pay(chainId, addSessionCalls(d, spec), {
      kind: "admin",
      // A new key, its targets and its caps are new storage: more state gas than a payment.
      gas: { state: 900_000n },
      label: `Adding a session for ${host}`,
      doneLabel: `Session added for ${host}`,
    });
    const s: SessionRecord = {
      id: sessionIdOf(signer),
      chainId,
      account: rec.address,
      origin: req.origin,
      index,
      signer,
      validUntil: spec.validUntil,
      perTxEth: spec.perTxEth.toString(),
      dailyEth: spec.dailyEth.toString(),
      targets: spec.targets,
      tokens: (spec.tokens ?? []).map((t) => ({
        token: t.token,
        perTx: t.perTx.toString(),
        daily: t.daily.toString(),
      })),
      status: "adding",
      activityId: entry.id,
      createdAt: this.now(),
    };
    await this.sessions.put(s);
    void this.trackSoon();
    return s;
  }

  private async revokeSession(id: Hex): Promise<SessionRecord> {
    const s = await this.sessions.get(id);
    if (!s) throw new Error("No such session.");
    if (s.status !== "active" && s.status !== "failed") throw new Error("This session is already ending.");
    const account = this.acct();
    const host = hostOf(s.origin);
    const entry = await account.pay(s.chainId, [revokeSessionCall(account.deployment(s.chainId), s.id)], {
      kind: "admin",
      label: `Ending the session for ${host}`,
      doneLabel: `Session ended for ${host}`,
    });
    void this.trackSoon();
    return (await this.sessions.update(id, { status: "revoking", activityId: entry.id }))!;
  }

  // ---- spending permissions (grants) ----

  /** The account's grants as the chain holds them (nothing is kept here: every device shows the same). */
  private async grantList(chainId: number): Promise<GrantView[]> {
    const account = this.acct();
    const rec = await account.ensure(chainId);
    if (!(await account.deployed(chainId, rec.address))) return [];
    const client = this.env.io!.publicClient(chainId);
    const nowSec = Math.floor(this.now() / 1000);
    const [list, tokens] = await Promise.all([
      listGrants(client, account.deployment(chainId), rec.address, nowSec),
      this.tokens(chainId),
    ]);
    return list.map((g) => grantView(g, tokens));
  }

  /** Grants (or changes) one asset for a person: what they have on chain, with this asset set, in one admin tx. */
  private async createGrant(req: GrantRequest): Promise<ActivityEntry> {
    const chainId = await this.chainOr(req.chainId);
    const account = this.acct();
    const d = account.deployment(chainId);
    const rec = await account.ensure(chainId);
    if (!(await account.deployed(chainId, rec.address)))
      throw new AccountError("not-created", "Create your account first (your first payment does it).");
    if (!isAddress(req.delegate, { strict: false }))
      throw new Error("Enter the wallet address of the person you're letting spend (0x + 40 characters).");
    const client = this.env.io!.publicClient(chainId);
    const nowSec = Math.floor(this.now() / 1000);
    const current = await readGrant(client, d, rec.address, getAddress(req.delegate), nowSec);
    const spec = mergeGrantSpec(current, req, await this.tokens(chainId), nowSec);
    validateGrant(d, rec.address, spec, nowSec);
    const who = shortAddress(spec.delegate);
    const entry = await account.pay(chainId, grantCalls(d, spec, current), {
      kind: "admin",
      // A new key, its allowlist and its caps are new storage (measured on the devnet: grants-live.ts).
      gas: { execution: GRANT_GAS, state: 900_000n },
      label: `Letting ${who} spend`,
      doneLabel: `${who} can spend from your account`,
    });
    void this.trackSoon();
    return entry;
  }

  private async revokeGrant(chainId: number, delegate: Address): Promise<ActivityEntry> {
    const account = this.acct();
    const d = account.deployment(chainId);
    const rec = await account.ensure(chainId);
    const client = this.env.io!.publicClient(chainId);
    const current = await readGrant(client, d, rec.address, getAddress(delegate), Math.floor(this.now() / 1000));
    if (!current.active) throw new Error("This person has no permission to remove.");
    const who = shortAddress(current.delegate);
    const entry = await account.pay(chainId, revokeGrantCalls(d, current), {
      kind: "admin",
      gas: { execution: REVOKE_GAS, state: 200_000n },
      label: `Removing ${who}'s permission`,
      doneLabel: `${who} can no longer spend`,
    });
    void this.trackSoon();
    return entry;
  }

  // ---- keys & recovery ----

  private async keysView(chainId: number): Promise<KeysView> {
    const account = this.acct();
    const d = account.deployment(chainId);
    const rec = await account.ensure(chainId);
    const client = this.env.io!.publicClient(chainId);
    const deployed = await account.deployed(chainId, rec.address);
    const nowSec = Math.floor(this.now() / 1000);
    const [keys, guardians, recoveries] = deployed
      ? await Promise.all([
          readKeys(client, d, rec.address, rec.vk, nowSec),
          readGuardians(client, d, rec.address, rec.liveGuardians?.guardians ?? rec.guardians),
          readRecoveries(client, d, rec.address).catch(() => []),
        ])
      : [[], (rec.liveGuardians?.guardians ?? rec.guardians).map((address) => ({ address, active: false })), []];
    return {
      chainId,
      deployed,
      keys,
      guardians,
      recoveries,
      ownerSignaturesLeft: await this.owner.remaining(),
      ownerSignatureBudget: this.owner.budget,
    };
  }

  // ---- move to quantum-safe ----

  private async migrationPlan(req: MigrationRequest): Promise<{ chainId: number; plan: MigrationPlan }> {
    const chainId = await this.chainOr(req.chainId);
    const account = this.acct();
    const d = account.deployment(chainId);
    const target = account.planOf(await account.ensure(chainId));
    for (const k of req.keys) {
      if (!isHex(k) || k.length !== 66) throw new Error("A private key is 32 bytes of hex (0x + 64 characters).");
    }
    const imported = req.keys.map((k) => privateKeyToAccount(k).address);
    let address = req.address;
    if (address !== undefined && !isAddress(address, { strict: false })) throw new Error("That isn't an address.");
    if (req.kind === "eoa" && req.external) {
      if (!address) throw new Error("Connect the wallet to move from.");
      if (req.keys.length) throw new Error("A connected wallet signs for itself: don't import its key too.");
      if (req.keepAddress) throw new Error("Keeping the address needs the wallet's key (EIP-7702); move it instead.");
    } else if (req.kind === "eoa") {
      const from = imported[0];
      if (!from) throw new Error("Import the address's private key.");
      if (address && address.toLowerCase() !== from.toLowerCase())
        throw new Error("That key doesn't belong to this address.");
      address = from;
    }
    if (!address) throw new Error("Enter the address to move from.");
    const client = this.env.io!.publicClient(chainId);
    const net = getNetwork(chainId);
    const src = await readMigrationSource(
      client,
      address,
      net.tokens.map((t) => t.token),
    );
    const safe = req.kind === "safe" ? await readSafe(client, address) : undefined;
    if (req.kind === "smart-account" && imported.length !== 1) throw new Error("Import the account's owner key.");
    const plan = planMigration(d, target, src, {
      kind: req.kind,
      ...(req.keepAddress ? { keepAddress: true } : {}),
      ...(safe ? { safe: { owners: safe.owners, threshold: safe.threshold, signers: imported } } : {}),
      ...(req.kind === "safe" && req.external ? { external: true } : {}),
    });
    return { chainId, plan };
  }

  private migrationView(chainId: number, p: MigrationPlan, safe?: { owners: Address[]; threshold: number }) {
    const net = getNetwork(chainId);
    return {
      kind: p.kind,
      mode: p.mode,
      source: p.source,
      destination: p.destination,
      ethWei: p.eth.toString(),
      tokens: p.tokens.map((t) => {
        const preset = net.tokens.find((x) => x.token.toLowerCase() === t.token.toLowerCase());
        return { token: t.token, ...(preset ? { symbol: preset.symbol } : {}), amount: t.balance.toString() };
      }),
      ...(p.warning ? { warning: p.warning } : {}),
      steps: p.steps,
      ...(safe ? { safe } : {}),
    } satisfies MigrationPreview;
  }

  private async runMigration(req: MigrationRequest): Promise<{ hashes: Hex[] }> {
    const { chainId, plan } = await this.migrationPlan(req);
    const account = this.acct();
    const hashes = await runMigration(
      {
        client: this.env.io!.publicClient(chainId),
        chainId,
        d: account.deployment(chainId),
        withSetupKey: (fn) => this.keyring.withKey(SETUP_PATH, fn),
        onSent: async ({ label, hash, from }) => {
          const now = this.now();
          await this.activity.add({
            id: crypto.randomUUID(),
            chainId,
            kind: "migration",
            signer: plan.mode === "safe-move" ? "setup" : "imported",
            via: "legacy",
            account: from,
            calls: [],
            status: "confirming",
            hash,
            headline: `Move to quantum-safe: ${label.toLowerCase()}`,
            createdAt: now,
            updatedAt: now,
          });
        },
      },
      plan,
      req.keys,
    );
    void this.trackSoon();
    return { hashes };
  }

  // ---- UI ----

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
      // Restored from words: the user has them already.
      await this.settings.updateSetup({ backupConfirmedAt: this.now() });
      return null;
    },
    "keyring:revealWords": async ({ password }) => ({ mnemonic: await this.keyring.revealWords(password) }),
    "keyring:unlock": async ({ password }) => {
      await this.keyring.unlock(password);
      await this.onUnlocked();
      return null;
    },
    "keyring:createFromPasskey": async ({ entropy, credentialId }) => {
      await this.keyring.createFromPasskey(hexToBytes(entropy), credentialId);
      return null;
    },
    "keyring:unlockWithPasskey": async ({ entropy }) => {
      await this.keyring.unlockWithPasskey(hexToBytes(entropy));
      await this.onUnlocked();
      return null;
    },
    "keyring:revealWordsWithPasskey": async ({ entropy }) => ({
      mnemonic: await this.keyring.revealWordsWithPasskey(hexToBytes(entropy)),
    }),
    "keyring:passkeyInfo": async () => (await this.keyring.passkeyInfo()) ?? null,
    "keyring:verify": async (req) => {
      await this.keyring.verify("entropy" in req ? { entropy: hexToBytes(req.entropy) } : { password: req.password });
      return null;
    },
    "keyring:lock": async () => {
      await this.keyring.lock();
      this.onLocked();
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
      await this.account?.clear();
      await this.sessions.clear();
      await this.owner.clear();
      await this.activity.clear();
      this.privacy?.lock();
      return null;
    },
    "settings:update": async (patch) => {
      if (patch.selectedChainId !== undefined) await this.switchChain(patch.selectedChainId);
      return this.settings.update(patch);
    },
    "setup:update": (patch) => this.settings.updateSetup(patch),
    "wallet:balance": async ({ chainId }) => {
      const id = await this.chainOr(chainId);
      const account = await this.accountFor(id);
      if (!account) throw new KeyringError("missing", "No account yet.");
      const net = getNetwork(id);
      const wei = await this.env.getBalance(id, account);
      return { chainId: id, wei: wei.toString(), ...net.currency, fetchedAt: this.now() };
    },
    "permissions:list": () => this.permissions.list(),
    "permissions:revoke": async ({ origin }) => {
      if (await this.permissions.revoke(origin)) this.env.emit("accountsChanged", [], origin);
      return null;
    },
    "approval:get": ({ id }) => this.approvalView(id),
    "approval:resolve": async ({ id, approved, proof }) => {
      if (approved) await this.consent(proof);
      await this.resolveApproval(id, approved);
      return null;
    },
    "approval:preview": ({ id }) => this.approvalPreview(id),
    "account:status": async ({ chainId }) => this.acct().status(await this.chainOr(chainId)),
    "account:setGuardians": async ({ chainId, guardians, threshold }) => {
      const id = await this.chainOr(chainId);
      for (const g of guardians) if (!isAddress(g, { strict: false })) throw new Error(`${g} isn't an address.`);
      await this.acct().ensure(id, { guardians, guardianThreshold: threshold });
      return this.acct().status(id);
    },
    "account:updateGuardians": async ({ chainId, guardians, threshold, proof }) => {
      const id = await this.chainOr(chainId);
      for (const g of guardians) if (!isAddress(g, { strict: false })) throw new Error(`${g} isn't an address.`);
      // After creation, the owner key signs the change; before, it only changes what creation will set.
      if ((await this.acct().status(id)).deployed) await this.consent(proof);
      const { entry } = await this.acct().updateGuardians(id, guardians, threshold);
      if (entry) void this.trackSoon();
      return { ...(entry ? { entry } : {}), status: await this.acct().status(id) };
    },
    "account:activate": async ({ chainId, proof }) => {
      await this.consent(proof);
      const entry = await this.acct().activate(await this.chainOr(chainId));
      void this.trackSoon();
      return entry;
    },
    "send:preview": async (req) => {
      const id = await this.chainOr(req.chainId);
      const s = await this.sendPlan(id, req);
      const p = await this.preview(id, [s.call]);
      if (!s.token) return p;
      return {
        ...p,
        enough: p.enough && s.balance >= s.amount,
        effects: [`${formatUnits(s.amount, s.token.decimals)} ${s.token.symbol} to ${shortAddress(req.to)}`],
        token: {
          token: s.token.token,
          symbol: s.token.symbol,
          decimals: s.token.decimals,
          balance: s.balance.toString(),
        },
      };
    },
    "send:submit": async ({ proof, ...req }) => {
      await this.consent(proof);
      const id = await this.chainOr(req.chainId);
      const s = await this.sendPlan(id, req);
      if (s.token && s.balance < s.amount)
        throw new AccountError(
          "funds",
          `Your account has ${formatUnits(s.balance, s.token.decimals)} ${s.token.symbol}; this sends ${formatUnits(s.amount, s.token.decimals)}.`,
        );
      const label = s.token
        ? `${formatUnits(s.amount, s.token.decimals)} ${s.token.symbol} to ${shortAddress(req.to)}`
        : undefined;
      const entry = await this.acct().pay(id, [s.call], label ? { label, doneLabel: `Paid ${label}` } : {});
      void this.trackSoon();
      return entry;
    },
    "tokens:list": async ({ chainId }) => this.tokenList(await this.chainOr(chainId)),
    "tokens:add": async ({ chainId, token }) => this.addToken(await this.chainOr(chainId), token),
    "tokens:remove": async ({ chainId, token }) => {
      const id = await this.chainOr(chainId);
      await this.setCustomTokens(
        id,
        (await this.customTokens(id)).filter((t) => t.token.toLowerCase() !== token.toLowerCase()),
      );
      return null;
    },
    "activity:list": async () => {
      if ((await this.activity.pending()).length > 0) await this.refreshActivity().catch(() => undefined);
      return this.activity.list();
    },

    "sessions:list": async ({ chainId }) => {
      const id = await this.chainOr(chainId);
      return (await this.sessions.list()).filter((s) => s.chainId === id);
    },
    "sessions:create": async ({ proof, ...req }) => {
      await this.consent(proof);
      return this.createSession(req);
    },
    "sessions:revoke": async ({ id, proof }) => {
      await this.consent(proof);
      return this.revokeSession(id);
    },

    "grants:list": async ({ chainId }) => this.grantList(await this.chainOr(chainId)),
    "grants:create": async ({ proof, ...req }) => {
      await this.consent(proof);
      return this.createGrant(req);
    },
    "grants:revoke": async ({ chainId, delegate, proof }) => {
      await this.consent(proof);
      return this.revokeGrant(await this.chainOr(chainId), delegate);
    },

    "keys:view": async ({ chainId }) => this.keysView(await this.chainOr(chainId)),
    "keys:prune": async ({ chainId, ids, proof }) => {
      await this.consent(proof);
      const id = await this.chainOr(chainId);
      const account = this.acct();
      const rec = await account.ensure(id);
      if (!ids.length) throw new Error("Nothing to remove.");
      const d = account.deployment(id);
      const entry = await account.pay(
        id,
        ids.map((k) => pruneExpiredCall(d, rec.address, k)),
        { kind: "admin", label: `Removing ${ids.length} ended key${ids.length > 1 ? "s" : ""}` },
      );
      void this.trackSoon();
      return entry;
    },
    "keys:cancelRecovery": async ({ chainId, id, proof }) => {
      await this.consent(proof);
      const cid = await this.chainOr(chainId);
      const account = this.acct();
      const d = account.deployment(cid);
      const entry = await account.pay(
        cid,
        [
          {
            to: d.recovery,
            data: encodeFunctionData({ abi: guardianRecoveryAbi, functionName: "cancel", args: [id] }),
          },
        ],
        { kind: "admin", label: "Cancelling a recovery", doneLabel: "Recovery cancelled" },
      );
      void this.trackSoon();
      return entry;
    },

    "migrate:preview": async (req) => {
      const { chainId, plan } = await this.migrationPlan(req);
      const safe = req.kind === "safe" ? await readSafe(this.env.io!.publicClient(chainId), plan.source) : undefined;
      return this.migrationView(chainId, plan, safe ? { owners: safe.owners, threshold: safe.threshold } : undefined);
    },
    "migrate:run": async ({ proof, ...req }) => {
      await this.consent(proof);
      return this.runMigration(req);
    },
    "migrate:safeTx": async ({ chainId: cid, address }) => {
      const { chainId, plan } = await this.migrationPlan({
        chainId: cid,
        kind: "safe",
        address,
        keys: [],
        external: true,
      });
      const d = this.acct().deployment(chainId);
      if (plan.mode !== "safe-upgrade" && !d.multiSend)
        throw new Error("This network has no MultiSend contract, so a Safe can't move here.");
      const client = this.env.io!.publicClient(chainId);
      const safe = await readSafe(client, address);
      const up = plan.mode === "safe-upgrade" ? plan.calls[0]! : undefined;
      const tx: SafeTx = up
        ? {
            to: up.to,
            value: 0n,
            data: up.data ?? ("0x" as Hex),
            operation: 1, // DELEGATECALL: the helper runs as the Safe
            safeTxGas: 0n,
            baseGas: 0n,
            gasPrice: 0n,
            gasToken: "0x0000000000000000000000000000000000000000",
            refundReceiver: "0x0000000000000000000000000000000000000000",
            nonce: safe.nonce,
          }
        : multiSendSafeTx(d.multiSend!, plan.calls, safe.nonce);
      const typed = safeTxTypedData(chainId, address, tx);
      const json: SafeTxJson = safeTxToJson(tx);
      return {
        chainId,
        safe: address,
        owners: safe.owners,
        threshold: safe.threshold,
        destination: plan.destination,
        steps: plan.steps,
        tx: json,
        hash: hashTypedData(typed),
        typedData: JSON.stringify({
          types: {
            EIP712Domain: [
              { name: "chainId", type: "uint256" },
              { name: "verifyingContract", type: "address" },
            ],
            ...typed.types,
          },
          primaryType: typed.primaryType,
          domain: { chainId, verifyingContract: address },
          message: json,
        }),
      };
    },
    "migrate:safeExec": async ({ chainId: cid, safe: address, tx: json, signatures }) => {
      const chainId = await this.chainOr(cid);
      const client = this.env.io!.publicClient(chainId);
      const tx = safeTxFromJson(json);
      const safe = await readSafe(client, address);
      if (tx.nonce !== safe.nonce) throw new Error("The Safe has moved on since this was signed: start again.");
      const owners = new Set(safe.owners.map((o) => o.toLowerCase()));
      const typed = safeTxTypedData(chainId, address, tx);
      const valid = new Map<string, { owner: Address; signature: Hex }>();
      for (const s of signatures) {
        const who = (await recoverTypedDataAddress({ ...typed, signature: s.signature })).toLowerCase();
        if (who !== s.owner.toLowerCase() || !owners.has(who))
          throw new Error(`A signature isn't from an owner of this Safe (${s.owner}).`);
        valid.set(who, { owner: s.owner, signature: s.signature });
      }
      if (valid.size < safe.threshold)
        throw new Error(`This Safe needs ${safe.threshold} owner signatures; ${valid.size} so far.`);
      const onChain = await client.readContract({
        address,
        abi: safeAbi,
        functionName: "getTransactionHash",
        args: [
          tx.to,
          tx.value,
          tx.data,
          tx.operation,
          tx.safeTxGas,
          tx.baseGas,
          tx.gasPrice,
          tx.gasToken,
          tx.refundReceiver,
          tx.nonce,
        ],
      });
      if (onChain !== hashTypedData(typed)) throw new Error("The Safe computes a different transaction hash.");
      const call = execTransactionCall(address, tx, packSafeSignatures([...valid.values()]));
      return { to: call.to, valueWei: "0", data: call.data ?? ("0x" as Hex) };
    },
    "migrate:calls": async (req) => {
      const { chainId, plan } = await this.migrationPlan({ ...req, external: true, keys: [] });
      if (plan.mode !== "move") throw new Error("A connected wallet can only move into a new account.");
      const transfers = plan.calls.slice(0, -1).map((c) => ({
        to: c.to,
        valueWei: (c.value ?? 0n).toString(),
        data: c.data ?? ("0x" as Hex),
      }));
      return { chainId, source: plan.source, destination: plan.destination, calls: transfers };
    },
    "migrate:sweep": async (req) => {
      const { chainId, plan } = await this.migrationPlan({ ...req, external: true, keys: [] });
      if (plan.mode !== "move") throw new Error("A connected wallet can only move into a new account.");
      const last = plan.calls[plan.calls.length - 1]!;
      const client = this.env.io!.publicClient(chainId);
      const q = await quoteLegacy(client, plan.source, { ...last, value: 0n });
      // The wallet may price the fee a little above the quote: hold back 30% more than the quoted fee.
      const reserve = (q.fee * 13n) / 10n;
      const balance = await client.getBalance({ address: plan.source });
      if (balance <= reserve) throw new Error("There isn't enough ETH left to pay the fee of the last step.");
      return {
        to: last.to,
        valueWei: (balance - reserve).toString(),
        data: last.data ?? ("0x" as Hex),
        gas: q.gas.toString(),
        gasPrice: q.gasPrice.toString(),
        leftoverWei: (reserve - q.fee).toString(),
      };
    },

    "privacy:view": async ({ chainId }) => this.priv().view(await this.chainOr(chainId)),
    "privacy:sync": async ({ chainId }) => this.priv().sync(await this.chainOr(chainId)),
    "privacy:start": async ({ chainId, kind, amountWei, note, to, proof }) => {
      await this.consent(proof);
      return this.priv().start(await this.chainOr(chainId), kind, amountWei, note, to);
    },
    "privacy:retry": async ({ chainId, opId, proof }) => {
      await this.consent(proof);
      return this.priv().retry(await this.chainOr(chainId), opId);
    },
    "privacy:cancel": async ({ chainId, opId }) => this.priv().cancel(await this.chainOr(chainId), opId),
    "privacy:dismiss": async ({ chainId }) => this.priv().dismiss(await this.chainOr(chainId)),
    "privacy:saveConfig": async (req) => {
      const chainId = await this.chainOr(req.chainId);
      if (!LOCAL_DEVNET || chainId !== 1337) throw new Error("Private-balance contracts are fixed on this network.");
      return this.priv().saveConfig({ ...req, chainId });
    },
    "privacy:connection": async ({ chainId }) => {
      const id = await this.chainOr(chainId);
      return { ...anonStatusFor(id, { harnessBundled: false }), enabled: (await this.settings.get()).anonRpc };
    },
  };
}

function toCalls(calls: ApprovalTx["calls"]): Call[] {
  return calls.map((c) => ({ to: c.target, value: BigInt(c.value), data: c.data }));
}

interface TokenInfo {
  token: Address;
  symbol: string;
  name: string;
  decimals: number;
}

function sendCall(req: SendRequest): Call {
  if (!isAddress(req.to, { strict: false })) throw new Error("That isn't an address.");
  if (!/^\d+$/u.test(req.valueWei) || BigInt(req.valueWei) <= 0n) throw new Error("Enter an amount.");
  if (req.token) {
    if (!isAddress(req.token, { strict: false })) throw new Error("That isn't a token address.");
    return {
      to: req.token,
      value: 0n,
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [req.to, BigInt(req.valueWei)] }),
    };
  }
  return { to: req.to, value: BigInt(req.valueWei), data: "0x" };
}

const shortAddress = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

function paymentState(e: ActivityEntry): PaymentState {
  return {
    status: e.status,
    headline: e.headline,
    ...(e.txHash ? { txHash: e.txHash } : {}),
    ...(e.detail ? { detail: e.detail } : {}),
  };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export { AccountError, ethAmount };

const safeTxToJson = (t: SafeTx): SafeTxJson => ({
  to: t.to,
  value: t.value.toString(),
  data: t.data,
  operation: t.operation,
  safeTxGas: t.safeTxGas.toString(),
  baseGas: t.baseGas.toString(),
  gasPrice: t.gasPrice.toString(),
  gasToken: t.gasToken,
  refundReceiver: t.refundReceiver,
  nonce: t.nonce.toString(),
});

const safeTxFromJson = (j: SafeTxJson): SafeTx => ({
  to: j.to,
  value: BigInt(j.value),
  data: j.data,
  operation: j.operation,
  safeTxGas: BigInt(j.safeTxGas),
  baseGas: BigInt(j.baseGas),
  gasPrice: BigInt(j.gasPrice),
  gasToken: j.gasToken,
  refundReceiver: j.refundReceiver,
  nonce: BigInt(j.nonce),
});

