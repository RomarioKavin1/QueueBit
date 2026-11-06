import { KIND, checkSessionCalls, sessionKeyId, type SessionCheck, type SessionSpec } from "@queuebit/account";
import { isAddress, parseEther, type Address, type Hex } from "viem";
import { StorageKeys, type KV } from "../../shared/kv";

/**
 * Sessions: a key the extension holds (secp256k1, keyring SESSION_PATH(index)) that the account lets call only one
 * site's contracts, within per-payment and daily limits, until it ends. Added and removed by the owner (admin
 * transactions); a dapp request it covers is signed by it and sent without a prompt.
 */
export interface SessionRecord {
  /** The keystore key id. */
  id: Hex;
  chainId: number;
  account: Address;
  /** The site it serves. */
  origin: string;
  /** The keyring index of its key. */
  index: number;
  signer: Address;
  /** Unix seconds. */
  validUntil: number;
  /** wei, decimal strings. */
  perTxEth: string;
  /** "0": no daily limit. */
  dailyEth: string;
  targets: Address[];
  /** Token limits, in the token's smallest unit (decimal strings). */
  tokens: Array<{ token: Address; perTx: string; daily: string }>;
  /** adding / revoking: the owner's transaction is on its way. */
  status: "adding" | "active" | "revoking" | "revoked" | "failed";
  activityId?: string;
  createdAt: number;
  /** What it spent today (UTC day number), as the extension counts it; the account's own count is authoritative. */
  spent?: { day: number; eth: string; tokens: Record<string, string> };
}

/** What a user asks for on the Sessions page (amounts as decimal strings: ETH, and token units). */
export interface SessionRequest {
  chainId: number;
  origin: string;
  targets: Address[];
  perTxEth: string;
  dailyEth: string;
  /** Hours from now. */
  hours: number;
  tokens?: Array<{ token: Address; perTx: string; daily: string; decimals: number }>;
}

export const MAX_SESSION_HOURS = 24 * 30;

/** Checks a Sessions-page request and turns it into the SDK's spec (pure). */
export function sessionSpec(req: SessionRequest, signer: Address, nowSec: number): SessionSpec {
  if (!/^https?:\/\/[^/\s]+$/u.test(req.origin)) throw new Error("Enter the site as https://name.");
  if (!req.targets.length) throw new Error("Add at least one contract the site may use.");
  for (const t of req.targets) if (!isAddress(t, { strict: false })) throw new Error(`${t} isn't an address.`);
  if (!(req.hours > 0 && req.hours <= MAX_SESSION_HOURS))
    throw new Error(`A session lasts between an hour and ${MAX_SESSION_HOURS / 24} days.`);
  const perTxEth = parseAmount(req.perTxEth, 18, "per-payment ETH limit");
  const dailyEth = parseAmount(req.dailyEth || "0", 18, "daily ETH limit");
  if (dailyEth > 0n && perTxEth > dailyEth) throw new Error("The per-payment limit can't be more than the daily one.");
  const tokens = (req.tokens ?? []).map((t) => {
    const perTx = parseAmount(t.perTx, t.decimals, "token limit");
    if (perTx === 0n) throw new Error("A token limit of 0 means the session can't move it: remove the token instead.");
    return { token: t.token, perTx, daily: parseAmount(t.daily || "0", t.decimals, "daily token limit") };
  });
  return {
    signer,
    kind: KIND.ECDSA,
    validUntil: nowSec + Math.round(req.hours * 3600),
    perTxEth,
    dailyEth,
    targets: req.targets,
    tokens,
  };
}

function parseAmount(v: string, decimals: number, what: string): bigint {
  if (!/^\d+(\.\d+)?$/u.test(v.trim())) throw new Error(`Enter the ${what} as a number.`);
  return decimals === 18 ? parseEther(v.trim()) : parseUnitsSafe(v.trim(), decimals);
}

function parseUnitsSafe(v: string, decimals: number): bigint {
  const [i, f = ""] = v.split(".");
  if (f.length > decimals) throw new Error(`At most ${decimals} decimals.`);
  return BigInt(i!) * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}

export const sessionIdOf = (signer: Address): Hex => sessionKeyId({ signer, kind: KIND.ECDSA });

export interface SessionCall {
  target: Address;
  value: bigint;
  data: Hex;
}

export type Coverage = SessionCheck;

export const utcDay = (nowMs: number) => Math.floor(nowMs / 86_400_000);

/**
 * Whether `session` may send `calls` on its own (pure). The call rules are the SDK's `checkSessionCalls`, the same as
 * the keystore's (SessionRules.sol); on top, what the account checks in execution (the expiry, the daily limits) and
 * the session's state here. Checking first means a request outside them asks the user (and the owner signs) instead
 * of failing at a fee. `adminTargets`: the keystore and the account's modules.
 */
export function sessionCovers(
  s: SessionRecord,
  calls: SessionCall[],
  nowMs: number,
  adminTargets: Address[] = [],
): Coverage {
  if (s.status !== "active") return { ok: false, reason: "The session isn't active." };
  if (nowMs >= s.validUntil * 1000) return { ok: false, reason: "The session has ended." };
  const c = checkSessionCalls(
    {
      account: s.account,
      adminTargets,
      targets: [...s.targets, ...s.tokens.map((t) => t.token)],
      tokens: s.tokens.map((t) => ({ token: t.token, perTx: BigInt(t.perTx) })),
      perTxEth: BigInt(s.perTxEth),
    },
    calls.map((x) => ({ to: x.target, value: x.value, data: x.data })),
  );
  if (!c.ok) return c;
  const today = s.spent && s.spent.day === utcDay(nowMs) ? s.spent : undefined;
  if (BigInt(s.dailyEth) > 0n && BigInt(today?.eth ?? "0") + c.eth > BigInt(s.dailyEth))
    return { ok: false, reason: "Over the session's daily ETH limit." };
  for (const [k, amount] of Object.entries(c.tokens)) {
    const t = s.tokens.find((x) => x.token.toLowerCase() === k)!;
    if (BigInt(t.daily) > 0n && BigInt(today?.tokens[k] ?? "0") + amount > BigInt(t.daily))
      return { ok: false, reason: "Over the session's daily token limit." };
  }
  return c;
}

/** The spend tally after a payment the session sent (pure). */
export function addSpend(s: SessionRecord, c: Extract<Coverage, { ok: true }>, nowMs: number): SessionRecord["spent"] {
  const day = utcDay(nowMs);
  const cur = s.spent && s.spent.day === day ? s.spent : { day, eth: "0", tokens: {} };
  const tokens = { ...cur.tokens };
  for (const [k, v] of Object.entries(c.tokens)) tokens[k] = (BigInt(tokens[k] ?? "0") + v).toString();
  return { day, eth: (BigInt(cur.eth) + c.eth).toString(), tokens };
}

export class SessionStore {
  constructor(private readonly kv: KV) {}

  async list(): Promise<SessionRecord[]> {
    return (await this.kv.get<SessionRecord[]>(StorageKeys.sessions)) ?? [];
  }

  async get(id: Hex): Promise<SessionRecord | undefined> {
    return (await this.list()).find((s) => s.id.toLowerCase() === id.toLowerCase());
  }

  async put(rec: SessionRecord): Promise<void> {
    const all = (await this.list()).filter((s) => s.id.toLowerCase() !== rec.id.toLowerCase());
    await this.kv.set(StorageKeys.sessions, [rec, ...all]);
  }

  async update(id: Hex, patch: Partial<SessionRecord>): Promise<SessionRecord | undefined> {
    const cur = await this.get(id);
    if (!cur) return undefined;
    const next = { ...cur, ...patch, id: cur.id };
    await this.put(next);
    return next;
  }

  /** A key index no session has used (keys are never reused: a revoked key's id stays revoked). */
  async nextIndex(): Promise<number> {
    return (await this.list()).reduce((m, s) => Math.max(m, s.index + 1), 0);
  }

  /** Active sessions for a site on a chain. */
  async forOrigin(chainId: number, account: Address, origin: string): Promise<SessionRecord[]> {
    return (await this.list()).filter(
      (s) =>
        s.chainId === chainId &&
        s.origin === origin &&
        s.account.toLowerCase() === account.toLowerCase() &&
        s.status === "active",
    );
  }

  async clear(): Promise<void> {
    await this.kv.remove(StorageKeys.sessions);
  }
}
