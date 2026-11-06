import { getAddress, parseGwei, type Address, type Hex } from "viem";
import { getProfile } from "@leaked/frames";
import {
  EncryptedStorage,
  FramePaymasterBroadcaster,
  PrivacyPoolsV1Client,
  createHostProvider,
  createSignatureSecretManager,
  directNetwork,
  eip1193FromTransport,
  importStorageKey,
  isolationKeyFor,
  networkTransport,
  readPoolPayerRules,
  refreshPublicNotes,
  withdrawalClients,
  type HostProvider,
  type Note,
  type Prover,
  type PublicNote,
  type StorageBackend,
} from "@leaked/privacy";
import { findNetwork, getNetwork } from "../../shared/chains";
import type { KV } from "../../shared/kv";
import type { AnonStatus } from "../../shared/offscreen";
import type { NoteView, PrivacyNetworkConfig, PrivacyOp, PrivacyView, SyncProgress } from "../../shared/privacy";
import type { ActivityStore } from "../activity";
import type { AccountPlans } from "../account";
import type { KeyringController } from "../keyring";
import type { Payments } from "../payments";
import type { SettingsStore } from "../settings";
import type { VaultFlow } from "../vault";
import { PrivacyConfigStore, poolOrderAsp, validatePrivacyConfig, type PrivacyConfigInput } from "./config";
import { failureFor, isFinal, newOp, proofEstimate, transition, type PrivacyEvent } from "./machine";
import { NeedsPhoneError, NoteAnswers, acceptPhoneAnswer, phoneAsk, phoneSigner } from "./phoneSigner";

export const PRIVACY_STATE_KEY = (chainId: number) => `leaked:privacy:${chainId}`;
const HISTORY = 20;

/**
 * Persisted per chain in storage.local (public data only: amounts, indices, hashes). The note LEDGER (public note
 * data: precommitments, commitments, labels, values, nullifier hashes; never a nullifier, secret or signature) and the
 * pool state live in the seed-keyed encrypted store; the phone's signatures (the spend keys) only in the session
 * answers (`NoteAnswers`).
 */
export interface PrivacyRecord {
  account?: Address;
  /** Deposits this browser knows it made: discovery stops there, so a refresh never asks the phone. */
  depositsMade: number;
  sync: SyncProgress;
  balance?: { approvedWei: string; pendingWei: string; notes: NoteView[]; syncedTo: string; at: number };
  op?: PrivacyOp;
  history: PrivacyOp[];
  proofMs: number[];
  /** The Vault payer whose note signatures were checked to be deterministic (one extra scan, once). */
  deterministicPayer?: Address;
}

const EMPTY: PrivacyRecord = { depositsMade: 0, sync: { status: "idle" }, history: [], proofMs: [] };

export interface PrivacyDeps {
  kv: KV;
  /** chrome.storage.session: the phone's note signatures of the operation in progress live here and nowhere else. */
  session: KV;
  keyring: KeyringController;
  plans: AccountPlans;
  payments: Payments;
  vault: VaultFlow;
  activity: ActivityStore;
  settings: SettingsStore;
  /** The offscreen document's prover. */
  prover: () => Prover;
  anonStatus: (chainId: number) => Promise<AnonStatus>;
  localDevnet: boolean;
  now?: () => number;
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
 *  - the browser holds no pool spend key (plan §00 "private spends are vault-approved only"): note secrets come from
 *    the paired phone's signatures over clear-signed note envelopes (QR, tx-type 2). A signature is the note's spend
 *    key, so it is kept only in `chrome.storage.session` for the operation that needs it (dropped on lock, when the
 *    operation ends, and when the browser closes), and the secret manager has no persistent cache. The balance is
 *    shown from a PUBLIC ledger (`PublicNote`: no preimages) in the seed-keyed encrypted store, refreshed against
 *    the synced pool with no phone; a withdrawal re-asks the phone for the note being spent and for its change note.
 *    Someone with the everyday seed and a copy of storage.local can read the balance, not move it;
 *  - a withdrawal always needs a phone approval (its change note is new) and goes to a fresh address through PoolPayer
 *    at cost: no fee choice exists anywhere (plan §40 §7);
 *  - the withdrawal's node calls run on their own circuit (`withdrawalClients`: a fresh Anon-RPC isolation key, or
 *    direct and labelled where no Anon-RPC worker exists), never the account's (BACKLOG).
 */
export class PrivacyController {
  readonly config: PrivacyConfigStore;
  private readonly now: () => number;
  private readonly stores = new Map<number, EncryptedStorage>();
  private readonly answers = new Map<number, NoteAnswers>();
  private readonly running = new Map<number, Promise<void>>();

  constructor(private readonly d: PrivacyDeps) {
    this.config = new PrivacyConfigStore(d.kv);
    this.now = d.now ?? Date.now;
  }

  // ---------------------------------------------------------------------------------------------- storage ----

  async record(chainId: number): Promise<PrivacyRecord> {
    return { ...EMPTY, ...(await this.d.kv.get<PrivacyRecord>(PRIVACY_STATE_KEY(chainId))) };
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

  private noteAnswers(chainId: number): NoteAnswers {
    let a = this.answers.get(chainId);
    if (!a) {
      a = new NoteAnswers(this.d.session, chainId);
      this.answers.set(chainId, a);
    }
    return a;
  }

  /** Wallet locked: drop every store key and every phone signature of the session. */
  lock(): void {
    for (const s of this.stores.values()) s.lock();
    for (const a of this.answers.values()) void a.clear().catch(() => undefined);
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
    // Anon-RPC is unavailable on the devnet (no worker there): reads go direct and the page says so (plan §40 §6.2).
    const net = getNetwork(chainId);
    return createHostProvider({
      rpc: eip1193FromTransport(networkTransport(net.rpcUrl, directNetwork(), 30_000)),
    });
  }

  private async context(chainId: number) {
    const cfg = await this.config.get(chainId);
    if (!cfg) throw new Error("Private balance isn't set up on this network.");
    const plan = await this.d.plans.get(chainId);
    if (!plan) throw new Error("Finish setting up your account first.");
    const payer = (await this.d.settings.getSetup()).vault?.payer;
    if (!payer) throw new Error("Pair your Vault first: its fee-payment key signs the private notes.");
    const provider = this.provider(chainId);
    const store = await this.store(chainId);
    const rec = await this.record(chainId);
    const answers = this.noteAnswers(chainId);
    // No `cache`: a signature is a spend key and must never reach the seed-keyed store (see the class comment).
    const secrets = createSignatureSecretManager({
      signer: phoneSigner(answers),
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
    return { cfg, plan, payer, provider, store, answers, client, secrets, timed };
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
    const [rec, cfg, plan, setup, anon] = await Promise.all([
      this.record(chainId),
      this.config.get(chainId),
      this.d.plans.get(chainId),
      this.d.settings.getSetup(),
      this.d.anonStatus(chainId).catch(() => ({ available: false, reason: "Private connection status unknown." })),
    ]);
    const net = findNetwork(chainId);
    let availability: PrivacyView["availability"] = { ok: true };
    if (!net || net.backend !== "frame")
      availability = {
        ok: false,
        reason: "Private balance needs a native account; it isn't available on this network yet.",
      };
    else if (!cfg)
      availability = {
        ok: false,
        reason: this.d.localDevnet
          ? "No Privacy Pools deployment is set for this network yet. Enter the local pool in Settings."
          : "Privacy Pools isn't available on this network in LEAKED yet.",
        ...(this.d.localDevnet ? { action: "settings" as const } : {}),
      };
    else if (!setup.vault?.payer)
      availability = { ok: false, reason: "Pair your Vault first: your phone signs the private notes." };
    else if (!plan) availability = { ok: false, reason: "Finish setting up your account first." };
    const notes = rec.balance?.notes ?? [];
    const max = notes
      .filter((n) => n.status === "approved")
      .reduce((m, n) => (BigInt(n.valueWei) > m ? BigInt(n.valueWei) : m), 0n);
    const est = proofEstimate(rec.proofMs);
    return {
      chainId,
      availability,
      ...(cfg ? { config: cfg } : {}),
      ...(plan ? { account: plan.address } : {}),
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

  /** Root-checked note sync with progress, then the balance from the public ledger (never a phone scan). */
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
      account: ctx.plan.address,
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

  async start(chainId: number, kind: PrivacyOp["kind"], amountWei: string): Promise<PrivacyView> {
    if (!/^\d+$/u.test(amountWei) || BigInt(amountWei) <= 0n) throw new Error("Enter an amount.");
    const rec = await this.record(chainId);
    if (rec.op && !isFinal(rec.op))
      throw new Error("Finish or cancel the private-balance operation in progress first.");
    await this.context(chainId); // fails early with the plain reason (no pool, no Vault, locked …)
    const op = newOp({ id: crypto.randomUUID(), kind, chainId, amountWei, now: this.now() });
    await this.save(chainId, { op, history: archive(rec) });
    void this.run(chainId);
    return this.view(chainId);
  }

  /** The phone's answer (the scanned `ur:leaked-signature`, CBOR hex) for the operation's current question. */
  async answerPhone(chainId: number, opId: string, signature: Hex): Promise<PrivacyView> {
    const rec = await this.record(chainId);
    const op = rec.op;
    if (!op || op.id !== opId || op.step !== "phone" || !op.phone) throw new Error("Nothing is waiting for the phone.");
    const ctx = await this.context(chainId);
    try {
      const { deterministic } = await acceptPhoneAnswer(ctx.answers, op.phone, signature, {
        chainId,
        entrypoint: ctx.cfg.entrypoint,
        payer: ctx.payer,
      });
      if (deterministic) await this.save(chainId, { deterministicPayer: getAddress(ctx.payer) });
    } catch (e) {
      // A wrong code (another request, another phone) leaves the question open; a non-deterministic phone ends it.
      if ((e as Error).name === "NonDeterministicSignerError") {
        await this.apply(chainId, { type: "failed", error: failureFor(e) });
        return this.view(chainId);
      }
      throw new Error(failureFor(e).message, { cause: e });
    }
    await this.apply(chainId, { type: "phone-answered" });
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

  /** Cancels an operation that has not sent anything yet (preparing / waiting for the phone). */
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
    await this.noteAnswers(chainId)
      .clear()
      .catch(() => undefined);
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
      if (!op || isFinal(op) || op.step === "phone") continue;
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
    if (!op || isFinal(op) || op.step === "phone") return;
    if (!(await this.d.keyring.isUnlocked())) return; // resumes on the next unlock
    const ctx = await this.context(chainId);
    try {
      if (op.kind === "shield") await this.advanceShield(chainId, ctx);
      else await this.advanceUnshield(chainId, ctx);
    } catch (e) {
      if (e instanceof NeedsPhoneError) {
        const cur = (await this.record(chainId)).op!;
        await this.apply(chainId, {
          type: "needs-phone",
          phone: phoneAsk(e, {
            chainId,
            entrypoint: ctx.cfg.entrypoint,
            payer: ctx.payer,
            purpose:
              e.attempt > 0
                ? "check"
                : cur.kind === "shield"
                  ? "deposit-key"
                  : e.secretIndex === cur.withdraw?.secretIndex
                    ? "withdraw-key"
                    : "note-key",
          }),
        });
        return;
      }
      throw e;
    }
  }

  private async advanceShield(chainId: number, ctx: Ctx) {
    let op = (await this.record(chainId)).op!;
    if (op.step === "preparing" && !op.deposit) {
      await this.syncWith(chainId, ctx);
      // The next index is the count of deposits this browser made: one phone signature, no discovery scan.
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
      // The deposit is a public payment from the account: instant within the daily limit, else a Vault approval.
      const preview = await this.d.payments.preview(chainId, [call]);
      if (preview.route.route === "hot") {
        const entry = await this.d.payments.send(chainId, [call], { origin: "LEAKED Private balance" });
        await this.apply(chainId, { type: "paying", route: "hot", activityId: entry.id });
      } else if (preview.route.route === "needs-vault") {
        // A deposit inserts into the pool's Poseidon tree: far more gas than a transfer, so the Vault request's body
        // step gets the estimate (with room for the quantum-safe check in the same step); the simulation decides.
        const est = await ctx.provider
          .estimateGas({ from: ctx.plan.address, to: call.target, data: call.data, value: call.value })
          .catch(() => 1_500_000n);
        const req = await this.d.vault.create(
          chainId,
          {
            type: "send",
            calls: [{ target: call.target, value: call.value.toString(), data: call.data }],
            usd6: String(Math.round(preview.route.amountUsd * 1e6)),
            body: { execution: (700_000n + 2n * est).toString(), state: (400_000n + est).toString() },
            label: `Deposit ${fmtEth(call.value)} ETH into your private balance`,
          },
          { origin: "LEAKED Private balance" },
        );
        await this.apply(chainId, { type: "paying", route: "vault", vaultRequestId: req.id });
      } else {
        throw new Error(`${preview.route.copy.headline}. ${preview.route.copy.detail}`);
      }
    }
    // paying: poll until the payment is on chain (the hand-off page sends the Vault one).
    for (let i = 0; i < 400; i++) {
      op = (await this.record(chainId)).op!;
      if (op.step !== "paying") return;
      const d = op.deposit!;
      if (d.route === "hot" && d.activityId) {
        await this.d.payments.refreshPending().catch(() => undefined);
        const e = await this.d.activity.get(d.activityId);
        if (e?.status === "confirmed") return this.paid(chainId, ctx, e.txHash ?? e.hash);
        if (e && (e.status === "failed" || e.status === "cancelled"))
          throw new Error(`The deposit payment didn't go through: ${e.headline}.`);
      } else if (d.route === "vault" && d.vaultRequestId) {
        const r = await this.d.vault.get(d.vaultRequestId);
        if (r?.status === "confirmed") return this.paid(chainId, ctx, r.hash);
        if (!r || r.status === "failed" || r.status === "expired" || r.status === "cancelled") {
          await this.apply(chainId, {
            type: "failed",
            error: {
              code: "payment",
              message:
                r?.status === "cancelled" || r?.status === "expired"
                  ? "The deposit's Vault approval was cancelled or expired. No money moved."
                  : `The deposit payment didn't go through${r?.error ? `: ${r.error.message}` : ""}.`,
              retry: true,
            },
          });
          return;
        }
        // waiting (QR on the hand-off page) or sending: the page drives it; keep polling while it is quick.
        if (r.status === "waiting" && i > 3) return; // resumed when the page reports back (privacy:run)
      }
      await sleep(2000);
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
    await ctx.answers.clear().catch(() => undefined); // the deposit key is not needed any more this session
    await this.syncWith(chainId, ctx).catch(() => undefined);
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
    // The note's own key (one phone approval; checked against the pool), then the change note's (another, which
    // also derives the fresh recipient). Both come from the session answers after a restart in the same session.
    const note: Note = await ctx.client.noteFor(pub);
    const change = await ctx.client.changeSecrets(note);

    // The withdrawal's own circuit: a fresh isolation key when Anon-RPC is available, else direct (devnet).
    const anon = await this.d.anonStatus(chainId).catch(() => ({ available: false, reason: "" }));
    if (anon.available)
      throw new Error(
        "The private connection is on, but this build can't send withdrawals through it yet. Nothing was sent.",
      );
    const clients = withdrawalClients({
      nodeUrl: net.rpcUrl,
      sidecarUrl: ctx.cfg.sidecarUrl,
      timeoutMs: 60_000,
    });
    const gasPrice = await ctx.provider.getGasPrice().catch(() => parseGwei("1"));
    const maxFeePerGas = gasPrice * 2n > parseGwei("2") ? gasPrice * 2n : parseGwei("2");
    const broadcaster = new FramePaymasterBroadcaster({
      ...clients,
      accountIsolationKeys: [isolationKeyFor(ctx.plan.address, BigInt(chainId))],
      profile: getProfile(net.profileId ?? "ethrex-eip8141-tracer"),
      chainId: BigInt(chainId),
      payer: ctx.cfg.poolPayer,
      rules: await readPoolPayerRules(ctx.provider, ctx.cfg.poolPayer),
      fees: { maxFeePerGas, maxPriorityFeePerGas: parseGwei("1") },
      timeoutMs: 240_000,
    });

    await this.apply(chainId, { type: "proving", at: this.now() });
    const out = await ctx.client.withdrawViaPoolPayer({
      note,
      amount,
      broadcaster,
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
    await this.finishWithdrawal(chainId, ctx, out.sender, {
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
    const clients = withdrawalClients({ nodeUrl: getNetwork(chainId).rpcUrl, sidecarUrl: ctx.cfg.sidecarUrl });
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
      if (receipt) return this.finishWithdrawal(chainId, ctx, w.recipient!);
      await sleep(1500);
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
  private async finishWithdrawal(chainId: number, ctx: Ctx, recipient: Address, change?: PublicNote) {
    if (change) await this.recordNote(ctx, change).catch(() => undefined);
    const received = await ctx.provider.getBalance(recipient).catch(() => 0n);
    await this.apply(chainId, { type: "withdrawn", receivedWei: received.toString() });
    await ctx.answers.clear().catch(() => undefined); // the spend keys of this withdrawal leave memory
    await this.syncWith(chainId, ctx).catch(() => undefined);
  }
}

function archive(rec: PrivacyRecord): PrivacyOp[] {
  return rec.op && isFinal(rec.op) ? [rec.op, ...rec.history].slice(0, HISTORY) : rec.history;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fmtEth(wei: bigint): string {
  const s = (Number(wei) / 1e18).toFixed(6);
  return s.replace(/\.?0+$/u, "");
}
