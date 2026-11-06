import { encodeFunctionData, erc20Abi, type Address, type Hex } from "viem";
import { accountAbi } from "../generated/contracts";
import { USD } from "./account";
import { callShape, type Call } from "./routing";

/**
 * What the Vault (or the Recovery key) can be asked to approve, as account calldata plus the plain-language framing
 * the extension shows next to the QR (ux-spec §3.6) and the advisory intent it puts in the request (key 11: never
 * shown by the phone, only compared with its own decoding). Tightening is instant; loosening goes through
 * `vaultQueue(calls, KIND_LOOSEN)` and waits (plan §10.3.2, ux-spec principle 4). Pure.
 */

export const KIND = { spend: 0, loosen: 1, upgrade: 2, migrate: 3 } as const;

export type VaultRole = "vault" | "recovery";

export type VaultActionRequest =
  | {
      type: "send";
      calls: Array<{ target: Address; value: string; data: Hex }>;
      usd6: string;
      /**
       * Gas for the body step when the calls are heavier than a transfer (a Privacy Pools deposit inserts into a
       * Poseidon tree): decimal strings, bounded by `MAX_ROLE_BODY`. The simulation still has the last word.
       */
      body?: { execution: string; state: string };
      /** What the payment is for, when the extension itself asks (e.g. "Deposit 0.1 ETH into your private balance"). */
      label?: string;
    }
  | { type: "setLimits"; dailyUsd: number; perPaymentUsd: number }
  | { type: "setRecipientMode"; mode: "open" | "strict" }
  | { type: "setToken"; token: Address; allowed: boolean; decimals: number; usdPerToken: string; symbol?: string }
  | { type: "setSession"; target: Address; selector: Hex; allowanceUsd: number; expiry: number; label?: string }
  | { type: "freeze" }
  | { type: "unfreeze" }
  | { type: "lockdown" }
  | { type: "setHotKey"; hotKey: Address; index: number }
  /** Install (or with the zero address, remove) the post-quantum everyday key's `LeanPoolHotSigner`. */
  | { type: "setPQHotSigner"; signer: Address }
  | { type: "setGuardian"; guardian: Address; enabled: boolean; name?: string }
  | { type: "setRecoverySigner"; signer: Address }
  /** 4337 backend: the executor stores the Recovery key's PQ public key itself (no signer contract). */
  | { type: "setRecoveryKey"; pk: Hex }
  | { type: "cancel"; opId: Hex; title: string; by: VaultRole };

/** The account's current policy, as read from chain (for "from → to" and tighten/loosen decisions). */
export interface CurrentPolicy {
  capUsd: bigint;
  perTxMaxUsd: bigint;
  maxFeeWeiPerTx: bigint;
  maxHotFrames: number;
  /** 4337 backend: the hook's `maxPriorityFeePerGas` (kept as is by a limits change). */
  maxPriorityFeePerGas?: bigint;
  recipientMode: "open" | "strict";
  /** Instant Vault spends left today (`getVaultBucket().available`). */
  vaultAvailableUsd: bigint;
  timelockDelay: number;
  tokens: Record<string, { allowed: boolean; decimals: number; usdPerToken: bigint }>;
  sessions: Record<string, { allowanceUsd: bigint; expiry: number }>;
}

export interface BuiltVaultAction {
  role: VaultRole;
  /** The account function the role signer forwards to (calldata for `executePQ(0, account, data)` / `relay`). */
  data: Hex;
  /** `vaultSetCap`, `send`, …: the companion's action id for the mismatch check. */
  action: string;
  title: string;
  /** "Takes effect now" / "Waits 48 h after your phone approves" / … */
  effect: string;
  timing: "now" | "queued";
  /** For queued ops: the calls `executeQueued(opId, calls)` must repeat exactly. */
  queued?: { kind: number; calls: Array<{ target: Address; value: string; data: Hex }> };
  intent?: { recipient?: Address; amount?: bigint; token?: Address };
  /** USD-6 value moved (sends). */
  usd6?: bigint;
}

const enc = (functionName: string, args: readonly unknown[] = []): Hex =>
  encodeFunctionData({ abi: accountAbi, functionName: functionName as never, args: args as never });

const money = (usd6: bigint) =>
  `$${(Number(usd6) / 1e6).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const hours = (s: number) => (s % 3600 === 0 ? `${s / 3600} h` : `${Math.round(s / 60)} min`);

function queuedLoosen(account: Address, data: Hex, delay: number) {
  const calls = [{ target: account, value: "0", data }];
  return {
    data: enc("vaultQueue", [calls.map((c) => ({ ...c, value: 0n })), KIND.loosen]),
    queued: { kind: KIND.loosen, calls },
    timing: "queued" as const,
    effect: `Waits ${hours(delay)} after your phone approves. You can cancel it during the wait.`,
  };
}

export function buildVaultAction(account: Address, req: VaultActionRequest, cur: CurrentPolicy): BuiltVaultAction {
  switch (req.type) {
    case "send": {
      const calls: Call[] = req.calls.map((c) => ({ target: c.target, value: BigInt(c.value), data: c.data }));
      const usd = BigInt(req.usd6);
      const first = calls[0] ? callShape(calls[0]) : undefined;
      const what = req.label
        ? req.label.slice(0, 80)
        : first?.kind === "eth-transfer"
          ? `Send ${ethText(first.amount)} to ${short(first.recipient)}`
          : first?.kind === "token-transfer"
            ? `Send tokens to ${short(first.recipient)}`
            : `Make a payment from your account`;
      const intent =
        first && first.kind !== "contract-call"
          ? {
              recipient: first.recipient,
              amount: first.amount,
              token: (first.token ?? "0x0000000000000000000000000000000000000000") as Address,
            }
          : undefined;
      if (usd <= cur.vaultAvailableUsd) {
        return {
          role: "vault",
          data: enc("vaultExecute", [calls, usd]),
          action: "send",
          title: `${what} (≈ ${money(usd)})`,
          effect: "No waiting period: within your Vault's instant allowance.",
          timing: "now",
          usd6: usd,
          ...(intent ? { intent } : {}),
        };
      }
      const qcalls = req.calls;
      return {
        role: "vault",
        data: enc("vaultQueue", [calls, KIND.spend]),
        action: "send",
        title: `${what} (≈ ${money(usd)})`,
        effect: `Large payment: waits ${hours(cur.timelockDelay)} after your phone approves, then anyone can send it.`,
        timing: "queued",
        queued: { kind: KIND.spend, calls: qcalls },
        usd6: usd,
        ...(intent ? { intent } : {}),
      };
    }
    case "setLimits": {
      const cap = BigInt(Math.round(req.dailyUsd * 100)) * (USD / 100n);
      const perTx = BigInt(Math.round(req.perPaymentUsd * 100)) * (USD / 100n);
      const data = enc("vaultSetCap", [cap, perTx, cur.maxFeeWeiPerTx, cur.maxHotFrames]);
      const parts = [
        ...(cap !== cur.capUsd ? [`daily limit ${money(cur.capUsd)} → ${money(cap)}`] : []),
        ...(perTx !== cur.perTxMaxUsd ? [`per-payment limit ${money(cur.perTxMaxUsd)} → ${money(perTx)}`] : []),
      ];
      const title = `Change ${parts.length > 0 ? parts.join(", ") : "nothing (same limits)"}`;
      if (cap <= cur.capUsd && perTx <= cur.perTxMaxUsd) {
        return {
          role: "vault",
          data,
          action: "vaultSetCap",
          title,
          effect: "Instant: this makes your account safer.",
          timing: "now",
        };
      }
      return { role: "vault", action: "vaultSetCap", title, ...queuedLoosen(account, data, cur.timelockDelay) };
    }
    case "setRecipientMode": {
      const data = enc("vaultSetRecipientMode", [req.mode === "open" ? 0 : 1]);
      if (req.mode === "strict") {
        return {
          role: "vault",
          data,
          action: "vaultSetRecipientMode",
          title: "Everyday payments only to allowed recipients (Strict)",
          effect: "Instant: this makes your account safer.",
          timing: "now",
        };
      }
      return {
        role: "vault",
        action: "vaultSetRecipientMode",
        title: "Everyday payments to any address within the limit (Open)",
        ...queuedLoosen(account, data, cur.timelockDelay),
      };
    }
    case "setToken": {
      const now = cur.tokens[req.token.toLowerCase()];
      const price = BigInt(req.usdPerToken);
      const data = enc("vaultSetToken", [req.token, req.allowed, req.decimals, req.allowed ? price : 0n]);
      const name = req.symbol ?? short(req.token);
      const loosening =
        req.allowed && (!now?.allowed || now.decimals !== req.decimals || price < (now?.usdPerToken ?? 0n));
      const title = req.allowed ? `Allow ${name} for everyday payments (${money(price)} each)` : `Remove ${name}`;
      if (!loosening) {
        return {
          role: "vault",
          data,
          action: "vaultSetToken",
          title,
          effect: "Instant: this makes your account safer.",
          timing: "now",
        };
      }
      return { role: "vault", action: "vaultSetToken", title, ...queuedLoosen(account, data, cur.timelockDelay) };
    }
    case "setSession": {
      const allowance = BigInt(Math.round(req.allowanceUsd * 100)) * (USD / 100n);
      const removal = allowance === 0n || req.expiry === 0;
      const data = enc("vaultSetSession", [
        req.target,
        req.selector,
        removal ? 0n : allowance,
        removal ? 0 : req.expiry,
      ]);
      const name = req.label ?? short(req.target);
      if (removal) {
        return {
          role: "vault",
          data,
          action: "vaultSetSession",
          title: `Revoke the allowance of ${name}`,
          effect: "Instant.",
          timing: "now",
        };
      }
      const s = cur.sessions[`${req.target.toLowerCase()}:${req.selector.toLowerCase()}`];
      const loosening = !s || allowance > s.allowanceUsd || req.expiry > s.expiry;
      const title = `Let ${name} spend up to ${money(allowance)} without asking, until ${new Date(req.expiry * 1000).toLocaleDateString("en-GB")}`;
      if (!loosening) {
        return { role: "vault", data, action: "vaultSetSession", title, effect: "Instant.", timing: "now" };
      }
      return { role: "vault", action: "vaultSetSession", title, ...queuedLoosen(account, data, cur.timelockDelay) };
    }
    case "freeze":
      return now("vaultFreeze", "Pause everyday spending", "Instant. Only your phone can resume it.");
    case "unfreeze":
      return now("vaultUnfreeze", "Resume everyday spending", "Instant.");
    case "lockdown":
      return now(
        "vaultEnableBunker",
        "Start Lockdown: switch everyday spending off",
        "Instant. To turn it back on, your phone issues a new everyday key.",
      );
    case "setHotKey":
      return now(
        "vaultSetHotKey",
        `Replace the everyday key with ${short(req.hotKey)}`,
        "Instant. The old everyday key stops working immediately; your address stays the same.",
        [req.hotKey],
      );
    case "setPQHotSigner":
      // Removing it is tightening (instant). Installing or replacing it adds a spender that trusts a new LeanPool
      // aggregator: loosening, so it waits for the timelock (the account refuses it otherwise: MustQueue).
      return BigInt(req.signer) === 0n
        ? now(
            "vaultSetPQHotSigner",
            "Turn off the quantum-safe everyday key",
            "Instant. Everyday payments go back to your regular everyday key.",
            [req.signer],
          )
        : {
            role: "vault",
            action: "vaultSetPQHotSigner",
            title: "Use a quantum-safe everyday key",
            ...queuedLoosen(account, enc("vaultSetPQHotSigner", [req.signer]), cur.timelockDelay),
          };
    case "setGuardian":
      return now(
        "vaultSetGuardian",
        req.enabled
          ? `Add ${req.name ?? short(req.guardian)} as a Guardian (can only pause everyday spending)`
          : `Remove the Guardian ${req.name ?? short(req.guardian)}`,
        "Instant.",
        [req.guardian, req.enabled],
      );
    case "setRecoverySigner":
      return now("vaultSetRecoverySigner", "Link your Recovery key to this account", "Instant (first Recovery key).", [
        req.signer,
      ]);
    case "setRecoveryKey":
      throw new Error("setRecoveryKey is a compatible-account (4337) action");
    case "cancel":
      return {
        role: req.by,
        data: enc(req.by === "vault" ? "vaultCancel" : "recoveryCancel", [req.opId]),
        action: req.by === "vault" ? "vaultCancel" : "recoveryCancel",
        title: `Cancel: ${req.title}`,
        effect: "Instant: the scheduled change never happens.",
        timing: "now",
      };
  }
}

function now(fn: string, title: string, effect: string, args: readonly unknown[] = []): BuiltVaultAction {
  return { role: "vault", data: enc(fn, args), action: fn, title, effect, timing: "now" };
}

function ethText(wei: bigint): string {
  const s = (Number(wei) / 1e18).toLocaleString("en-US", { maximumFractionDigits: 6 });
  return `${s} ETH`;
}

/** An ERC-20 transfer call (for token sends through the Vault). */
export function erc20TransferCall(token: Address, to: Address, amount: bigint): Call {
  return {
    target: token,
    value: 0n,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }),
  };
}
