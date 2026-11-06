import { decodeFunctionResult, encodeFunctionData, type Address, type Hex } from "viem";
import type { HostProvider, Storage } from "../host/types.js";
import type { NoteSecrets } from "../envelope/envelope.js";
import type { SecretManager } from "../envelope/secretManager.js";
import { assertWithdrawMode } from "../guardrails.js";
import { ENTRYPOINT_ABI, POOL_ABI } from "./abi.js";
import { NATIVE_ASSET, type Withdrawal } from "./crypto.js";
import { discoverNotes, noteFromPublic, type DiscoveryResult, type Note, type PublicNote } from "./notes.js";
import type { Prover, ProveResult } from "./prover.js";
import {
  SyncIntegrityError,
  findRootIndex,
  syncPool,
  verifiedAspLabels,
  type AspSource,
  type FetchLogsOptions,
  type PoolState,
} from "./sync.js";
import { buildWithdrawInputs } from "./withdraw.js";
import {
  localFrameSigner,
  type FramePaymasterBroadcaster,
  type FramePaymasterOutcome,
  type FrameSenderSigner,
} from "./broadcaster.js";
import { relayerWithdrawal, type RelayerClient, type RelayerResult } from "./relayer.js";

export interface DepositTx {
  to: Address;
  data: Hex;
  value: bigint;
}

/** `Entrypoint.deposit(precommitment)` for the native pool: sent by the LEAKED account as a hot/vault-tier call. */
export const buildDepositTx = (entrypoint: Address, value: bigint, precommitment: bigint): DepositTx => ({
  to: entrypoint,
  data: encodeFunctionData({ abi: ENTRYPOINT_ABI, functionName: "deposit", args: [precommitment] }),
  value,
});

export interface PrivacyPoolsV1Config {
  provider: HostProvider;
  chainId: bigint;
  entrypoint: Address;
  /** v1: the native-ETH pool. */
  pool: Address;
  /** First block to scan (the pool's deployment block). */
  deployBlock: bigint;
  secrets: SecretManager;
  asp: AspSource;
  prover: Prover;
  /** Persists the verified public pool state between sessions (the Host's encrypted storage). */
  storage?: Storage;
}

const STATE_KEY = (pool: Address) => `state:${pool.toLowerCase()}`;
const ser = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
const de = <T>(s: string): T =>
  JSON.parse(s, (_k, x) => (typeof x === "string" && /^\d+n$/.test(x) ? BigInt(x.slice(0, -1)) : x)) as T;

export interface PreparedProof {
  proof: ProveResult;
  context: bigint;
  changeCommitment: bigint;
  rootIndexHint: number;
}

/**
 * Privacy Pools v1 for one chain/pool. Public state (sync) needs no vault; anything derived from note secrets goes
 * through `secrets` (vault envelope signatures). Every spend re-verifies the ASP root and uses a root-checked state.
 */
export class PrivacyPoolsV1Client {
  state: PoolState | undefined;
  aspLabels: bigint[] | undefined;
  private scopeCache: bigint | undefined;

  constructor(readonly c: PrivacyPoolsV1Config) {}

  async scope(): Promise<bigint> {
    this.scopeCache ??= decodeFunctionResult({
      abi: POOL_ABI,
      functionName: "SCOPE",
      data: await this.c.provider.call({
        to: this.c.pool,
        data: encodeFunctionData({ abi: POOL_ABI, functionName: "SCOPE" }),
      }),
    });
    return this.scopeCache;
  }

  async loadState(): Promise<PoolState | undefined> {
    const s = await this.c.storage?.get(STATE_KEY(this.c.pool));
    if (s) this.state = de<PoolState>(s);
    return this.state;
  }

  /**
   * Incremental, root-checked sync (fails closed), then the ASP labels checked against `latestRoot()`. A prior state
   * that no longer extends to the chain (a reorg past its `syncedTo`, a store from another chain) is dropped and the
   * pool re-synced from its deployment block, with the same root check; the stale prior is never kept.
   */
  async sync(o: { toBlock?: bigint; chunkSize?: bigint; onProgress?: FetchLogsOptions["onProgress"] } = {}) {
    const run = (prior: PoolState | undefined) =>
      syncPool(this.c.provider, {
        pool: this.c.pool,
        fromBlock: this.c.deployBlock,
        ...(prior ? { prior } : {}),
        ...o,
      });
    const prior = this.state;
    this.state = undefined;
    this.aspLabels = undefined;
    try {
      this.state = await run(prior);
    } catch (e) {
      if (!prior || !(e instanceof SyncIntegrityError)) throw e;
      this.state = await run(undefined);
    }
    this.aspLabels = (
      await verifiedAspLabels(this.c.provider, this.c.entrypoint, this.c.asp, this.state.syncedTo)
    ).labels;
    await this.c.storage?.set(STATE_KEY(this.c.pool), ser(this.state));
    return this.state;
  }

  private need(): { state: PoolState; asp: bigint[] } {
    if (!this.state || !this.aspLabels) throw new Error("sync first");
    return { state: this.state, asp: this.aspLabels };
  }

  /**
   * Our notes. `maxDeposits` stops discovery after that many deposit indices (a wallet that knows how many deposits
   * it made never probes the next index, which would cost a vault scan on every refresh).
   */
  notes(o: { gapLimit?: number; maxDeposits?: number } = {}): Promise<DiscoveryResult> {
    const { state, asp } = this.need();
    return discoverNotes({ secrets: this.c.secrets, state, aspLabels: asp, ...o });
  }

  /** The spendable note of a public ledger entry: one vault signature, checked against the pool (`noteFromPublic`). */
  noteFor(pub: PublicNote): Promise<Note> {
    return noteFromPublic(pub, this.c.secrets);
  }

  /** The change note's secrets for a spend of `note` (the same signature `prove` uses; public parts go to the ledger). */
  changeSecrets(note: Note): Promise<NoteSecrets> {
    return this.c.secrets.getSecrets(note.depositIndex, note.secretIndex + 1);
  }

  /**
   * The next deposit: its precommitment comes from one vault envelope signature `(d, 0)`. A wallet that keeps a
   * public ledger passes `depositIndex` (how many deposits it made) so nothing else is derived; without it the
   * index comes from a full discovery (a vault signature per deposit).
   */
  async prepareDeposit(
    value: bigint,
    o: { depositIndex?: number } = {},
  ): Promise<{ tx: DepositTx; depositIndex: number; precommitment: bigint; nullifierHash: bigint }> {
    const nextDepositIndex = o.depositIndex ?? (await this.notes()).nextDepositIndex;
    const s = await this.c.secrets.getDepositSecrets(nextDepositIndex);
    const p = this.c.provider;
    const [cfg, used] = await Promise.all([
      p.call({
        to: this.c.entrypoint,
        data: encodeFunctionData({ abi: ENTRYPOINT_ABI, functionName: "assetConfig", args: [NATIVE_ASSET] }),
      }),
      p.call({
        to: this.c.entrypoint,
        data: encodeFunctionData({ abi: ENTRYPOINT_ABI, functionName: "usedPrecommitments", args: [s.precommitment] }),
      }),
    ]);
    const [, minimum] = decodeFunctionResult({ abi: ENTRYPOINT_ABI, functionName: "assetConfig", data: cfg });
    if (value < minimum) throw new Error(`deposit below the pool minimum ${minimum}`);
    if (decodeFunctionResult({ abi: ENTRYPOINT_ABI, functionName: "usedPrecommitments", data: used })) {
      throw new Error(`precommitment of deposit ${nextDepositIndex} already used (re-sync)`);
    }
    return {
      tx: buildDepositTx(this.c.entrypoint, value, s.precommitment),
      depositIndex: nextDepositIndex,
      precommitment: s.precommitment,
      nullifierHash: s.nullifierHash,
    };
  }

  /** Proves spending `amount` of `note` under `withdrawal` (whose data carries the fee terms of the chosen mode). */
  async prove(note: Note, amount: bigint, withdrawal: Withdrawal): Promise<PreparedProof> {
    const { state, asp } = this.need();
    const change = await this.c.secrets.getSecrets(note.depositIndex, note.secretIndex + 1);
    const { inputs, context, changeCommitment } = buildWithdrawInputs({
      note,
      amount,
      state,
      aspLabels: asp,
      withdrawal,
      scope: await this.scope(),
      change,
    });
    const [proof, rootIndexHint] = await Promise.all([
      this.c.prover.prove(inputs),
      findRootIndex(this.c.provider, this.c.pool, state.root),
    ]);
    return { proof, context, changeCommitment, rootIndexHint };
  }

  /**
   * Mode `frame-paymaster`: a fresh default-code sender (derived from the change note's envelope signature, so it is
   * recoverable from the vault) receives `amount − fee + refund`; PoolPayer pays the gas out of the withdrawal.
   */
  async withdrawViaPoolPayer(a: {
    note: Note;
    amount: bigint;
    broadcaster: FramePaymasterBroadcaster;
    refundRecipient?: Address;
    /** The fresh sender; default: derived from the change note's vault signature (recoverable from the vault). */
    sender?: FrameSenderSigner;
    onStatus?: (s: string) => void;
    /** Called once the signed transaction is built, before it is submitted (so a caller can persist its hash). */
    onBuilt?: (b: { hash: Hex; sender: Address; fee: bigint }) => void | Promise<void>;
  }): Promise<FramePaymasterOutcome & { sender: Address; fee: bigint; changeCommitment: bigint }> {
    assertWithdrawMode("frame-paymaster");
    const { state } = this.need();
    const hint = await findRootIndex(this.c.provider, this.c.pool, state.root);
    const sender =
      a.sender ?? localFrameSigner(await this.c.secrets.senderKey(a.note.depositIndex, a.note.secretIndex + 1));
    const q = await a.broadcaster.quote({
      sender,
      rootIndexHint: hint,
      ...(a.refundRecipient ? { refundRecipient: a.refundRecipient } : {}),
    });
    if (q.fee > a.amount) throw new Error(`withdrawal ${a.amount} does not cover the gas (${q.fee})`);
    a.onStatus?.("prove");
    const p = await this.prove(a.note, a.amount, q.withdrawal);
    const built = await a.broadcaster.build(q, p.proof.proof, p.rootIndexHint);
    await a.onBuilt?.({ hash: built.hash, sender: q.sender, fee: q.fee });
    a.onStatus?.("routing");
    const hash = await a.broadcaster.submit(built);
    const out = await a.broadcaster.wait(hash, a.onStatus);
    return { ...out, sender: q.sender, fee: q.fee, changeCommitment: p.changeCommitment };
  }

  /** Mode `relayer`: 0xbow's relayer submits `Entrypoint.relay` and keeps its quoted, on-chain-capped BPS. */
  async withdrawViaRelayer(a: {
    note: Note;
    amount: bigint;
    recipient: Address;
    relayer: RelayerClient;
  }): Promise<RelayerResult> {
    assertWithdrawMode("relayer");
    const quote = await a.relayer.quote({
      chainId: this.c.chainId,
      amount: a.amount,
      asset: NATIVE_ASSET,
      recipient: a.recipient,
    });
    const cfg = await this.c.provider.call({
      to: this.c.entrypoint,
      data: encodeFunctionData({ abi: ENTRYPOINT_ABI, functionName: "assetConfig", args: [NATIVE_ASSET] }),
    });
    const [, , , maxRelayFeeBPS] = decodeFunctionResult({
      abi: ENTRYPOINT_ABI,
      functionName: "assetConfig",
      data: cfg,
    });
    const { withdrawal } = relayerWithdrawal({
      entrypoint: this.c.entrypoint,
      recipient: a.recipient,
      quote,
      maxRelayFeeBPS,
    });
    const p = await this.prove(a.note, a.amount, withdrawal);
    return a.relayer.request({
      chainId: this.c.chainId,
      scope: await this.scope(),
      asset: NATIVE_ASSET,
      withdrawal,
      proof: p.proof,
      quote,
    });
  }
}
