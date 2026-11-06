import { formatEther, type Address, type Hex } from "viem";
import type { LeanPoolTxStatus } from "@queuebit/rpc";
import { StorageKeys, type KV } from "../shared/kv";

/**
 * Activity (ux-spec §3.12): one entry per transaction the wallet sent, persisted in storage.local so it survives
 * restarts. Owner-signed payments are followed through the LeanPool node's stages (approved by the pool → recorded on
 * the network → waiting to be included → done); session payments and setup-key transactions by their receipt.
 */

export type ActivityStatus = "sending" | "confirming" | "confirmed" | "failed";

export interface ActivityCall {
  target: Address;
  /** wei, decimal string */
  value: string;
  data: Hex;
}

export interface ActivityEntry {
  id: string;
  chainId: number;
  /** payment: the account paid; admin: the account changed its keys or sessions; activation / migration: setup. */
  kind: "payment" | "admin" | "activation" | "migration";
  /** Who signed: the owner key (quantum-safe), a session key, the setup key, or a key imported for a move. */
  signer: "owner" | "session" | "setup" | "imported";
  /** leanpool: owner-signed, through the LeanPool node; alt-mempool: a session payment; legacy: an ordinary tx. */
  via: "leanpool" | "alt-mempool" | "legacy";
  /** The site that asked, for dapp requests. */
  origin?: string;
  /** EIP-5792 batch id (wallet_sendCalls) when the dapp supplied or was given one. */
  batchId?: string;
  /** The session that signed (its key id). */
  sessionId?: Hex;
  /** The account (or, for a migration step, the address that sent it). */
  account: Address;
  calls: ActivityCall[];
  status: ActivityStatus;
  /** The id the wallet knows the transaction by: the LeanPool id, or the transaction hash. */
  hash: Hex;
  /** The mined transaction's hash (LeanPool fills the witness, which changes it from the LeanPool id). */
  txHash?: Hex;
  /** LeanPool's stage, for owner-signed payments. */
  stage?: LeanPoolTxStatus["stage"];
  /** EIP-8250 nonce lane (frame transactions; one pending transaction per lane). */
  nonceKey?: string;
  nonceSeq?: string;
  headline: string;
  /** The headline once it succeeded (default: "Paid …" for payments, else the headline). */
  doneHeadline?: string;
  detail?: string;
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
    return (await this.list()).find((e) => e.hash.toLowerCase() === h || e.txHash?.toLowerCase() === h);
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

/** What the payment does ("0.05 ETH to 0xab…cd"). */
export function intentTitle(calls: ActivityCall[]): string {
  const total = calls.reduce((s, c) => s + BigInt(c.value), 0n);
  if (calls.length === 1) {
    const c = calls[0]!;
    if (c.data === "0x") return `${ethAmount(total)} to ${shortAddr(c.target)}`;
    return `Call to ${shortAddr(c.target)}${total > 0n ? ` with ${ethAmount(total)}` : ""}`;
  }
  const to = new Set(calls.map((c) => c.target.toLowerCase()));
  const where = to.size === 1 ? ` to ${shortAddr(calls[0]!.target)}` : "";
  return `${calls.length} steps${total > 0n ? ` moving ${ethAmount(total)} in total` : ""}${where}`;
}

/** The plain words for a LeanPool stage (ux-spec: no "mempool", no "hash"). */
export function stageCopy(stage: LeanPoolTxStatus["stage"]): { status: ActivityStatus; text: string } {
  switch (stage) {
    case "pooled":
      return { status: "confirming", text: "Signature checked; waiting for the next batch" };
    case "posted":
      return { status: "confirming", text: "Batch recorded on the network; sending" };
    case "submitted":
      return { status: "confirming", text: "Sent; waiting to be included" };
    case "mined":
      return { status: "confirmed", text: "Done" };
    case "reverted":
      return { status: "failed", text: "The network included it, but it failed: nothing moved except the network fee" };
    case "refused":
      return { status: "failed", text: "The network refused it: nothing was sent" };
  }
}

/** EIP-5792 `wallet_getCallsStatus` status code (plan §30 §3.5). */
export function callsStatusCode(e: Pick<ActivityEntry, "status">): 100 | 200 | 400 | 500 {
  switch (e.status) {
    case "sending":
    case "confirming":
      return 100;
    case "confirmed":
      return 200;
    case "failed":
      return 500;
  }
}
