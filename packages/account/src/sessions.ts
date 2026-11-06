import { encodeFunctionData, type Address, type Hex } from "viem";
import { keystoreAbi, spendingLimitHookAbi } from "./abi.js";
import type { AccountDeployment } from "./create.js";
import type { KIND} from "./keys.js";
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
