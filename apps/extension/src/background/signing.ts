import { encodeFunctionData, getAddress, isAddress, parseAbi, type Address, type Hex } from "viem";
import { accountAbi } from "../generated/contracts";

/**
 * Signature-request classifier (plan §30 §3.4, as amended by the account audit of 2026-11-06):
 *  - `personal_sign` (SIWE or any text) and zero-value typed data → **sign-in**: the everyday key signs an ERC-7739
 *    envelope. The account accepts it only when the caller has no code (eth_call / off-chain verifiers such as SIWE)
 *    or is a Vault-trusted verifier, so it can never move assets.
 *  - an ERC-2612 `Permit` → **pre-approve via `registerPermit(token, spender, value, deadline)`** inside a hot batch:
 *    the account computes the permit digest itself and debits the permit's value from the daily limit.
 *  - a Permit2 `PermitSingle` / `PermitTransferFrom` → **pre-approve via `registerPermit2` / `registerPermit2Transfer`**
 *    in a hot batch, like ERC-2612 (the account computes Permit2's digest and debits the typed amount); the spender
 *    must be an allowed app or hold a live allowance.
 *  - Permit2 batch / witness signatures and every other value-bearing or unknown typed data → **refused** (the
 *    opaque `registerHash` is no longer honoured for tokens or Permit2).
 * Pure; the signing itself (approval window, 7739 envelope, `registerPermit` batch) is in `wallet.ts` / `signin.ts`.
 */

export const PERMIT2: Address = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

/** The Permit2 views the pre-checks read (the account reads the same ones on chain). */
export const PERMIT2_VIEWS = parseAbi([
  "function allowance(address owner, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)",
  "function nonceBitmap(address owner, uint256 wordPos) view returns (uint256)",
]);

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
  | {
      kind: "register-permit2";
      rule: "SIG-PERMIT2-SINGLE";
      token: Address;
      amount: bigint;
      expiration: bigint;
      /** Permit2's `allowance(owner, token, spender).nonce` the site signed over (checked against chain). */
      nonce: bigint;
      spender: Address;
      sigDeadline: bigint;
    }
  | {
      kind: "register-permit2-transfer";
      rule: "SIG-PERMIT2-TRANSFER";
      token: Address;
      amount: bigint;
      spender: Address;
      nonce: bigint;
      deadline: bigint;
    }
  | { kind: "needs-vault"; rule: "SIG-PERMIT2" | "SIG-VALUE-BEARING" | "SIG-UNKNOWN-SCHEMA"; reason: string };

/** Any typed pre-approval the account records itself in an everyday batch. */
export type PermitClass = Extract<
  SignatureClass,
  { kind: "register-permit" | "register-permit2" | "register-permit2-transfer" }
>;
export const isPermitClass = (c: SignatureClass): c is PermitClass =>
  c.kind === "register-permit" || c.kind === "register-permit2" || c.kind === "register-permit2-transfer";

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
    const p2 = permit2Class(td);
    if (p2) return p2;
    return {
      kind: "needs-vault",
      rule: "SIG-PERMIT2",
      reason:
        "This Permit2 signature (a batch, a witness transfer, or one for another Permit2 contract) lets a contract move your tokens in a way LEAKED can't record and limit, so it isn't signed.",
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

const addr = (v: unknown): Address | undefined => (typeof v === "string" && isAddress(v) ? getAddress(v) : undefined);
const fieldsOf = (td: TypedData, t: string) => (td.types?.[t] ?? []).map((f) => `${f.type} ${f.name}`).join(",");

/**
 * Permit2 `PermitSingle` (AllowanceTransfer) and `PermitTransferFrom` (SignatureTransfer) with the canonical domain
 * (name "Permit2", the canonical address) and exactly the canonical struct fields; anything else is undefined.
 */
function permit2Class(td: TypedData): SignatureClass | undefined {
  const d = td.domain ?? {};
  if (d.name !== "Permit2" || d.version !== undefined || addr(d.verifyingContract) !== PERMIT2) return undefined;
  const m = td.message ?? {};
  if (
    td.primaryType === "PermitSingle" &&
    fieldsOf(td, "PermitSingle") === "PermitDetails details,address spender,uint256 sigDeadline" &&
    fieldsOf(td, "PermitDetails") === "address token,uint160 amount,uint48 expiration,uint48 nonce"
  ) {
    const det = (m.details ?? {}) as Record<string, unknown>;
    const [token, spender] = [addr(det.token), addr(m.spender)];
    const [amount, expiration, nonce, sigDeadline] = [
      big(det.amount),
      big(det.expiration),
      big(det.nonce),
      big(m.sigDeadline),
    ];
    if (
      token &&
      spender &&
      amount !== undefined &&
      expiration !== undefined &&
      nonce !== undefined &&
      sigDeadline !== undefined
    )
      return {
        kind: "register-permit2",
        rule: "SIG-PERMIT2-SINGLE",
        token,
        amount,
        expiration,
        nonce,
        spender,
        sigDeadline,
      };
  }
  if (
    td.primaryType === "PermitTransferFrom" &&
    fieldsOf(td, "PermitTransferFrom") ===
      "TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline" &&
    fieldsOf(td, "TokenPermissions") === "address token,uint256 amount"
  ) {
    const per = (m.permitted ?? {}) as Record<string, unknown>;
    const [token, spender] = [addr(per.token), addr(m.spender)];
    const [amount, nonce, deadline] = [big(per.amount), big(m.nonce), big(m.deadline)];
    if (token && spender && amount !== undefined && nonce !== undefined && deadline !== undefined)
      return {
        kind: "register-permit2-transfer",
        rule: "SIG-PERMIT2-TRANSFER",
        token,
        amount,
        spender,
        nonce,
        deadline,
      };
  }
  return undefined;
}

/**
 * Why an ERC-2612 permit can never match what `registerPermit` would record, checked before anything is sent: the
 * account registers a digest for `owner = itself` on the current chain, so a permit naming another owner or another
 * chain would be recorded (and debited from the daily limit) yet never be the signature the site asked for.
 */
export function permitMismatch(input: unknown, account: Address, chainId: number): string | undefined {
  const td = (typeof input === "string" ? safeJson(input) : input) as TypedData | undefined;
  if (!td || typeof td !== "object") return undefined;
  const owner = td.message?.owner;
  if (typeof owner === "string" && isAddress(owner) && getAddress(owner) !== getAddress(account)) {
    return `This permit is for another account (${owner}), not yours.`;
  }
  const chain = td.domain?.chainId;
  if (chain !== undefined && chain !== null) {
    const n = big(chain);
    if (n === undefined || n !== BigInt(chainId)) {
      return `This permit is for another network (chain ${String(chain)}), not the one this site is connected to.`;
    }
  }
  return undefined;
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

/**
 * The hot-batch call for a Permit2 pre-approval. `sessionSelector` names the live allowance that admits a spender
 * which is not an allowed app (`0x00000000` when it is one).
 */
export function registerPermit2Call(
  target: Address,
  c: Extract<SignatureClass, { kind: "register-permit2" | "register-permit2-transfer" }>,
  sessionSelector: Hex = "0x00000000",
) {
  const data =
    c.kind === "register-permit2"
      ? encodeFunctionData({
          abi: accountAbi,
          functionName: "registerPermit2",
          args: [c.token, c.amount, Number(c.expiration), c.spender, c.sigDeadline, sessionSelector],
        })
      : encodeFunctionData({
          abi: accountAbi,
          functionName: "registerPermit2Transfer",
          args: [c.token, c.amount, c.spender, c.nonce, c.deadline, sessionSelector],
        });
  return { target, value: 0n, data: data as Hex };
}

/** Why a Permit2 pre-approval would be refused by the account or never match, checked before anything is sent. */
export function permit2Problem(
  c: Extract<SignatureClass, { kind: "register-permit2" | "register-permit2-transfer" }>,
  o: { chainId: number; domainChainId: unknown; now: number; allowanceNonce?: bigint; nonceUsed?: boolean },
): string | undefined {
  const n = big(o.domainChainId);
  if (n === undefined || n !== BigInt(o.chainId))
    return `This permit is for another network (chain ${String(o.domainChainId)}), not the one this site is connected to.`;
  const MAX_TTL = 30n * 86_400n;
  const now = BigInt(o.now);
  if (c.kind === "register-permit2") {
    if (c.amount >= 1n << 160n) return "This permit's amount is too large to record.";
    if (c.expiration <= now || c.expiration > now + MAX_TTL)
      return "This permit must expire within 30 days (and not already be expired); LEAKED can't record an open-ended one.";
    if (c.sigDeadline <= now) return "This permit has already expired.";
    if (o.allowanceNonce !== undefined && o.allowanceNonce !== c.nonce)
      return "This permit uses an old Permit2 nonce, so it can't be recorded as asked. Ask the site to try again.";
  } else {
    if (c.deadline <= now) return "This permit has already expired.";
    if (o.nonceUsed) return "This permit's nonce was already used. Ask the site to try again.";
  }
  return undefined;
}

/** One sentence for the approval / error copy. */
export function signatureCopy(c: SignatureClass): string {
  switch (c.kind) {
    case "sign-in":
      return "Sign in: your everyday key signs a message that can't move money.";
    case "register-permit":
    case "register-permit2":
    case "register-permit2-transfer":
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
