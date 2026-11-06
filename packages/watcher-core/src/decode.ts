import { decodeErrorResult, decodeEventLog, getAddress, type Abi, type Address, type Hex } from "viem";
import { entryPointAbi, frameAccountAbi, moduleAbi, QUEUE_KINDS, roleSignerAbi } from "./generated/abi.js";
import type { AccountEvent, Backend, BlockReason, QueueKind, RpcLog, WatchedEvent, WatchTargets } from "./types.js";

const num = (v: Hex | bigint | number | undefined): bigint =>
  v === undefined ? 0n : typeof v === "bigint" ? v : BigInt(v === "0x" ? 0 : v);

const lc = (a: string) => a.toLowerCase();

export function queueKind(kind: number): QueueKind {
  switch (kind) {
    case QUEUE_KINDS.SPEND:
      return "spend";
    case QUEUE_KINDS.LOOSEN:
      return "loosen";
    case QUEUE_KINDS.UPGRADE:
      return "upgrade";
    case QUEUE_KINDS.MIGRATE:
      return "migrate";
    default:
      return "unknown";
  }
}

/** A revert selector's error name (any QueueBit contract) as the reason a hot payment was blocked. */
export function blockReasonOf(errorName: string | undefined): BlockReason {
  switch (errorName) {
    case undefined:
      return "unknown";
    case "OverCap":
    case "OverDailyCap":
      return "over-limit";
    case "PerTxMaxExceeded":
    case "DeclaredOverPerTxMax":
      return "per-payment-limit";
    case "NotAllowed":
    case "TokenNotAllowed":
    case "StandingApproval":
      return "not-allowed";
    case "HotFrozen":
    case "BunkerActive":
    case "FrozenOnlyClear":
      return "paused";
    default:
      return "other";
  }
}

/** Decodes revert data against the QueueBit error ABIs (both backends). Undefined when unknown or empty. */
export function decodeRevertName(data: Hex | undefined): string | undefined {
  if (!data || data.length < 10) return undefined;
  for (const abi of [frameAccountAbi, moduleAbi] as const) {
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

/** Maps a decoded QueueBit event (either backend; the 4337 variants carry an extra `account`) to an AccountEvent. */
function toAccountEvent(name: string, a: Args, emitter: Address): AccountEvent | null {
  switch (name) {
    case "Queued":
      return { type: "queued", opId: a.opId as Hex, kind: queueKind(n(a.kind)), eta: n(a.eta) };
    case "UpgradeQueued":
      return { type: "upgradeQueued", impl: addr(a.impl), eta: n(a.eta) };
    case "MigrationQueued":
      return { type: "migrationQueued", to: addr(a.to), eta: n(a.eta) };
    case "QueueExecuted":
      return { type: "queueExecuted", opId: a.opId as Hex };
    case "QueueCancelled":
      return a.by !== undefined
        ? { type: "queueCancelled", opId: a.opId as Hex, by: addr(a.by) }
        : { type: "queueCancelled", opId: a.opId as Hex, byRecovery: Boolean(a.byRecovery) };
    case "Frozen":
      return { type: "frozen", by: a.by === undefined ? null : addr(a.by), until: n(a.until) };
    case "Unfrozen":
      return { type: "unfrozen", by: a.by === undefined ? null : addr(a.by) };
    case "BunkerEnabled":
      return { type: "bunkerEnabled" };
    case "BunkerDisabled":
      return { type: "bunkerDisabled" };
    case "HotKeyRotated":
      return { type: "hotKeyRotated", oldKey: addr(a.oldKey), newKey: addr(a.newKey) };
    case "VaultRotationStarted":
      return { type: "vaultRotationStarted", newVault: (a.newVaultSigner ?? a.newVaultPk) as Hex, eta: n(a.eta) };
    case "VaultRotationFinalized":
      return { type: "vaultRotationFinalized", newVault: (a.newVaultSigner ?? a.newVaultPk) as Hex };
    case "VaultRotationCancelled":
      return { type: "vaultRotationCancelled", newVault: (a.newVaultSigner ?? a.newVaultPk) as Hex };
    case "VaultSignerSet":
      return { type: "vaultSignerSet", signer: addr(a.signer) };
    case "RecoverySignerSet":
    case "RecoveryKeySet":
      return { type: "recoverySet" };
    case "GuardianSet":
      return { type: "guardianSet", guardian: addr(a.guardian), enabled: Boolean(a.enabled) };
    case "CapUpdated":
      return { type: "capUpdated" };
    case "TimelockUpdated":
      return { type: "timelockUpdated" };
    case "TokenConfigured":
      return { type: "policyChanged", what: "token" };
    case "TargetConfigured":
      return { type: "policyChanged", what: "target" };
    case "SessionConfigured":
      return { type: "policyChanged", what: "session" };
    case "ValueVerifierSet":
      return { type: "policyChanged", what: "value-verifier" };
    case "TrustedVerifierSet":
      return { type: "policyChanged", what: "trusted-verifier" };
    case "FeePolicyUpdated":
      return { type: "policyChanged", what: "fees" };
    case "RecipientModeSet":
      // Open -> Strict is an instant tightening; Strict -> Open is a queued loosening (announced by `Queued`).
      return { type: "policyChanged", what: "recipients" };
    case "Upgraded":
      return { type: "upgraded", impl: addr(a.implementation) };
    case "Migrated":
      return { type: "migrated", to: addr(a.to) };
    case "HotExecuted":
      return { type: "activity", what: "hot" };
    case "VaultExecuted":
      return { type: "activity", what: "vault" };
    case "SessionUsed":
      return { type: "activity", what: "session" };
    case "HashRegistered":
      return { type: "activity", what: "hash-registered" };
    case "Staked":
      return { type: "roleSignerStake", what: "staked", roleSigner: emitter };
    case "StakeUnlocked":
      return { type: "roleSignerStake", what: "unlocked", roleSigner: emitter };
    case "StakeWithdrawn":
      return { type: "roleSignerStake", what: "withdrawn", roleSigner: emitter };
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
  readonly accounts = new Map<string, Backend>();
  readonly modules = new Set<string>();
  readonly entryPoint: string | undefined;
  readonly roleSigners = new Map<string, Address>();

  constructor(t: WatchTargets) {
    this.chainId = t.chainId;
    for (const a of t.accounts) this.accounts.set(lc(a.address), a.backend);
    for (const m of t.modules ?? []) this.modules.add(lc(m));
    this.entryPoint = t.entryPoint ? lc(t.entryPoint) : undefined;
    for (const r of t.roleSigners ?? []) this.roleSigners.set(lc(r.address), getAddress(r.account));
  }

  /** Every address whose logs must be fetched (one `eth_getLogs` address filter). */
  logAddresses(): Address[] {
    const out = new Set<string>();
    for (const [a, b] of this.accounts) if (b === "frame") out.add(a);
    for (const m of this.modules) out.add(m);
    if (this.entryPoint && [...this.accounts.values()].includes("4337")) out.add(this.entryPoint);
    for (const r of this.roleSigners.keys()) out.add(r);
    return [...out].map((a) => getAddress(a));
  }

  backendOf(account: string): Backend | undefined {
    return this.accounts.get(lc(account));
  }
}

/**
 * Decodes one log into a WatchedEvent, or null when it is not about a watched account (or not a QueueBit event).
 *  - frame backend: the account itself emits; the account is the log's address;
 *  - 4337 backend: the modules emit with `account` as the first indexed topic; the EntryPoint's
 *    `UserOperationRevertReason` for a watched sender becomes a `hotBlocked` event with the decoded reason;
 *  - role signers: staking events, attributed to the account the signer serves.
 */
export function decodeLog(log: RpcLog, idx: TargetIndex): WatchedEvent | null {
  if (log.removed) return null;
  const emitter = getAddress(log.address);
  const at = lc(log.address);
  let account: Address | undefined;
  let backend: Backend | undefined;
  let event: AccountEvent | null = null;

  if (idx.accounts.get(at) === "frame") {
    const d = tryDecode(frameAccountAbi as Abi, log);
    if (!d) return null;
    account = emitter;
    backend = "frame";
    event = toAccountEvent(d.eventName, d.args, emitter);
  } else if (idx.modules.has(at)) {
    const d = tryDecode(moduleAbi as Abi, log);
    if (!d || typeof d.args.account !== "string") return null;
    if (idx.backendOf(d.args.account) !== "4337") return null;
    account = getAddress(d.args.account);
    backend = "4337";
    event = toAccountEvent(d.eventName, d.args, emitter);
  } else if (idx.entryPoint === at) {
    const d = tryDecode(entryPointAbi as Abi, log);
    if (!d || d.eventName !== "UserOperationRevertReason") return null;
    const sender = d.args.sender as string;
    if (idx.backendOf(sender) !== "4337") return null;
    account = getAddress(sender);
    backend = "4337";
    const errorName = decodeRevertName(d.args.revertReason as Hex | undefined);
    event = { type: "hotBlocked", reason: blockReasonOf(errorName), ...(errorName ? { errorName } : {}) };
  } else if (idx.roleSigners.has(at)) {
    const d = tryDecode(roleSignerAbi as Abi, log);
    if (!d) return null;
    account = idx.roleSigners.get(at)!;
    backend = idx.backendOf(account) ?? "frame";
    event = toAccountEvent(d.eventName, d.args, emitter);
  }
  if (!event || !account || !backend) return null;
  const out: WatchedEvent = {
    chainId: idx.chainId,
    account,
    backend,
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
