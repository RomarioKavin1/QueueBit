import { concatHex, hashTypedData, hexToString, isHex, type Address, type Hex, type TypedDataDefinition } from "viem";
import { sign, serializeSignature } from "viem/accounts";
import {
  hashMessage as hash7739Message,
  hashTypedData as hash7739TypedData,
  wrapTypedDataSignature,
} from "viem/experimental/erc7739";

/**
 * Scoped ERC-1271 sign-in (plan §30 §3.2 / §3.4 path (a), M3): the everyday key signs an ERC-7739 envelope that the
 * account accepts only when the verifier has no code (an `eth_call` check: SIWE back ends, viem `verifyMessage`) or
 * is a Vault-trusted verifier (LeakedAccountImpl "hot verifier rule"). It can never move money: tokens, Permit2 and
 * any untrusted on-chain contract get "invalid". Pure except for the signing callback.
 */

/** The account's own EIP-712 domain (`EIP712("LEAKED", "1")` in LeakedAccountImpl), the 7739 verifier domain. */
export function accountDomain(account: Address, chainId: number) {
  return {
    name: "LEAKED",
    version: "1",
    chainId: BigInt(chainId),
    verifyingContract: account,
    salt: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex,
  } as const;
}

/**
 * The 7579 backend's 7739 domain: LeakedHotValidator's `EIP712Domain(name "LeakedHotValidator", version "1",
 * chainId, verifyingContract = account)` without a salt (its `accountDomainSeparator`); the nested TypedDataSign
 * carries `salt = 0` (its `domainBytes`). The host routes 1271 to the validator by a 20-byte prefix.
 */
export type VerifierDomain = { name: string; version: string; chainId: bigint; verifyingContract: Address; salt?: Hex };

export function validatorDomain(account: Address, chainId: number, withSalt: boolean): VerifierDomain {
  return {
    name: "LeakedHotValidator",
    version: "1",
    chainId: BigInt(chainId),
    verifyingContract: account,
    ...(withSalt ? { salt: "0x0000000000000000000000000000000000000000000000000000000000000000" as Hex } : {}),
  };
}

/** `personal_sign` params[0] (hex bytes or plain text) as the message viem hashes. */
export function personalMessage(raw: string): string | { raw: Hex } {
  return isHex(raw) ? { raw } : raw;
}

/** The text shown to the user (UTF-8 when it decodes, else the hex). */
export function messageText(raw: string): string {
  if (!isHex(raw)) return raw;
  try {
    const s = hexToString(raw);
    // Control characters other than whitespace: show hex instead of something misleading.
    // eslint-disable-next-line no-control-regex
    return /[\u0000-\u0008\u000e-\u001f\u007f]/u.test(s) ? raw : s;
  } catch {
    return raw;
  }
}

/** ERC-7739 PersonalSign: the hot key's raw signature over `PersonalSign(prefixed)` in the account's domain. */
export async function signPersonal7739(
  privateKey: Hex,
  account: Address,
  chainId: number,
  message: string | { raw: Hex },
  verifierDomain: VerifierDomain = accountDomain(account, chainId),
): Promise<Hex> {
  const hash = hash7739Message({ message, verifierDomain });
  return serializeSignature(await sign({ hash, privateKey }));
}

/** ERC-7739 TypedDataSign: the hot key signs the nested hash; the signature is wrapped with the app's domain/contents. */
export async function signTyped7739(
  privateKey: Hex,
  account: Address,
  chainId: number,
  typed: TypedDataDefinition,
  verifierDomain: VerifierDomain = accountDomain(account, chainId),
): Promise<Hex> {
  const { domain, types, primaryType, message } = typed as unknown as {
    domain: Record<string, unknown>;
    types: Record<string, Array<{ name: string; type: string }>>;
    primaryType: string;
    message: Record<string, unknown>;
  };
  const cleanTypes = Object.fromEntries(Object.entries(types).filter(([k]) => k !== "EIP712Domain"));
  const hash = hash7739TypedData({
    domain,
    types: cleanTypes,
    primaryType,
    message,
    verifierDomain,
  } as never);
  const signature = serializeSignature(await sign({ hash, privateKey }));
  return wrapTypedDataSignature({ domain, types: cleanTypes, primaryType, message, signature } as never);
}

/** `REGISTERED_MARKER ‖ hash` (LeakedAccountImpl): what the account accepts for a hash a hot batch registered. */
export const REGISTERED_MARKER: Hex = "0xdc6b87c9";
export const registeredMarker = (digest: Hex): Hex => concatHex([REGISTERED_MARKER, digest]);

/** The EIP-712 digest of a typed-data request (what a token's `permit` asks `isValidSignature` about). */
export function typedDigest(typed: unknown): Hex {
  const t = typed as TypedDataDefinition & { types: Record<string, unknown> };
  const types = Object.fromEntries(Object.entries(t.types).filter(([k]) => k !== "EIP712Domain"));
  return hashTypedData({ ...t, types } as never);
}

export interface SiweFields {
  domain: string;
  address?: string;
  statement?: string;
  uri?: string;
  chainId?: number;
  nonce?: string;
  issuedAt?: string;
  expirationTime?: string;
}

/** The EIP-4361 fields the approval screen shows and the domain check uses (lenient: unknown lines are ignored). */
export function parseSiwe(text: string): SiweFields | undefined {
  const lines = text.split("\n");
  const m = /^(\S+) wants you to sign in with your Ethereum account:$/u.exec(lines[0] ?? "");
  if (!m) return undefined;
  const out: SiweFields = { domain: m[1]! };
  if (lines[1] && /^0x[0-9a-fA-F]{40}$/u.test(lines[1].trim())) out.address = lines[1].trim();
  // The statement is the paragraph between the blank lines after the address.
  if (lines[2] === "" && lines[3] && !/^[A-Z][A-Za-z ]+: /u.test(lines[3])) out.statement = lines[3];
  for (const l of lines) {
    const kv = /^([A-Za-z ]+): (.*)$/u.exec(l);
    if (!kv) continue;
    const [, k, v] = kv;
    if (k === "URI") out.uri = v!;
    else if (k === "Chain ID") out.chainId = Number(v);
    else if (k === "Nonce") out.nonce = v!;
    else if (k === "Issued At") out.issuedAt = v!;
    else if (k === "Expiration Time") out.expirationTime = v!;
  }
  return out;
}

/**
 * SIWE `domain` must be the requesting origin's host (EIP-4361 §"Security considerations", plan §30 §9.1). A message
 * that names another site is a phishing attempt (ux-spec E-50) and is never signed.
 */
export function siweDomainMatches(domain: string, origin: string): boolean {
  try {
    const u = new URL(origin);
    return domain.toLowerCase() === u.host.toLowerCase();
  } catch {
    return false;
  }
}
