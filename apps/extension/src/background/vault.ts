import {
  decodeEventLog,
  encodeFunctionData,
  hexToBytes,
  isAddressEqual,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  encodeTx,
  fromWire,
  getProfile,
  recoverSecp256k1Signer,
  roleSignerPathATx,
  roleSignerPathBTx,
  setSignature,
  sigHash,
  toWire,
  txHash,
  type FrameTx,
  type FrameTxReceipt,
  type WireFrameTx,
} from "@leaked/frames";
import { schemeById } from "@leaked/pq-signer";
import type { NodeClient, SidecarClient } from "@leaked/rpc";
import {
  ROLE,
  TX_TYPE,
  UrSchemaError,
  decodeSignature,
  encodeSignRequest,
  randomUuid,
  type AdvisoryPolicy,
  type SignRequest,
} from "@leaked/ur";
import { accountAbi, pqRoleSignerAbi, pqVerifierAbi } from "../generated/contracts";
import { findNetwork, type Network } from "../shared/chains";
import { StorageKeys, type KV } from "../shared/kv";
import {
  CLONE_GAS,
  RECOVERY_SIGNER_FLOAT,
  VAULT_SIGNER_FLOAT,
  createRoleSignerCalldata,
  roleParams,
  type AccountPlan,
  type AccountPlans,
} from "./account";
import type { ActivityStore } from "./activity";
import type { KeyringController } from "./keyring";
import { choosePath, onlyBudgetViolation, parseBudgets, STOCK_VERIFY_BUDGET, type LaneBudgets } from "./lanes";
import { parseSimFrames } from "./engine";
import {
  buildVaultAction,
  type BuiltVaultAction,
  type CurrentPolicy,
  type VaultActionRequest,
  type VaultRole,
} from "./vaultActions";

/**
 * The Vault flow from the extension side (plan §30 §6, ux-spec §3.6): build the role signer's frame transaction for
 * the chosen path, wrap it as `ur:leaked-sign-request` (keys 1–12 exactly as `apps/companion` parses them), and once
 * the phone's `ur:leaked-signature` is scanned back: check it is the answer to *this* request, verify the
 * quantum-safe witness locally against the signer's on-chain `pk()` with `@leaked/pq-signer` and the Path-B payer
 * signature against `payerKey()`, simulate the exact signed bytes, and only then submit. Nothing unverified or
 * unsimulated is ever sent; a request is never re-broadcast automatically (plan §30 §4.7).
 */

export const REQUEST_TTL_MS = 10 * 60_000;
/** Role-signer body limits (G1 ROLE_BODY); the signer's `maxFee` bounds the worst case. */
const ROLE_BODY = { execution: 700_000n, state: 400_000n };
const GWEI = 1_000_000_000n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

export type VaultRequestStatus =
  | "waiting" // QR shown, waiting for the phone's signature
  | "sending" // verified + simulated, submitted, waiting for a receipt
  | "confirmed" // mined, the action took effect
  | "scheduled" // mined, a queued op is waiting out its timelock
  | "failed" // mined but the role call reverted, or refused before sending
  | "expired"
  | "cancelled";

export interface VaultRequestRecord {
  id: string;
  chainId: number;
  role: VaultRole;
  account: Address;
  signer: Address;
  path: "A" | "B";
  lane: "standard" | "staked";
  rules: string[];
  profileId: string;
  action: Omit<BuiltVaultAction, "data" | "usd6" | "intent"> & { usd6?: string };
  /** The unsigned transaction (PQ placeholder in entry 0, payer placeholder in entry 1 on Path B). */
  wire: WireFrameTx;
  digest: Hex;
  /** `ur:leaked-sign-request` CBOR (hex); the page renders the animated QR from it. */
  cbor: Hex;
  createdAt: number;
  expiresAt: number;
  status: VaultRequestStatus;
  hash?: Hex;
  error?: { code: string; message: string };
  /** Queued ops: from the mined `Queued` event. */
  opId?: Hex;
  eta?: number;
  origin?: string;
  /** An approval-window request waiting on this (dapp asked; resolved when sent). */
  approvalId?: string;
  feeWei?: string;
  /** "Replace everyday key": the new key's derivation index, adopted once the change is confirmed. */
  hotIndex?: number;
  updatedAt: number;
}

export class VaultError extends Error {
  constructor(
    /** ux-spec §7 code (E-60 expired, E-61 wrong response, E-62 bad signature, …) or a short reason. */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "VaultError";
  }
}

export interface VaultIo {
  publicClient(chainId: number): PublicClient;
  node(chainId: number): NodeClient;
  /** A sidecar client for a URL (the staked lane); absent in contexts without one. */
  sidecar?(url: string): SidecarClient;
}

export interface VaultDeps {
  io: VaultIo;
  kv: KV;
  keyring: KeyringController;
  plans: AccountPlans;
  activity: ActivityStore;
  now: () => number;
}

interface SignerState {
  address: Address;
  deployed: boolean;
  pk: Hex;
  payerKey: Address;
  schemeId: Hex;
  verifyGasEstimate: bigint;
  sigLength: number;
  maxFee: bigint;
  balance: bigint;
  staked: boolean;
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export class VaultFlow {
  constructor(private readonly d: VaultDeps) {}

  // ---- storage ----

  async list(): Promise<VaultRequestRecord[]> {
    return (await this.d.kv.get<VaultRequestRecord[]>(StorageKeys.vaultRequests)) ?? [];
  }

  async get(id: string): Promise<VaultRequestRecord | undefined> {
    const r = (await this.list()).find((x) => x.id === id);
    if (r && r.status === "waiting" && this.d.now() > r.expiresAt) return this.update(r.id, { status: "expired" });
    return r;
  }

  private async put(r: VaultRequestRecord): Promise<void> {
    const all = (await this.list()).filter((x) => x.id !== r.id);
    all.unshift(r);
    await this.d.kv.set(StorageKeys.vaultRequests, all.slice(0, 100));
  }

  async update(id: string, patch: Partial<VaultRequestRecord>): Promise<VaultRequestRecord | undefined> {
    const all = await this.list();
    const i = all.findIndex((x) => x.id === id);
    if (i < 0) return undefined;
    all[i] = { ...all[i]!, ...patch, updatedAt: this.d.now() };
    await this.d.kv.set(StorageKeys.vaultRequests, all);
    return all[i];
  }

  // ---- chain reads ----

  private sidecar(url: string): SidecarClient {
    if (!this.d.io.sidecar) throw new VaultError("no-lane", "The staked lane isn't reachable from here.");
    return this.d.io.sidecar(url);
  }

  private network(chainId: number): Network & { deployment: NonNullable<Network["deployment"]>; profileId: string } {
    const net = findNetwork(chainId);
    if (!net?.deployment || !net.profileId)
      throw new VaultError("unsupported", "Vault approvals aren't available on this network.");
    return net as never;
  }

  private async plan(chainId: number): Promise<AccountPlan> {
    const p = await this.d.plans.get(chainId);
    if (!p) throw new VaultError("no-account", "Finish setting up your account first.");
    return p;
  }

  private signerAddress(plan: AccountPlan, role: VaultRole): Address {
    const a = role === "vault" ? plan.vaultSigner : plan.recoverySigner;
    if (!a) throw new VaultError("no-recovery", "No Recovery key is linked to this account yet.");
    return a;
  }

  /** Reads what the extension needs about a role signer; before deployment, from the plan (the derivation inputs). */
  async signerState(chainId: number, role: VaultRole): Promise<SignerState> {
    const plan = await this.plan(chainId);
    const net = this.network(chainId);
    const client = this.d.io.publicClient(chainId);
    const address = this.signerAddress(plan, role);
    const params = roleParams(plan, role);
    const code = await client.getCode({ address });
    const deployed = code !== undefined && code !== "0x";
    const read = <T>(fn: string) =>
      client.readContract({ address, abi: pqRoleSignerAbi, functionName: fn as never }) as Promise<T>;
    const verifier = params.verifier;
    const [schemeId, verifyGasEstimate, sigLength] = await Promise.all([
      client.readContract({ address: verifier, abi: pqVerifierAbi, functionName: "schemeId" }) as Promise<Hex>,
      client.readContract({
        address: verifier,
        abi: pqVerifierAbi,
        functionName: "verifyGasEstimate",
      }) as Promise<bigint>,
      client.readContract({ address: verifier, abi: pqVerifierAbi, functionName: "sigLength" }) as Promise<bigint>,
    ]);
    // On-chain truth once deployed (plan §30 §6.2: verify against the signer's pk(), not our own storage).
    const [pk, payerKey, maxFee] = deployed
      ? await Promise.all([read<Hex>("pk"), read<Address>("payerKey"), read<bigint>("maxFee")])
      : [params.pk, params.payerKey, 0n];
    const balance = await client.getBalance({ address });
    let staked = false;
    if (deployed) {
      try {
        const [stake, , withdrawTime] = (await client.readContract({
          address: net.deployment.stakingRegistry,
          abi: STAKING_ABI,
          functionName: "getDepositInfo",
          args: [address],
        })) as readonly [bigint, number, bigint];
        staked = stake >= 10_000_000_000_000_000n && withdrawTime === 0n;
      } catch {
        staked = false;
      }
    }
    return {
      address,
      deployed,
      pk,
      payerKey,
      schemeId,
      verifyGasEstimate,
      sigLength: Number(sigLength),
      maxFee,
      balance,
      staked,
    };
  }

  /** The verification budgets of the lanes: the stock 100k, and the BUDGET-010 sidecar's `skandha_config.budgets`. */
  async budgets(chainId: number): Promise<LaneBudgets> {
    const net = this.network(chainId);
    const out: LaneBudgets = { standard: STOCK_VERIFY_BUDGET };
    if (net.stakedSidecarUrl) {
      try {
        const staked = parseBudgets(await this.sidecar(net.stakedSidecarUrl).config());
        if (staked) out.staked = staked;
      } catch {
        // unreachable: no staked lane right now
      }
    }
    return out;
  }

  /** The account's current policy (for tighten / loosen decisions and the request's advisory key 12). */
  async currentPolicy(chainId: number): Promise<CurrentPolicy> {
    const plan = await this.plan(chainId);
    const client = this.d.io.publicClient(chainId);
    const read = <T>(fn: string, args: readonly unknown[] = []) =>
      client.readContract({
        address: plan.address,
        abi: accountAbi,
        functionName: fn as never,
        args: args as never,
      }) as Promise<T>;
    const [hot, bucket, vb, mode, tokenList] = await Promise.all([
      read<{ perTxMaxUsd: bigint; maxFeeWeiPerTx: bigint; maxHotFrames: number }>("getHotConfig"),
      read<readonly [bigint, number, bigint, number]>("getBucket"),
      read<readonly [bigint, bigint, number]>("getVaultBucket"),
      read<number>("recipientMode"),
      read<readonly Address[]>("getTokenList"),
    ]);
    const tokens: CurrentPolicy["tokens"] = {};
    for (const t of [ZERO, ...tokenList]) {
      const c = await read<{ allowed: boolean; decimals: number; usdPerToken: bigint }>("getToken", [t]);
      tokens[t.toLowerCase()] = { allowed: c.allowed, decimals: Number(c.decimals), usdPerToken: c.usdPerToken };
    }
    return {
      capUsd: bucket[2],
      perTxMaxUsd: hot.perTxMaxUsd,
      maxFeeWeiPerTx: hot.maxFeeWeiPerTx,
      maxHotFrames: Number(hot.maxHotFrames),
      recipientMode: Number(mode) === 0 ? "open" : "strict",
      vaultAvailableUsd: vb[0],
      timelockDelay: Number(vb[2]),
      tokens,
      sessions: {},
    };
  }

  // ---- role signer deployment (lazy, by the fee tank) ----

  /**
   * Deploys a derived role signer if it has no code yet: `createRoleSigner` with the plan's arguments, sent by the fee
   * tank with a float the signer pays its own fees from (anyone may send it; IMPLEMENTATION-NOTES "Bound signers").
   * Returns the deployment hash, or undefined when it was already deployed.
   */
  async ensureSigner(chainId: number, role: VaultRole, wait = true): Promise<Hex | undefined> {
    const plan = await this.plan(chainId);
    const net = this.network(chainId);
    const client = this.d.io.publicClient(chainId);
    const address = this.signerAddress(plan, role);
    const code = await client.getCode({ address });
    if (code && code !== "0x") return undefined;
    const accounts = await this.d.keyring.accounts();
    if (!accounts) throw new VaultError("locked", "Unlock LEAKED first.");
    const data = createRoleSignerCalldata(plan, role);
    const value = role === "vault" ? VAULT_SIGNER_FLOAT : RECOVERY_SIGNER_FLOAT;
    const gasPrice = await this.gasPrice(chainId);
    const tank = await client.getBalance({ address: accounts.feeTank });
    if (tank < value + CLONE_GAS * gasPrice) {
      throw new VaultError(
        "tank-low",
        `Your fee tank needs about ${(Number(value + CLONE_GAS * gasPrice) / 1e18).toFixed(4)} ETH to set up your ${role === "vault" ? "Vault" : "Recovery key"} on the network.`,
      );
    }
    await client.call({ account: accounts.feeTank, to: net.deployment.roleSignerFactory, data, value, gas: CLONE_GAS });
    const nonce = await client.getTransactionCount({ address: accounts.feeTank, blockTag: "pending" });
    const raw = await this.d.keyring.withHotKeys((k) =>
      privateKeyToAccount(k.feeTank).signTransaction({
        type: "legacy",
        chainId,
        nonce,
        gasPrice,
        gas: CLONE_GAS,
        to: net.deployment.roleSignerFactory,
        data,
        value,
      }),
    );
    const hash = await this.d.io.node(chainId).sendRawTransaction(raw);
    if (wait) {
      const r = await client.waitForTransactionReceipt({ hash, timeout: 180_000 });
      if (r.status !== "success")
        throw new VaultError("deploy-failed", "Setting up the signer failed; your fee tank paid the network fee.");
    }
    return hash;
  }

  private async gasPrice(chainId: number): Promise<bigint> {
    const gp = await this.d.io.publicClient(chainId).getGasPrice();
    return gp * 2n > GWEI ? gp * 2n : GWEI;
  }

  // ---- requests ----

  /** Builds and stores a request; the page shows its QR. Deploys the role signer first if it has no code. */
  async create(
    chainId: number,
    req: VaultActionRequest,
    meta: { origin?: string; approvalId?: string } = {},
  ): Promise<VaultRequestRecord> {
    const net = this.network(chainId);
    const plan = await this.plan(chainId);
    const client = this.d.io.publicClient(chainId);
    const code = await client.getCode({ address: plan.address });
    if (!code || code === "0x") throw new VaultError("not-activated", "Activate your account before using the Vault.");
    const policy = await this.currentPolicy(chainId);
    const built = buildVaultAction(plan.address, req, policy);
    await this.ensureSigner(chainId, built.role);
    const signer = await this.signerState(chainId, built.role);

    const choice = choosePath({
      schemeVerifyGas: signer.verifyGasEstimate,
      hasPayer: signer.payerKey !== ZERO,
      signerStaked: signer.staked,
      budgets: await this.budgets(chainId),
    });
    if (!choice.ok) throw new VaultError("no-lane", choice.reason);

    const profile = getProfile(net.profileId);
    const nonceSeq = await this.d.io.node(chainId).getTransactionCount(signer.address, "pending");
    const base = (await client.getBlock({ blockTag: "latest" })).baseFeePerGas ?? 0n;
    const fees = { maxPriorityFeePerGas: GWEI, maxFeePerGas: 2n * base + GWEI };
    const common = {
      chainId,
      nonceSeq,
      fees,
      roleSigner: signer.address,
      sigLength: signer.sigLength,
      verifyGas: choice.verifyGas,
    };
    const tx: FrameTx =
      choice.path === "B"
        ? roleSignerPathBTx(profile, {
            ...common,
            payerKey: signer.payerKey,
            body: {
              data: encodeFunctionData({
                abi: pqRoleSignerAbi,
                functionName: "executePQ",
                args: [0n, plan.address, built.data],
              }),
              ...ROLE_BODY,
            },
          })
        : roleSignerPathATx(profile, {
            ...common,
            body: {
              data: encodeFunctionData({
                abi: pqRoleSignerAbi,
                functionName: "relay",
                args: [plan.address, built.data],
              }),
              ...ROLE_BODY,
            },
          });

    const now = this.d.now();
    const id = randomUuid();
    const request = signRequest({
      id,
      chainId,
      role: built.role,
      payload: encodeTx(profile, tx),
      schemeId: signer.schemeId,
      pk: signer.pk,
      profileId: net.profileId,
      origin: meta.origin ?? "LEAKED extension",
      built,
      policy: advisoryPolicy(plan.address, policy),
    });
    const record: VaultRequestRecord = {
      id,
      chainId,
      role: built.role,
      account: plan.address,
      signer: signer.address,
      path: choice.path,
      lane: choice.lane,
      rules: choice.rules,
      profileId: net.profileId,
      action: {
        role: built.role,
        action: built.action,
        title: built.title,
        effect: built.effect,
        timing: built.timing,
        ...(built.queued ? { queued: built.queued } : {}),
        ...(built.usd6 !== undefined ? { usd6: built.usd6.toString() } : {}),
      },
      wire: toWire(tx),
      digest: sigHash(profile, tx),
      cbor: toHex(encodeSignRequest(request)),
      createdAt: now,
      expiresAt: now + REQUEST_TTL_MS,
      status: "waiting",
      ...(meta.origin ? { origin: meta.origin } : {}),
      ...(meta.approvalId ? { approvalId: meta.approvalId } : {}),
      ...(req.type === "setHotKey" ? { hotIndex: req.index } : {}),
      updatedAt: now,
    };
    // Plan §30 §6.3: never hold two live requests for one (signer, nonce). Every waiting request of this signer
    // carries the same pending nonce as this one, so an older code the phone may still sign is withdrawn now: its
    // answer is refused at scan-back rather than racing this one.
    for (const r of await this.list()) {
      if (r.status === "waiting" && r.chainId === chainId && isAddressEqual(r.signer, signer.address)) {
        await this.update(r.id, {
          status: "cancelled",
          error: { code: "superseded", message: "A newer request for this key replaced it. Nothing was sent." },
        });
      }
    }
    await this.put(record);
    return record;
  }

  /**
   * The phone's answer: check, verify, simulate, submit. Throws a `VaultError` with the ux-spec code (E-60/61/62/…)
   * and leaves the request waiting, so the user can scan again; nothing is sent unless every check passes.
   */
  async submit(id: string, signatureCbor: Hex): Promise<VaultRequestRecord> {
    const rec = await this.get(id);
    if (!rec) throw new VaultError("unknown", "This request is no longer available. Start again.");
    if (rec.status === "expired" || this.d.now() > rec.expiresAt) {
      await this.update(id, { status: "expired" });
      throw new VaultError("E-60", "This request expired. Nothing was sent. Start again for a fresh code.");
    }
    if (rec.status === "cancelled" && rec.error?.code === "superseded") {
      throw new VaultError(
        "superseded",
        "This code was replaced by a newer request. Nothing was sent. Scan the newest code shown by LEAKED instead.",
      );
    }
    if (rec.status !== "waiting") throw new VaultError("not-waiting", "This request was already handled.");

    let sig;
    try {
      sig = decodeSignature(hexToBytes(signatureCbor));
    } catch (e) {
      throw new VaultError(
        "E-62",
        `That code isn't a valid signature (${e instanceof UrSchemaError ? e.message : "unreadable"}).`,
      );
    }
    if (sig.requestId !== rec.id) {
      throw new VaultError("E-61", "That signature is for a different request. Scan the code for this request.");
    }
    if (!sig.witness || !sig.schemeId) throw new VaultError("E-62", "The phone sent no quantum-safe signature.");

    const profile = getProfile(rec.profileId);
    const unsigned = fromWire(rec.wire);
    const digest = sigHash(profile, unsigned);
    if (digest !== rec.digest) throw new VaultError("E-62", "Internal check failed: the request changed.");
    const signer = await this.signerState(rec.chainId, rec.role);
    if (!isAddressEqual(signer.address, rec.signer) || !signer.deployed) {
      throw new VaultError("E-62", "The signer this request was made for is not on the network.");
    }
    if (sig.schemeId.toLowerCase() !== signer.schemeId.toLowerCase()) {
      throw new VaultError("E-62", "The signature uses a different kind of key than your account's Vault.");
    }
    // 1. The quantum-safe witness, against the signer's on-chain pk() (plan §30 §6.2).
    const scheme = schemeById(signer.schemeId);
    if (!scheme)
      throw new VaultError("E-22", "This Vault uses a key type this version doesn't support. Update LEAKED.");
    if (!scheme.verify(hexToBytes(signer.pk), hexToBytes(digest), hexToBytes(sig.witness))) {
      throw new VaultError(
        "E-62",
        "The signature didn't check out. Nothing was sent. Make sure this phone is the Vault paired with this account.",
      );
    }
    let tx = setSignature(profile, unsigned, 0, sig.witness);
    // 2. Path B: the payer signature must recover to the signer's pinned payerKey().
    if (rec.path === "B") {
      if (!sig.payerSig) throw new VaultError("E-62", "The phone didn't sign the network fee step.");
      tx = setSignature(profile, tx, 1, sig.payerSig);
      const payer = await recoverSecp256k1Signer(profile, tx, 1).catch(() => ZERO);
      if (!isAddressEqual(payer as Address, signer.payerKey)) {
        throw new VaultError(
          "E-62",
          "The fee-step signature is from a different key than your Vault's. Nothing was sent.",
        );
      }
    } else if (sig.payerSig) {
      throw new VaultError("E-64", "Network conditions changed. Please approve the new code on your phone.");
    }

    // 3. Simulate the exact bytes (fail closed).
    const raw = encodeTx(profile, tx);
    const sim = await this.d.io.node(rec.chainId).simulateFrameTransaction(raw);
    const frames = parseSimFrames(sim.frames);
    const bodyOk = frames.length >= 2 && frames[1]!.succeeded && !sim.executionError;
    const admitted = rec.lane === "staked" ? sim.valid || onlyBudgetViolation(sim.violation) : sim.valid;
    const maxCost = sim.maxCost ?? 0n;
    if (!admitted || !bodyOk) {
      const why = sim.executionError ?? sim.violation ?? "the account refused it";
      await this.update(id, { status: "failed", error: { code: "SIM-REJECTED", message: why } });
      throw new VaultError("SIM-REJECTED", `The network would refuse this approval (${why}). Nothing was sent.`);
    }
    if (sim.maxCost === null || maxCost > signer.maxFee) {
      throw new VaultError(
        "fee-too-high",
        "The network fee is above what your Vault signer allows right now. Nothing was sent.",
      );
    }
    if (signer.balance < maxCost) {
      throw new VaultError(
        "signer-low",
        "Your Vault signer doesn't have enough ETH for the network fee. Top it up from Security, then scan again.",
      );
    }

    // 4. Submit on the chosen lane.
    const hash =
      rec.lane === "staked"
        ? await this.sidecar(this.network(rec.chainId).stakedSidecarUrl!).sendFrameTransaction(tx)
        : await this.d.io.node(rec.chainId).sendRawTransaction(raw);
    if (hash.toLowerCase() !== txHash(profile, tx).toLowerCase()) {
      throw new VaultError("hash-mismatch", `The node returned ${hash}.`);
    }
    const now = this.d.now();
    await this.d.activity.add({
      id: rec.id,
      chainId: rec.chainId,
      kind: "vault",
      ...(rec.origin && rec.origin !== "LEAKED extension" ? { origin: rec.origin } : {}),
      account: rec.account,
      tank: rec.signer,
      calls: [],
      declaredUsd: rec.action.usd6 ?? "0",
      rules: [] as never,
      status: "confirming",
      hash,
      replaced: [],
      nonce: unsigned.nonceSeq.toString(),
      headline: `Approved by your phone: ${rec.action.title}`,
      detail: rec.action.effect,
      steps: [
        { label: rec.path === "A" ? "Check the quantum-safe signature" : "Check the fee step", status: "pending" },
        { label: rec.action.title, status: "pending" },
      ],
      createdAt: now,
      updatedAt: now,
    });
    return (await this.update(id, { status: "sending", hash }))!;
  }

  /** Polls receipts of sent requests; `Queued` events turn into scheduled changes with their eta. */
  async refresh(): Promise<VaultRequestRecord[]> {
    const changed: VaultRequestRecord[] = [];
    for (const r of await this.list()) {
      if (r.status !== "sending" || !r.hash) continue;
      try {
        const receipt = await this.receipt(r);
        if (!receipt) continue;
        const ok = receipt.frameReceipts[1]?.status === "success";
        let opId: Hex | undefined;
        let eta: number | undefined;
        for (const f of receipt.frameReceipts) {
          for (const log of f.logs) {
            if (!isAddressEqual(log.address, r.account)) continue;
            try {
              const ev = decodeEventLog({ abi: accountAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
              if (ev.eventName === "Queued") {
                const a = ev.args as unknown as { opId: Hex; eta: number };
                opId = a.opId;
                eta = Number(a.eta);
              }
            } catch {
              // not an account event we know
            }
          }
        }
        const status: VaultRequestStatus = !ok ? "failed" : opId ? "scheduled" : "confirmed";
        const u = await this.update(r.id, {
          status,
          ...(opId ? { opId } : {}),
          ...(eta ? { eta } : {}),
          ...(!ok ? { error: { code: "REVERTED", message: "Your account refused the approved change." } } : {}),
        });
        await this.d.activity.update(r.id, {
          status: ok ? "confirmed" : "failed",
          headline: ok
            ? opId
              ? `Scheduled: ${r.action.title}`
              : `Done: ${r.action.title}`
            : `Failed: ${r.action.title}`,
          detail: ok
            ? opId
              ? `Happens after the waiting period (${new Date(eta! * 1000).toLocaleString("en-GB")}). You can cancel it from Pending.`
              : r.action.effect
            : "Your account refused it. Your Vault signer paid the network fee.",
          steps: receipt.frameReceipts.slice(0, 2).map((f, i) => ({
            label:
              i === 0 ? (r.path === "A" ? "Check the quantum-safe signature" : "Check the fee step") : r.action.title,
            status:
              f.status === "success"
                ? ("done" as const)
                : f.status === "skipped"
                  ? ("skipped" as const)
                  : ("failed" as const),
          })),
          ...(receipt.blockNumber !== undefined ? { blockNumber: receipt.blockNumber.toString() } : {}),
        });
        if (u) changed.push(u);
      } catch {
        // retry on the next poll
      }
    }
    return changed;
  }

  private async receipt(r: VaultRequestRecord): Promise<FrameTxReceipt | null> {
    const fromNode = await this.d.io
      .node(r.chainId)
      .getTransactionReceipt(r.hash!)
      .catch(() => null);
    if (fromNode || r.lane !== "staked") return fromNode;
    return this.sidecar(this.network(r.chainId).stakedSidecarUrl!)
      .getFrameTransactionReceipt(r.hash!)
      .catch(() => null);
  }

  async cancelRequest(id: string): Promise<void> {
    const r = await this.get(id);
    if (r && r.status === "waiting") await this.update(id, { status: "cancelled" });
  }

  // ---- the timelock queue (plan §30 §6.4) ----

  async queue(chainId: number): Promise<QueuedView[]> {
    const plan = await this.d.plans.get(chainId);
    if (!plan) return [];
    const client = this.d.io.publicClient(chainId);
    const code = await client.getCode({ address: plan.address });
    if (!code || code === "0x") return [];
    const logs = await client.getContractEvents({
      address: plan.address,
      abi: accountAbi,
      eventName: "Queued",
      fromBlock: 0n,
    });
    const records = await this.list();
    const block = await client.getBlock({ blockTag: "latest" });
    const out: QueuedView[] = [];
    for (const l of logs) {
      const { opId, kind, eta } = l.args as unknown as { opId: Hex; kind: number; eta: number };
      const q = (await client.readContract({
        address: plan.address,
        abi: accountAbi,
        functionName: "getQueued",
        args: [opId],
      })) as { eta: number; kind: number; state: number };
      const rec = records.find((r) => r.opId?.toLowerCase() === opId.toLowerCase());
      const state = (["none", "pending", "executed", "cancelled"] as const)[Number(q.state)] ?? "none";
      out.push({
        opId,
        kind: Number(kind),
        eta: Number(eta),
        state,
        title: rec?.action.title ?? (Number(kind) === 0 ? "A large payment" : "A change that raises your limits"),
        ...(rec
          ? { requestId: rec.id, queuedAt: rec.updatedAt, executable: !!rec.action.queued }
          : { executable: false }),
        chainNow: Number(block.timestamp),
      });
    }
    return out.sort((a, b) => b.eta - a.eta);
  }

  /** `executeQueued(opId, calls)` after the eta: permissionless, sent by the fee tank as a plain transaction. */
  async executeQueued(chainId: number, opId: Hex): Promise<Hex> {
    const plan = await this.plan(chainId);
    const rec = (await this.list()).find((r) => r.opId?.toLowerCase() === opId.toLowerCase());
    if (!rec?.action.queued)
      throw new VaultError("unknown-op", "LEAKED doesn't have the details of this change, so it can't send it.");
    const calls = rec.action.queued.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }));
    const data = encodeFunctionData({ abi: accountAbi, functionName: "executeQueued", args: [opId, calls] });
    const client = this.d.io.publicClient(chainId);
    const accounts = (await this.d.keyring.accounts())!;
    const gas = 1_500_000n;
    try {
      await client.call({ account: accounts.feeTank, to: plan.address, data, gas });
    } catch (e) {
      throw new VaultError("not-ready", `It can't be sent yet (${(e as Error).message.split("\n")[0]}).`);
    }
    const gasPrice = await this.gasPrice(chainId);
    const nonce = await client.getTransactionCount({ address: accounts.feeTank, blockTag: "pending" });
    const raw = await this.d.keyring.withHotKeys((k) =>
      privateKeyToAccount(k.feeTank).signTransaction({
        type: "legacy",
        chainId,
        nonce,
        gasPrice,
        gas,
        to: plan.address,
        data,
        value: 0n,
      }),
    );
    return this.d.io.node(chainId).sendRawTransaction(raw);
  }
}

export interface QueuedView {
  opId: Hex;
  kind: number;
  eta: number;
  state: "none" | "pending" | "executed" | "cancelled";
  title: string;
  requestId?: string;
  queuedAt?: number;
  executable: boolean;
  /** The latest block's timestamp (countdowns use chain time). */
  chainNow: number;
}

const STAKING_ABI = [
  {
    type: "function",
    name: "getDepositInfo",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [
      { name: "stake", type: "uint256" },
      { name: "unstakeDelaySec", type: "uint32" },
      { name: "withdrawTime", type: "uint64" },
    ],
  },
] as const;

/** Key 12: what the phone can't read itself (the limits and the Vault-pinned prices), always labelled as advisory. */
export function advisoryPolicy(account: Address, p: CurrentPolicy): AdvisoryPolicy {
  return {
    account: account.toLowerCase() as Hex,
    capUsdPerDay: p.capUsd,
    perTxMaxUsd: p.perTxMaxUsd,
    timelockDelay: BigInt(p.timelockDelay),
    timelockThresholdUsd: p.vaultAvailableUsd,
    tokens: Object.entries(p.tokens)
      .filter(([, t]) => t.allowed)
      .map(([token, t]) => ({ token: token as Hex, decimals: t.decimals, usdPerToken: t.usdPerToken })),
    maxFeeWeiPerTx: p.maxFeeWeiPerTx,
    maxHotFrames: p.maxHotFrames,
  };
}

/** `ur:leaked-sign-request` for a role-signer frame tx, keys 1–12 as `apps/companion` parses them. */
export function signRequest(o: {
  id: string;
  chainId: number;
  role: VaultRole;
  payload: Hex;
  schemeId: Hex;
  pk: Hex;
  profileId: string;
  origin: string;
  built: Pick<BuiltVaultAction, "action" | "title" | "intent">;
  policy?: AdvisoryPolicy;
}): SignRequest {
  const intent: NonNullable<SignRequest["intent"]> = { action: o.built.action, summary: o.built.title.slice(0, 500) };
  if (o.built.intent?.recipient) intent.recipient = o.built.intent.recipient.toLowerCase() as Hex;
  if (o.built.intent?.amount !== undefined) intent.amount = o.built.intent.amount;
  if (o.built.intent?.token) intent.token = o.built.intent.token.toLowerCase() as Hex;
  return {
    requestId: o.id,
    chainId: BigInt(o.chainId),
    txType: TX_TYPE.frameTx,
    payload: o.payload,
    role: o.role === "vault" ? ROLE.vault : ROLE.recovery,
    schemeId: o.schemeId,
    sigIndex: 0,
    expectedPk: o.pk,
    origin: o.origin.slice(0, 256),
    profileId: o.profileId,
    intent,
    ...(o.policy && o.role === "vault" ? { policy: o.policy } : {}),
  };
}

/** The last 8 hex characters of a key, as both the phone and the browser show it for the pairing check. */
export const last8 = (h: Hex): string => h.slice(-8).toLowerCase();

export const _test = { short, keccak256 };
