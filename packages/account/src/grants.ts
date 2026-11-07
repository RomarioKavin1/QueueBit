import {
  concat,
  decodeAbiParameters,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  getAddress,
  hexToBigInt,
  isAddress,
  keccak256,
  pad,
  size,
  slice,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { keystoreAbi, leanAccountAbi, spendingLimitHookAbi } from "./abi.js";
import type { AccountDeployment } from "./create.js";
import { addrKey, keyIdOf, KIND, ROLE } from "./keys.js";
import { addSessionCalls, checkSessionCalls } from "./sessions.js";
import { buildAndSign, LEAN_PROFILE, MODE_SINGLE, type Call, type TxPlan, type TypedTx } from "./tx.js";

/**
 * Grants: the owner lets another wallet (a browser wallet such as MetaMask: an EIP712 SESSION key) spend from the
 * account on the owner's behalf, within limits, until a time. One grant per delegate address (the key id is
 * keyIdOf(EIP712, delegate)); it can cover ETH and any number of tokens.
 *
 * What the contracts can express (KeystoreValidator._allowed, SessionRules, SpendingLimitHook):
 *  - Tokens: the session's target is the token contract with a per-payment cap (setSessionToken) and a daily cap
 *    (setTokenDailyCap). Only `transfer`/`transferFrom` are allowed on it, to ANY recipient: the recipient is calldata,
 *    which the keystore does not restrict. So a token grant is always "to anyone", and "only these addresses" cannot
 *    be enforced for tokens.
 *  - ETH: the session may send value only to its allowlisted targets, so an ETH grant is always "only these
 *    addresses": there is no "any target" switch. Per-payment cap = the key's perTxCap, daily cap = the hook's.
 *  - Expiry: VERIFY cannot read the clock; an expired grant's payment is admitted, then stopped in execution by the
 *    hook, and the account pays its fee. Senders must check the expiry first (checkGrantPayment does).
 *  - Fees: a delegate's payment is paid by the account (the frame tx's payer is the account), outside the caps.
 */

/** ETH a delegate may send: to listed recipients only (see above). Amounts in wei. */
export interface EthAllowance {
  perPayment: bigint;
  perDay: bigint;
  recipients: Address[];
}

/** A token a delegate may send, to anyone. Amounts in the token's smallest unit. */
export interface TokenAllowance {
  token: Address;
  perPayment: bigint;
  perDay: bigint;
}

export interface GrantSpec {
  delegate: Address;
  /** Unix seconds. */
  validUntil: number;
  eth?: EthAllowance;
  tokens: TokenAllowance[];
}

/** What a payment of an allowance spent today, as the hook records it. */
export interface DailyUse {
  /** 0 = no daily cap. */
  cap: bigint;
  spentToday: bigint;
  /** cap - spentToday (0 when spent; the cap when no cap is set is meaningless: see `cap`). */
  leftToday: bigint;
}

/** A grant as the chain holds it. */
export interface Grant {
  account: Address;
  delegate: Address;
  keyId: Hex;
  /** The key exists and is an EIP712 SESSION key. */
  active: boolean;
  /** Unix seconds (0: never, which grants made here never are). */
  validUntil: number;
  eth?: EthAllowance & DailyUse;
  tokens: Array<TokenAllowance & DailyUse>;
  /** Targets the chain still allows for this key id (also after a revoke or a prune: stale ones to clear). */
  targets: Address[];
}

export const grantKeyId = (delegate: Address): Hex => keyIdOf(KIND.EIP712, addrKey(delegate));

/**
 * The delegate's own EIP-8250 nonce lane on the account, apart from the owner's (0x1000) and the extension's site
 * sessions (1, 2, ...): 2^32 + the address's low 32 bits. Two delegates of one account sharing those bits (1 in 2^32)
 * share a lane: their payments then wait on each other, nothing worse.
 */
export const delegateNonceKey = (delegate: Address): bigint => (1n << 32n) | (hexToBigInt(delegate) & 0xffffffffn);

const lower = (a: string) => a.toLowerCase();
const uniq = (xs: Address[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => (seen.has(lower(x)) ? false : (seen.add(lower(x)), true)));
};
const has = (xs: Address[], a: Address) => xs.some((x) => lower(x) === lower(a));

/** Checks a grant before it is signed (pure). `nowSec`: the clock. Throws with a sentence a person can act on. */
export function validateGrant(d: AccountDeployment, account: Address, g: GrantSpec, nowSec: number): void {
  if (!isAddress(g.delegate, { strict: false }) || lower(g.delegate) === lower(zeroAddress))
    throw new Error("Enter the wallet address of the person you're letting spend (0x + 40 characters).");
  const admin = [account, d.keystore, d.hook, d.recovery];
  if (lower(g.delegate) === lower(account)) throw new Error("That's this account: pick someone else's wallet.");
  if (!(g.validUntil > nowSec)) throw new Error("Pick an end time in the future.");
  if (!g.eth && !g.tokens.length) throw new Error("Choose what they may spend.");
  const amounts = (what: string, perPayment: bigint, perDay: bigint) => {
    if (perPayment <= 0n) throw new Error(`Set how much ${what} they may send in one payment.`);
    if (perDay <= 0n) throw new Error(`Set how much ${what} they may send in a day.`);
    if (perPayment > perDay) throw new Error(`The per-payment ${what} limit can't be more than the daily one.`);
    if (perDay >= 1n << 128n) throw new Error(`That ${what} limit is too large.`);
  };
  if (g.eth) {
    amounts("ETH", g.eth.perPayment, g.eth.perDay);
    if (!g.eth.recipients.length) throw new Error("Add at least one address they may send ETH to.");
    for (const r of g.eth.recipients) {
      if (!isAddress(r, { strict: false })) throw new Error(`${r} isn't an address.`);
      if (has(admin, r)) throw new Error("A recipient can't be this account or its own contracts.");
      if (g.tokens.some((t) => lower(t.token) === lower(r)))
        throw new Error("A recipient can't be a token they may spend.");
    }
  }
  const seen = new Set<string>();
  for (const t of g.tokens) {
    if (!isAddress(t.token, { strict: false })) throw new Error(`${t.token} isn't a token address.`);
    if (seen.has(lower(t.token))) throw new Error("Each token once.");
    seen.add(lower(t.token));
    amounts("token", t.perPayment, t.perDay);
  }
}

/**
 * The owner's admin calls that make the chain hold exactly `g` for its delegate (one tx). `current`: what the chain
 * holds now for that key id (readGrant), so a new grant replaces an old one: targets and token caps not in `g` are
 * cleared, including stale ones a revoke or a prune left behind (removing a key does not clear its allowlist).
 */
export function grantCalls(d: AccountDeployment, g: GrantSpec, current?: Grant): Call[] {
  const id = grantKeyId(g.delegate);
  const recipients = uniq(g.eth?.recipients ?? []);
  const tokens = g.tokens;
  const want = uniq([...recipients, ...tokens.map((t) => t.token)]);
  const ks = (functionName: "setSessionTargets" | "setSessionToken" | "removeKey" | "updateKey", args: unknown[]) => ({
    to: d.keystore,
    data: encodeFunctionData({ abi: keystoreAbi, functionName, args } as never),
  });
  const hook = (functionName: "setDailyCap" | "setTokenDailyCap", args: unknown[]) => ({
    to: d.hook,
    data: encodeFunctionData({ abi: spendingLimitHookAbi, functionName, args } as never),
  });
  const calls: Call[] = [];
  if (!current?.active) {
    // addKey (with the targets), the daily ETH cap, the token caps.
    calls.push(
      ...addSessionCalls(d, {
        signer: g.delegate,
        kind: KIND.EIP712,
        validUntil: g.validUntil,
        perTxEth: g.eth?.perPayment ?? 0n,
        dailyEth: g.eth?.perDay ?? 0n,
        targets: recipients,
        tokens: tokens.map((t) => ({ token: t.token, perTx: t.perPayment, daily: t.perDay })),
      }),
    );
  } else {
    calls.push(ks("updateKey", [id, 1, ROLE.SESSION, g.validUntil, g.eth?.perPayment ?? 0n]));
    const add = want.filter((a) => !has(current.targets, a));
    if (add.length) calls.push(ks("setSessionTargets", [id, add, true]));
    if (g.eth) calls.push(hook("setDailyCap", [id, g.eth.perDay]));
    for (const t of tokens) {
      calls.push(ks("setSessionToken", [id, t.token, t.perPayment]));
      calls.push(hook("setTokenDailyCap", [id, t.token, t.perDay]));
    }
  }
  if (!g.eth && current?.active) calls.push(hook("setDailyCap", [id, 0n]));
  const stale = (current?.targets ?? []).filter((a) => !has(want, a));
  if (stale.length) calls.push(ks("setSessionTargets", [id, stale, false]));
  for (const t of current?.tokens ?? []) {
    if (!tokens.some((x) => lower(x.token) === lower(t.token))) calls.push(ks("setSessionToken", [id, t.token, 0n]));
  }
  return calls;
}

/** The owner's admin calls that end a grant now: its allowlist and token caps cleared, then the key removed. */
export function revokeGrantCalls(d: AccountDeployment, current: Grant): Call[] {
  const id = current.keyId;
  const calls: Call[] = [];
  if (current.targets.length)
    calls.push({
      to: d.keystore,
      data: encodeFunctionData({
        abi: keystoreAbi,
        functionName: "setSessionTargets",
        args: [id, current.targets, false],
      }),
    });
  for (const t of current.tokens)
    calls.push({
      to: d.keystore,
      data: encodeFunctionData({ abi: keystoreAbi, functionName: "setSessionToken", args: [id, t.token, 0n] }),
    });
  calls.push({
    to: d.keystore,
    data: encodeFunctionData({ abi: keystoreAbi, functionName: "removeKey", args: [id] }),
  });
  return calls;
}

// ------------------------------------------------------------------------------------------ reading -------------

/** The executions in `account.execute(mode, executionCalldata)` calldata (single or batch); [] for anything else. */
export function decodeExecute(data: Hex): Call[] {
  let mode: Hex;
  let ec: Hex;
  try {
    const c = decodeFunctionData({ abi: leanAccountAbi, data });
    if (c.functionName !== "execute") return [];
    [mode, ec] = c.args as [Hex, Hex];
  } catch {
    return [];
  }
  if (lower(mode) === lower(MODE_SINGLE)) {
    if (size(ec) < 52) return [];
    return [
      {
        to: getAddress(slice(ec, 0, 20)),
        value: hexToBigInt(slice(ec, 20, 52)),
        data: size(ec) > 52 ? slice(ec, 52) : "0x",
      },
    ];
  }
  try {
    const [xs] = decodeAbiParameters(
      [
        {
          type: "tuple[]",
          components: [
            { name: "target", type: "address" },
            { name: "value", type: "uint256" },
            { name: "callData", type: "bytes" },
          ],
        },
      ],
      ec,
    );
    return xs.map((x) => ({ to: x.target, value: x.value, data: x.callData }));
  } catch {
    return [];
  }
}

/**
 * Targets a tx put on a key id's allowlist, from the tx itself (the keystore emits no event for them): every
 * `addKey(k)` of that key and `setSessionTargets(id, targets, true)` the account's executions made. `tx` is
 * eth_getTransactionByHash's result: a frame tx (frames[].data) or a plain one (input).
 */
export function targetsFromTx(
  tx: { frames?: { data?: Hex }[]; input?: Hex },
  keystore: Address,
  keyId: Hex,
): Address[] {
  const blobs = tx.frames?.length ? tx.frames.map((f) => f.data ?? "0x") : [tx.input ?? "0x"];
  const out: Address[] = [];
  for (const blob of blobs) {
    for (const x of decodeExecute(blob)) {
      if (lower(x.to) !== lower(keystore) || !x.data) continue;
      try {
        const c = decodeFunctionData({ abi: keystoreAbi, data: x.data });
        if (c.functionName === "addKey") {
          const k = c.args[0];
          if (lower(keyIdOf(k.kind, k.a, k.b)) === lower(keyId)) out.push(...k.sessionTargets);
        } else if (c.functionName === "setSessionTargets") {
          const [id, targets, allowed] = c.args;
          if (allowed && lower(id) === lower(keyId)) out.push(...targets);
        }
      } catch {
        // not a keystore call we read
      }
    }
  }
  return uniq(out);
}

/** The reads `readGrant` and `findGrants` make: a viem public client is one. */
export type GrantClient = Pick<PublicClient, "readContract" | "getLogs" | "request">;

const utcDay = (nowSec: number) => BigInt(Math.floor(nowSec / 86_400));

function daily(limit: { dailyCap: bigint; day: bigint; spent: bigint }, nowSec: number): DailyUse {
  const spentToday = limit.day === utcDay(nowSec) ? limit.spent : 0n;
  const cap = limit.dailyCap;
  return { cap, spentToday, leftToday: cap > spentToday ? cap - spentToday : 0n };
}

/**
 * A grant from the chain: the key (expiry, ETH per payment), the allowlist (recovered from the txs that set it, then
 * confirmed with isSessionTarget), the token caps (SessionTokenSet events, confirmed with sessionTokenCap), and the
 * hook's daily caps and today's spend. `tokens` keeps a removed key's leftover token caps too (grantCalls clears
 * them on a new grant); `eth` only exists while the key does (its per-payment cap lives in the key).
 */
export async function readGrant(
  client: GrantClient,
  d: AccountDeployment,
  account: Address,
  delegate: Address,
  nowSec: number,
): Promise<Grant> {
  const keyId = grantKeyId(delegate);
  const read = <T>(address: Address, abi: unknown, functionName: string, args: unknown[]) =>
    client.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const key = await read<{ kind: number; roles: number; validUntil: number; perTxCap: bigint }>(
    d.keystore,
    keystoreAbi,
    "getKey",
    [account, keyId],
  );
  const active = Number(key.kind) === KIND.EIP712 && (Number(key.roles) & ROLE.SESSION) !== 0;

  const logs = (await client.getLogs({
    address: d.keystore,
    events: keystoreAbi.filter(
      (x) => x.type === "event" && ["KeyAdded", "KeyUpdated", "SessionTokenSet"].includes(x.name),
    ),
    args: { account, keyId },
    fromBlock: 0n,
    toBlock: "latest",
  } as never)) as unknown as Array<{ eventName: string; transactionHash: Hex; args: { token?: Address } }>;
  const tokenCandidates = uniq(logs.filter((l) => l.eventName === "SessionTokenSet").map((l) => l.args.token!));
  const txHashes = [
    ...new Set(
      logs.filter((l) => l.eventName === "KeyAdded" || l.eventName === "KeyUpdated").map((l) => l.transactionHash),
    ),
  ];
  const fromTxs = (
    await Promise.all(
      txHashes.map(async (hash) => {
        const tx = (await client
          .request({ method: "eth_getTransactionByHash", params: [hash] } as never)
          .catch(() => null)) as { frames?: { data?: Hex }[]; input?: Hex } | null;
        return tx ? targetsFromTx(tx, d.keystore, keyId) : [];
      }),
    )
  ).flat();

  const tokens: Grant["tokens"] = [];
  for (const token of tokenCandidates) {
    const perPayment = await read<bigint>(d.keystore, keystoreAbi, "sessionTokenCap", [account, keyId, token]);
    if (perPayment === 0n) continue;
    const lim = await read<{ dailyCap: bigint; day: bigint; spent: bigint }>(
      d.hook,
      spendingLimitHookAbi,
      "tokenLimitOf",
      [account, keyId, token],
    );
    const u = daily(lim, nowSec);
    tokens.push({ token, perPayment, perDay: u.cap, ...u });
  }

  const candidates = uniq([...fromTxs, ...tokenCandidates]);
  const allowed = await Promise.all(
    candidates.map((t) => read<boolean>(d.keystore, keystoreAbi, "isSessionTarget", [account, keyId, t])),
  );
  const targets = candidates.filter((_, i) => allowed[i]);
  const recipients = targets.filter((t) => !tokenCandidates.some((x) => lower(x) === lower(t)));

  let eth: Grant["eth"];
  if (active && key.perTxCap > 0n) {
    const lim = await read<{ dailyCap: bigint; day: bigint; spent: bigint }>(d.hook, spendingLimitHookAbi, "limitOf", [
      account,
      keyId,
    ]);
    const u = daily(lim, nowSec);
    eth = { perPayment: key.perTxCap, perDay: u.cap, recipients, ...u };
  }
  return {
    account,
    delegate: getAddress(delegate),
    keyId,
    active,
    validUntil: Number(key.validUntil),
    ...(eth ? { eth } : {}),
    tokens,
    targets,
  };
}

/**
 * Every account that granted `delegate` (KeyAdded events for its key id, on any account), read now. Grants that were
 * revoked are left out; expired ones are kept (with `validUntil` in the past) so the page can say so.
 */
export async function findGrants(
  client: GrantClient,
  d: AccountDeployment,
  delegate: Address,
  nowSec: number,
): Promise<Grant[]> {
  const keyId = grantKeyId(delegate);
  const logs = (await client.getLogs({
    address: d.keystore,
    event: keystoreAbi.find((x) => x.type === "event" && x.name === "KeyAdded"),
    args: { keyId },
    fromBlock: 0n,
    toBlock: "latest",
  } as never)) as unknown as Array<{ args: { account: Address } }>;
  const accounts = uniq(logs.map((l) => getAddress(l.args.account)));
  const grants = await Promise.all(accounts.map((a) => readGrant(client, d, a, delegate, nowSec)));
  return grants.filter((g) => g.active);
}

/** Every grant `account` made (its EIP712 SESSION keys), read now. */
export async function listGrants(
  client: GrantClient,
  d: AccountDeployment,
  account: Address,
  nowSec: number,
): Promise<Grant[]> {
  const [, keys] = (await client.readContract({
    address: d.keystore,
    abi: keystoreAbi,
    functionName: "getKeys",
    args: [account],
  })) as readonly [readonly Hex[], readonly { kind: number; roles: number; a: Hex }[]];
  const delegates = keys
    .filter((k) => Number(k.kind) === KIND.EIP712 && (Number(k.roles) & ROLE.SESSION) !== 0)
    .map((k) => getAddress(slice(k.a, 12)));
  return Promise.all(delegates.map((x) => readGrant(client, d, account, x, nowSec)));
}

// ------------------------------------------------------------------------------------------ the delegate pays ---

/** One payment within a grant: ETH (value to `to`) or a token (`transfer(to, amount)` on the token). */
export function grantPaymentCall(asset: "ETH" | Address, to: Address, amount: bigint): Call {
  if (asset === "ETH") return { to, value: amount };
  return { to: asset, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) };
}

export type GrantPaymentCheck = { ok: true } | { ok: false; reason: string };

/**
 * Whether the delegate may send `calls` now under `g`, with the reason when not (pure): the keystore's rules (the
 * account refuses these at admission, before any fee), then what the hook checks in execution (expiry, daily caps:
 * past them the tx is mined, reverts, and the account pays its fee, so they are checked here first).
 */
export function checkGrantPayment(d: AccountDeployment, g: Grant, calls: Call[], nowSec: number): GrantPaymentCheck {
  if (!g.active) return { ok: false, reason: "This permission was removed by the account's owner." };
  if (g.validUntil && nowSec >= g.validUntil) return { ok: false, reason: "This permission has ended." };
  const c = checkSessionCalls(
    {
      account: g.account,
      adminTargets: [d.keystore, d.hook, d.recovery],
      targets: g.targets,
      tokens: g.tokens.map((t) => ({ token: t.token, perTx: t.perPayment })),
      perTxEth: g.eth?.perPayment ?? 0n,
    },
    calls,
  );
  if (!c.ok) {
    const reason =
      c.reason === "The session doesn't cover this contract."
        ? g.eth
          ? "You may only send ETH to the addresses the owner listed."
          : "This permission doesn't cover ETH."
        : c.reason
            .replace("Over the session's per-payment ETH limit.", "That's more ETH than one payment may send.")
            .replace("Over the session's per-payment token limit.", "That's more than one payment may send.")
            .replace(/the session/giu, "this permission")
            .replace(/A session/gu, "This permission");
    return { ok: false, reason };
  }
  if (c.eth > 0n && g.eth && g.eth.cap > 0n && c.eth > g.eth.leftToday)
    return { ok: false, reason: "That's more ETH than is left for today." };
  for (const [token, amount] of Object.entries(c.tokens)) {
    const t = g.tokens.find((x) => lower(x.token) === token);
    if (t && t.cap > 0n && amount > t.leftToday) return { ok: false, reason: "That's more than is left for today." };
  }
  return { ok: true };
}

/** EIP-8250: the next `nonce_seq` of the account's lane `key` (NONCE_MANAGER slot keccak256(pad32(account) ‖ key)). */
export async function laneNonce(
  client: Pick<PublicClient, "getStorageAt">,
  account: Address,
  key: bigint,
): Promise<bigint> {
  const manager = LEAN_PROFILE.predeploys?.NONCE_MANAGER as Address | undefined;
  if (!manager) throw new Error("This network profile has no nonce manager.");
  const slot = keccak256(concat([pad(account), toHex(key, { size: 32 })]));
  return hexToBigInt((await client.getStorageAt({ address: manager, slot })) ?? "0x0");
}

/** Fees for a delegate's payment, as the wallet pays its own: twice the base fee plus a 1 gwei tip. */
export async function paymentFees(
  client: Pick<PublicClient, "getBlock" | "getGasPrice">,
): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const tip = 1_000_000_000n;
  const block = await client.getBlock().catch(() => undefined);
  const base = block?.baseFeePerGas ?? (await client.getGasPrice());
  return { maxFeePerGas: 2n * base + tip, maxPriorityFeePerGas: tip };
}

export interface DelegatePaymentOptions {
  d: AccountDeployment;
  grant: Grant;
  calls: Call[];
  nonceSeq: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  /** The delegate's browser wallet: eth_signTypedData_v4 of `typed` (it shows the calls). */
  signTypedData: (typed: TypedTx) => Promise<Hex>;
}

/**
 * The frame tx a delegate sends for the owner's account: the account is the sender and pays the fees; the delegate's
 * wallet signs the typed data (sig hash + the calls). No PQ signer, so it goes straight to the alt mempool.
 */
export function buildDelegatePayment(o: DelegatePaymentOptions): Promise<TxPlan> {
  return buildAndSign({
    d: o.d,
    account: o.grant.account,
    nonceKey: delegateNonceKey(o.grant.delegate),
    nonceSeq: o.nonceSeq,
    calls: [o.calls],
    signers: [{ kind: "EIP712", keyId: o.grant.keyId, signTypedData: o.signTypedData }],
    maxFeePerGas: o.maxFeePerGas,
    maxPriorityFeePerGas: o.maxPriorityFeePerGas,
  });
}
