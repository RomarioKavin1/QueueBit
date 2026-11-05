import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  MapReader,
  UrSchemaError,
  cborUint,
  decodeCbor,
  encodeCbor,
  equalBytes,
  fromHex,
  toHex,
  uuidTag,
  uuidToBytes,
  type CborValue,
  type Hex,
} from "./cbor.js";

/**
 * The LEAKED UR vocabulary (plan `20-pq-crypto-vault.md` §4.2, keys 10–11 from `30-extension.md` §6.1; the additions
 * here are recorded in `docs/plan/IMPLEMENTATION-NOTES.md`). Every payload is a CBOR map with integer keys, encoded
 * deterministically; decoders reject unknown keys, wrong types, wrong sizes and non-canonical bytes.
 */

export const UR_TYPES = {
  signRequest: "leaked-sign-request",
  signature: "leaked-signature",
  pqKey: "leaked-pq-key",
  recoveryTest: "leaked-recovery-test",
} as const;
export type UrType = (typeof UR_TYPES)[keyof typeof UR_TYPES];

/** `tx-type` (key 3). */
export const TX_TYPE = {
  /** ERC-4337 PackedUserOperation (pre-Hegotá backend B). Defined, not yet signed by the companion. */
  userOp4337: 1,
  /** EIP-712 typed data (as ERC-4527 data-type 2): the Privacy Pools `PrivacyPoolNote` envelope, signed by the payer key. */
  typedData: 2,
  /** EIP-8141 frame transaction. */
  frameTx: 6,
} as const;
export type TxType = (typeof TX_TYPE)[keyof typeof TX_TYPE];

/** `role` (key 5). */
export const ROLE = { vault: 1, recovery: 2, guardian: 3 } as const;
export type RoleId = (typeof ROLE)[keyof typeof ROLE];

/** keccak256("SPHINCS-C13/keccak/fips-adrs/v1"), `IPQVerifier.schemeId()` of the C13 adapter. */
export const C13_SCHEME_ID: Hex = "0xb2062c48f163f38edbf050c4a98b6abbe194acda9a6de525b69b330a739aa054";
/** Fixed witness lengths per known scheme; a witness for a listed scheme must have exactly this length. */
export const KNOWN_SIG_LENGTHS: Readonly<Record<string, number>> = { [C13_SCHEME_ID]: 3688 };

export const MAX_UNSIGNED_PAYLOAD = 64 * 1024;
export const MAX_WITNESS = 32 * 1024;
const PROFILE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------------------------------------------
// ur:leaked-sign-request
// ---------------------------------------------------------------------------------------------------------------

/**
 * Key 11: what the browser *claims* the request does. Advisory only: the companion never displays it, it only
 * compares it with its own decoding and warns on a mismatch (ux-spec §4.4 rule 5).
 */
export interface AdvisoryIntent {
  /** 1: an action id from the descriptor registry, e.g. `send`, `vaultSetCap`. */
  action?: string;
  /** 2: the browser's one-line description. Never rendered by the companion. */
  summary?: string;
  /** 3: ERC-7730 descriptor reference the browser used. */
  erc7730Ref?: string;
  /** 4: the main recipient. */
  recipient?: Hex;
  /** 5: the main amount, in the token's base units. */
  amount?: bigint;
  /** 6: the token moved; the zero address for ETH. */
  token?: Hex;
}

export interface AdvisoryTokenPrice {
  /** 1: token address; the zero address for ETH. */
  token: Hex;
  /** 2: decimals, as the Vault set them (`vaultSetToken`). */
  decimals: number;
  /** 3: `usdPerToken`: 6-decimal USD per one whole token, as `vaultSetToken` / `TokenConfigured` (ILeakedAccount.TokenCfg). */
  usdPerToken: bigint;
}

/**
 * Key 12 (LEAKED addition): the account state the browser reads from chain and the companion has no other way to
 * learn: the Vault-pinned token prices (`TokenConfigured`) and the current limits. Advisory: used for USD estimates
 * and the "from → to" of a limit change, always labelled as coming from the browser, and cross-checked against the
 * phone's own snapshot of what it last signed (ux-spec E-74).
 */
export interface AdvisoryPolicy {
  /** 1: the LEAKED account these values belong to. */
  account?: Hex;
  /** 2: `capUsdPerDay`, 6-decimal USD. */
  capUsdPerDay?: bigint;
  /** 3: `perTxMaxUsd`, 6-decimal USD. */
  perTxMaxUsd?: bigint;
  /** 4: `timelockDelay`, seconds. */
  timelockDelay?: bigint;
  /** 5: `timelockThresholdUsd`, 6-decimal USD. */
  timelockThresholdUsd?: bigint;
  /** 6: pinned token prices. */
  tokens?: AdvisoryTokenPrice[];
  /** 7: `maxFeeWeiPerTx`, wei. */
  maxFeeWeiPerTx?: bigint;
  /** 8: `maxHotFrames`. */
  maxHotFrames?: number;
}

export interface SignRequest {
  /** 1 */
  requestId: string;
  /** 2 */
  chainId: bigint;
  /** 3 */
  txType: TxType;
  /**
   * 4: tx-type 6: the frame tx in `@leaked/frames` wire form (`encodeTx`) with every empty-`msg` signature entry
   * holding its placeholder (the PQ entry: `sigLength` zero bytes), i.e. exactly what `sigHash(profile, decodeTx(…))`
   * hashes after elision. tx-type 2: the EIP-712 typed data as UTF-8 JSON (`{types, primaryType, domain, message}`).
   */
  payload: Hex;
  /** 5 */
  role: RoleId;
  /** 6: tx-types 1 and 6. */
  schemeId?: Hex;
  /** 7: tx-types 1 and 6: which `tx.signatures` entry the witness fills. */
  sigIndex?: number;
  /** 8: tx-types 1 and 6: the role signer's immutable `pk()`. */
  expectedPk?: Hex;
  /** 9: the dapp or page that asked, as the browser saw it. */
  origin?: string;
  /** 10: tx-type 6: the `@leaked/frames` profile that encoded key 4. */
  profileId?: string;
  /** 11 */
  intent?: AdvisoryIntent;
  /** 12 */
  policy?: AdvisoryPolicy;
  /** 13 (LEAKED addition): tx-type 2: the payer address the request expects to sign. */
  payer?: Hex;
}

const SIGN_REQUEST_KEYS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13] as const;
const INTENT_KEYS = [1, 2, 3, 4, 5, 6] as const;
const POLICY_KEYS = [1, 2, 3, 4, 5, 6, 7, 8] as const;
const PRICE_KEYS = [1, 2, 3] as const;

function bytesN(h: Hex | undefined, n: number, what: string): Uint8Array | undefined {
  if (h === undefined) return undefined;
  const b = fromHex(h, what);
  if (b.length !== n) throw new UrSchemaError(`expected ${n} bytes, got ${b.length}`, what);
  return b;
}

function put(m: Map<number, unknown>, k: number, v: unknown): void {
  if (v !== undefined) m.set(k, v);
}

function checkRequestShape(r: SignRequest): void {
  const path = UR_TYPES.signRequest;
  const has = (k: keyof SignRequest) => r[k] !== undefined;
  if (r.txType === TX_TYPE.frameTx || r.txType === TX_TYPE.userOp4337) {
    for (const [k, n] of [
      ["schemeId", 6],
      ["sigIndex", 7],
      ["expectedPk", 8],
    ] as const) {
      if (!has(k)) throw new UrSchemaError(`required for tx-type ${r.txType}`, `${path}.${n}`);
    }
    if (r.txType === TX_TYPE.frameTx && !has("profileId")) {
      throw new UrSchemaError("required for tx-type 6", `${path}.10`);
    }
    if (has("payer")) throw new UrSchemaError("only allowed for tx-type 2", `${path}.13`);
  } else if (r.txType === TX_TYPE.typedData) {
    if (!has("payer")) throw new UrSchemaError("required for tx-type 2", `${path}.13`);
    for (const [k, n] of [
      ["schemeId", 6],
      ["sigIndex", 7],
      ["expectedPk", 8],
      ["profileId", 10],
    ] as const) {
      if (has(k)) throw new UrSchemaError("not allowed for tx-type 2", `${path}.${n}`);
    }
    if (r.role !== ROLE.vault)
      throw new UrSchemaError("typed data is signed by the Vault's payer key only", `${path}.5`);
  } else {
    throw new UrSchemaError(`unknown tx-type ${String(r.txType)}`, `${path}.3`);
  }
  if (r.sigIndex !== undefined && (!Number.isInteger(r.sigIndex) || r.sigIndex < 0 || r.sigIndex > 63)) {
    throw new UrSchemaError("must be 0..63", `${path}.7`);
  }
  if (r.chainId <= 0n) throw new UrSchemaError("must be positive", `${path}.2`);
  if (![ROLE.vault, ROLE.recovery, ROLE.guardian].includes(r.role))
    throw new UrSchemaError("unknown role", `${path}.5`);
}

export function encodeSignRequest(r: SignRequest): Uint8Array {
  checkRequestShape(r);
  const payload = fromHex(r.payload, "payload");
  if (payload.length === 0 || payload.length > MAX_UNSIGNED_PAYLOAD) {
    throw new UrSchemaError(`must be 1..${MAX_UNSIGNED_PAYLOAD} bytes`, `${UR_TYPES.signRequest}.4`);
  }
  const m = new Map<number, unknown>();
  m.set(1, uuidTag(r.requestId));
  m.set(2, cborUint(r.chainId));
  m.set(3, r.txType);
  m.set(4, payload);
  m.set(5, r.role);
  put(m, 6, bytesN(r.schemeId, 32, "scheme-id"));
  put(m, 7, r.sigIndex);
  put(m, 8, bytesN(r.expectedPk, 32, "expected-pk"));
  put(m, 9, r.origin);
  put(m, 10, r.profileId);
  if (r.intent) {
    const i = new Map<number, unknown>();
    put(i, 1, r.intent.action);
    put(i, 2, r.intent.summary);
    put(i, 3, r.intent.erc7730Ref);
    put(i, 4, bytesN(r.intent.recipient, 20, "intent.recipient"));
    put(i, 5, r.intent.amount === undefined ? undefined : cborUint(r.intent.amount));
    put(i, 6, bytesN(r.intent.token, 20, "intent.token"));
    m.set(11, i);
  }
  if (r.policy) {
    const p = new Map<number, unknown>();
    put(p, 1, bytesN(r.policy.account, 20, "policy.account"));
    put(p, 2, r.policy.capUsdPerDay === undefined ? undefined : cborUint(r.policy.capUsdPerDay));
    put(p, 3, r.policy.perTxMaxUsd === undefined ? undefined : cborUint(r.policy.perTxMaxUsd));
    put(p, 4, r.policy.timelockDelay === undefined ? undefined : cborUint(r.policy.timelockDelay));
    put(p, 5, r.policy.timelockThresholdUsd === undefined ? undefined : cborUint(r.policy.timelockThresholdUsd));
    if (r.policy.tokens) {
      p.set(
        6,
        r.policy.tokens.map((t) => {
          const e = new Map<number, unknown>();
          e.set(1, bytesN(t.token, 20, "policy.tokens.token"));
          e.set(2, t.decimals);
          e.set(3, cborUint(t.usdPerToken));
          return e;
        }),
      );
    }
    put(p, 7, r.policy.maxFeeWeiPerTx === undefined ? undefined : cborUint(r.policy.maxFeeWeiPerTx));
    put(p, 8, r.policy.maxHotFrames);
    m.set(12, p);
  }
  put(m, 13, bytesN(r.payer, 20, "payer"));
  const bytes = encodeCbor(m);
  decodeSignRequest(bytes); // what we emit must pass our own decoder
  return bytes;
}

const lowerAddr = (b: Uint8Array) => toHex(b);

export function decodeSignRequest(cbor: Uint8Array): SignRequest {
  const path = UR_TYPES.signRequest;
  const r = MapReader.of(decodeCbor(cbor, path), path, SIGN_REQUEST_KEYS);
  const txType = r.smallUint(3, true, 255) as TxType;
  const out: SignRequest = {
    requestId: r.uuid(1, true),
    chainId: r.uint(2, true, (1n << 64n) - 1n),
    txType,
    payload: toHex(r.bytes(4, true, { max: MAX_UNSIGNED_PAYLOAD })),
    role: r.smallUint(5, true, 255) as RoleId,
  };
  if (out.payload === "0x") throw new UrSchemaError("empty", `${path}.4`);
  const schemeId = r.bytes(6, false, { size: 32 });
  if (schemeId) out.schemeId = toHex(schemeId);
  const sigIndex = r.smallUint(7, false, 63);
  if (sigIndex !== undefined) out.sigIndex = sigIndex;
  const pk = r.bytes(8, false, { size: 32 });
  if (pk) out.expectedPk = toHex(pk);
  const origin = r.text(9, false, { max: 256 });
  if (origin !== undefined) out.origin = origin;
  const profileId = r.text(10, false, { max: 64, pattern: PROFILE_RE });
  if (profileId !== undefined) out.profileId = profileId;

  const ir = r.map(11, false, INTENT_KEYS);
  if (ir) {
    const intent: AdvisoryIntent = {};
    const action = ir.text(1, false, { max: 64, pattern: /^[A-Za-z0-9._:-]+$/ });
    if (action !== undefined) intent.action = action;
    const summary = ir.text(2, false, { max: 512 });
    if (summary !== undefined) intent.summary = summary;
    const ref = ir.text(3, false, { max: 256 });
    if (ref !== undefined) intent.erc7730Ref = ref;
    const rec = ir.bytes(4, false, { size: 20 });
    if (rec) intent.recipient = lowerAddr(rec);
    const amount = ir.uint(5, false);
    if (amount !== undefined) intent.amount = amount;
    const token = ir.bytes(6, false, { size: 20 });
    if (token) intent.token = lowerAddr(token);
    ir.done();
    out.intent = intent;
  }

  const pr = r.map(12, false, POLICY_KEYS);
  if (pr) {
    const policy: AdvisoryPolicy = {};
    const acct = pr.bytes(1, false, { size: 20 });
    if (acct) policy.account = lowerAddr(acct);
    const usd = (k: number) => pr.uint(k, false, (1n << 128n) - 1n);
    const cap = usd(2);
    if (cap !== undefined) policy.capUsdPerDay = cap;
    const perTx = usd(3);
    if (perTx !== undefined) policy.perTxMaxUsd = perTx;
    const delay = pr.uint(4, false, (1n << 48n) - 1n);
    if (delay !== undefined) policy.timelockDelay = delay;
    const thr = usd(5);
    if (thr !== undefined) policy.timelockThresholdUsd = thr;
    const tokens = pr.array(6, false, 64);
    if (tokens) {
      const list = tokens.map(({ value, path: p }: { value: CborValue; path: string }) => {
        const t = MapReader.of(value, p, PRICE_KEYS);
        const e: AdvisoryTokenPrice = {
          token: lowerAddr(t.bytes(1, true, { size: 20 })),
          decimals: t.smallUint(2, true, 36),
          usdPerToken: t.uint(3, true, (1n << 128n) - 1n),
        };
        t.done();
        return e;
      });
      policy.tokens = list;
      const seen = new Set(list.map((t) => t.token));
      if (seen.size !== list.length) throw new UrSchemaError("duplicate token", `${path}.12.6`);
    }
    const maxFee = pr.uint(7, false, (1n << 128n) - 1n);
    if (maxFee !== undefined) policy.maxFeeWeiPerTx = maxFee;
    const frames = pr.smallUint(8, false, 255);
    if (frames !== undefined) policy.maxHotFrames = frames;
    pr.done();
    out.policy = policy;
  }

  const payer = r.bytes(13, false, { size: 20 });
  if (payer) out.payer = lowerAddr(payer);
  r.done();
  checkRequestShape(out);
  if (txType === TX_TYPE.typedData) {
    // Must at least be well-formed UTF-8 JSON; the companion validates the schema itself.
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fromHex(out.payload)));
    } catch {
      throw new UrSchemaError("tx-type 2 payload must be UTF-8 JSON", `${path}.4`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ur:leaked-signature
// ---------------------------------------------------------------------------------------------------------------

export interface SignatureResponse {
  /** 1: echoes the request. */
  requestId: string;
  /** 2: present with a witness. */
  schemeId?: Hex;
  /** 3: the PQ witness (3,688 bytes for C13) for `tx.signatures[sigIndex]`. */
  witness?: Hex;
  /**
   * 4: Path B: the payer key's secp256k1 signature over the same sig hash, in `@leaked/frames` entry form
   * `v ‖ r ‖ s` (65 bytes, v ∈ {0, 1}, low s): drop it into the payer's SECP256K1 entry with `setSignature`.
   */
  payerSig?: Hex;
  /** 5 (LEAKED addition): tx-type 2: the EIP-712 signature `r ‖ s ‖ v` (65 bytes, v ∈ {27, 28}, low s, RFC 6979). */
  typedSig?: Hex;
}

const SIGNATURE_KEYS = [1, 2, 3, 4, 5] as const;
const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

function checkSecp(sig: Uint8Array, form: "vrs" | "rsv", where: string): void {
  if (sig.length !== 65) throw new UrSchemaError("expected 65 bytes", where);
  const v = form === "vrs" ? sig[0]! : sig[64]!;
  const rs = form === "vrs" ? sig.subarray(1) : sig.subarray(0, 64);
  const r = BigInt(toHex(rs.subarray(0, 32)));
  const s = BigInt(toHex(rs.subarray(32, 64)));
  const okV = form === "vrs" ? v === 0 || v === 1 : v === 27 || v === 28;
  if (!okV || r === 0n || r >= SECP256K1_N || s === 0n || s > SECP256K1_N / 2n) {
    throw new UrSchemaError("not a canonical low-s secp256k1 signature", where);
  }
}

function checkSignatureShape(s: SignatureResponse): void {
  const path = UR_TYPES.signature;
  if (s.witness === undefined && s.typedSig === undefined)
    throw new UrSchemaError("needs a witness (3) or a typed-data signature (5)", path);
  if (s.witness !== undefined && s.schemeId === undefined)
    throw new UrSchemaError("required with a witness", `${path}.2`);
  if (s.witness === undefined && s.schemeId !== undefined)
    throw new UrSchemaError("only allowed with a witness", `${path}.2`);
  if (s.payerSig !== undefined && s.witness === undefined)
    throw new UrSchemaError("only allowed with a witness", `${path}.4`);
  if (s.typedSig !== undefined && s.witness !== undefined)
    throw new UrSchemaError("a typed-data response carries no witness", `${path}.5`);
  if (s.witness !== undefined && s.schemeId !== undefined) {
    const len = (s.witness.length - 2) / 2;
    const want = KNOWN_SIG_LENGTHS[s.schemeId];
    if (want !== undefined && len !== want)
      throw new UrSchemaError(`expected ${want} bytes for this scheme, got ${len}`, `${path}.3`);
    if (len === 0 || len > MAX_WITNESS) throw new UrSchemaError(`must be 1..${MAX_WITNESS} bytes`, `${path}.3`);
  }
  if (s.payerSig !== undefined) checkSecp(fromHex(s.payerSig), "vrs", `${path}.4`);
  if (s.typedSig !== undefined) checkSecp(fromHex(s.typedSig), "rsv", `${path}.5`);
}

export function encodeSignature(s: SignatureResponse): Uint8Array {
  checkSignatureShape(s);
  const m = new Map<number, unknown>();
  m.set(1, uuidTag(s.requestId));
  put(m, 2, bytesN(s.schemeId, 32, "scheme-id"));
  put(m, 3, s.witness === undefined ? undefined : fromHex(s.witness, "witness"));
  put(m, 4, bytesN(s.payerSig, 65, "payer-sig"));
  put(m, 5, bytesN(s.typedSig, 65, "typed-sig"));
  const bytes = encodeCbor(m);
  decodeSignature(bytes);
  return bytes;
}

export function decodeSignature(cbor: Uint8Array): SignatureResponse {
  const path = UR_TYPES.signature;
  const r = MapReader.of(decodeCbor(cbor, path), path, SIGNATURE_KEYS);
  const out: SignatureResponse = { requestId: r.uuid(1, true) };
  const scheme = r.bytes(2, false, { size: 32 });
  if (scheme) out.schemeId = toHex(scheme);
  const witness = r.bytes(3, false, { max: MAX_WITNESS });
  if (witness) out.witness = toHex(witness);
  const payer = r.bytes(4, false, { size: 65 });
  if (payer) out.payerSig = toHex(payer);
  const typed = r.bytes(5, false, { size: 65 });
  if (typed) out.typedSig = toHex(typed);
  r.done();
  checkSignatureShape(out);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ur:leaked-pq-key (pairing: the public key a role device shows the browser)
// ---------------------------------------------------------------------------------------------------------------

export interface PqKeyAnnouncement {
  /** 1 */
  schemeId: Hex;
  /** 2: `pkSeed ‖ pkRoot`, the role signer's `pk()`. */
  pk: Hex;
  /** 3: 1 vault, 2 recovery. */
  role: typeof ROLE.vault | typeof ROLE.recovery;
  /** 4: vault only: the Path-B payer address (BIP-32 `m/44'/60'/8141'/0/0` of the same mnemonic). */
  payer?: Hex;
}

const PQ_KEY_KEYS = [1, 2, 3, 4] as const;

export function encodePqKey(k: PqKeyAnnouncement): Uint8Array {
  const m = new Map<number, unknown>();
  m.set(1, bytesN(k.schemeId, 32, "scheme-id"));
  m.set(2, bytesN(k.pk, 32, "pk"));
  m.set(3, k.role);
  put(m, 4, bytesN(k.payer, 20, "payer"));
  const bytes = encodeCbor(m);
  decodePqKey(bytes);
  return bytes;
}

export function decodePqKey(cbor: Uint8Array): PqKeyAnnouncement {
  const path = UR_TYPES.pqKey;
  const r = MapReader.of(decodeCbor(cbor, path), path, PQ_KEY_KEYS);
  const role = r.smallUint(3, true, 255);
  if (role !== ROLE.vault && role !== ROLE.recovery)
    throw new UrSchemaError("must be 1 (vault) or 2 (recovery)", `${path}.3`);
  const out: PqKeyAnnouncement = {
    schemeId: toHex(r.bytes(1, true, { size: 32 })),
    pk: toHex(r.bytes(2, true, { size: 32 })),
    role,
  };
  const payer = r.bytes(4, false, { size: 20 });
  if (payer) out.payer = toHex(payer);
  if (payer && role !== ROLE.vault) throw new UrSchemaError("only the Vault has a payer key", `${path}.4`);
  r.done();
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// ur:leaked-recovery-test (the end of the recovery setup: the phone proves the written-down key signs)
// ---------------------------------------------------------------------------------------------------------------

export interface RecoveryTest {
  /** 1: fresh per test, chosen by the phone; part of the challenge. */
  requestId: string;
  /** 2 */
  schemeId: Hex;
  /** 3: the Recovery key's `pk`. */
  recoveryPk: Hex;
  /** 4: signature over `recoveryTestChallenge(…)`. */
  witness: Hex;
  /** 5: always true; the phone only emits a test after the word check passed. */
  ok: true;
}

const RECOVERY_TEST_KEYS = [1, 2, 3, 4, 5] as const;
const RECOVERY_TEST_DOMAIN = new TextEncoder().encode("LEAKED recovery test v1");

/**
 * The digest a Recovery key signs to prove a test restore: `keccak256("LEAKED recovery test v1" ‖ schemeId ‖ pk ‖
 * requestId)`. Domain-separated so it can never be a frame transaction's sig hash (those are keccak of a `0x06`-led
 * RLP payload, which this 87-byte preimage is not).
 */
export function recoveryTestChallenge(schemeId: Hex, recoveryPk: Hex, requestId: string): Hex {
  const s = bytesN(schemeId, 32, "scheme-id")!;
  const p = bytesN(recoveryPk, 32, "recovery-pk")!;
  const id = uuidToBytes(requestId);
  const pre = new Uint8Array(RECOVERY_TEST_DOMAIN.length + 80);
  pre.set(RECOVERY_TEST_DOMAIN, 0);
  pre.set(s, RECOVERY_TEST_DOMAIN.length);
  pre.set(p, RECOVERY_TEST_DOMAIN.length + 32);
  pre.set(id, RECOVERY_TEST_DOMAIN.length + 64);
  return toHex(keccak_256(pre));
}

export function encodeRecoveryTest(t: RecoveryTest): Uint8Array {
  if (t.ok !== true) throw new UrSchemaError("must be true", `${UR_TYPES.recoveryTest}.5`);
  const m = new Map<number, unknown>();
  m.set(1, uuidTag(t.requestId));
  m.set(2, bytesN(t.schemeId, 32, "scheme-id"));
  m.set(3, bytesN(t.recoveryPk, 32, "recovery-pk"));
  m.set(4, fromHex(t.witness, "witness"));
  m.set(5, true);
  const bytes = encodeCbor(m);
  decodeRecoveryTest(bytes);
  return bytes;
}

export function decodeRecoveryTest(cbor: Uint8Array): RecoveryTest {
  const path = UR_TYPES.recoveryTest;
  const r = MapReader.of(decodeCbor(cbor, path), path, RECOVERY_TEST_KEYS);
  const out: RecoveryTest = {
    requestId: r.uuid(1, true),
    schemeId: toHex(r.bytes(2, true, { size: 32 })),
    recoveryPk: toHex(r.bytes(3, true, { size: 32 })),
    witness: toHex(r.bytes(4, true, { max: MAX_WITNESS })),
    ok: true,
  };
  if (r.bool(5, true) !== true) throw new UrSchemaError("must be true", `${path}.5`);
  r.done();
  const want = KNOWN_SIG_LENGTHS[out.schemeId];
  const len = (out.witness.length - 2) / 2;
  if (want !== undefined && len !== want) throw new UrSchemaError(`expected ${want} bytes, got ${len}`, `${path}.4`);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

export type DecodedUr =
  | { type: typeof UR_TYPES.signRequest; value: SignRequest }
  | { type: typeof UR_TYPES.signature; value: SignatureResponse }
  | { type: typeof UR_TYPES.pqKey; value: PqKeyAnnouncement }
  | { type: typeof UR_TYPES.recoveryTest; value: RecoveryTest };

/** Decodes a complete payload by UR type. Throws `UrSchemaError` for an unknown type or a bad payload. */
export function decodeByType(type: string, cbor: Uint8Array): DecodedUr {
  switch (type) {
    case UR_TYPES.signRequest:
      return { type, value: decodeSignRequest(cbor) };
    case UR_TYPES.signature:
      return { type, value: decodeSignature(cbor) };
    case UR_TYPES.pqKey:
      return { type, value: decodePqKey(cbor) };
    case UR_TYPES.recoveryTest:
      return { type, value: decodeRecoveryTest(cbor) };
    default:
      throw new UrSchemaError(`unknown UR type "${type}"`);
  }
}

export type { CborValue };
export { equalBytes };
