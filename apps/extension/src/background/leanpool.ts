import {
  bytesToHex,
  concat,
  encodeFunctionData,
  hexToBytes,
  keccak256,
  pad,
  toHex,
  type Address,
  type Hex,
} from "viem";
import {
  encodeTx,
  fromWire,
  getProfile,
  leanPoolHotTx,
  sigHash,
  toWire,
  txHash,
  type FrameTxReceipt,
  type WireFrameTx,
} from "@queuebit/frames";
import { LeanSphincsKey, SCHEME_LABEL, SIGNATURE_BUDGET, verify as leanVerify } from "@queuebit/lean-sphincs";
import {
  RpcError,
  createLeanPoolClient,
  httpTransport,
  isFinalLeanPoolStage,
  type LeanPoolClient,
  type LeanPoolTxStatus,
} from "@queuebit/rpc";
import { leanPoolHotSignerAbi, leanPoolHotSignerFactoryAbi } from "../generated/contracts";
import type { ActivityCall, ActivityEntry, ActivityStep } from "./activity";
import { feeAmount, intentTitle, type Labels } from "./activity";
import type { Call } from "./routing";

/**
 * The post-quantum everyday key (docs/plan/60-leanpool-merge-plan.md, option H).
 *
 * A leanVM leanSPHINCS key, derived from the recovery phrase, signs everyday payments. A LeanPool node verifies the
 * signature off-chain, batches it and commits the batch's Merkle root on-chain into the signer's own ring; the
 * account's `LeanPoolHotSigner` (its own EIP-8141 sender) only checks the inclusion proof in VERIFY and then spends
 * through `hotExecuteFrom`, under exactly the everyday limits of the ECDSA everyday key. The signature never goes
 * on-chain, and the ERC-8421 alt mempool admits the transaction without stake.
 *
 * What the user trusts beyond the chain: the LeanPool node they use (its aggregator could approve a payment the key
 * did not sign). The account's everyday limits bound that, exactly as they bound a leaked everyday key, and every
 * batch carries a recursive STARK whose hash is on-chain (`queuebit-leanpool-verify-batch <root>` checks it).
 */

/** The VERIFY frame's execution limit: inclusion check ~50k (measured on the devnet), + ARBITRARY 100 ≤ 100k. */
export const PQ_VERIFY_GAS = 90_000n;
/** Most a single PQ payment may cost the signer (the clone's immutable `maxFee`). */
export const PQ_SIGNER_MAX_FEE = 10_000_000_000_000_000n; // 0.01 ETH
/** What the fee tank puts into a new signer for its first payments. */
export const PQ_SIGNER_INITIAL_FLOAT = 30_000_000_000_000_000n; // 0.03 ETH
/** EIP-8250 nonce lanes the PQ key rotates through, so several payments can wait for their batches at once. */
export const PQ_LANES = 8;

/** The checked everyday twin's body frame: `[VERIFY, pay(tank), SENDER body]` (`hotSpendTx`). */
const TWIN_BODY_FRAME = 2;

export interface PqEverydayRecord {
  chainId: number;
  account: Address;
  /** The `LeanPoolHotSigner` clone (bound to `account`, `aggregator`, `vk`, `maxFee`). */
  signer: Address;
  aggregator: Address;
  vk: Hex;
  maxFee: string;
  nodeUrl: string;
  /** The fee tank's `createHotSigner` transaction. */
  createTx?: Hex;
  /** The user's choice: pay with the quantum-safe key when it is installed and the node answers. */
  preferred: boolean;
  /** Signatures made with this key (leanSPHINCS at kept height 12 is proven for about 120,000). */
  signatures?: number;
  createdAt: number;
}

export type PqEverydayState =
  /** This network has no LeanPool node or no LeanPool contracts. */
  | { state: "unavailable"; reason: string }
  /** Not set up yet. */
  | { state: "off"; aggregator?: Address; nodeOk: boolean }
  /** The signer exists; the Vault has not installed it (or installed another one). */
  | { state: "awaiting-vault"; record: PqEverydayRecord; nodeOk: boolean; balanceWei: string }
  /** Installed by the Vault. `active` when it is also preferred and the node answers. */
  | { state: "on"; record: PqEverydayRecord; nodeOk: boolean; balanceWei: string; active: boolean };

export interface PqDeps {
  /** HKDF of the recovery phrase for `label` (keyring.deriveStorageKey's sibling). Unlocked only. */
  deriveSeed(label: string): Promise<Uint8Array>;
  client(chainId: number): {
    readContract(args: {
      address: Address;
      abi: readonly unknown[];
      functionName: string;
      args?: readonly unknown[];
    }): Promise<unknown>;
    getBalance(args: { address: Address }): Promise<bigint>;
    getCode(args: { address: Address }): Promise<Hex | undefined>;
    getStorageAt(args: { address: Address; slot: Hex }): Promise<Hex | undefined>;
  };
  /** Sends a legacy transaction from the fee tank and waits for it (creating the signer). */
  sendFromTank(chainId: number, tx: { to: Address; data: Hex; value: bigint; gas: bigint }): Promise<Hex>;
  getRecord(chainId: number): Promise<PqEverydayRecord | undefined>;
  putRecord(r: PqEverydayRecord): Promise<void>;
  now(): number;
  leanpool?: (url: string) => LeanPoolClient;
}

/** Failures before the node got the payment: the checked everyday payment may go out instead. */
export const PQ_FALLBACK_REASONS: ReadonlySet<PqEverydayError["reason"]> = new Set([
  "node-down",
  "fee-balance-low",
  "lanes-full",
  "budget",
]);

export class PqEverydayError extends Error {
  constructor(
    /**
     * Before the payment reached the node (`node-down`, `fee-balance-low`, `lanes-full`, `budget`): nothing was handed
     * over, so the checked everyday payment may go out instead. `refused`: the node or the key refused it; never retry
     * it with another key.
     */
    readonly reason:
      | "unavailable"
      | "node-down"
      | "fee-balance-low"
      | "lanes-full"
      | "budget"
      | "not-installed"
      | "locked"
      | "refused",
    message: string,
  ) {
    super(message);
    this.name = "PqEverydayError";
  }
}

/** The pieces of a network the PQ key needs. */
export interface PqNetwork {
  chainId: number;
  profileId?: string;
  leanpoolUrl?: string;
  deployment?: { leanPoolHotSignerFactory?: Address | null; depsRegistry?: Address | null };
}

export class PqEveryday {
  private key: { vk: Hex; key: LeanSphincsKey } | null = null;
  private building: Promise<{ vk: Hex; key: LeanSphincsKey }> | null = null;
  /** Bumped by `lock()`: a key whose build started before a lock is disposed, never kept. */
  private generation = 0;
  private readonly clients = new Map<string, LeanPoolClient>();

  constructor(private readonly d: PqDeps) {}

  private node(url: string): LeanPoolClient {
    let c = this.clients.get(url);
    if (!c) {
      c = this.d.leanpool?.(url) ?? createLeanPoolClient(httpTransport(url, { timeoutMs: 15_000 }));
      this.clients.set(url, c);
    }
    return c;
  }

  /** Builds the key once per unlock (~1 s in WASM); later payments sign in ~0.1 s. */
  async signingKey(): Promise<{ vk: Hex; key: LeanSphincsKey }> {
    if (this.key) return this.key;
    const gen = this.generation;
    this.building ??= (async () => {
      const seed = await this.d.deriveSeed(SCHEME_LABEL);
      try {
        const key = LeanSphincsKey.fromSeed(seed);
        const built = { vk: bytesToHex(key.publicKey), key };
        if (gen !== this.generation) {
          key.dispose();
          throw new PqEverydayError("locked", "QueueBit locked while the quantum-safe key was being prepared.");
        }
        this.key = built;
        return built;
      } finally {
        seed.fill(0);
        this.building = null;
      }
    })();
    return this.building;
  }

  /** On lock: the WASM instance holding the key is released and the key is no longer usable from here. */
  lock(): void {
    this.generation++;
    this.key?.key.dispose();
    this.key = null;
  }

  /** Why the PQ key is not offered on this network, or undefined when it can be. */
  unavailable(net: PqNetwork | undefined): string | undefined {
    if (!net?.profileId) return "Quantum-safe everyday payments need a native-account network.";
    if (!net.deployment?.leanPoolHotSignerFactory || !net.deployment.depsRegistry) {
      return "LeanPool's contracts aren't on this network yet.";
    }
    if (!net.leanpoolUrl) return "This build has no LeanPool node configured for this network.";
    return undefined;
  }

  /** The node's aggregator, if the node answers and posts to this network's registry. */
  private async nodeAggregator(net: PqNetwork): Promise<Address | undefined> {
    try {
      const s = await this.node(net.leanpoolUrl!).status();
      if (!s.aggregating || !s.nodeId || !s.registry) return undefined;
      if (s.registry.toLowerCase() !== net.deployment!.depsRegistry!.toLowerCase()) return undefined;
      return s.nodeId;
    } catch {
      return undefined;
    }
  }

  async state(net: PqNetwork | undefined, account: Address | undefined): Promise<PqEverydayState> {
    const why = this.unavailable(net);
    if (why) return { state: "unavailable", reason: why };
    if (!account) return { state: "unavailable", reason: "Activate your account first." };
    const n = net!;
    const aggregator = await this.nodeAggregator(n);
    const nodeOk = aggregator !== undefined;
    const record = await this.d.getRecord(n.chainId);
    if (!record || record.account.toLowerCase() !== account.toLowerCase()) {
      return { state: "off", ...(aggregator ? { aggregator } : {}), nodeOk };
    }
    const client = this.d.client(n.chainId);
    const [installed, balance] = await Promise.all([
      client.readContract({ address: account, abi: ACCOUNT_PQ_ABI, functionName: "pqHotSigner" }) as Promise<Address>,
      client.getBalance({ address: record.signer }),
    ]);
    if (installed.toLowerCase() !== record.signer.toLowerCase()) {
      return { state: "awaiting-vault", record, nodeOk, balanceWei: balance.toString() };
    }
    return {
      state: "on",
      record,
      nodeOk,
      balanceWei: balance.toString(),
      active: record.preferred && nodeOk && balance >= PQ_MIN_BALANCE,
    };
  }

  /**
   * Step 1 of turning it on: derive the key, create the account's `LeanPoolHotSigner` (the fee tank pays and funds it)
   * and remember it. Step 2 is the Vault's approval of `vaultSetPQHotSigner(signer)` (vaultActions "setPQHotSigner").
   * Idempotent: an existing signer for the same parameters is reused.
   */
  async prepare(net: PqNetwork, account: Address): Promise<PqEverydayRecord> {
    const why = this.unavailable(net);
    if (why) throw new PqEverydayError("unavailable", why);
    const aggregator = await this.nodeAggregator(net);
    if (!aggregator)
      throw new PqEverydayError("node-down", "The LeanPool node isn't answering. Try again in a minute.");
    const { vk } = await this.signingKey();
    const factory = net.deployment!.leanPoolHotSignerFactory!;
    const client = this.d.client(net.chainId);
    const args = [account, aggregator, vk, PQ_SIGNER_MAX_FEE] as const;
    const signer = (await client.readContract({
      address: factory,
      abi: leanPoolHotSignerFactoryAbi,
      functionName: "predictHotSigner",
      args,
    })) as Address;
    let createTx: Hex | undefined;
    const code = await client.getCode({ address: signer });
    if (!code || code === "0x") {
      createTx = await this.d.sendFromTank(net.chainId, {
        to: factory,
        data: encodeFunctionData({ abi: leanPoolHotSignerFactoryAbi, functionName: "createHotSigner", args }),
        value: PQ_SIGNER_INITIAL_FLOAT,
        gas: 1_500_000n,
      });
    }
    const record: PqEverydayRecord = {
      chainId: net.chainId,
      account,
      signer,
      aggregator,
      vk,
      maxFee: PQ_SIGNER_MAX_FEE.toString(),
      nodeUrl: net.leanpoolUrl!,
      ...(createTx ? { createTx } : {}),
      preferred: true,
      createdAt: this.d.now(),
    };
    await this.d.putRecord(record);
    return record;
  }

  async setPreferred(chainId: number, preferred: boolean): Promise<void> {
    const r = await this.d.getRecord(chainId);
    if (!r) throw new PqEverydayError("not-installed", "Set up the quantum-safe key first.");
    await this.d.putRecord({ ...r, preferred });
  }

  /** The signer's next sequence number on nonce lane `key` (EIP-8250 NONCE_MANAGER storage of `net`'s profile). */
  async laneNonce(net: PqNetwork, signer: Address, key: bigint): Promise<bigint> {
    const nm = getProfile(net.profileId!).predeploys?.NONCE_MANAGER as Address | undefined;
    if (!nm) throw new PqEverydayError("unavailable", "This network has no keyed nonces.");
    const slot = keccak256(concat([pad(signer), toHex(key, { size: 32 })]));
    return BigInt((await this.d.client(net.chainId).getStorageAt({ address: nm, slot })) ?? "0x0");
  }

  /** The next free nonce lane and its sequence number (lanes held by pending payments are skipped). */
  async nextLane(
    net: PqNetwork,
    signer: Address,
    busy: ReadonlySet<string>,
  ): Promise<{ nonceKey: bigint; nonceSeq: bigint }> {
    for (let k = 1n; k <= BigInt(PQ_LANES); k++) {
      if (busy.has(k.toString())) continue;
      return { nonceKey: k, nonceSeq: await this.laneNonce(net, signer, k) };
    }
    throw new PqEverydayError(
      "lanes-full",
      `${PQ_LANES} quantum-safe payments are still waiting for LeanPool, so this one used your regular everyday key.`,
    );
  }

  /**
   * Builds the PQ payment from an already-checked everyday payment (its `twin`: the same calls as an ECDSA everyday
   * transaction that the node simulated, body gas included), signs its signature hash with the leanSPHINCS key and
   * hands it to the LeanPool node. Returns what the activity entry needs.
   */
  async submit(a: {
    net: PqNetwork;
    record: PqEverydayRecord;
    declaredUsd: bigint;
    calls: Call[];
    twin: WireFrameTx;
    fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
    busyLanes: ReadonlySet<string>;
  }): Promise<{
    poolId: Hex;
    wire: WireFrameTx;
    nonceKey: bigint;
    nonceSeq: bigint;
    maxCostWei: bigint;
    /** The node didn't answer the hand-over: it may have the payment. Follow it; never send another copy. */
    unconfirmed?: boolean;
  }> {
    const profile = getProfile(a.net.profileId!);
    if ((a.record.signatures ?? 0) >= SIGNATURE_BUDGET) {
      throw new PqEverydayError(
        "budget",
        "Your quantum-safe key has made all the signatures it is proven safe for. Set up a new one in Security; this payment used your regular everyday key.",
      );
    }
    const body = fromWire(a.twin).frames[TWIN_BODY_FRAME];
    if (!body) throw new PqEverydayError("refused", "The checked payment has no body.");
    const limits = { execution: body.limits.execution, state: body.limits.state };
    const maxCostWei = (PQ_VERIFY_GAS + limits.execution + limits.state) * a.fees.maxFeePerGas;
    if (maxCostWei > BigInt(a.record.maxFee)) {
      throw new PqEverydayError(
        "refused",
        "The network fee is above what your quantum-safe key may spend on one payment, so this one used your regular everyday key.",
      );
    }
    const balance = await this.d.client(a.net.chainId).getBalance({ address: a.record.signer });
    if (balance < maxCostWei) {
      throw new PqEverydayError(
        "fee-balance-low",
        `Your quantum-safe key's fee balance is ${feeAmount(balance)}; this payment may need up to ${feeAmount(maxCostWei)}. Top it up from Security.`,
      );
    }
    const { key, vk } = await this.signingKey();
    if (vk.toLowerCase() !== a.record.vk.toLowerCase()) {
      throw new PqEverydayError("refused", "This browser's quantum-safe key isn't the one installed on the account.");
    }
    const lane = await this.nextLane(a.net, a.record.signer, a.busyLanes);
    const tx = leanPoolHotTx(profile, {
      chainId: a.net.chainId,
      nonceSeq: lane.nonceSeq,
      nonceKey: lane.nonceKey,
      fees: a.fees,
      signer: a.record.signer,
      vk,
      verifyGas: PQ_VERIFY_GAS,
      body: {
        data: encodeFunctionData({
          abi: leanPoolHotSignerAbi,
          functionName: "execute",
          args: [a.declaredUsd, a.calls.map((c) => ({ target: c.target, value: c.value, data: c.data }))],
        }),
        ...limits,
      },
    });
    const sh = sigHash(profile, tx);
    const sig = key.sign(hexToBytes(sh));
    if (!leanVerify(key.publicKey, hexToBytes(sh), sig))
      throw new PqEverydayError("refused", "The quantum-safe signature did not verify.");
    await this.d.putRecord({ ...a.record, signatures: (a.record.signatures ?? 0) + 1 });
    // The LeanPool id is the tx hash before the witness: known before the node answers.
    const ownId = txHash(profile, tx).toLowerCase() as Hex;
    const out = { wire: toWire(tx), nonceKey: lane.nonceKey, nonceSeq: lane.nonceSeq, maxCostWei };
    try {
      const { txHash: poolId } = await this.node(a.record.nodeUrl).sendTransaction(encodeTx(profile, tx), [
        bytesToHex(sig),
      ]);
      return { ...out, poolId };
    } catch (e) {
      if (e instanceof RpcError && typeof e.code === "number") {
        throw new PqEverydayError("refused", `LeanPool refused the payment: ${e.reason}`);
      }
      // No answer (timeout, connection dropped): the node may have taken it. Sending the everyday copy too could pay
      // twice, so follow this one by its id instead.
      return { ...out, poolId: ownId, unconfirmed: true };
    }
  }

  track(nodeUrl: string, poolId: Hex): Promise<LeanPoolTxStatus | null> {
    return this.node(nodeUrl).getTx(poolId);
  }
}

/** Below this, a payment would likely not fit the signer's fee balance: the PQ key is not used (and Security says so). */
export const PQ_MIN_BALANCE = 2_000_000_000_000_000n; // 0.002 ETH

const ACCOUNT_PQ_ABI = [
  { type: "function", name: "pqHotSigner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

// ---------------------------------------------------------------------------------------------- activity ----

/** The steps a PQ payment shows: what actually happens, in order. */
export function pqSteps(calls: ActivityCall[], stage?: LeanPoolTxStatus["stage"], bodyOk?: boolean): ActivityStep[] {
  const reached = (s: LeanPoolTxStatus["stage"][]) =>
    stage && s.includes(stage) ? ("done" as const) : ("pending" as const);
  const final = stage === "mined" || stage === "reverted";
  return [
    { label: "Signed with your quantum-safe key", status: "done" },
    { label: "Checked by LeanPool", status: stage === "refused" ? "failed" : stage ? "done" : "pending" },
    { label: "Batch committed on-chain", status: reached(["posted", "submitted", "mined", "reverted"]) },
    {
      label: calls.length > 1 ? `Payment (${calls.length} steps, all or nothing)` : "Payment",
      status: final ? (bodyOk ? "done" : "failed") : stage === "refused" ? "skipped" : "pending",
    },
  ];
}

/** Activity fields for a LeanPool status (and, once mined, its receipt). */
export function describePq(
  entry: Pick<ActivityEntry, "calls" | "declaredUsd">,
  st: LeanPoolTxStatus,
  receipt: FrameTxReceipt | null,
  ctx: { feeWei?: bigint; labels?: Labels },
): Pick<ActivityEntry, "status" | "headline" | "detail" | "steps"> {
  const title = intentTitle(entry.calls, ctx.labels ?? {});
  if (st.stage === "refused") {
    return {
      status: "failed",
      headline: "Not sent: the network refused it",
      detail: st.error ?? "The alt mempool refused the transaction. Nothing was paid.",
      steps: pqSteps(entry.calls, "refused"),
    };
  }
  if ((st.stage === "mined" || st.stage === "reverted") && receipt) {
    const body = receipt.frameReceipts.slice(1);
    const ok = st.stage === "mined" && body.length > 0 && body.every((f) => f.status === "success");
    const fee = ctx.feeWei !== undefined ? feeAmount(ctx.feeWei) : undefined;
    return ok
      ? {
          status: "confirmed",
          headline: `Paid ${title}`,
          detail: `Quantum-safe: no signature on-chain.${fee ? ` Network fee ${fee} from your quantum-safe key's fee balance.` : ""}`,
          steps: pqSteps(entry.calls, st.stage, true),
        }
      : {
          status: "failed",
          headline: `Failed: your account refused this payment, nothing was sent${fee ? `; fee ${fee}` : ""}`,
          detail: "Your limits or allowed lists may have changed before it was included.",
          steps: pqSteps(entry.calls, st.stage, false),
        };
  }
  const waiting: Record<string, string> = {
    pooled: "Waiting for the next LeanPool batch…",
    posted: "Batch committed. Waiting for the block…",
    submitted: "In the alt mempool. Waiting for the block…",
    mined: "Mined. Reading the result…",
    reverted: "Mined. Reading the result…",
  };
  return {
    status: "confirming",
    headline: `Sending ${title}`,
    detail: waiting[st.stage] ?? "Waiting…",
    steps: pqSteps(entry.calls, st.stage),
  };
}

export { isFinalLeanPoolStage };
