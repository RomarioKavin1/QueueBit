import { hexToBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import { KeyringController, KeyringError, passkeyMnemonic } from "../../src/background/keyring";
import { MemoryKV, StorageKeys } from "../../src/shared/kv";
import { makeWallet } from "./fakes";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const keyring = () => new KeyringController(new MemoryKV(), new MemoryKV(), { scrypt: FAST });
const entropy = (byte: number) => new Uint8Array(32).fill(byte);
const CRED = "cred-abc";

// BIP-39 reference vectors (trezor/python-mnemonic vectors.json), 256-bit entropy.
const ZEROS_WORDS = `${"abandon ".repeat(23)}art`;
const SEVENF_WORDS =
  "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title";

describe("passkeyMnemonic: a passkey's 32-byte PRF output is the 24-word entropy", () => {
  it("matches the BIP-39 reference vectors", () => {
    expect(passkeyMnemonic(entropy(0x00))).toBe(ZEROS_WORDS);
    expect(passkeyMnemonic(hexToBytes("7f".repeat(32)))).toBe(SEVENF_WORDS);
  });

  it("refuses anything but 32 bytes", () => {
    expect(() => passkeyMnemonic(new Uint8Array(16))).toThrow(KeyringError);
  });
});

describe("a passkey keyring", () => {
  it("has the same keys as importing the passkey's words", async () => {
    const byPasskey = keyring();
    const byWords = keyring();
    const a = await byPasskey.createFromPasskey(entropy(0x7f), CRED);
    const b = await byWords.import(SEVENF_WORDS, "a long password");
    expect(a).toEqual(b);
    expect(await byPasskey.ownerSeed()).toEqual(await byWords.ownerSeed());
  });

  it("stores no secret: only the credential id and the public addresses", async () => {
    const local = new MemoryKV();
    const k = new KeyringController(local, new MemoryKV(), { scrypt: FAST });
    const accounts = await k.createFromPasskey(entropy(0x7f), CRED);
    const record = await local.get<Record<string, unknown>>(StorageKeys.keyring);
    expect(record).toMatchObject({ source: "passkey", passkey: { credentialId: CRED }, accounts });
    expect(record).not.toHaveProperty("blob");
    expect(JSON.stringify(record)).not.toContain("legal");
  });

  it("unlocks with the same passkey and refuses another one", async () => {
    const k = keyring();
    const accounts = await k.createFromPasskey(entropy(0x7f), CRED);
    await k.lock();
    expect(await k.isUnlocked()).toBe(false);
    await expect(k.unlockWithPasskey(entropy(0x01))).rejects.toMatchObject({ reason: "wrong-passkey" });
    expect(await k.isUnlocked()).toBe(false);
    expect(await k.unlockWithPasskey(entropy(0x7f))).toEqual(accounts);
    expect(await k.isUnlocked()).toBe(true);
    await k.withMnemonic((m) => expect(m).toBe(SEVENF_WORDS));
  });

  it("refuses password operations, and reveals its words only for the same passkey", async () => {
    const k = keyring();
    await k.createFromPasskey(entropy(0x7f), CRED);
    await expect(k.unlock("a long password")).rejects.toMatchObject({ reason: "passkey" });
    await expect(k.revealWords("a long password")).rejects.toMatchObject({ reason: "passkey" });
    await expect(k.changePassword("a long password", "another long one")).rejects.toMatchObject({ reason: "passkey" });
    expect(await k.revealWordsWithPasskey(entropy(0x7f))).toBe(SEVENF_WORDS);
    await expect(k.revealWordsWithPasskey(entropy(0x01))).rejects.toMatchObject({ reason: "wrong-passkey" });
  });

  it("verifies the same passkey again and refuses another one or a password", async () => {
    const k = keyring();
    await k.createFromPasskey(entropy(0x7f), CRED);
    await k.verify({ entropy: entropy(0x7f) });
    await expect(k.verify({ entropy: entropy(0x01) })).rejects.toMatchObject({ reason: "wrong-passkey" });
    await expect(k.verify({ password: "a long password" })).rejects.toBeInstanceOf(KeyringError);
  });

  it("tells a password keyring apart from a passkey one", async () => {
    const k = keyring();
    await k.import(SEVENF_WORDS, "a long password");
    expect(await k.passkeyInfo()).toBeUndefined();
    await expect(k.unlockWithPasskey(entropy(0x7f))).rejects.toMatchObject({ reason: "not-passkey" });
    const p = keyring();
    await p.createFromPasskey(entropy(0x7f), CRED);
    expect(await p.passkeyInfo()).toEqual({ credentialId: CRED });
  });
});

describe("the wallet's passkey messages", () => {
  const hex = (b: number) => `0x${b.toString(16).padStart(2, "0").repeat(32)}` as const;

  it("creates, locks, unlocks and reveals through the UI API", async () => {
    const { wallet } = makeWallet();
    await wallet.handleUi("keyring:createFromPasskey", { entropy: hex(0x7f), credentialId: CRED });
    expect(await wallet.handleUi("keyring:passkeyInfo", undefined)).toEqual({ credentialId: CRED });
    expect((await wallet.handleUi("state:get", undefined)).unlocked).toBe(true);
    await wallet.handleUi("keyring:lock", undefined);
    expect((await wallet.handleUi("state:get", undefined)).unlocked).toBe(false);
    await expect(wallet.handleUi("keyring:unlockWithPasskey", { entropy: hex(0x01) })).rejects.toMatchObject({
      reason: "wrong-passkey",
    });
    await wallet.handleUi("keyring:unlockWithPasskey", { entropy: hex(0x7f) });
    expect((await wallet.handleUi("state:get", undefined)).unlocked).toBe(true);
    expect(await wallet.handleUi("keyring:revealWordsWithPasskey", { entropy: hex(0x7f) })).toEqual({
      mnemonic: SEVENF_WORDS,
    });
  });

  it("reports no passkey for a password wallet", async () => {
    const { wallet } = makeWallet();
    await wallet.keyring.import(SEVENF_WORDS, "a long password");
    expect(await wallet.handleUi("keyring:passkeyInfo", undefined)).toBeNull();
  });
});
