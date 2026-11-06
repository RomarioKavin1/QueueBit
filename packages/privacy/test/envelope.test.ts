import { describe, expect, it } from "vitest";
import {
  concat,
  hashTypedData,
  hexToBigInt,
  hexToString,
  keccak256,
  numberToHex,
  slice,
  stringToHex,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodeSignRequest } from "@leaked/ur";
import {
  EncryptedStorage,
  EnvelopeSignatureError,
  NOTE_DOMAIN_SALT,
  NonDeterministicSignerError,
  QrEnvelopeSigner,
  StorageLockedError,
  acceptNoteSignature,
  buildNoteEnvelope,
  canonicalRS,
  createNoteSignRequest,
  createSignatureSecretManager,
  deriveNoteSecrets,
  importStorageKey,
  memoryBackend,
  noteEnvelopeDigest,
  type EnvelopeSigner,
} from "../src/index.js";
import { SECP256K1_N as SECP256K1_N_FOR_TEST } from "../src/envelope/envelope.js";
import { CHAIN, ENTRYPOINT, PAYER_KEY, softwareSigner, vaultDevice } from "./helpers.js";

const payer = privateKeyToAccount(PAYER_KEY);
const env = (d = 0, k = 0) =>
  buildNoteEnvelope({ chainId: CHAIN, entrypoint: ENTRYPOINT, depositIndex: d, secretIndex: k });

const flipS = (sig: Hex): Hex => {
  const r = slice(sig, 0, 32);
  const s = hexToBigInt(slice(sig, 32, 64));
  const v = hexToBigInt(slice(sig, 64, 65));
  return concat([
    r,
    numberToHex(SECP256K1_N_FOR_TEST - s, { size: 32 }),
    numberToHex(v === 27n ? 28n : 27n, { size: 1 }),
  ]);
};

describe("note envelope", () => {
  it("is the companion's PrivacyPoolNote typed data (domain, types, salt)", () => {
    const e = env(3, 1);
    expect(e.domain).toEqual({
      name: "PrivacyPools Keychain",
      version: "1",
      chainId: 1337,
      verifyingContract: ENTRYPOINT,
      salt: keccak256(stringToHex("privacypools")),
    });
    expect(NOTE_DOMAIN_SALT).toBe(e.domain.salt);
    expect(e.types.PrivacyPoolNote).toEqual([
      { name: "depositIndex", type: "uint64" },
      { name: "secretIndex", type: "uint64" },
    ]);
    expect(noteEnvelopeDigest(e)).toBe(hashTypedData(e));
    expect(() =>
      buildNoteEnvelope({ chainId: CHAIN, entrypoint: ENTRYPOINT, depositIndex: -1, secretIndex: 0 }),
    ).toThrow();
    expect(() =>
      buildNoteEnvelope({ chainId: CHAIN, entrypoint: ENTRYPOINT, depositIndex: 2n ** 64n, secretIndex: 0 }),
    ).toThrow();
  });

  it("same (r, s) → identical notes: software signer, vault-over-QR, high-s, v encodings, ERC-2098 compact", async () => {
    const sw = await payer.signTypedData(env(0, 0));
    const pending = createNoteSignRequest(env(0, 0), { payer: payer.address });
    const viaQr = await acceptNoteSignature(pending, await vaultDevice(pending));
    expect(viaQr).toBe(sw); // RFC 6979: the vault and viem produce the same signature
    const base = deriveNoteSecrets(sw);
    const highS = flipS(sw);
    expect(hexToBigInt(slice(highS, 32, 64)) > SECP256K1_N_FOR_TEST / 2n).toBe(true);
    const v01 = concat([slice(sw, 0, 64), numberToHex(hexToBigInt(slice(sw, 64, 65)) - 27n, { size: 1 })]);
    const yParity = hexToBigInt(slice(sw, 64, 65)) - 27n;
    const compact = concat([
      slice(sw, 0, 32),
      numberToHex(hexToBigInt(slice(sw, 32, 64)) | (yParity << 255n), { size: 32 }),
    ]);
    for (const variant of [viaQr, highS, v01, compact]) expect(deriveNoteSecrets(variant)).toEqual(base);
    expect(canonicalRS(highS)).toEqual(canonicalRS(sw));
  });

  it("canonical low-s rule: s is reduced to the lower half, out-of-range r/s rejected", () => {
    const r = numberToHex(5n, { size: 32 });
    const lowS = 7n;
    const a = concat([r, numberToHex(lowS, { size: 32 }), "0x1b"]);
    const b = concat([r, numberToHex(SECP256K1_N_FOR_TEST - lowS, { size: 32 }), "0x1c"]);
    expect(canonicalRS(a)).toEqual(canonicalRS(b));
    expect(toHex(canonicalRS(b).subarray(32))).toBe(numberToHex(lowS, { size: 32 }));
    expect(() => canonicalRS(concat([r, numberToHex(0n, { size: 32 }), "0x1b"]))).toThrow();
    expect(() =>
      canonicalRS(concat([numberToHex(SECP256K1_N_FOR_TEST, { size: 32 }), numberToHex(1n, { size: 32 }), "0x1b"])),
    ).toThrow();
    expect(() => canonicalRS("0x1234")).toThrow();
  });

  it("secrets are 31-byte field elements, distinct per tag and per note", async () => {
    const s00 = deriveNoteSecrets(await payer.signTypedData(env(0, 0)));
    const s01 = deriveNoteSecrets(await payer.signTypedData(env(0, 1)));
    expect(s00.nullifier).not.toBe(s00.salt);
    expect(s00.nullifier).not.toBe(s01.nullifier);
    for (const x of [s00.nullifier, s00.salt]) expect(x < 2n ** 248n).toBe(true);
  });
});

describe("vault EnvelopeSigner over QR", () => {
  it("emits a schema-valid ur:leaked-sign-request (tx-type 2, vault role, payer)", () => {
    const req = createNoteSignRequest(env(2, 0), { payer: payer.address, origin: "LEAKED Privacy" });
    const back = decodeSignRequest(req.cbor);
    expect(back).toMatchObject({ txType: 2, role: 1, chainId: 1337n, payer: payer.address.toLowerCase() });
    const json = JSON.parse(hexToString(back.payload));
    expect(Object.keys(json).sort()).toEqual(["domain", "message", "primaryType", "types"]);
    expect(Object.keys(json.domain).sort()).toEqual(["chainId", "name", "salt", "verifyingContract", "version"]);
    expect(json.message).toEqual({ depositIndex: "2", secretIndex: "0" });
    expect(req.ur.nextPart()).toMatch(/^UR:LEAKED-SIGN-REQUEST\//);
  });

  it("rejects a signature by another key, for another request, or without a typed sig", async () => {
    const req = createNoteSignRequest(env(0, 0), { payer: payer.address });
    const other = ("0x" + "42".repeat(32)) as Hex;
    await expect(acceptNoteSignature(req, await vaultDevice(req, other))).rejects.toBeInstanceOf(
      EnvelopeSignatureError,
    );
    const req2 = createNoteSignRequest(env(0, 0), { payer: payer.address });
    await expect(acceptNoteSignature(req2, await vaultDevice(req))).rejects.toThrow(/different request/);
    // A signature over a different envelope (the vault signed note #1 instead of #0).
    const sig1 = await payer.signTypedData(env(1, 0));
    await expect(acceptNoteSignature(req, { requestId: req.request.requestId, typedSig: sig1 })).rejects.toThrow(
      /expected the vault payer/,
    );
  });

  it("QrEnvelopeSigner + secret manager: deterministic check, memo, encrypted cache", async () => {
    let scans = 0;
    const signer = new QrEnvelopeSigner({
      payer: payer.address,
      exchange: async (r) => (scans++, vaultDevice(r)),
    });
    const cache = new EncryptedStorage({
      backend: memoryBackend(),
      namespace: "pp:",
      key: await importStorageKey(new Uint8Array(32).fill(9)),
    });
    const sm = createSignatureSecretManager({ signer, chainId: CHAIN, entrypoint: ENTRYPOINT, cache });
    const d0 = await sm.getDepositSecrets(0);
    expect(scans).toBe(2); // the first envelope twice (determinism)
    expect(await sm.getDepositSecrets(0)).toEqual(d0);
    expect(scans).toBe(2);
    expect(d0).toEqual(deriveNoteSecrets(await payer.signTypedData(env(0, 0))));
    // A new session with the same cache: no scan at all.
    const sm2 = createSignatureSecretManager({ signer, chainId: CHAIN, entrypoint: ENTRYPOINT, cache });
    expect(await sm2.getDepositSecrets(0)).toEqual(d0);
    expect(scans).toBe(2);
    await expect(sm.getSecrets(0, 0)).rejects.toThrow(/start at 1/);
    expect(await sm.senderKey(0, 1)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("locking the encrypted cache makes the secret manager forget its in-memory signatures", async () => {
    let scans = 0;
    const signer: EnvelopeSigner = { signEnvelope: async (e) => (scans++, softwareSigner().signEnvelope(e)) };
    const key = await importStorageKey(new Uint8Array(32).fill(7));
    const cache = new EncryptedStorage({ backend: memoryBackend(), namespace: "pp:", key });
    const sm = createSignatureSecretManager({ signer, chainId: CHAIN, entrypoint: ENTRYPOINT, cache });
    await sm.getDepositSecrets(0);
    expect(scans).toBe(2);
    cache.lock();
    // The memo is gone: the next derivation reads the (now locked) cache and fails closed instead of answering from memory.
    await expect(sm.getDepositSecrets(0)).rejects.toBeInstanceOf(StorageLockedError);
    cache.unlock(key);
    await sm.getDepositSecrets(0);
    expect(scans).toBe(2); // from the encrypted cache: no new vault scan, and the determinism check is not redone
  });

  it("refuses a non-deterministic signer (secrets could never be re-derived)", async () => {
    let n = 0;
    const sm = createSignatureSecretManager({
      signer: {
        signEnvelope: async (e) =>
          privateKeyToAccount(PAYER_KEY).signTypedData({ ...e, message: { ...e.message, secretIndex: BigInt(n++) } }),
      },
      chainId: CHAIN,
      entrypoint: ENTRYPOINT,
    });
    await expect(sm.getDepositSecrets(0)).rejects.toBeInstanceOf(NonDeterministicSignerError);
    const ok = softwareSigner();
    const sm2 = createSignatureSecretManager({
      signer: ok,
      chainId: CHAIN,
      entrypoint: ENTRYPOINT,
      verifyDeterminism: false,
    });
    await sm2.getDepositSecrets(0);
    expect(ok.calls).toBe(1);
  });
});
