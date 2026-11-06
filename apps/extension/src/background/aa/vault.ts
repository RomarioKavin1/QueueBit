import {
  decodeEventLog,
  decodeFunctionData,
  hexToBytes,
  isAddressEqual,
  keccak256,
  toHex,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { schemeById } from "@queuebit/pq-signer";
import {
  ROLE,
  TX_TYPE,
  UrSchemaError,
  decodeSignature,
  encodeSignRequest,
  randomUuid,
  type SignRequest,
} from "@queuebit/ur";
import { policyHookAbi, pqVerifierAbi, roleExecutorAbi } from "../../generated/contracts";
import type { AaDeployment } from "../../shared/chains";
import type { AccountPlan } from "../account";
import type { CurrentPolicy, VaultActionRequest, VaultRole } from "../vaultActions";
import type { KeyringController } from "../keyring";
import { aaNetwork } from "./payments";
import { buildAaVaultAction, executorDigest, pqSigOf, withPqSig, type ExecutorFn } from "./executor";
import { decodeRevert, revertData } from "./userop";

/**
 * The Vault flow on the 4337 backend (plan §30 §6 for backend U): the phone signs the executor's EIP-712 digest
 * (`ur:queuebit-sign-request` tx-type 3), the extension verifies the witness against the executor's stored PQ key with
 * `@queuebit/pq-signer`, recomputes the digest from the calldata and checks it against the executor's own `hash*` view,
 * simulates the exact call, and the fee tank relays it as a plain transaction (the PQ check runs in execution, so
 * the relayer needs no special rights: IMPLEMENTATION-NOTES "Contracts M7", Gas). Nothing unverified is sent.
 */

export interface AaRoles {
  hook: Address;
  verifier: Address;
  vaultPk: Hex;
  recoveryPk: Hex;
  vaultNonce: bigint;
  recoveryNonce: bigint;
  pendingVaultEta: number;
}

/** Relayed role call gas (C13 verify ≈ 110k inside; 228,923 measured direct vaultExec, 4.2 KB calldata). */
export const AA_ROLE_GAS_FLOOR = 400_000n;

export class AaVault {
  constructor(
    private readonly client: (chainId: number) => PublicClient,
    private readonly keyring: KeyringController,
  ) {}

  dep(chainId: number): AaDeployment {
    const n = aaNetwork(chainId);
    if (!n) throw new Error("Vault approvals aren't available on this network.");
    return n.aa;
  }

  async roles(chainId: number, account: Address): Promise<AaRoles> {
    const r = (await this.client(chainId).readContract({
      address: this.dep(chainId).executor,
      abi: roleExecutorAbi,
      functionName: "getRoles",
      args: [account],
    })) as readonly [Address, Address, Hex, Hex, bigint, bigint, number, Hex, number];
    return {
      hook: r[0],
      verifier: r[1],
      vaultPk: r[2],
      recoveryPk: r[3],
      vaultNonce: r[4],
      recoveryNonce: r[5],
      pendingVaultEta: Number(r[8]),
    };
  }

  async schemeId(chainId: number, verifier: Address): Promise<Hex> {
    return (await this.client(chainId).readContract({
      address: verifier,
      abi: pqVerifierAbi,
      functionName: "schemeId",
    })) as Hex;
  }

  /** The policy the Limits screen and the request's key 12 show (the hook's and the executor's views). */
  async currentPolicy(chainId: number, account: Address): Promise<CurrentPolicy> {
    const dep = this.dep(chainId);
    const c = this.client(chainId);
    const hook = <T>(fn: string, args: readonly unknown[] = []) =>
      c.readContract({
        address: dep.hook,
        abi: policyHookAbi,
        functionName: fn,
        args: [account, ...args],
      } as never) as Promise<T>;
    const [hot, bucket, mode, list, vb] = await Promise.all([
      hook<{ perTxMaxUsd: bigint; maxFeeWei: bigint; maxPriorityFeePerGas: bigint }>("hotView"),
      hook<readonly [bigint, number, bigint]>("getBucket"),
      hook<number>("recipientMode"),
      hook<readonly Address[]>("monitoredTokens"),
      c.readContract({
        address: dep.executor,
        abi: roleExecutorAbi,
        functionName: "getVaultBucket",
        args: [account],
      }) as Promise<readonly [bigint, bigint, number]>,
    ]);
    const tokens: CurrentPolicy["tokens"] = {};
    const ZERO: Address = "0x0000000000000000000000000000000000000000";
    for (const t of [ZERO, ...list.filter((x) => x !== ZERO)]) {
      const cfg = await hook<{ allowed: boolean; decimals: number; usdPerToken: bigint }>("getToken", [t]);
      tokens[t.toLowerCase()] = { allowed: cfg.allowed, decimals: Number(cfg.decimals), usdPerToken: cfg.usdPerToken };
    }
    return {
      capUsd: bucket[2],
      perTxMaxUsd: hot.perTxMaxUsd,
      maxFeeWeiPerTx: hot.maxFeeWei,
      maxPriorityFeePerGas: hot.maxPriorityFeePerGas,
      maxHotFrames: 8,
      recipientMode: Number(mode) === 0 ? "open" : "strict",
      vaultAvailableUsd: vb[0],
      timelockDelay: Number(vb[2]),
      tokens,
      sessions: {},
    };
  }

  /** The executor call + the request for the phone. */
  async build(
    chainId: number,
    plan: AccountPlan,
    req: VaultActionRequest,
    policy: CurrentPolicy,
    meta: { origin?: string },
    advisory: SignRequest["policy"],
  ) {
    const dep = this.dep(chainId);
    const roles = await this.roles(chainId, plan.address);
    if (roles.vaultPk === "0x" + "0".repeat(64)) throw new Error("This account has no Vault on the network yet.");
    const role: VaultRole = req.type === "cancel" ? req.by : "vault";
    if (role === "recovery" && /^0x0+$/u.test(roles.recoveryPk)) {
      throw new Error("No Recovery key is linked to this account yet.");
    }
    const nonce = role === "vault" ? roles.vaultNonce : roles.recoveryNonce;
    const built = buildAaVaultAction(plan.address, dep, req, policy, nonce);
    const { digest } = executorDigest(chainId, dep.executor, built.calldata);
    await this.checkDigest(chainId, built.fn, built.calldata, digest);
    const schemeId = await this.schemeId(chainId, roles.verifier);
    const pk = role === "vault" ? roles.vaultPk : roles.recoveryPk;
    const id = randomUuid();
    const intent: NonNullable<SignRequest["intent"]> = { action: built.action, summary: built.title.slice(0, 500) };
    if (built.intent?.recipient) intent.recipient = built.intent.recipient.toLowerCase() as Hex;
    if (built.intent?.amount !== undefined) intent.amount = built.intent.amount;
    if (built.intent?.token) intent.token = built.intent.token.toLowerCase() as Hex;
    const request: SignRequest = {
      requestId: id,
      chainId: BigInt(chainId),
      txType: TX_TYPE.roleExecutor7579,
      payload: built.calldata,
      role: role === "vault" ? ROLE.vault : ROLE.recovery,
      schemeId,
      expectedPk: pk,
      verifyingContract: dep.executor.toLowerCase() as Hex,
      origin: (meta.origin ?? "QueueBit extension").slice(0, 256),
      intent,
      ...(advisory && role === "vault" ? { policy: advisory } : {}),
    };
    return { id, built, digest, role, pk, cbor: toHex(encodeSignRequest(request)), executor: dep.executor };
  }

  /** The executor's own view of the digest must equal ours (else the phone would sign something else). */
  private async checkDigest(chainId: number, fn: ExecutorFn, calldata: Hex, digest: Hex): Promise<void> {
    const dep = this.dep(chainId);
    const { args } = decodeFunctionData({ abi: roleExecutorAbi, data: calldata });
    const a = args as readonly unknown[];
    const view: Record<ExecutorFn, [string, readonly unknown[]]> = {
      vaultExec: ["hashVaultExec", [a[0], a[3], a[1], a[2]]],
      vaultQueue: ["hashVaultQueue", [a[0], a[3], a[1], a[2]]],
      vaultCancel: ["hashVaultCancel", [a[0], a[2], a[1]]],
      recoveryCancel: ["hashRecoveryCancel", [a[0], a[2], a[1]]],
      recoveryStartVaultRotation: ["hashRecoveryRotate", [a[0], a[2], a[1]]],
      recoveryCancelVaultRotation: ["hashRecoveryCancelRotation", [a[0], a[1]]],
    };
    const [name, viewArgs] = view[fn];
    const onChain = (await this.client(chainId).readContract({
      address: dep.executor,
      abi: roleExecutorAbi,
      functionName: name,
      args: viewArgs,
    } as never)) as Hex;
    if (onChain.toLowerCase() !== digest.toLowerCase()) {
      throw new Error("Internal check failed: the account's digest differs from QueueBit's. Nothing was sent.");
    }
  }

  /**
   * Checks the phone's answer and returns the signed raw transaction from the tank (simulated first). Throws with
   * the ux-spec codes; nothing is sent here.
   */
  async signed(
    rec: { id: string; chainId: number; account: Address; role: VaultRole; exec: { calldata: Hex; digest: Hex } },
    signatureCbor: Hex,
  ): Promise<{ raw: Hex; hash: Hex; nonce: bigint } | { error: string; code: string; failed?: boolean }> {
    let sig;
    try {
      sig = decodeSignature(hexToBytes(signatureCbor));
    } catch (e) {
      return {
        code: "E-62",
        error: `That code isn't a valid signature (${e instanceof UrSchemaError ? e.message : "unreadable"}).`,
      };
    }
    if (sig.requestId !== rec.id) {
      return { code: "E-61", error: "That signature is for a different request. Scan the code for this request." };
    }
    if (!sig.witness || !sig.schemeId) return { code: "E-62", error: "The phone sent no quantum-safe signature." };
    if (sig.payerSig) return { code: "E-62", error: "Unexpected fee-step signature for this network." };
    const dep = this.dep(rec.chainId);
    const { digest } = executorDigest(rec.chainId, dep.executor, rec.exec.calldata);
    if (digest !== rec.exec.digest || pqSigOf(rec.exec.calldata) !== "0x") {
      return { code: "E-62", error: "Internal check failed: the request changed." };
    }
    const roles = await this.roles(rec.chainId, rec.account);
    const schemeId = await this.schemeId(rec.chainId, roles.verifier);
    if (sig.schemeId.toLowerCase() !== schemeId.toLowerCase()) {
      return { code: "E-62", error: "The signature uses a different kind of key than your account's Vault." };
    }
    const scheme = schemeById(schemeId);
    if (!scheme)
      return { code: "E-22", error: "This Vault uses a key type this version doesn't support. Update QueueBit." };
    const pk = rec.role === "vault" ? roles.vaultPk : roles.recoveryPk;
    if (!scheme.verify(hexToBytes(pk), hexToBytes(digest), hexToBytes(sig.witness))) {
      return {
        code: "E-62",
        error:
          "The signature didn't check out. Nothing was sent. Make sure this phone is the Vault paired with this account.",
      };
    }
    const data = withPqSig(rec.exec.calldata, sig.witness);
    const c = this.client(rec.chainId);
    const accounts = await this.keyring.accounts();
    if (!accounts) return { code: "locked", error: "Unlock QueueBit first." };
    let gas: bigint;
    try {
      gas = await c.estimateGas({ account: accounts.feeTank, to: dep.executor, data });
    } catch (e) {
      const why = decodeRevert(revertData(e)) ?? "the account refused it";
      return {
        code: "SIM-REJECTED",
        error: `The network would refuse this approval (${why}). Nothing was sent.`,
        failed: true,
      };
    }
    gas = (gas * 13n) / 10n;
    if (gas < AA_ROLE_GAS_FLOOR) gas = AA_ROLE_GAS_FLOOR;
    const gp = await c.getGasPrice();
    const gasPrice = gp * 2n > 1_000_000_000n ? gp * 2n : 1_000_000_000n;
    if ((await c.getBalance({ address: accounts.feeTank })) < gas * gasPrice) {
      return {
        code: "tank-low",
        error: "Your fee tank doesn't have enough ETH to send this approval. Top it up, then scan again.",
      };
    }
    const nonce = BigInt(await c.getTransactionCount({ address: accounts.feeTank, blockTag: "pending" }));
    const raw = await this.keyring.withHotKeys((k) =>
      privateKeyToAccount(k.feeTank).signTransaction({
        type: "legacy",
        chainId: rec.chainId,
        nonce: Number(nonce),
        gasPrice,
        gas,
        to: dep.executor,
        data,
        value: 0n,
      }),
    );
    return { raw, hash: keccak256(raw), nonce };
  }

  /** The mined outcome: success, and a `Queued(account, opId, kind, eta)` from the executor. */
  async outcome(chainId: number, account: Address, hash: Hex) {
    const r = await this.client(chainId)
      .getTransactionReceipt({ hash })
      .catch(() => null);
    if (!r) return null;
    let opId: Hex | undefined;
    let eta: number | undefined;
    for (const log of r.logs) {
      if (!isAddressEqual(log.address, this.dep(chainId).executor)) continue;
      try {
        const ev = decodeEventLog({ abi: roleExecutorAbi, data: log.data, topics: log.topics });
        if (ev.eventName === "Queued") {
          const a = ev.args as unknown as { account: Address; opId: Hex; eta: number };
          if (isAddressEqual(a.account, account)) {
            opId = a.opId;
            eta = Number(a.eta);
          }
        }
      } catch {
        // another event
      }
    }
    return {
      ok: r.status === "success",
      opId,
      eta,
      blockNumber: r.blockNumber,
      feeWei: r.gasUsed * r.effectiveGasPrice,
    };
  }

  /** `Queued` ops of the account from the executor's logs, with their state. */
  /** `fromBlock`: the account's deployment block (its modules cannot have queued anything earlier). */
  async queue(chainId: number, account: Address, fromBlock = 0n) {
    const dep = this.dep(chainId);
    const c = this.client(chainId);
    const logs = await c.getContractEvents({
      address: dep.executor,
      abi: roleExecutorAbi,
      eventName: "Queued",
      args: { account } as never,
      fromBlock,
    });
    const out: Array<{ opId: Hex; kind: number; eta: number; state: number }> = [];
    for (const l of logs) {
      const { opId, kind, eta } = l.args as unknown as { opId: Hex; kind: number; eta: number };
      const q = (await c.readContract({
        address: dep.executor,
        abi: roleExecutorAbi,
        functionName: "getQueued",
        args: [account, opId],
      })) as { state: number };
      out.push({ opId, kind: Number(kind), eta: Number(eta), state: Number(q.state) });
    }
    return out;
  }
}
