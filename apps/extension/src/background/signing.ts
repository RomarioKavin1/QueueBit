import { encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { accountAbi } from "../generated/contracts";

/**
 * Signature-request classifier (plan §30 §3.4, as amended by the account audit of 2026-11-06):
 *  - `personal_sign` (SIWE or any text) and zero-value typed data → **sign-in**: the everyday key signs an ERC-7739
 *    envelope. The account accepts it only when the caller has no code (eth_call / off-chain verifiers such as SIWE)
 *    or is a Vault-trusted verifier, so it can never move assets.
 *  - an ERC-2612 `Permit` → **pre-approve via `registerPermit(token, spender, value, deadline)`** inside a hot batch:
 *    the account computes the permit digest itself and debits the permit's value from the daily limit.
 *  - Permit2 and every other value-bearing or unknown typed data → **needs the Vault** (the opaque `registerHash`
 *    is no longer honoured for tokens or Permit2).
 * Pure; the signing itself (approval window, 7739 envelope, `registerPermit` batch) is in `wallet.ts` / `signin.ts`.
 */

export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

export type SignatureClass =
  | { kind: "sign-in"; rule: "SIG-SIGN-IN"; domain?: string }
  | {
      kind: "register-permit";
      rule: "SIG-PERMIT-2612";
      token: Address;
      spender: Address;
      value: bigint;
      deadline: bigint;
    }
  | { kind: "needs-vault"; rule: "SIG-PERMIT2" | "SIG-VALUE-BEARING" | "SIG-UNKNOWN-SCHEMA"; reason: string };

interface TypedData {
  domain?: { name?: string; version?: string; chainId?: unknown; verifyingContract?: string };
  types?: Record<string, Array<{ name: string; type: string }>>;
  primaryType?: string;
  message?: Record<string, unknown>;
}

const PERMIT2_TYPES = new Set([
  "PermitSingle",
  "PermitBatch",
  "PermitTransferFrom",
  "PermitBatchTransferFrom",
  "PermitWitnessTransferFrom",
  "PermitBatchWitnessTransferFrom",
]);

/** Known value-bearing order schemas (plan §30 §3.4 registry). */
const VALUE_BEARING = new Set([
  "OrderComponents",
  "BulkOrder",
  "Order",
  "ExclusiveDutchOrder",
  "PriorityOrder",
  "LimitOrder",
]);

const ERC2612_FIELDS = ["owner", "spender", "value", "nonce", "deadline"];

/** Fields that usually carry money: an unknown schema with one of these is treated as value-bearing. */
const AMOUNTISH = /amount|value|price|wad|qty|quantity|fee|allowance|deposit|withdraw/iu;

const big = (v: unknown): bigint | undefined => {
  try {
    if (typeof v === "bigint") return v;
    if (typeof v === "number" && Number.isSafeInteger(v)) return BigInt(v);
    if (typeof v === "string" && /^(0x[0-9a-fA-F]+|\d+)$/u.test(v)) return BigInt(v);
  } catch {
    // fall through
  }
  return undefined;
};

export function classifyPersonalSign(message: string): SignatureClass {
  const m = /^(\S+) wants you to sign in with your Ethereum account:/u.exec(message);
  return { kind: "sign-in", rule: "SIG-SIGN-IN", ...(m?.[1] ? { domain: m[1] } : {}) };
}

export function classifyTypedData(input: unknown): SignatureClass {
  const td = (typeof input === "string" ? safeJson(input) : input) as TypedData | undefined;
  if (!td || typeof td !== "object" || !td.primaryType || !td.types?.[td.primaryType]) {
    return { kind: "needs-vault", rule: "SIG-UNKNOWN-SCHEMA", reason: "LEAKED couldn't read this signature request." };
  }
  const primary = td.primaryType;
  const fields = td.types[primary]!.map((f) => f.name);
  const verifying = td.domain?.verifyingContract;

  if (PERMIT2_TYPES.has(primary) || (verifying && isAddress(verifying) && getAddress(verifying) === PERMIT2)) {
    return {
      kind: "needs-vault",
      rule: "SIG-PERMIT2",
      reason:
        "This is a Permit2 signature, which lets a contract move your tokens. LEAKED's everyday key never signs these, and your Vault's quantum-safe key never signs for sites.",
    };
  }
  if (primary === "Permit" && ERC2612_FIELDS.every((f) => fields.includes(f)) && verifying && isAddress(verifying)) {
    const msg = td.message ?? {};
    const value = big(msg.value);
    const deadline = big(msg.deadline);
    const spender = typeof msg.spender === "string" && isAddress(msg.spender) ? getAddress(msg.spender) : undefined;
    if (value !== undefined && deadline !== undefined && spender) {
      return {
        kind: "register-permit",
        rule: "SIG-PERMIT-2612",
        token: getAddress(verifying),
        spender,
        value,
        deadline,
      };
    }
  }
  if (VALUE_BEARING.has(primary)) {
    return {
      kind: "needs-vault",
      rule: "SIG-VALUE-BEARING",
      reason:
        "This signature can move your money (an order or a payment), so LEAKED won't sign it with the everyday key.",
    };
  }
  const allTypes = Object.values(td.types).flat();
  const valueish = allTypes.some((f) => /^u?int\d*$/u.test(f.type) && AMOUNTISH.test(f.name));
  if (valueish) {
    return {
      kind: "needs-vault",
      rule: "SIG-UNKNOWN-SCHEMA",
      reason: "We don't recognise this kind of signature, so LEAKED won't sign it blind.",
    };
  }
  return { kind: "sign-in", rule: "SIG-SIGN-IN", ...(td.domain?.name ? { domain: td.domain.name } : {}) };
}

/** The hot-batch call for an ERC-2612 permit (the account computes and registers the digest itself). */
export function registerPermitCall(account: Address, c: Extract<SignatureClass, { kind: "register-permit" }>) {
  return {
    target: account,
    value: 0n,
    data: encodeFunctionData({
      abi: accountAbi,
      functionName: "registerPermit",
      args: [c.token, c.spender, c.value, c.deadline],
    }) as Hex,
  };
}

/** One sentence for the approval / error copy. */
export function signatureCopy(c: SignatureClass): string {
  switch (c.kind) {
    case "sign-in":
      return "Sign in: your everyday key signs a message that can't move money.";
    case "register-permit":
      return "Pre-approve a token permit: recorded on the network and counts against your daily limit.";
    case "needs-vault":
      return c.reason;
  }
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
