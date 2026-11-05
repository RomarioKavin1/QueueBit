import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SCRYPT,
  DecryptionError,
  aadFor,
  decryptWithKey,
  decryptWithPassword,
  encryptWithPassword,
  type EncryptedBlob,
} from "../../src/background/encryption";
import { KeyringController, KeyringError, deriveAccounts, type SessionRecord } from "../../src/background/keyring";
import { MemoryKV, StorageKeys } from "../../src/shared/kv";

// Fast KDF for tests; the production parameters are asserted separately below.
const FAST = { N: 2 ** 10, r: 8, p: 1 };
// BIP-39 test vector mnemonic (Hardhat/Anvil's default): its first account at m/44'/60'/0'/0/0 is well known.
const TEST_MNEMONIC = "test test test test test test test test test test test junk";
const enc = new TextEncoder();

function flipHex(hex: string, at = 0): string {
  const b = hexToBytes(hex);
  b[at] = b[at]! ^ 0x01;
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

describe("encryption (scrypt → AES-256-GCM)", () => {
  it("uses the plan's scrypt parameters by default", () => {
    expect(DEFAULT_SCRYPT).toEqual({ N: 131072, r: 8, p: 1 });
  });

  it("round-trips and has the plan's blob format", async () => {
    const aad = aadFor("0xAbC0000000000000000000000000000000000001");
    const { blob, dek } = await encryptWithPassword("correct horse", enc.encode("secret"), aad, FAST);
    expect(blob.v).toBe(1);
    expect(blob.kdf).toMatchObject({ name: "scrypt", N: FAST.N, r: 8, p: 1 });
    expect(hexToBytes(blob.kdf.salt)).toHaveLength(32);
    expect(blob.cipher.name).toBe("AES-GCM");
    expect(hexToBytes(blob.cipher.iv)).toHaveLength(12);
    expect(hexToBytes(blob.tag)).toHaveLength(16);
    expect(dek).toHaveLength(32);
    const { plaintext } = await decryptWithPassword("correct horse", blob, aad);
    expect(new TextDecoder().decode(plaintext)).toBe("secret");
    expect(new TextDecoder().decode(await decryptWithKey(dek, blob, aad))).toBe("secret");
  });

  it("uses a fresh salt and IV on every write", async () => {
    const aad = aadFor("0x01");
    const a = await encryptWithPassword("pw-123456", enc.encode("x"), aad, FAST);
    const b = await encryptWithPassword("pw-123456", enc.encode("x"), aad, FAST);
    expect(a.blob.kdf.salt).not.toBe(b.blob.kdf.salt);
    expect(a.blob.cipher.iv).not.toBe(b.blob.cipher.iv);
    expect(a.blob.ct).not.toBe(b.blob.ct);
  });

  it("rejects a wrong password", async () => {
    const aad = aadFor("0x01");
    const { blob } = await encryptWithPassword("right-password", enc.encode("x"), aad, FAST);
    await expect(decryptWithPassword("wrong-password", blob, aad)).rejects.toBeInstanceOf(DecryptionError);
  });

  it.each<[string, (b: EncryptedBlob) => EncryptedBlob]>([
    ["ciphertext", (b) => ({ ...b, ct: flipHex(b.ct) })],
    ["tag", (b) => ({ ...b, tag: flipHex(b.tag, 15) })],
    ["iv", (b) => ({ ...b, cipher: { ...b.cipher, iv: flipHex(b.cipher.iv) } })],
    ["salt", (b) => ({ ...b, kdf: { ...b.kdf, salt: flipHex(b.kdf.salt) } })],
  ])("detects tampering with the %s", async (_, tamper) => {
    const aad = aadFor("0x01");
    const { blob } = await encryptWithPassword("pw-123456", enc.encode("payload"), aad, FAST);
    await expect(decryptWithPassword("pw-123456", tamper(blob), aad)).rejects.toBeInstanceOf(DecryptionError);
  });

  it("binds the blob to its address through the AAD", async () => {
    const { blob } = await encryptWithPassword("pw-123456", enc.encode("x"), aadFor("0x01"), FAST);
    await expect(decryptWithPassword("pw-123456", blob, aadFor("0x02"))).rejects.toBeInstanceOf(DecryptionError);
  });

  it("refuses unknown blob versions", async () => {
    const { blob } = await encryptWithPassword("pw-123456", enc.encode("x"), aadFor("0x01"), FAST);
    await expect(
      decryptWithPassword("pw-123456", { ...blob, v: 2 } as unknown as EncryptedBlob, aadFor("0x01")),
    ).rejects.toThrow("Unsupported keyring format");
  });
});

describe("key derivation", () => {
  it("derives the everyday key at m/44'/60'/0'/0/0 and the fee tank on its own branch", () => {
    const a = deriveAccounts(TEST_MNEMONIC);
    expect(a.everyday).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(a.feeTank).not.toBe(a.everyday);
    expect(a.feeTank).toMatch(/^0x[0-9a-fA-F]{40}$/u);
  });
});

function setup(now = { t: 1_000_000 }) {
  const local = new MemoryKV();
  const session = new MemoryKV();
  const k = new KeyringController(local, session, { scrypt: FAST, now: () => now.t });
  return { local, session, k, now };
}

describe("KeyringController", () => {
  it("creates a 24-word seed, stores only ciphertext, and starts unlocked", async () => {
    const { k, local, session } = setup();
    const { mnemonic, accounts } = await k.create("password-1");
    expect(mnemonic.split(" ")).toHaveLength(24);
    expect(await k.isUnlocked()).toBe(true);
    const stored = JSON.stringify(await local.get(StorageKeys.keyring));
    for (const word of new Set(mnemonic.split(" "))) expect(stored).not.toContain(` ${word} `);
    expect(stored).not.toContain(mnemonic);
    expect(stored).not.toContain("password-1");
    const s = await session.get<SessionRecord>(StorageKeys.session);
    expect(s?.dek).toMatch(/^[0-9a-f]{64}$/u);
    expect(JSON.stringify(s)).not.toContain("password-1");
    expect(accounts).toEqual(deriveAccounts(mnemonic));
    expect(await k.withMnemonic((m) => m)).toBe(mnemonic);
  });

  it("refuses short passwords and a second account", async () => {
    const { k } = setup();
    await expect(k.create("short")).rejects.toMatchObject({ reason: "weak-password" });
    await k.create("password-1");
    await expect(k.create("password-2")).rejects.toMatchObject({ reason: "exists" });
  });

  it("imports a valid mnemonic (normalising whitespace and case) and rejects a bad one", async () => {
    const { k } = setup();
    await expect(k.import("test test test", "password-1")).rejects.toMatchObject({ reason: "bad-mnemonic" });
    const accounts = await k.import(`  ${TEST_MNEMONIC.toUpperCase().replace(/ /gu, "   ")} `, "password-1");
    expect(accounts.everyday).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });

  it("locks and unlocks; a wrong password keeps it locked", async () => {
    const { k } = setup();
    await k.import(TEST_MNEMONIC, "password-1");
    await k.lock();
    expect(await k.isUnlocked()).toBe(false);
    await expect(k.withMnemonic((m) => m)).rejects.toMatchObject({ reason: "locked" });
    await expect(k.unlock("nope-nope")).rejects.toBeInstanceOf(KeyringError);
    expect(await k.isUnlocked()).toBe(false);
    await k.unlock("password-1");
    expect(await k.withMnemonic((m) => m)).toBe(TEST_MNEMONIC);
  });

  it("changes the password: old stops working, new works, secret unchanged", async () => {
    const { k } = setup();
    await k.import(TEST_MNEMONIC, "password-1");
    await expect(k.changePassword("wrong-old", "password-2")).rejects.toMatchObject({ reason: "wrong-password" });
    await expect(k.changePassword("password-1", "short")).rejects.toMatchObject({ reason: "weak-password" });
    await k.changePassword("password-1", "password-2");
    await k.lock();
    await expect(k.unlock("password-1")).rejects.toMatchObject({ reason: "wrong-password" });
    await k.unlock("password-2");
    expect(await k.withMnemonic((m) => m)).toBe(TEST_MNEMONIC);
  });

  it("auto-locks only after the idle time, and activity resets the timer", async () => {
    const { k, now } = setup();
    await k.import(TEST_MNEMONIC, "password-1");
    now.t += 14 * 60_000;
    expect(await k.autoLockIfIdle(15)).toBe(false);
    await k.touch();
    now.t += 14 * 60_000;
    expect(await k.autoLockIfIdle(15)).toBe(false);
    now.t += 60_000;
    expect(await k.autoLockIfIdle(15)).toBe(true);
    expect(await k.isUnlocked()).toBe(false);
  });

  it("detects a tampered keyring at unlock", async () => {
    const { k, local } = setup();
    await k.import(TEST_MNEMONIC, "password-1");
    await k.lock();
    const rec = (await local.get<{ blob: EncryptedBlob }>(StorageKeys.keyring))!;
    await local.set(StorageKeys.keyring, { ...rec, blob: { ...rec.blob, ct: flipHex(rec.blob.ct, 3) } });
    await expect(k.unlock("password-1")).rejects.toMatchObject({ reason: "wrong-password" });
  });

  it("reset removes the key and the session", async () => {
    const { k } = setup();
    await k.import(TEST_MNEMONIC, "password-1");
    await k.reset();
    expect(await k.isInitialized()).toBe(false);
    expect(await k.isUnlocked()).toBe(false);
  });
});
