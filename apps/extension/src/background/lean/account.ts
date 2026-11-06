import { LEAN_PROFILE, buildAndSign, submit, type Call, type Signer } from "@queuebit/account";
import type { LeanPoolClient, NodeClient, SidecarClient } from "@queuebit/rpc";
import { concat, keccak256, pad, parseGwei, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { NO_DEPLOYMENT, getNetwork, type NetworkDeployment } from "../../shared/chains";
import { StorageKeys, type KV } from "../../shared/kv";
import type { AccountStatus } from "../../shared/views";
import type { ActivityStore } from "../activity";
import { intentTitle, stageCopy, type ActivityEntry } from "../activity";
import { SETUP_PATH, type KeyringController } from "../keyring";
import { quoteLegacy, sendLegacy } from "./legacy";
import type { OwnerKey } from "./owner";
import { accountPlan, frameMaxCost, type AccountPlan, type PlanInput } from "./plan";

/** Per-chain network clients (the service worker passes real ones; tests pass fakes). */
export interface LeanIo {
  publicClient(chainId: number): PublicClient;
  node(chainId: number): NodeClient;
  sidecar(chainId: number): SidecarClient;
  leanpool(chainId: number): LeanPoolClient;
}

/** What the extension keeps about the account on a chain (JSON-safe). */
export interface AccountRecord {
  chainId: number;
  address: Address;
  vk: Hex;
  aggregator: Address;
  salt: Hex;
  guardians: Address[];
  guardianThreshold: number;
  createdAt: number;
  activation?: { hash: Hex; activityId: string; sentAt: number };
}

export class AccountError extends Error {
  constructor(
    readonly reason:
      "no-deployment" | "leanpool" | "not-created" | "busy" | "funds" | "setup-funds" | "already-created",
    message: string,
  ) {
    super(message);
    this.name = "AccountError";
  }
}

export interface SendOptions {
  origin?: string;
  batchId?: string;
  kind?: ActivityEntry["kind"];
  /** Headline while pending (default: what the calls do), and once done. */
  label?: string;
  doneLabel?: string;
  /** Execution / state gas for the SENDER frame (defaults: 300k / 400k). */
  gas?: { execution?: bigint; state?: bigint };
}

/** The session lane: one EIP-8250 nonce key per session key, so sessions never wait on the owner or each other. */
export const sessionNonceKey = (index: number): bigint => BigInt(index + 1);
const OWNER_NONCE_KEY = 0n;

const toEntryCalls = (calls: Call[]) =>
  calls.map((c) => ({ target: c.to, value: (c.value ?? 0n).toString(), data: c.data ?? ("0x" as Hex) }));

export interface AccountDeps {
  kv: KV;
  io: LeanIo;
  keyring: KeyringController;
  owner: OwnerKey;
  activity: ActivityStore;
  now?: () => number;
}

/**
 * The LeanAccount on each chain: its address (counterfactual until created), creating it with the setup key, owner
 * payments (signed with the owner key, sent through the LeanPool node) and session payments (signed by a session key,
 * sent straight to the alt mempool), and following them in Activity.
 */
export class AccountService {
  private readonly now: () => number;

  constructor(private readonly d: AccountDeps) {
    this.now = d.now ?? Date.now;
  }

  deployment(chainId: number): NetworkDeployment {
    const dep = getNetwork(chainId).deployment;
    if (!dep) throw new AccountError("no-deployment", NO_DEPLOYMENT);
    return dep;
  }

  async all(): Promise<Record<string, AccountRecord>> {
    return (await this.d.kv.get<Record<string, AccountRecord>>(StorageKeys.accounts)) ?? {};
  }

  async record(chainId: number): Promise<AccountRecord | undefined> {
    return (await this.all())[String(chainId)];
  }

  private async save(rec: AccountRecord): Promise<AccountRecord> {
    await this.d.kv.set(StorageKeys.accounts, { ...(await this.all()), [String(rec.chainId)]: rec });
    return rec;
  }

  async clear(): Promise<void> {
    await this.d.kv.remove(StorageKeys.accounts);
  }

  /** The plan behind a record (the creation call and options are recomputed; the address must not change). */
  planOf(rec: AccountRecord): AccountPlan {
    const plan = accountPlan(this.deployment(rec.chainId), inputOf(rec));
    if (plan.address.toLowerCase() !== rec.address.toLowerCase())
      throw new Error("This network's contracts changed since your account's address was computed.");
    return plan;
  }

  /** The aggregator a new account trusts: the LeanPool node's address. */
  private async aggregator(chainId: number): Promise<Address> {
    const net = getNetwork(chainId);
    let nodeId: Address | undefined;
    try {
      nodeId = (await this.d.io.leanpool(chainId).status()).nodeId;
    } catch {
      throw new AccountError(
        "leanpool",
        `The LeanPool node at ${net.leanpoolUrl} isn't answering. Start it (services/leanpool-node), then try again.`,
      );
    }
    if (!nodeId) throw new AccountError("leanpool", "The LeanPool node didn't say which address it posts from.");
    return nodeId;
  }

  /**
   * The account on `chainId`: computed (and kept) the first time. Before it is created, `guardians` may change it
   * (the address is bound to them); after, guardians change only through the account.
   */
  async ensure(chainId: number, opts: { guardians?: Address[]; guardianThreshold?: number } = {}) {
    const cur = await this.record(chainId);
    const changing = opts.guardians !== undefined;
    if (cur && !changing) return cur;
    if (cur && changing && (await this.deployed(chainId, cur.address)))
      throw new AccountError("already-created", "Your account exists: change guardians from Keys & recovery.");
    const d = this.deployment(chainId);
    const vk = await this.d.owner.vk();
    const aggregator = cur?.aggregator ?? (await this.aggregator(chainId));
    const guardians = opts.guardians ?? cur?.guardians ?? [];
    const threshold = guardians.length ? (opts.guardianThreshold ?? cur?.guardianThreshold ?? 1) : 0;
    const input: PlanInput = { vk, aggregator, guardians, guardianThreshold: threshold };
    const plan = accountPlan(d, input);
    return this.save({
      chainId,
      address: plan.address,
      vk,
      aggregator,
      salt: plan.options.salt,
      guardians,
      guardianThreshold: threshold,
      createdAt: cur?.createdAt ?? this.now(),
    });
  }

  async deployed(chainId: number, address: Address): Promise<boolean> {
    const code = await this.d.io.publicClient(chainId).getCode({ address });
    return !!code && code !== "0x";
  }

  async status(chainId: number): Promise<AccountStatus> {
    const net = getNetwork(chainId);
    const accounts = await this.d.keyring.accounts();
    const base = {
      chainId,
      setupKey: accounts?.setup ?? ("0x0000000000000000000000000000000000000000" as Address),
      ownerSignaturesLeft: await this.d.owner.remaining(),
      leanpoolUrl: net.leanpoolUrl,
      readAt: this.now(),
    };
    if (!net.deployment) return { ...base, supported: false, unsupportedReason: NO_DEPLOYMENT, deployed: false };
    let rec: AccountRecord | undefined;
    try {
      rec = await this.ensure(chainId);
    } catch (e) {
      return { ...base, supported: true, deployed: false, error: (e as Error).message };
    }
    const client = this.d.io.publicClient(chainId);
    try {
      const plan = this.planOf(rec);
      const [deployed, accountWei, setupWei, gasPrice] = await Promise.all([
        this.deployed(chainId, rec.address),
        client.getBalance({ address: rec.address }),
        client.getBalance({ address: base.setupKey }),
        client.getGasPrice(),
      ]);
      let activationCostWei = 0n;
      if (!deployed) {
        const q = await quoteLegacy(client, base.setupKey, plan.create).catch(() => ({
          fee: 2_000_000n * gasPrice,
        }));
        activationCostWei = q.fee;
      }
      return {
        ...base,
        supported: true,
        address: rec.address,
        deployed,
        accountWei: accountWei.toString(),
        setupWei: setupWei.toString(),
        activationCostWei: activationCostWei.toString(),
        aggregator: rec.aggregator,
        guardians: rec.guardians,
        ...(rec.activation ? { activation: { hash: rec.activation.hash, sentAt: rec.activation.sentAt } } : {}),
      };
    } catch (e) {
      return { ...base, supported: true, address: rec.address, deployed: false, error: (e as Error).message };
    }
  }

  /** Creates the account: the setup key sends `factory.createAccount(salt, init)` (an ordinary transaction). */
  async activate(chainId: number): Promise<ActivityEntry> {
    const rec = await this.ensure(chainId);
    if (await this.deployed(chainId, rec.address))
      throw new AccountError("already-created", "Your account already exists.");
    const plan = this.planOf(rec);
    const client = this.d.io.publicClient(chainId);
    return this.d.keyring.withKey(SETUP_PATH, async (key) => {
      const setup = privateKeyToAccount(key).address;
      const q = await quoteLegacy(client, setup, plan.create);
      const balance = await client.getBalance({ address: setup });
      if (balance < q.fee)
        throw new AccountError(
          "setup-funds",
          `Your setup key needs about ${fmt(q.fee)} ETH for the network fee. Send test ETH to ${setup}.`,
        );
      const hash = await sendLegacy(client, key, chainId, plan.create, q);
      const entry = this.entry(chainId, {
        kind: "activation",
        signer: "setup",
        via: "legacy",
        account: rec.address,
        calls: [{ to: plan.create.to, value: 0n, data: plan.create.data }],
        hash,
        headline: "Creating your account",
        doneHeadline: "Account created",
      });
      await this.d.activity.add(entry);
      await this.save({ ...rec, activation: { hash, activityId: entry.id, sentAt: this.now() } });
      return entry;
    });
  }

  /** Frame fees: twice the base fee plus a 1 gwei tip. */
  async fees(chainId: number): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const client = this.d.io.publicClient(chainId);
    const tip = parseGwei("1");
    const block = await client.getBlock().catch(() => undefined);
    const base = block?.baseFeePerGas ?? (await client.getGasPrice());
    return { maxFeePerGas: 2n * base + tip, maxPriorityFeePerGas: tip };
  }

  /** EIP-8250: the next `nonce_seq` of (account, key). Key 0 is the account nonce. */
  async nonce(chainId: number, account: Address, key: bigint): Promise<bigint> {
    const client = this.d.io.publicClient(chainId);
    if (key === 0n) return BigInt(await client.getTransactionCount({ address: account }));
    const manager = LEAN_PROFILE.predeploys?.NONCE_MANAGER as Address | undefined;
    if (!manager) throw new Error("This network profile has no nonce manager.");
    const slot = keccak256(concat([pad(account), toHex(key, { size: 32 })]));
    return BigInt((await client.getStorageAt({ address: manager, slot })) ?? "0x0");
  }

  /** What an owner payment would cost at most, and whether the account can pay it. */
  async quote(chainId: number, calls: Call[], gas?: SendOptions["gas"]) {
    const rec = await this.ensure(chainId);
    const fees = await this.fees(chainId);
    const maxFee = frameMaxCost(fees.maxFeePerGas, 1, gas);
    const value = calls.reduce((s, c) => s + (c.value ?? 0n), 0n);
    const [balance, deployed] = await Promise.all([
      this.d.io.publicClient(chainId).getBalance({ address: rec.address }),
      this.deployed(chainId, rec.address),
    ]);
    return { rec, fees, maxFee, value, balance, deployed, enough: balance >= value + maxFee };
  }

  /** An owner payment: signed with the owner key, handed to the LeanPool node. */
  async pay(chainId: number, calls: Call[], o: SendOptions = {}): Promise<ActivityEntry> {
    const q = await this.quote(chainId, calls, o.gas);
    if (!q.deployed) throw new AccountError("not-created", "Create your account first (Home › Create account).");
    if (!q.enough)
      throw new AccountError(
        "funds",
        `Your account needs ${fmt(q.value + q.maxFee)} ETH for this (including up to ${fmt(q.maxFee)} ETH network fee); it has ${fmt(q.balance)}.`,
      );
    await this.assertLaneFree(chainId, q.rec.address, OWNER_NONCE_KEY);
    const vk = q.rec.vk;
    const owner = this.d.owner;
    const signer: Signer = { kind: "PQ", vk, sign: (m) => owner.sign(m) };
    return this.sendFrame(chainId, q.rec.address, OWNER_NONCE_KEY, calls, signer, q.fees, o, "owner");
  }

  /** A session payment: signed by the session key, sent straight to the alt mempool. */
  async payWithSession(
    chainId: number,
    session: { id: Hex; index: number; signer: Address },
    privateKey: Hex,
    calls: Call[],
    o: SendOptions = {},
  ): Promise<ActivityEntry> {
    const rec = await this.ensure(chainId);
    const key = sessionNonceKey(session.index);
    await this.assertLaneFree(chainId, rec.address, key);
    const fees = await this.fees(chainId);
    const signer: Signer = { kind: "ECDSA", address: session.signer, privateKey };
    return this.sendFrame(
      chainId,
      rec.address,
      key,
      calls,
      signer,
      fees,
      { ...o, kind: o.kind ?? "payment" },
      "session",
      session.id,
    );
  }

  private async assertLaneFree(chainId: number, account: Address, key: bigint) {
    const busy = (await this.d.activity.pending()).some(
      (e) =>
        e.chainId === chainId && e.account.toLowerCase() === account.toLowerCase() && e.nonceKey === key.toString(),
    );
    if (busy) throw new AccountError("busy", "Your last transaction is still on its way. Try again once it's done.");
  }

  private async sendFrame(
    chainId: number,
    account: Address,
    nonceKey: bigint,
    calls: Call[],
    signer: Signer,
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint },
    o: SendOptions,
    who: "owner" | "session",
    sessionId?: Hex,
  ): Promise<ActivityEntry> {
    const nonceSeq = await this.nonce(chainId, account, nonceKey);
    const plan = await buildAndSign({
      d: this.deployment(chainId),
      account,
      nonceKey,
      nonceSeq,
      calls: [calls],
      signers: [signer],
      ...fees,
      ...(o.gas?.execution ? { senderGas: o.gas.execution } : {}),
      ...(o.gas?.state ? { senderState: o.gas.state } : {}),
    });
    const sub = await submit(plan, {
      ...(who === "owner" ? { leanpool: this.d.io.leanpool(chainId) } : {}),
      sidecar: this.d.io.sidecar(chainId),
    }).catch((e: unknown) => {
      if (who === "owner")
        throw new AccountError(
          "leanpool",
          `The LeanPool node refused the payment: ${(e as Error).message}. Nothing was sent.`,
        );
      throw e;
    });
    const entryCalls = toEntryCalls(calls);
    const entry = this.entry(chainId, {
      kind: o.kind ?? "payment",
      signer: who,
      via: sub.via,
      account,
      calls,
      hash: sub.via === "leanpool" ? sub.poolId : sub.txHash,
      headline: o.label ?? intentTitle(entryCalls),
      ...(o.doneLabel ? { doneHeadline: o.doneLabel } : {}),
      nonceKey: nonceKey.toString(),
      nonceSeq: nonceSeq.toString(),
      ...(sub.via === "leanpool" ? { stage: "pooled" as const, detail: stageCopy("pooled").text } : {}),
      ...(o.origin ? { origin: o.origin } : {}),
      ...(o.batchId ? { batchId: o.batchId } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
    await this.d.activity.add(entry);
    return entry;
  }

  private entry(
    chainId: number,
    e: Omit<ActivityEntry, "id" | "chainId" | "status" | "createdAt" | "updatedAt" | "calls"> & { calls: Call[] },
  ): ActivityEntry {
    const now = this.now();
    return {
      ...e,
      id: crypto.randomUUID(),
      chainId,
      status: "confirming",
      calls: toEntryCalls(e.calls),
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Polls every pending entry once. Returns the entries that reached a final state. */
  async refresh(): Promise<ActivityEntry[]> {
    const done: ActivityEntry[] = [];
    for (const e of await this.d.activity.pending()) {
      const next = await this.poll(e).catch(() => undefined);
      if (!next) continue;
      const updated = await this.d.activity.update(e.id, next);
      if (updated && (updated.status === "confirmed" || updated.status === "failed")) done.push(updated);
    }
    return done;
  }

  private async poll(e: ActivityEntry): Promise<Partial<ActivityEntry> | undefined> {
    if (e.via === "leanpool") {
      const st = await this.d.io.leanpool(e.chainId).getTx(e.hash);
      if (!st || st.stage === e.stage) return undefined;
      const c = stageCopy(st.stage);
      return {
        stage: st.stage,
        status: c.status,
        detail: (st.error ?? st.lastError) ? `${c.text}: ${st.error ?? st.lastError}` : c.text,
        ...(st.txHash ? { txHash: st.txHash } : {}),
        ...(c.status === "confirmed" ? { headline: done(e) } : {}),
      };
    }
    if (e.via === "alt-mempool") {
      const r = await this.d.io
        .node(e.chainId)
        .getTransactionReceipt(e.hash)
        .catch(() => null);
      if (r) {
        const ok = r.frameReceipts.slice(1).every((f) => f.status === "success");
        return {
          status: ok ? "confirmed" : "failed",
          txHash: e.hash,
          ...(r.blockNumber !== undefined ? { blockNumber: r.blockNumber.toString() } : {}),
          ...(ok
            ? { headline: done(e) }
            : { detail: "Included, but it failed: nothing moved except the network fee." }),
        };
      }
      const st = await this.d.io
        .sidecar(e.chainId)
        .frameTransactionStatus(e.hash)
        .catch(() => null);
      if (st?.status === "Cancelled" || st?.status === "Reverted")
        return { status: "failed", detail: "The network refused it: nothing was sent." };
      return undefined;
    }
    const r = await this.d.io
      .publicClient(e.chainId)
      .getTransactionReceipt({ hash: e.hash })
      .catch(() => null);
    if (!r) return undefined;
    const ok = r.status === "success";
    return {
      status: ok ? "confirmed" : "failed",
      txHash: e.hash,
      blockNumber: r.blockNumber.toString(),
      feeWei: (r.gasUsed * r.effectiveGasPrice).toString(),
      ...(ok ? { headline: done(e) } : { detail: "It failed: nothing moved except the network fee." }),
    };
  }
}

function inputOf(rec: AccountRecord): PlanInput {
  return {
    vk: rec.vk,
    aggregator: rec.aggregator,
    guardians: rec.guardians,
    guardianThreshold: rec.guardianThreshold,
    salt: rec.salt,
  };
}

const done = (e: ActivityEntry) => e.doneHeadline ?? (e.kind === "payment" ? `Paid ${e.headline}` : e.headline);

function fmt(wei: bigint): string {
  return (Number(wei) / 1e18).toFixed(6).replace(/\.?0+$/u, "") || "0";
}
