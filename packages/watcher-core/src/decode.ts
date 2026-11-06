import { decodeErrorResult, decodeEventLog, getAddress, type Abi, type Address, type Hex } from "viem";
import { accountAbi, modulesAbi } from "./generated/abi.js";
import type { AccountEvent, Backend, RpcLog, WatchedEvent, WatchTargets } from "./types.js";

const num = (v: Hex | bigint | number | undefined): bigint =>
  v === undefined ? 0n : typeof v === "bigint" ? v : BigInt(v === "0x" ? 0 : v);

const lc = (a: string) => a.toLowerCase();

/** Decodes revert data against the LeanAccount stack's errors (e.g. DailyCapExceeded, ExpiredKey, ValidationFailed).
 * Undefined when unknown or empty. */
export function decodeRevertName(data: Hex | undefined): string | undefined {
  if (!data || data.length < 10) return undefined;
  for (const abi of [accountAbi, modulesAbi] as const) {
    try {
      return decodeErrorResult({ abi: abi as Abi, data }).errorName;
    } catch {
      // try the next ABI
    }
  }
  return undefined;
}

type Args = Record<string, unknown>;
const addr = (v: unknown) => getAddress(v as string);
const n = (v: unknown) => Number(v as bigint | number);
const big = (v: unknown) => BigInt(v as bigint | number);

/** Maps a decoded LeanAccount / module event to an AccountEvent. */
function toAccountEvent(name: string, a: Args): AccountEvent | null {
  switch (name) {
    case "KeyAdded":
      return { type: "keyAdded", keyId: a.keyId as Hex, kind: n(a.kind), weight: n(a.weight), roles: n(a.roles) };
    case "KeyRemoved":
      return { type: "keyRemoved", keyId: a.keyId as Hex };
    case "KeyUpdated":
      return { type: "keyUpdated", keyId: a.keyId as Hex };
    case "PolicySet":
      return {
        type: "policySet",
        adminThreshold: n(a.adminThreshold),
        spendThreshold: n(a.spendThreshold),
        requirePQ: Boolean(a.requirePQ),
        aggregator: addr(a.aggregator),
      };
    case "SessionTokenSet":
      return { type: "sessionTokenSet", keyId: a.keyId as Hex, token: addr(a.token), perTxCap: big(a.perTxCap) };
    case "DailyCapSet":
      return { type: "dailyCapSet", keyId: a.keyId as Hex, cap: big(a.cap) };
    case "TokenDailyCapSet":
      return { type: "dailyCapSet", keyId: a.keyId as Hex, token: addr(a.token), cap: big(a.cap) };
    case "SessionSpend":
      return { type: "sessionSpend", keyId: a.keyId as Hex, amount: big(a.amount), spentToday: big(a.spentToday) };
    case "SessionTokenSpend":
      return {
        type: "sessionSpend",
        keyId: a.keyId as Hex,
        token: addr(a.token),
        amount: big(a.amount),
        spentToday: big(a.spentToday),
      };
    case "Approved":
      return {
        type: "recoveryApproved",
        id: a.id as Hex,
        guardian: addr(a.guardian),
        approvals: n(a.approvals),
        readyAt: n(a.readyAt),
      };
    case "Recovered":
      return { type: "recovered", id: a.id as Hex };
    case "Cancelled":
      return { type: "recoveryCancelled", id: a.id as Hex };
    case "ModuleInstalled":
      return { type: "moduleInstalled", moduleType: n(a.moduleTypeId), module: addr(a.module) };
    case "ModuleUninstalled":
      return { type: "moduleUninstalled", moduleType: n(a.moduleTypeId), module: addr(a.module) };
    case "Upgraded":
      return { type: "upgraded", impl: addr(a.implementation) };
    default:
      return null;
  }
}

function tryDecode(abi: Abi, log: RpcLog): { eventName: string; args: Args } | null {
  try {
    const d = decodeEventLog({ abi, topics: log.topics as [Hex, ...Hex[]], data: log.data, strict: true });
    return { eventName: String(d.eventName), args: (d.args ?? {}) as unknown as Args };
  } catch {
    return null;
  }
}

/** Indexes WatchTargets for decoding. Build it once per target set. */
export class TargetIndex {
  readonly chainId: number;
  /** Lower-cased account address -> backend. */
  readonly accounts = new Map<string, Backend>();
  readonly modules = new Set<string>();

  constructor(t: WatchTargets) {
    this.chainId = t.chainId;
    for (const a of t.accounts) this.accounts.set(lc(a.address), "frame");
    for (const m of t.modules ?? []) this.modules.add(lc(m));
  }

  /** Every address whose logs must be fetched (one `eth_getLogs` address filter). */
  logAddresses(): Address[] {
    return [...new Set([...this.accounts.keys(), ...this.modules])].map((a) => getAddress(a));
  }

  backendOf(account: string): Backend | undefined {
    return this.accounts.get(lc(account));
  }
}

/**
 * Decodes one log into a WatchedEvent, or null when it is not about a watched account:
 *  - a watched account's own logs (module installs, upgrades);
 *  - a shared module's logs (keystore, hook, recovery) whose `account` is watched.
 */
export function decodeLog(log: RpcLog, idx: TargetIndex): WatchedEvent | null {
  if (log.removed) return null;
  const emitter = getAddress(log.address);
  const at = lc(log.address);
  let account: Address | undefined;
  let event: AccountEvent | null = null;

  if (idx.accounts.has(at)) {
    const d = tryDecode(accountAbi as Abi, log);
    if (!d) return null;
    account = emitter;
    event = toAccountEvent(d.eventName, d.args);
  } else if (idx.modules.has(at)) {
    const d = tryDecode(modulesAbi as Abi, log);
    if (!d || typeof d.args.account !== "string" || !idx.accounts.has(lc(d.args.account))) return null;
    account = getAddress(d.args.account);
    event = toAccountEvent(d.eventName, d.args);
  }
  if (!event || !account) return null;
  const out: WatchedEvent = {
    chainId: idx.chainId,
    account,
    backend: "frame",
    emitter,
    blockNumber: num(log.blockNumber),
    blockHash: log.blockHash,
    txHash: log.transactionHash,
    logIndex: Number(num(log.logIndex)),
    event,
  };
  if (log.blockTimestamp !== undefined) out.timestamp = Number(num(log.blockTimestamp));
  return out;
}

/** Decodes many logs, in chain order, dropping the ones that are not about a watched account. */
export function decodeLogs(logs: readonly RpcLog[], idx: TargetIndex): WatchedEvent[] {
  return logs
    .map((l) => decodeLog(l, idx))
    .filter((e): e is WatchedEvent => e !== null)
    .sort((a, b) =>
      a.blockNumber === b.blockNumber ? a.logIndex - b.logIndex : a.blockNumber < b.blockNumber ? -1 : 1,
    );
}
