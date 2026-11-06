import { decodeFunctionData, erc20Abi, type Address, type Hex } from "viem";

/**
 * The routing engine (plan §30 §5): decides, before the user commits, whether a hot batch is an everyday payment
 * (`ROUTE-HOT-OK`) or needs the Vault (`ROUTE-NEEDS-VAULT` + why), from the account's own on-chain policy (cap,
 * per-payment limit, allowed tokens and recipients) and the simulation of the exact signed transaction. The check is
 * advisory and must never be looser than the chain (§9.8 iii): every rule here mirrors one in `hotExecute` /
 * `verifyFrame`, and the simulation has the last word.
 *
 * Pure: no I/O. Amounts are USD with 6 decimals (the account's unit).
 */

export const MAX_HOT_CALLS = 8;
const TRANSFER_SELECTOR = "0xa9059cbb";

export interface Call {
  target: Address;
  value: bigint;
  data: Hex;
}

/** `permit-registration`: the account's own `registerPermit` in a hot batch (an ERC-2612 pre-approval, M3). */
export type CallKind = "eth-transfer" | "token-transfer" | "contract-call" | "permit-registration";

/** A call with the policy facts the router needs, read from the account (`isTarget`, `getToken`, `quoteUsd`). */
export interface ClassifiedCall {
  call: Call;
  kind: CallKind;
  /** Who receives value: `target` for ETH, the `to` argument for an ERC-20 transfer, `target` otherwise. */
  recipient: Address;
  /** ETH or the token is an allowed (priced) asset. */
  assetAllowed: boolean;
  recipientAllowed: boolean;
  /** A vault-issued app allowance covers `(target, selector)` (only meaningful for contract calls). */
  sessionMatch: boolean;
  /** USD-6 at the account's static price (0 when the asset is not priced). */
  usd: bigint;
  /** Base units moved (wei for ETH). */
  amount: bigint;
  token?: Address;
}

export interface PolicySnapshot {
  deployed: boolean;
  frozen: boolean;
  bunker: boolean;
  frozenUntil?: number;
  capUsd: bigint;
  availableUsd: bigint;
  perTxMaxUsd: bigint;
}

/** The simulation of the signed transaction, reduced to what routing needs. */
export interface SimulationVerdict {
  /** canonicalMempoolValid: the validation prefix (VERIFY + pay) admits it. */
  admitted: boolean;
  /** Every body frame succeeded in the simulation. */
  bodyOk: boolean;
  /** The node's reason, when not admitted or a body frame failed. */
  reason?: string;
}

export type RuleId =
  | "ROUTE-HOT-OK"
  | "ROUTE-NEEDS-VAULT"
  | "ROUTE-FROZEN"
  | "ROUTE-BUNKER"
  | "ROUTE-NOT-ACTIVATED"
  | "CAP-EXCEEDED"
  | "PER-PAYMENT-LIMIT"
  | "TARGET-NOT-ALLOWED"
  | "TOKEN-NOT-ALLOWED"
  | "BATCH-TOO-LARGE"
  | "SIM-REJECTED";

export type Route = "hot" | "needs-vault" | "blocked" | "not-activated";

export interface RouteDecision {
  route: Route;
  /** Primary rule first (`ROUTE-*`), then the reasons. Shown under Details only. */
  rules: RuleId[];
  amountUsd: bigint;
  /** Left today after this payment (hot route only). */
  leftAfterUsd?: bigint;
  /** First recipient / asset that is not allowed, for the copy. */
  notAllowed?: { what: "recipient" | "token"; address: Address };
  simulationReason?: string;
}

/** Classifies a raw call by shape (no chain reads): ETH transfer, ERC-20 `transfer`, or any other contract call. */
export function callShape(call: Call): { kind: CallKind; recipient: Address; amount: bigint; token?: Address } {
  if (call.data === "0x" || call.data.length <= 2)
    return { kind: "eth-transfer", recipient: call.target, amount: call.value };
  if (call.data.toLowerCase().startsWith(TRANSFER_SELECTOR) && call.value === 0n && (call.data.length - 2) / 2 === 68) {
    try {
      const { args } = decodeFunctionData({ abi: erc20Abi, data: call.data });
      const [to, amount] = args as readonly [Address, bigint];
      return { kind: "token-transfer", recipient: to, amount, token: call.target };
    } catch {
      // fall through: not a well-formed transfer
    }
  }
  return { kind: "contract-call", recipient: call.target, amount: call.value };
}

export function totalUsd(calls: readonly ClassifiedCall[]): bigint {
  return calls.reduce((s, c) => s + c.usd, 0n);
}

export function decideRoute(
  policy: PolicySnapshot,
  calls: readonly ClassifiedCall[],
  sim?: SimulationVerdict,
): RouteDecision {
  const amountUsd = totalUsd(calls);
  if (!policy.deployed) return { route: "not-activated", rules: ["ROUTE-NOT-ACTIVATED"], amountUsd };
  if (policy.bunker) return { route: "blocked", rules: ["ROUTE-BUNKER"], amountUsd };
  if (policy.frozen) return { route: "blocked", rules: ["ROUTE-FROZEN"], amountUsd };
  if (calls.length === 0 || calls.length > MAX_HOT_CALLS) {
    return { route: "blocked", rules: ["BATCH-TOO-LARGE"], amountUsd };
  }

  const reasons: RuleId[] = [];
  let notAllowed: RouteDecision["notAllowed"];
  for (const c of calls) {
    if (c.kind === "contract-call") {
      if (!c.sessionMatch) {
        reasons.push("TARGET-NOT-ALLOWED");
        notAllowed ??= { what: "recipient", address: c.recipient };
      }
      continue;
    }
    if (!c.assetAllowed) {
      reasons.push("TOKEN-NOT-ALLOWED");
      notAllowed ??= { what: "token", address: c.token ?? c.call.target };
    }
    if (!c.recipientAllowed) {
      reasons.push("TARGET-NOT-ALLOWED");
      notAllowed ??= { what: "recipient", address: c.recipient };
    }
  }
  if (amountUsd > policy.perTxMaxUsd) reasons.push("PER-PAYMENT-LIMIT");
  if (amountUsd > policy.availableUsd) reasons.push("CAP-EXCEEDED");

  const unique = [...new Set(reasons)];
  if (unique.length > 0) {
    return {
      route: "needs-vault",
      rules: ["ROUTE-NEEDS-VAULT", ...unique],
      amountUsd,
      ...(notAllowed ? { notAllowed } : {}),
    };
  }
  if (sim && (!sim.admitted || !sim.bodyOk)) {
    return {
      route: "needs-vault",
      rules: ["ROUTE-NEEDS-VAULT", "SIM-REJECTED"],
      amountUsd,
      ...(sim.reason ? { simulationReason: sim.reason } : {}),
    };
  }
  return { route: "hot", rules: ["ROUTE-HOT-OK"], amountUsd, leftAfterUsd: policy.availableUsd - amountUsd };
}

/** USD-6 → display number. */
export const usdNumber = (usd6: bigint): number => Number(usd6) / 1e6;

const usd = (usd6: bigint) =>
  `$${usdNumber(usd6).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

export interface RouteCopy {
  tone: "safe" | "vault" | "limit" | "danger";
  headline: string;
  detail: string;
  /** What the user can do instead (the dapp error's `remedy`). */
  remedy?: string;
}

/**
 * The route card copy (ux-spec §3.3.1 table). The same `detail` string is the dapp error's `explanation`
 * (ux-spec §9 item 9): dapps that show `error.message` say what the user saw.
 */
export function routeCopy(
  d: RouteDecision,
  policy: PolicySnapshot,
  short: (a: Address) => string = (a) => a,
): RouteCopy {
  switch (d.route) {
    case "not-activated":
      return {
        tone: "limit",
        headline: "Activate your account first",
        detail: "Your account isn't active on this network yet, so it can't pay. Activation sets your daily limit.",
        remedy: "Open QueueBit and choose Activate account.",
      };
    case "blocked":
      if (d.rules[0] === "ROUTE-BUNKER") {
        return {
          tone: "danger",
          headline: "Lockdown is on",
          detail: "Everyday spending is off. Open Security.",
          remedy: "Issue a new everyday key with your Vault.",
        };
      }
      if (d.rules[0] === "ROUTE-FROZEN") {
        const until = policy.frozenUntil ? new Date(policy.frozenUntil * 1000).toLocaleString("en-GB") : "later";
        return {
          tone: "limit",
          headline: "Everyday spending is paused",
          detail: `Resumes ${until}, or your phone can resume it now.`,
          remedy: "Resume everyday spending with your Vault.",
        };
      }
      return {
        tone: "danger",
        headline: "Too many steps for one payment",
        detail: `This request has too many steps for one payment (more than ${MAX_HOT_CALLS}).`,
      };
    case "needs-vault": {
      const r = d.rules;
      let detail: string;
      if (r.includes("TARGET-NOT-ALLOWED") || r.includes("TOKEN-NOT-ALLOWED")) {
        const who = d.notAllowed?.what === "token" ? "This token" : `${short(d.notAllowed?.address ?? "0x")}`;
        detail = `${who} isn't on your allowed list yet.`;
      } else if (r.includes("PER-PAYMENT-LIMIT")) {
        detail = `Above your ${usd(policy.perTxMaxUsd)} per-payment limit.`;
      } else if (r.includes("CAP-EXCEEDED")) {
        detail = `Over what's left today (${usd(policy.availableUsd)}).`;
      } else {
        detail = "Your account would refuse this as an everyday payment.";
      }
      return {
        tone: "vault",
        headline: "Needs your phone",
        detail: `${detail} Your phone (the Vault) has to approve it.`,
        remedy: "Approve it with your Vault, or send less.",
      };
    }
    case "hot":
      return {
        tone: "safe",
        headline: "Instant: within your daily limit",
        detail: `Uses ${usd(d.amountUsd)} of ${usd(policy.availableUsd)} left today`,
      };
  }
}
