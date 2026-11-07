import {
  decodeEventLog,
  decodeFunctionResult,
  encodeFunctionData,
  getAddress,
  isAddress,
  parseGwei,
  type Address,
  type Hex,
} from "viem";
import { getProfile, type FrameTxReceipt } from "@queuebit/frames";
import {
  EncryptedStorage,
  FramePaymasterBroadcaster,
  POOL_ABI,
  POOL_PAYER_ABI,
  POOL_PAYER_LITE_LIMITS,
  PrivacyPoolsV1Client,
  buildRagequitTx,
  createHostProvider,
  createSignatureSecretManager,
  directNetwork,
  eip1193FromTransport,
  importStorageKey,
  isolationKeyFor,
  networkTransport,
  ragequitInputs,
  readPoolPayerRules,
  refreshPublicNotes,
  withdrawalClients as newWithdrawalClients,
  type EnvelopeSigner,
  type HostProvider,
  type Note,
  type Prover,
  type PublicNote,
  type RagequitProver,
  type StorageBackend,
} from "@queuebit/privacy";
import { findNetwork, getNetwork } from "../../shared/chains";
import type { KV } from "../../shared/kv";
import type { AnonStatus } from "../../shared/offscreen";
import type { NoteView, PrivacyNetworkConfig, PrivacyOp, PrivacyView, SyncProgress } from "../../shared/privacy";
import type { KeyringController } from "../keyring";
import { PrivacyConfigStore, poolOrderAsp, validatePrivacyConfig, type PrivacyConfigInput } from "./config";
import { failureFor, isFinal, newOp, proofEstimate, transition, upgradeOp, type PrivacyEvent } from "./machine";

export const PRIVACY_STATE_KEY = (chainId: number) => `queuebit:privacy:${chainId}`;
const HISTORY = 20;

/**
 * Persisted per chain in storage.local (public data only: amounts, indices, hashes). The note LEDGER (public note
 * data: precommitments, commitments, labels, values, nullifier hashes; never a nullifier, secret or signature) and the
 * pool state live in the seed-keyed encrypted store; the note signatures (the spend keys) are made again when needed
 * and never stored.
 */
export interface PrivacyRecord {
  account?: Address;
  /** Deposits this browser knows it made: discovery stops there, so a refresh never signs note keys. */
  depositsMade: number;
  sync: SyncProgress;
  balance?: { approvedWei: string; pendingWei: string; notes: NoteView[]; syncedTo: string; at: number };
  op?: PrivacyOp;
  history: PrivacyOp[];
  proofMs: number[];
  /** The note signer whose signatures were checked to be deterministic (once). */
  deterministicPayer?: Address;
}

const EMPTY: PrivacyRecord = { depositsMade: 0, sync: { status: "idle" }, history: [], proofMs: [] };

/** A payment the private balance asked the account to make, as Activity sees it. */
export interface PaymentState {
  status: "sending" | "confirming" | "confirmed" | "failed";
  txHash?: Hex;
  headline: string;
  detail?: string;
}

export interface PrivacyDeps {
  kv: KV;
  session: KV;
  keyring: KeyringController;
  /** The account's address on `chainId` (undefined until it exists). */
  account(chainId: number): Promise<Address | undefined>;
  /** An owner payment from the account (signed with the owner key, sent through LeanPool). Returns its activity id. */
  pay(
    chainId: number,
    call: { target: Address; value: bigint; data: Hex },
    o: { label: string; gas?: { execution: bigint; state: bigint } },
  ): Promise<{ id: string }>;
  /** A payment's state, polled from the network first. */
  payment(activityId: string): Promise<PaymentState | undefined>;
  /** The note signer: the privacy payer key (keyring PRIVACY_PAYER_PATH), which signs the note envelopes. */
  noteSigner(): Promise<{ address: Address; signer: EnvelopeSigner }>;
  /** The offscreen document's prover (withdrawals, and the commitment circuit for the public exit). */
  prover: () => Prover & RagequitProver;
  anonStatus: (chainId: number) => Promise<AnonStatus>;
  localDevnet: boolean;
  now?: () => number;
  /** Tests: the account-circuit reads (default: the network's RPC, direct). */
  provider?: (chainId: number) => HostProvider;
  /** Tests: a withdrawal's own node + sidecar clients (default: `withdrawalClients`, a fresh circuit each time). */
  withdrawalClients?: typeof newWithdrawalClients;
  /** Tests: how long to wait between polls of a payment (default 2 s). */
  pollMs?: number;
}

/** The private balance's contracts on `chainId`: the ones saved in Settings, else the ones QueueBit ships with. */
export function builtInPrivacyConfig(chainId: number): PrivacyNetworkConfig | undefined {
  const p = findNetwork(chainId)?.privacy;
  if (!p) return undefined;
  return {
    chainId,
    entrypoint: getAddress(p.entrypoint),
    pool: getAddress(p.pool),
    poolPayer: getAddress(p.poolPayer),
    deployBlock: p.deployBlock,
    sidecarUrl: p.sidecarUrl,
    asp: "pool-order",
    savedAt: 0,
    payer: p.payer,
    builtIn: true,
  };
}

/**
 * The withdrawal transaction's fees: twice the node's gas price plus a 1 gwei tip (the account's own payments use the
 * same rule). The fee taken from the withdrawal is the transaction's max cost at these fees, and `refund()` returns
 * everything the network didn't charge.
 */
export function withdrawalFees(gasPrice: bigint): { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } {
  const tip = parseGwei("1");
  return { maxFeePerGas: 2n * gasPrice + tip, maxPriorityFeePerGas: tip };
}

/**
 * What a mined withdrawal paid out, from the fee payer's own events: `Settled.paid` to the recipient, plus the
 * `Refunded` amount when it went to the same address. No `Settled` event: the settle frame failed (the transaction was
 * mined, but nothing was withdrawn), which is an error, never a success.
 */
export function withdrawalPayout(receipt: FrameTxReceipt, payer: Address, recipient: Address): bigint {
  const logs = receipt.frameReceipts.flatMap((f) => f.logs);
  let paid: bigint | undefined;
  let refunded = 0n;
  for (const l of logs) {
    if (l.address.toLowerCase() !== payer.toLowerCase()) continue;
    let ev;
    try {
      ev = decodeEventLog({ abi: POOL_PAYER_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
    } catch {
      continue;
    }
    if (ev.eventName === "Settled" && getAddress(ev.args.recipient) === getAddress(recipient))
      paid = (paid ?? 0n) + ev.args.paid;
    if (ev.eventName === "Refunded" && getAddress(ev.args.to) === getAddress(recipient)) refunded += ev.args.amount;
  }
  if (paid === undefined) {
    const e = new Error("The transaction was mined but the withdrawal step failed, so nothing was sent.");
    e.name = "SettleFailedError";
    throw e;
  }
  return paid + refunded;
}

/** A KV as the privacy package's ciphertext backend (storage.local; values are opaque strings). */
const kvBackend = (kv: KV): StorageBackend => ({
  get: async (k) => (await kv.get<string>(k)) ?? null,
  set: (k, v) => kv.set(k, v),
  remove: (k) => kv.remove(k),
});

type Ctx = Awaited<ReturnType<PrivacyController["context"]>>;

/**
 * The private balance (plan §40 §1, ux-spec §3.11) in the service worker. Every operation is a persisted state
 * machine (`machine.ts`) advanced by `run`, which is safe to call again after a service-worker restart: it re-derives
 * everything from storage and the chain, and resumes a withdrawal that was already sent by its hash.
 *
 * Rules kept here:
 *  - note secrets come from the privacy payer key's signatures over note envelopes (a seed-derived secp256k1 key that
 *    signs nothing else). A signature is the note's spend key, so it is made again for each operation and never
 *    stored; the balance is shown from a PUBLIC ledger (`PublicNote`: no preimages) in the seed-keyed encrypted store;
 *  - deposits and public exits are owner payments from the account; a withdrawal goes to a fresh address through PoolPayer
 *    at cost: no fee choice exists anywhere (plan §40 §7);
 *  - the withdrawal's node calls run on their own circuit (`withdrawalClients`: a fresh Anon-RPC isolation key, or
 *    direct and labelled where no Anon-RPC worker exists), never the account's (BACKLOG).
 */
export class PrivacyController {
  readonly config: PrivacyConfigStore;
  private readonly now: () => number;
  private readonly stores = new Map<number, EncryptedStorage>();
  private readonly running = new Map<number, Promise<void>>();

  constructor(private readonly d: PrivacyDeps) {
    this.config = new PrivacyConfigStore(d.kv);
    this.now = d.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------------------------- storage ----

  async record(chainId: number): Promise<PrivacyRecord> {
    const r = { ...EMPTY, ...(await this.d.kv.get<PrivacyRecord>(PRIVACY_STATE_KEY(chainId))) };
    return { ...r, ...(r.op ? { op: upgradeOp(r.op) } : {}), history: r.history.map(upgradeOp) };
  }

  private async save(chainId: number, patch: Partial<PrivacyRecord>): Promise<PrivacyRecord> {
    const next = { ...(await this.record(chainId)), ...patch };
    await this.d.kv.set(PRIVACY_STATE_KEY(chainId), next);
    return next;
  }

  private async apply(chainId: number, e: PrivacyEvent): Promise<PrivacyOp> {
    const r = await this.record(chainId);
    if (!r.op) throw new Error("No private-balance operation in progress.");
    const op = transition(r.op, e, this.now());
    await this.save(chainId, { op });
    return op;
  }

  /** The public ledger + pool-state store for `chainId`, unlocked with the seed-derived key (wallet unlocked). */
  private async store(chainId: number): Promise<EncryptedStorage> {
    let s = this.stores.get(chainId);
    if (!s) {
      s = new EncryptedStorage({ backend: kvBackend(this.d.kv), namespace: `pp:${chainId}:0:` });
      this.stores.set(chainId, s);
    }
    if (s.locked) {
      const raw = await this.d.keyring.deriveStorageKey(`privacy-pools:${chainId}`);
      try {
        s.unlock(await importStorageKey(raw));
      } finally {
        raw.fill(0);
      }
    }
    return s;
  }

  /** Wallet locked: drop every store key. */
  lock(): void {
    for (const s of this.stores.values()) s.lock();
  }

  // ---------------------------------------------------------------------------------------------- ledger ----

  /** The public note ledger of `pool` (encrypted store, key `ledger:<pool>`): bigints as `<n>n` strings. */
  private async ledger(store: EncryptedStorage, pool: Address): Promise<PublicNote[]> {
    const s = await store.get(`ledger:${pool.toLowerCase()}`);
    if (!s) return [];
    return JSON.parse(s, (_k, x) => (typeof x === "string" && /^\d+n$/u.test(x) ? BigInt(x.slice(0, -1)) : x));
  }

  private async saveLedger(store: EncryptedStorage, pool: Address, ledger: readonly PublicNote[]): Promise<void> {
    await store.set(
      `ledger:${pool.toLowerCase()}`,
      JSON.stringify(ledger, (_k, x) => (typeof x === "bigint" ? `${x}n` : x)),
    );
  }

  /** Appends (or replaces) one public note in the ledger. */
  private async recordNote(ctx: Ctx, note: PublicNote): Promise<void> {
    const cur = (await this.ledger(ctx.store, ctx.cfg.pool)).filter(
      (n) => !(n.depositIndex === note.depositIndex && n.secretIndex === note.secretIndex),
    );
    await this.saveLedger(ctx.store, ctx.cfg.pool, [...cur, note]);
  }

  // ---------------------------------------------------------------------------------------------- context ----

  private provider(chainId: number): HostProvider {
    if (this.d.provider) return this.d.provider(chainId);
    // Anon-RPC is unavailable on the devnet (no worker there): reads go direct and the page says so (plan §40 §6.2).
    const net = getNetwork(chainId);
    return createHostProvider({
      rpc: eip1193FromTransport(networkTransport(net.rpcUrl, directNetwork(), 30_000)),
    });
  }

  /** The contracts in use: saved in Settings (a local devnet), else the ones this network ships with. */
  async cfg(chainId: number): Promise<PrivacyNetworkConfig | undefined> {
    return (await this.config.get(chainId)) ?? builtInPrivacyConfig(chainId);
  }

  private async context(chainId: number) {
    const cfg = await this.cfg(chainId);
    if (!cfg) throw new Error("Private balance isn't set up on this network.");
    const address = await this.d.account(chainId);
    if (!address) throw new Error("Create your account first.");
    const { address: payer, signer } = await this.d.noteSigner();
    const provider = this.provider(chainId);
    const store = await this.store(chainId);
    const rec = await this.record(chainId);
    // No `cache`: a signature is a spend key and must never reach the seed-keyed store (see the class comment).
    const secrets = createSignatureSecretManager({
      signer,
      chainId: BigInt(chainId),
      entrypoint: cfg.entrypoint,
      verifyDeterminism: rec.deterministicPayer?.toLowerCase() !== payer.toLowerCase(),
    });
    const holder: { client?: PrivacyPoolsV1Client } = {};
    const asp = poolOrderAsp({ provider, entrypoint: cfg.entrypoint, state: () => holder.client?.state });
    const timed = this.timedProver();
    const client = (holder.client = new PrivacyPoolsV1Client({
      provider,
      chainId: BigInt(chainId),
      entrypoint: cfg.entrypoint,
      pool: cfg.pool,
      deployBlock: BigInt(cfg.deployBlock),
      secrets,
      asp,
      prover: timed.prover,
      storage: store,
    }));
    await client.loadState().catch(() => undefined);
    if (rec.deterministicPayer?.toLowerCase() !== payer.toLowerCase())
      await this.save(chainId, { deterministicPayer: getAddress(payer) });
    return { cfg, address, payer, provider, store, client, secrets, timed };
  }

  private timedProver() {
    const box: { ms?: number } = {};
    const inner = this.d.prover();
    const prover: Prover = {
      prove: async (inputs) => {
        const r = await inner.prove(inputs);
        box.ms = r.ms;
        return r;
      },
    };
    return { prover, box };
  }

  // ---------------------------------------------------------------------------------------------- view ----

  async view(chainId: number): Promise<PrivacyView> {
    const [rec, cfg, account, anon] = await Promise.all([
      this.record(chainId),
      this.cfg(chainId),
      this.d.account(chainId),
      this.d.anonStatus(chainId).catch(() => ({ available: false, reason: "Private connection status unknown." })),
    ]);
    const net = findNetwork(chainId);
    let availability: PrivacyView["availability"] = { ok: true };
    if (!net) availability = { ok: false, reason: "Private balance isn't available on this network yet." };
    else if (!net.capabilities.stagedBudget && cfg?.payer !== "lite")
      // Withdrawals go through PoolPayer, whose VERIFY needs more than 100k gas and precompile calls: only a mempool
      // with staked budgets admits it (PoolPayerLite fits a stock 100k sidecar). Shielding is off too, so no one
      // strands funds in a pool they could then only leave publicly (ragequit).
      availability = {
        ok: false,
        reason:
          "Private withdrawals need a mempool with staked budgets (not available on this network yet), so the private balance is off here: adding money to it would leave you only a public way out.",
      };
    else if (!cfg)
      availability = {
        ok: false,
        reason: this.d.localDevnet
          ? "No Privacy Pools deployment is set for this network yet. Enter the local pool in Settings."
          : "Privacy Pools isn't available on this network in QueueBit yet.",
        ...(this.d.localDevnet ? { action: "settings" as const } : {}),
      };
    else if (!account) availability = { ok: false, reason: "Create your account first." };
    const notes = rec.balance?.notes ?? [];
    const max = notes
      .filter((n) => n.status === "approved")
      .reduce((m, n) => (BigInt(n.valueWei) > m ? BigInt(n.valueWei) : m), 0n);
    const est = proofEstimate(rec.proofMs);
    return {
      chainId,
      availability,
      ...(cfg ? { config: cfg } : {}),
      ...(account ? { account } : {}),
      approvedWei: rec.balance?.approvedWei ?? "0",
      pendingWei: rec.balance?.pendingWei ?? "0",
      notes,
      sync: rec.sync,
      maxWithdrawWei: max.toString(),
      ...(rec.op ? { op: rec.op } : {}),
      history: rec.history,
      ...(est !== undefined ? { proofEstimateMs: est } : {}),
      connection: anon.available
        ? { anonymous: true, text: "Private connection on: the network provider doesn't see your IP." }
        : { anonymous: false, text: anon.reason },
      readsVerified: false,
      ...(cfg && net
        ? {
            syncSource: {
              node: hostOfUrl(net.rpcUrl),
              verified: false,
              asp: ASP_SOURCE_TEXT[cfg.asp] ?? cfg.asp,
              ...(rec.sync.scannedTo ? { scannedTo: rec.sync.scannedTo } : {}),
            },
          }
        : {}),
    };
  }

  // ---------------------------------------------------------------------------------------------- config ----

  async saveConfig(input: PrivacyConfigInput): Promise<PrivacyNetworkConfig> {
    const cfg = await validatePrivacyConfig(input, this.provider(input.chainId), this.now());
    const before = await this.config.get(input.chainId);
    await this.config.set(cfg);
    if (!before || before.pool.toLowerCase() !== cfg.pool.toLowerCase()) {
      // Another pool: its history, balance and deposit count start over (the ledger is per pool, so it cannot be
      // confused).
      const rec = await this.record(input.chainId);
      await this.save(input.chainId, { ...EMPTY, history: rec.history, proofMs: rec.proofMs });
    }
    return cfg;
  }

  // ---------------------------------------------------------------------------------------------- sync ----

  /** Root-checked note sync with progress, then the balance from the public ledger (no note keys needed). */
  async sync(chainId: number): Promise<PrivacyView> {
    const ctx = await this.context(chainId);
    await this.syncWith(chainId, ctx);
    return this.view(chainId);
  }

  private async syncWith(chainId: number, ctx: Ctx): Promise<PublicNote[]> {
    const fromBlock = ctx.client.state ? ctx.client.state.syncedTo + 1n : BigInt(ctx.cfg.deployBlock);
    await this.save(chainId, { sync: { status: "syncing", fromBlock: fromBlock.toString(), at: this.now() } });
    let lastWrite = 0;
    try {
      await ctx.client.sync({
        onProgress: (p) => {
          // At most a write per 500 ms: progress for the page, and keeps the service worker awake.
          if (this.now() - lastWrite < 500 && p.scannedTo < p.toBlock) return;
          lastWrite = this.now();
          void this.save(chainId, {
            sync: {
              status: "syncing",
              fromBlock: fromBlock.toString(),
              scannedTo: p.scannedTo.toString(),
              toBlock: p.toBlock.toString(),
              at: this.now(),
            },
          });
        },
      });
    } catch (e) {
      await this.save(chainId, {
        sync: { status: "failed", at: this.now(), error: failureFor(e).message },
      });
      throw e;
    }
    const { ledger, current: notes } = refreshPublicNotes({
      ledger: await this.ledger(ctx.store, ctx.cfg.pool),
      state: ctx.client.state!,
      aspLabels: ctx.client.aspLabels!,
    });
    await this.saveLedger(ctx.store, ctx.cfg.pool, ledger);
    const sum = (s: PublicNote["status"]) => notes.filter((n) => n.status === s).reduce((a, n) => a + n.value, 0n);
    await this.save(chainId, {
      account: ctx.address,
      sync: {
        status: "idle",
        scannedTo: ctx.client.state!.syncedTo.toString(),
        toBlock: ctx.client.state!.syncedTo.toString(),
        at: this.now(),
      },
      balance: {
        approvedWei: sum("approved").toString(),
        pendingWei: sum("pending").toString(),
        notes: notes
          .filter((n) => n.status !== "unconfirmed")
          .map((n) => ({
            depositIndex: n.depositIndex,
            secretIndex: n.secretIndex,
            valueWei: n.value.toString(),
            status: n.status as NoteView["status"],
          })),
        syncedTo: ctx.client.state!.syncedTo.toString(),
        at: this.now(),
      },
    });
    return notes;
  }

  // ---------------------------------------------------------------------------------------------- operations ----

  async start(
    chainId: number,
    kind: PrivacyOp["kind"],
    amountWei: string,
    note?: { depositIndex: number; secretIndex: number },
    to?: string,
  ): Promise<PrivacyView> {
    if (!/^\d+$/u.test(amountWei) || BigInt(amountWei) <= 0n) throw new Error("Enter an amount.");
    if (to !== undefined && (kind !== "unshield" || !isAddress(to, { strict: false })))
      throw new Error("That isn't an address.");
    const toAddr = to === undefined ? undefined : getAddress(to);
    const rec = await this.record(chainId);
    if (rec.op && !isFinal(rec.op))
      throw new Error("Finish or cancel the private-balance operation in progress first.");
    await this.context(chainId); // fails early with the plain reason (no pool, no account, locked …)
    if (kind === "exit") {
      const n = rec.balance?.notes.find(
        (x) => note && x.depositIndex === note.depositIndex && x.secretIndex === note.secretIndex,
      );
      if (!n || n.status === "ragequit") throw new Error("Pick a note in your private balance to take back.");
      amountWei = n.valueWei;
    }
    const base = newOp({ id: crypto.randomUUID(), kind, chainId, amountWei, now: this.now() });
    const op: PrivacyOp =
      kind === "exit" && note
        ? { ...base, exit: { depositIndex: note.depositIndex, secretIndex: note.secretIndex } }
        : toAddr
          ? { ...base, to: toAddr }
          : base;
    await this.save(chainId, { op, history: archive(rec) });
    void this.run(chainId);
    return this.view(chainId);
  }

  async retry(chainId: number, opId: string): Promise<PrivacyView> {
    const rec = await this.record(chainId);
    if (!rec.op || rec.op.id !== opId) throw new Error("No such operation.");
    await this.apply(chainId, { type: "retry" });
    void this.run(chainId);
    return this.view(chainId);
  }

  /** Cancels an operation that has not sent anything yet. */
  async cancel(chainId: number, opId: string): Promise<PrivacyView> {
    const rec = await this.record(chainId);
    const op = rec.op;
    if (!op || op.id !== opId) throw new Error("No such operation.");
    if (op.step === "paying" || op.step === "submitted")
      throw new Error("Already sent: it can't be cancelled from here.");
    if (!isFinal(op))
      await this.apply(chainId, {
        type: "failed",
        error: { code: "cancelled", message: "Cancelled. Nothing was sent.", retry: false },
      });
    return this.view(chainId);
  }

  async dismiss(chainId: number): Promise<PrivacyView> {
    const rec = await this.record(chainId);
    if (rec.op && isFinal(rec.op)) {
      const { op: _op, ...rest } = rec;
      await this.d.kv.set(PRIVACY_STATE_KEY(chainId), { ...rest, history: archive(rec) });
    }
    return this.view(chainId);
  }

  /** After an SW restart: resume what can be resumed (a payment or a sent withdrawal is polled, a proof redone). */
  async rehydrate(chainIds: readonly number[]): Promise<void> {
    for (const chainId of chainIds) {
      if (this.running.has(chainId)) continue; // this instance is working on it
      const op = (await this.record(chainId)).op;
      if (!op || isFinal(op)) continue;
      if (op.step === "proving") await this.apply(chainId, { type: "restart" });
      void this.run(chainId);
    }
  }

  /** Advances the operation of `chainId` as far as it can go now (one runner per chain). */
  run(chainId: number): Promise<void> {
    const cur = this.running.get(chainId);
    if (cur) return cur;
    const p = this.advance(chainId)
      .catch(async (e) => {
        const op = (await this.record(chainId)).op;
        if (op && !isFinal(op))
          await this.apply(chainId, { type: "failed", error: failureFor(e) }).catch(() => undefined);
      })
      .finally(() => this.running.delete(chainId));
    this.running.set(chainId, p);
    return p;
  }

  private async advance(chainId: number): Promise<void> {
    const op = (await this.record(chainId)).op;
    if (!op || isFinal(op)) return;
    if (!(await this.d.keyring.isUnlocked())) return; // resumes on the next unlock
    const ctx = await this.context(chainId);
    if (op.kind === "shield") await this.advanceShield(chainId, ctx);
    else if (op.kind === "exit") await this.advanceExit(chainId, ctx);
    else await this.advanceUnshield(chainId, ctx);
  }

  private async advanceShield(chainId: number, ctx: Ctx) {
    let op = (await this.record(chainId)).op!;
    if (op.step === "preparing" && !op.deposit) {
      await this.syncWith(chainId, ctx);
      // The next index is the count of deposits this browser made: no discovery scan.
      const rec = await this.record(chainId);
      const dep = await ctx.client.prepareDeposit(BigInt(op.amountWei), { depositIndex: rec.depositsMade });
      op = await this.apply(chainId, {
        type: "deposit-ready",
        deposit: {
          depositIndex: dep.depositIndex,
          precommitment: dep.precommitment.toString(),
          nullifierHash: dep.nullifierHash.toString(),
          tx: { to: dep.tx.to, data: dep.tx.data, valueWei: dep.tx.value.toString() },
        },
      });
    }
    const dep = op.deposit!;
    const call = { target: dep.tx.to, value: BigInt(dep.tx.valueWei), data: dep.tx.data };
    if (op.step === "preparing") {
      // The deposit is a public payment from the account, signed with the owner key. It inserts into the pool's
      // Poseidon tree: far more gas than a transfer, so its frame gets the estimate with room to spare.
      const est = await ctx.provider
        .estimateGas({ from: ctx.address, to: call.target, data: call.data, value: call.value })
        .catch(() => 1_500_000n);
      const p = await this.d.pay(chainId, call, {
        label: `Deposit ${fmtEth(call.value)} ETH into your private balance`,
        gas: { execution: 300_000n + 2n * est, state: 400_000n + est },
      });
      await this.apply(chainId, { type: "paying", route: "owner", activityId: p.id });
    }
    // paying: poll until the payment is on chain.
    for (let i = 0; i < 400; i++) {
      op = (await this.record(chainId)).op!;
      if (op.step !== "paying" || !op.deposit?.activityId) return;
      const e = await this.d.payment(op.deposit.activityId);
      if (e?.status === "confirmed") return this.paid(chainId, ctx, e.txHash);
      if (!e || e.status === "failed")
        throw new Error(`The deposit payment didn't go through${e?.detail ? `: ${e.detail}` : ""}.`);
      await sleep(this.d.pollMs ?? 2000);
    }
  }

  private async paid(chainId: number, ctx: Ctx, txHash?: Hex) {
    const rec = await this.record(chainId);
    const dep = rec.op!.deposit!;
    // The deposit's public entry: the sync fills value/label/commitment from the pool's `Deposited` event.
    if (dep.precommitment && dep.nullifierHash)
      await this.recordNote(ctx, {
        depositIndex: dep.depositIndex,
        secretIndex: 0,
        precommitment: BigInt(dep.precommitment),
        nullifierHash: BigInt(dep.nullifierHash),
        value: 0n,
        label: 0n,
        commitment: 0n,
        status: "unconfirmed",
      });
    await this.save(chainId, { depositsMade: Math.max(rec.depositsMade, dep.depositIndex + 1) });
    await this.apply(chainId, { type: "paid", ...(txHash ? { txHash } : {}) });
    await this.syncWith(chainId, ctx).catch(() => undefined);
  }

  /**
   * Public exit (ragequit): the note's key (checked against the pool), a commitment-circuit proof in the offscreen
   * Worker, then `pool.ragequit(proof)` from the account as an owner payment (only the original depositor, the
   * account, may exit). Public: it unlinks nothing.
   */
  private async advanceExit(chainId: number, ctx: Ctx) {
    let op = (await this.record(chainId)).op!;
    if (op.step === "preparing") {
      const notes = await this.syncWith(chainId, ctx);
      const pub = notes.find(
        (n) =>
          n.depositIndex === op.exit?.depositIndex &&
          n.secretIndex === op.exit?.secretIndex &&
          (n.status === "approved" || n.status === "pending"),
      );
      if (!pub) throw new Error("That note isn't in your private balance any more (spent or already taken back).");
      const note: Note = await ctx.client.noteFor(pub);
      const depositor = decodeFunctionResult({
        abi: POOL_ABI,
        functionName: "depositors",
        data: await ctx.provider.call({
          to: ctx.cfg.pool,
          data: encodeFunctionData({ abi: POOL_ABI, functionName: "depositors", args: [note.label] }),
        }),
      });
      if (getAddress(depositor) !== getAddress(ctx.address))
        throw new Error("Only the account that made the deposit can take it back publicly, and that isn't this one.");
      op = await this.apply(chainId, { type: "proving", at: this.now() });
      const r = await this.d.prover().proveRagequit(ragequitInputs(note));
      if (r.proof.pubSignals[0] !== note.commitment) throw new Error("The proof doesn't match this note.");
      const tx = buildRagequitTx(ctx.cfg.pool, r.proof);
      const est = await ctx.provider
        .estimateGas({ from: ctx.address, to: tx.to, data: tx.data, value: 0n })
        .catch(() => 600_000n);
      const p = await this.d.pay(
        chainId,
        { target: tx.to, value: 0n, data: tx.data },
        {
          label: `Public exit: take ${fmtEth(note.value)} ETH back from Privacy Pools`,
          gas: { execution: 300_000n + 2n * est, state: 400_000n + est },
        },
      );
      op = await this.apply(chainId, { type: "exit-proved", activityId: p.id, provedMs: r.ms });
    }
    for (let i = 0; i < 400; i++) {
      op = (await this.record(chainId)).op!;
      if (op.step !== "paying" || !op.exit?.activityId) return;
      const e = await this.d.payment(op.exit.activityId);
      if (e?.status === "confirmed") {
        await this.apply(chainId, { type: "paid", ...(e.txHash ? { txHash: e.txHash } : {}) });
        await this.syncWith(chainId, ctx).catch(() => undefined);
        return;
      }
      if (!e || e.status === "failed") {
        await this.apply(chainId, {
          type: "failed",
          error: {
            code: "payment",
            message: `The exit didn't go through${e?.detail ? `: ${e.detail}` : ""}.`,
            retry: true,
          },
        });
        return;
      }
      await sleep(this.d.pollMs ?? 2000);
    }
  }

  private async advanceUnshield(chainId: number, ctx: Ctx) {
    const op = (await this.record(chainId)).op!;
    const net = getNetwork(chainId);
    if (op.step === "submitted" && op.withdraw?.hash) return this.waitWithdrawal(chainId, ctx);

    const notes = await this.syncWith(chainId, ctx);
    const amount = BigInt(op.amountWei);
    const pub = notes
      .filter((n) => n.status === "approved" && n.value >= amount)
      .sort((a, b) => (a.value < b.value ? -1 : 1))[0];
    if (!pub) {
      const best = notes.filter((n) => n.status === "approved").reduce((m, n) => (n.value > m ? n.value : m), 0n);
      throw new Error(
        best === 0n
          ? "Nothing in your private balance is approved by the pool's reviewer yet."
          : `One withdrawal can move up to ${fmtEth(best)} ETH (one deposit at a time).`,
      );
    }
    if (!op.withdraw)
      await this.apply(chainId, {
        type: "withdraw-ready",
        depositIndex: pub.depositIndex,
        secretIndex: pub.secretIndex + 1,
        circuit: "direct",
      });
    // The note's own key (checked against the pool), then the change note's (which also derives the fresh recipient).
    const note: Note = await ctx.client.noteFor(pub);
    const change = await ctx.client.changeSecrets(note);

    // The withdrawal's own circuit: a fresh isolation key when Anon-RPC is available, else direct (devnet).
    const anon = await this.d.anonStatus(chainId).catch(() => ({ available: false, reason: "" }));
    if (anon.available)
      throw new Error(
        "The private connection is on, but this build can't send withdrawals through it yet. Nothing was sent.",
      );
    const withdrawalClients = this.d.withdrawalClients ?? newWithdrawalClients;
    const clients = withdrawalClients({
      nodeUrl: net.rpcUrl,
      sidecarUrl: ctx.cfg.sidecarUrl,
      timeoutMs: 60_000,
    });
    // Every read from here on (gas price, PoolPayer's rules, the recipient's balance) runs on the withdrawal's own
    // circuit: on the account's, its timing and the fresh recipient's address would link the two.
    const wp = withdrawalProvider(clients);
    const gasPrice = await wp.getGasPrice().catch(() => parseGwei("1"));
    const broadcaster = new FramePaymasterBroadcaster({
      ...clients,
      accountIsolationKeys: [isolationKeyFor(ctx.address, BigInt(chainId))],
      profile: getProfile(net.profileId ?? "ethrex-eip8141-tracer"),
      chainId: BigInt(chainId),
      payer: ctx.cfg.poolPayer,
      rules: await readPoolPayerRules(wp, ctx.cfg.poolPayer),
      fees: withdrawalFees(gasPrice),
      // PoolPayerLite: the validation prefix fits the stock sidecar's 100k cap.
      ...(ctx.cfg.payer === "lite" ? { limits: POOL_PAYER_LITE_LIMITS } : {}),
      timeoutMs: 240_000,
    });

    await this.apply(chainId, { type: "proving", at: this.now() });
    const out = await ctx.client.withdrawViaPoolPayer({
      note,
      amount,
      broadcaster,
      // A private send pays the person directly; the fresh, empty address only signs (and pays nothing).
      ...(op.to ? { recipient: op.to } : {}),
      onBuilt: async (b) => {
        await this.apply(chainId, {
          type: "built",
          hash: b.hash,
          recipient: b.sender,
          feeWei: b.fee.toString(),
          ...(ctx.timed.box.ms !== undefined ? { provedMs: ctx.timed.box.ms } : {}),
        });
        if (ctx.timed.box.ms !== undefined) {
          const rec = await this.record(chainId);
          await this.save(chainId, { proofMs: [...rec.proofMs, ctx.timed.box.ms].slice(-5) });
        }
      },
      onStatus: (s) => {
        if (s === "prove" || s === "routing") return;
        void this.apply(chainId, { type: "mempool", status: s }).catch(() => undefined);
      },
    });
    await this.finishWithdrawal(chainId, ctx, out.receipt, op.to ?? out.sender, {
      depositIndex: note.depositIndex,
      secretIndex: note.secretIndex + 1,
      precommitment: change.precommitment,
      nullifierHash: change.nullifierHash,
      value: note.value - amount,
      label: note.label,
      commitment: out.changeCommitment,
      status: "pending",
    });
  }

  /** A withdrawal sent before a restart: poll the alt mempool by its hash. */
  private async waitWithdrawal(chainId: number, ctx: Ctx) {
    const op = (await this.record(chainId)).op!;
    const w = op.withdraw!;
    const withdrawalClients = this.d.withdrawalClients ?? newWithdrawalClients;
    const clients = withdrawalClients({
      nodeUrl: getNetwork(chainId).rpcUrl,
      sidecarUrl: ctx.cfg.sidecarUrl,
    });
    const t0 = this.now();
    while (this.now() - t0 < 240_000) {
      const st = await clients.sidecar.frameTransactionStatus(w.hash!).catch(() => null);
      if (st?.status && st.status !== op.withdraw?.mempool)
        await this.apply(chainId, { type: "mempool", status: st.status }).catch(() => undefined);
      if (st?.status === "Cancelled" || st?.status === "Reverted") {
        const e = new Error(st.reason ?? st.status) as Error & { reason?: string; status?: string };
        e.name = "MempoolOutcomeError";
        e.reason = st.reason;
        e.status = st.status;
        throw e;
      }
      const receipt = await clients.node.getTransactionReceipt(w.hash!).catch(() => null);
      if (receipt) return this.finishWithdrawal(chainId, ctx, receipt, op.to ?? w.recipient!);
      await sleep(this.d.pollMs ?? 1500);
    }
    const e = new Error("timed out") as Error & { status?: string };
    e.name = "MempoolOutcomeError";
    e.status = "timed out";
    throw e;
  }

  /**
   * `change`: the change note's public data when this run proved the withdrawal (its secrets were in memory). After a
   * restart the sync still finds the change note from the `Withdrawn` event, keyless until its next spend re-keys it.
   */
  private async finishWithdrawal(
    chainId: number,
    ctx: Ctx,
    receipt: FrameTxReceipt,
    recipient: Address,
    change?: PublicNote,
  ) {
    // Mined is not enough: the settle frame must have paid out (else the note is unspent and a retry is safe).
    const received = withdrawalPayout(receipt, ctx.cfg.poolPayer, recipient);
    if (change) await this.recordNote(ctx, change).catch(() => undefined);
    await this.apply(chainId, { type: "withdrawn", receivedWei: received.toString() });
    await this.syncWith(chainId, ctx).catch(() => undefined);
  }
}

/** A host provider over a withdrawal's node client (`withdrawalClients`): the withdrawal's circuit, not the account's. */
export function withdrawalProvider(clients: { node: { transport: Parameters<typeof eip1193FromTransport>[0] } }) {
  return createHostProvider({ rpc: eip1193FromTransport(clients.node.transport) });
}

/** How each reviewer-list source reads on the sync-source badge. */
const ASP_SOURCE_TEXT: Record<string, string> = {
  "pool-order": "the pool's own approval order (devnet stand-in for 0xbow's published list)",
};

const hostOfUrl = (u: string): string => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

function archive(rec: PrivacyRecord): PrivacyOp[] {
  return rec.op && isFinal(rec.op) ? [rec.op, ...rec.history].slice(0, HISTORY) : rec.history;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toFixed(6);
  return s.replace(/\.?0+$/u, "");
}
