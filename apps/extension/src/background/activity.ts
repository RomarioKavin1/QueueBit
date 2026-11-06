import { formatEther, type Address, type Hex } from "viem";
import type { FrameStatus, FrameTxReceipt, WireFrameTx } from "@queuebit/frames";
import { StorageKeys, type KV } from "../shared/kv";
import type { SerializedOp } from "./aa/userop";
import type { RuleId } from "./routing";

/**
 * Activity (ux-spec §3.12): one entry per payment the wallet sent, with per-step status from `frameReceipts`
 * (plan §30 §4.6) and a plain-language headline. Persisted in storage.local so it survives restarts; pending
 * entries keep the signed transaction so a replacement or a status poll can resume after a service-worker restart.
 */

export type ActivityStatus = "sending" | "confirming" | "confirmed" | "failed" | "cancelled" | "replaced";

export interface ActivityStep {
  label: string;
  status: "done" | "failed" | "skipped" | "pending";
}

export interface ActivityCall {
  target: Address;
  /** wei, decimal string */
  value: string;
  data: Hex;
}

export interface ActivityEntry {
  id: string;
  chainId: number;
  kind: "payment" | "cancel" | "activation" | "vault";
  /** The site that asked, for dapp requests. */
  origin?: string;
  /** EIP-5792 batch id (wallet_sendCalls) when the dapp supplied or was given one. */
  batchId?: string;
  account: Address;
  tank: Address;
  calls: ActivityCall[];
  /** USD-6, decimal string. */
  declaredUsd: string;
  rules: RuleId[];
  status: ActivityStatus;
  hash: Hex;
  /** Earlier hashes this entry replaced (speed-up), oldest first. */
  replaced: Hex[];
  nonce: string;
  wire?: WireFrameTx;
  /** "4337": `hash` is the userOpHash; `txHash` the bundle transaction once mined. */
  backend?: "4337";
  userOp?: SerializedOp;
  txHash?: Hex;
  fees?: { maxFeePerGas: string; maxPriorityFeePerGas: string };
  /**
   * "leanpool": a post-quantum everyday payment. `hash` is its LeanPool id until the node reports the mined hash;
   * `nonce` is `lane:seq` of the signer's keyed nonce; `wire` is the signer's transaction.
   */
  lane?: "leanpool";
  poolId?: Hex;
  pqNodeUrl?: string;
  pqSigner?: Address;
  /** Why a payment that would have used the quantum-safe key went out with the everyday key instead. */
  fallbackNote?: string;
  /** Block number when the transaction was sent (for "stuck after 3 blocks", plan §30 §4.7). */
  sentAtBlock?: string;
  stuck?: boolean;
  headline: string;
  detail?: string;
  steps: ActivityStep[];
  feeWei?: string;
  blockNumber?: string;
  createdAt: number;
  updatedAt: number;
}

const MAX_ENTRIES = 200;

export class ActivityStore {
  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  async list(): Promise<ActivityEntry[]> {
    return (await this.kv.get<ActivityEntry[]>(StorageKeys.activity)) ?? [];
  }

  async get(id: string): Promise<ActivityEntry | undefined> {
    return (await this.list()).find((e) => e.id === id);
  }

  async findByHash(hash: Hex): Promise<ActivityEntry | undefined> {
    const h = hash.toLowerCase();
    return (await this.list()).find((e) => e.hash.toLowerCase() === h || e.replaced.some((r) => r.toLowerCase() === h));
  }

  async findByBatchId(batchId: string, origin?: string): Promise<ActivityEntry | undefined> {
    return (await this.list()).find((e) => e.batchId === batchId && (origin === undefined || e.origin === origin));
  }

  async add(entry: ActivityEntry): Promise<void> {
    const all = await this.list();
    await this.kv.set(StorageKeys.activity, [entry, ...all].slice(0, MAX_ENTRIES));
  }

  async update(id: string, patch: Partial<ActivityEntry>): Promise<ActivityEntry | undefined> {
    const all = await this.list();
    const i = all.findIndex((e) => e.id === id);
    if (i < 0) return undefined;
    const next = { ...all[i]!, ...patch, id, updatedAt: this.now() };
    all[i] = next;
    await this.kv.set(StorageKeys.activity, all);
    return next;
  }

  async pending(): Promise<ActivityEntry[]> {
    return (await this.list()).filter((e) => e.status === "sending" || e.status === "confirming");
  }

  async clear(): Promise<void> {
    await this.kv.remove(StorageKeys.activity);
  }
}

// ---------------------------------------------------------------------------------------------- copy ------

const shortAddr = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** "0.05 ETH" with up to 6 significant decimals. */
export function ethAmount(wei: bigint): string {
  const s = formatEther(wei);
  const [i, f = ""] = s.split(".");
  const frac = f.slice(0, 6).replace(/0+$/u, "");
  return `${i}${frac ? `.${frac}` : ""} ETH`;
}

/** "~0.0001 ETH": a fee, rounded to 2 significant digits. */
export function feeAmount(wei: bigint): string {
  if (wei === 0n) return "0 ETH";
  const eth = Number(wei) / 1e18;
  return `~${eth.toPrecision(2).replace(/\.?0+$/u, "")} ETH`;
}

export interface Labels {
  /** A friendly name for an address (e.g. "your fee tank"), if any. */
  name?(address: Address): string | undefined;
}

function recipientLabel(a: Address, labels: Labels): string {
  return labels.name?.(a) ?? shortAddr(a);
}

/** What the payment does, as the headline of a successful payment ("Paid 0.05 ETH to 0xab…cd"). */
export function intentTitle(calls: ActivityCall[], labels: Labels = {}): string {
  const total = calls.reduce((s, c) => s + BigInt(c.value), 0n);
  if (calls.length === 1) {
    const c = calls[0]!;
    if (c.data === "0x") return `${ethAmount(total)} to ${recipientLabel(c.target, labels)}`;
    return `Call to ${recipientLabel(c.target, labels)}${total > 0n ? ` with ${ethAmount(total)}` : ""}`;
  }
  const to = new Set(calls.map((c) => c.target.toLowerCase()));
  const where = to.size === 1 ? ` to ${recipientLabel(calls[0]!.target, labels)}` : "";
  return `${calls.length} payments${total > 0n ? ` of ${ethAmount(total)} in total` : ""}${where}`;
}

const STEP_LABELS = ["Check approval", "Pay network fee"];

export function pendingSteps(calls: ActivityCall[]): ActivityStep[] {
  return [
    ...STEP_LABELS.map((label) => ({ label, status: "pending" as const })),
    { label: calls.length > 1 ? `Payment (${calls.length} steps, all or nothing)` : "Payment", status: "pending" },
  ];
}

const stepStatus = (s: FrameStatus | undefined): ActivityStep["status"] =>
  s === "success" ? "done" : s === "reverted" ? "failed" : s === "skipped" ? "skipped" : "pending";

export interface OutcomeContext {
  /** Fee actually paid by the tank (gas used × effective price), in wei. */
  feeWei: bigint;
  /** The bucket after the failure (USD-6), to tell an over-limit failure from other refusals. */
  availableUsdAfter?: bigint;
  labels?: Labels;
}

/**
 * Maps a mined receipt to the activity copy (ux-spec §3.12, E-06/E-08): per-step words from the frame statuses
 * (`0x1` done, `0x0` failed, `0x2` skipped) and one plain-language headline.
 */
export function describeReceipt(
  entry: Pick<ActivityEntry, "calls" | "declaredUsd" | "kind">,
  receipt: FrameTxReceipt,
  ctx: OutcomeContext,
): Pick<ActivityEntry, "status" | "headline" | "detail" | "steps"> {
  const fr = receipt.frameReceipts;
  const steps = pendingSteps(entry.calls).map((s, i) => ({ ...s, status: stepStatus(fr[i]?.status) }));
  const body = fr.slice(2);
  const ok = body.length > 0 && body.every((f) => f.status === "success");
  const fee = feeAmount(ctx.feeWei);
  if (entry.kind === "cancel") {
    return ok
      ? { status: "cancelled", headline: "Cancelled: nothing was sent", detail: `Fee tank paid ${fee}.`, steps }
      : { status: "failed", headline: `Cancel failed; fee tank paid ${fee}`, steps };
  }
  if (ok) {
    return {
      status: "confirmed",
      headline: `Paid ${intentTitle(entry.calls, ctx.labels ?? {})}`,
      detail: `Fee tank paid ${fee}.`,
      steps,
    };
  }
  const overLimit = ctx.availableUsdAfter !== undefined && ctx.availableUsdAfter < BigInt(entry.declaredUsd);
  return overLimit
    ? {
        status: "failed",
        headline: `Blocked: over your daily limit, nothing was sent; fee tank paid ${fee}`,
        detail: "Your daily limit changed before this payment was included. Your limit was refreshed.",
        steps,
      }
    : {
        status: "failed",
        headline: `Failed: your account refused this payment, nothing was sent; fee tank paid ${fee}`,
        detail: "The recipient or token may not be on your allowed list any more.",
        steps,
      };
}

/** EIP-5792 `wallet_getCallsStatus` status code (plan §30 §3.5). */
export function callsStatusCode(e: Pick<ActivityEntry, "status" | "steps">): 100 | 200 | 400 | 500 | 600 {
  switch (e.status) {
    case "sending":
    case "confirming":
      return 100;
    case "confirmed":
      return 200;
    case "cancelled":
    case "replaced":
      return 400;
    case "failed": {
      const body = e.steps.slice(2);
      return body.some((s) => s.status === "done") ? 600 : 500;
    }
  }
}
