import { encodeFunctionData, hexToBigInt, size, slice, type Address, type Hex } from "viem";
import { keystoreAbi, spendingLimitHookAbi } from "./abi.js";
import type { AccountDeployment } from "./create.js";
import type { KIND } from "./keys.js";
import { addrKey, keyIdOf, keyTuple, ROLE, type KeyInit } from "./keys.js";
import type { Call } from "./tx.js";

/** A token a session may spend: per-tx cap in the keystore (refused in VERIFY), daily cap in the hook. */
export interface SessionToken {
  token: Address;
  perTx: bigint;
  /** 0 = no daily cap (the per-tx cap still applies). */
  daily: bigint;
}

/**
 * A session key: alone, it may call only its targets, within a per-tx and a daily ETH cap and per-token caps; it can
 * never change keys or settings. On a token with a cap it may only `transfer`/`transferFrom`; approvals, permits and
 * NFT transfers are refused everywhere (SessionRules.sol).
 */
export interface SessionSpec {
  /** The session signer's address: an ECDSA key the wallet holds, or a browser wallet (EIP712). */
  signer: Address;
  kind: typeof KIND.ECDSA | typeof KIND.EIP712;
  /** Unix seconds. Required: a session should always end. */
  validUntil: number;
  perTxEth: bigint;
  /** 0 = no daily ETH cap. */
  dailyEth: bigint;
  /** Contracts or recipients it may call (tokens are added from `tokens`). */
  targets: Address[];
  tokens?: SessionToken[];
}

export const sessionKeyId = (s: Pick<SessionSpec, "signer" | "kind">): Hex => keyIdOf(s.kind, addrKey(s.signer));

export function sessionKeyInit(s: SessionSpec): KeyInit {
  if (!s.validUntil) throw new Error("a session needs an expiry");
  return {
    kind: s.kind,
    weight: 1,
    roles: ROLE.SESSION,
    validUntil: s.validUntil,
    perTxCap: s.perTxEth,
    a: addrKey(s.signer),
    sessionTargets: [...s.targets, ...(s.tokens ?? []).map((t) => t.token)],
  };
}

/** The admin calls that add a session with all its caps (one tx, signed by the owner). */
export function addSessionCalls(d: AccountDeployment, s: SessionSpec): Call[] {
  const id = sessionKeyId(s);
  const calls: Call[] = [
    {
      to: d.keystore,
      data: encodeFunctionData({ abi: keystoreAbi, functionName: "addKey", args: [keyTuple(sessionKeyInit(s))] }),
    },
  ];
  if (s.dailyEth > 0n) {
    calls.push({
      to: d.hook,
      data: encodeFunctionData({ abi: spendingLimitHookAbi, functionName: "setDailyCap", args: [id, s.dailyEth] }),
    });
  }
  for (const t of s.tokens ?? []) {
    if (t.perTx <= 0n) throw new Error(`token ${t.token}: a per-tx cap of 0 means the session may not move it`);
    calls.push({
      to: d.keystore,
      data: encodeFunctionData({ abi: keystoreAbi, functionName: "setSessionToken", args: [id, t.token, t.perTx] }),
    });
    if (t.daily > 0n) {
      calls.push({
        to: d.hook,
        data: encodeFunctionData({
          abi: spendingLimitHookAbi,
          functionName: "setTokenDailyCap",
          args: [id, t.token, t.daily],
        }),
      });
    }
  }
  return calls;
}

/** The admin call that ends a session now. */
export const revokeSessionCall = (d: AccountDeployment, id: Hex): Call => ({
  to: d.keystore,
  data: encodeFunctionData({ abi: keystoreAbi, functionName: "removeKey", args: [id] }),
});

/** Anyone may delete an expired key: until then it still passes VERIFY (its txs revert in execution, at a fee). */
export const pruneExpiredCall = (d: AccountDeployment, account: Address, id: Hex): Call => ({
  to: d.keystore,
  data: encodeFunctionData({ abi: keystoreAbi, functionName: "pruneExpired", args: [account, id] }),
});

// ------------------------------------------------------------------------------------- what a session may send ---

export const TRANSFER_SELECTOR: Hex = "0xa9059cbb";
export const TRANSFER_FROM_SELECTOR: Hex = "0x23b872dd";

/**
 * Selectors a session may never call, on any target: SessionRules.grantsOrMovesUncounted (contracts/src/account),
 * pinned to the Solidity source by test/session-rules.test.ts.
 */
export const SESSION_REFUSED_SELECTORS: Readonly<Record<string, string>> = {
  "0x095ea7b3": "approve",
  "0x39509351": "increaseAllowance",
  "0xd73dd623": "increaseApproval",
  "0xa22cb465": "setApprovalForAll",
  "0x42842e0e": "safeTransferFrom",
  "0xb88d4fde": "safeTransferFrom",
  "0xf242432a": "safeTransferFrom",
  "0x2eb2c2d6": "safeBatchTransferFrom",
  "0xd505accf": "permit",
  "0x87517c45": "approve (Permit2)",
  "0x2b67b570": "permit (Permit2)",
  "0x2a2d80d1": "permit (Permit2)",
  "0x36c78516": "transferFrom (Permit2)",
  "0x0d58b1db": "transferFrom (Permit2)",
  "0x9bd9bbc6": "send (ERC-777)",
  "0x1296ee62": "transferAndCall",
  "0x4000aea0": "transferAndCall",
  "0xd8fbe994": "transferFromAndCall",
  "0xc1d34b89": "transferFromAndCall",
  "0x3177029f": "approveAndCall",
  "0xcae9ca51": "approveAndCall",
  "0xb753a98c": "push",
  "0xf2d5d56b": "pull",
  "0xbb35783b": "move",
};

/** SessionRules.transferAmount: an ERC-20 transfer / transferFrom and its amount; `wellFormed` false when short. */
export function transferAmount(data: Hex): { isTransfer: boolean; wellFormed: boolean; amount: bigint } {
  if (size(data) < 4) return { isTransfer: false, wellFormed: true, amount: 0n };
  const sel = slice(data, 0, 4).toLowerCase();
  const end = sel === TRANSFER_SELECTOR ? 68 : sel === TRANSFER_FROM_SELECTOR ? 100 : 0;
  if (!end) return { isTransfer: false, wellFormed: true, amount: 0n };
  if (size(data) < end) return { isTransfer: true, wellFormed: false, amount: 0n };
  return { isTransfer: true, wellFormed: true, amount: hexToBigInt(slice(data, end - 32, end)) };
}

/** What a session key is allowed, as the keystore holds it. */
export interface SessionScope {
  account: Address;
  /** The keystore and the account's modules (hook, recovery): a session can never call them. */
  adminTargets: Address[];
  /** Its allowlist (tokens with a cap are on it too). */
  targets: Address[];
  /** Per-tx token caps (0 or absent: the token is not capped). */
  tokens: { token: Address; perTx: bigint }[];
  /** Most ETH per tx, summed over its calls. */
  perTxEth: bigint;
}

export type SessionCheck = { ok: true; eth: bigint; tokens: Record<string, bigint> } | { ok: false; reason: string };

/**
 * Whether a lone session key may send `calls` in one tx: KeystoreValidator._allowed for a session signer. Daily caps
 * (SpendingLimitHook) and expiry are checked in execution, not here.
 */
export function checkSessionCalls(scope: SessionScope, calls: Call[]): SessionCheck {
  const lower = (a: string) => a.toLowerCase();
  const admin = new Set([scope.account, ...scope.adminTargets].map(lower));
  const targets = new Set(scope.targets.map(lower));
  const caps = new Map(scope.tokens.filter((t) => t.perTx > 0n).map((t) => [lower(t.token), t.perTx]));
  let eth = 0n;
  const tokens: Record<string, bigint> = {};
  for (const c of calls) {
    const to = lower(c.to);
    if (admin.has(to)) return { ok: false, reason: "A session can't change the account's keys or settings." };
    eth += c.value ?? 0n;
    if (!targets.has(to)) return { ok: false, reason: "The session doesn't cover this contract." };
    const data = c.data ?? "0x";
    const t = transferAmount(data);
    const cap = caps.get(to);
    if (cap !== undefined) {
      if (!t.isTransfer || !t.wellFormed) return { ok: false, reason: "On a token, a session may only transfer." };
      tokens[to] = (tokens[to] ?? 0n) + t.amount;
      if (tokens[to]! > cap) return { ok: false, reason: "Over the session's per-payment token limit." };
      continue;
    }
    if (t.isTransfer) return { ok: false, reason: "The session has no limit for this token, so it can't move it." };
    const refused = size(data) >= 4 ? SESSION_REFUSED_SELECTORS[slice(data, 0, 4).toLowerCase()] : undefined;
    if (refused) return { ok: false, reason: `A session can never call ${refused}.` };
  }
  if (eth > scope.perTxEth) return { ok: false, reason: "Over the session's per-payment ETH limit." };
  return { ok: true, eth, tokens };
}
