import "fake-indexeddb/auto";
import { describe, expect, it } from "vitest";
import * as db from "../src/core/db.js";
import { WrongPassphrase, openSeed, sealSeed } from "../src/core/vaultCrypto.js";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const entropy = () => Uint8Array.from({ length: 32 }, (_, i) => i);
const PK = `0x${"ab".repeat(32)}`;

describe("seed sealing (AES-256-GCM, scrypt)", () => {
  it("round-trips entropy and the BIP-39 passphrase", async () => {
    const sealed = await sealSeed({ entropy: entropy(), bip39Passphrase: "tréma" }, "long enough", PK, FAST);
    const open = await openSeed(sealed, "long enough", PK);
    expect(open.entropy).toEqual(entropy());
    expect(open.bip39Passphrase).toBe("tréma"); // NFKD-normalised, as BIP-39 does
  });

  it("uses a fresh salt and IV each time and never stores plaintext", async () => {
    const a = await sealSeed({ entropy: entropy(), bip39Passphrase: "" }, "long enough", PK, FAST);
    const b = await sealSeed({ entropy: entropy(), bip39Passphrase: "" }, "long enough", PK, FAST);
    expect(a.kdf.salt).not.toEqual(b.kdf.salt);
    expect(a.iv).not.toEqual(b.iv);
    expect(Buffer.from(a.ciphertext).includes(Buffer.from(entropy()))).toBe(false);
    expect(a.ciphertext.length).toBe(1 + 32 + 1 + 16); // + GCM tag
  });

  it("rejects a wrong passphrase", async () => {
    const sealed = await sealSeed({ entropy: entropy(), bip39Passphrase: "" }, "long enough", PK, FAST);
    await expect(openSeed(sealed, "long enougH", PK)).rejects.toBeInstanceOf(WrongPassphrase);
  });

  it("is bound to its public key (a swapped record does not open)", async () => {
    const sealed = await sealSeed({ entropy: entropy(), bip39Passphrase: "" }, "long enough", PK, FAST);
    await expect(openSeed(sealed, "long enough", `0x${"cd".repeat(32)}`)).rejects.toBeInstanceOf(WrongPassphrase);
  });

  it("detects tampering with the ciphertext, IV or KDF parameters", async () => {
    const sealed = await sealSeed({ entropy: entropy(), bip39Passphrase: "" }, "long enough", PK, FAST);
    const ct = sealed.ciphertext.slice();
    ct[0]! ^= 1;
    await expect(openSeed({ ...sealed, ciphertext: ct }, "long enough", PK)).rejects.toBeInstanceOf(WrongPassphrase);
    const iv = sealed.iv.slice();
    iv[0]! ^= 1;
    await expect(openSeed({ ...sealed, iv }, "long enough", PK)).rejects.toBeInstanceOf(WrongPassphrase);
    await expect(openSeed({ ...sealed, kdf: { ...sealed.kdf, N: 2 ** 11 } }, "long enough", PK)).rejects.toBeInstanceOf(
      WrongPassphrase,
    );
  });

  it("refuses short passphrases", async () => {
    await expect(sealSeed({ entropy: entropy(), bip39Passphrase: "" }, "short", PK, FAST)).rejects.toThrow(
      /8 characters/,
    );
  });

  it("defaults to OWASP-minimum scrypt", async () => {
    const { DEFAULT_KDF } = await import("../src/core/vaultCrypto.js");
    expect(DEFAULT_KDF).toEqual({ alg: "scrypt", N: 131072, r: 8, p: 1 });
  });
});

describe("IndexedDB store", () => {
  it("persists the sealed record with its typed arrays and bigints", async () => {
    db._resetForTests();
    const sealed = await sealSeed({ entropy: entropy(), bip39Passphrase: "" }, "long enough", PK, FAST);
    await db.put("vault", {
      v: 1,
      schemeId: `0x${"00".repeat(32)}`,
      vaultPk: PK as `0x${string}`,
      payerAddress: "0x0000000000000000000000000000000000000001",
      sealed,
      createdAt: 1,
      restored: false,
      backupConfirmed: false,
    });
    await db.put("snapshots", [
      {
        account: "0x0000000000000000000000000000000000000002",
        chainId: 1,
        signers: [],
        settings: { capUsdPerDay: 5n },
        tokens: {},
        updatedAt: 1,
      },
    ]);
    const v = await db.get("vault");
    expect(v?.sealed.ciphertext).toEqual(sealed.ciphertext);
    expect((await openSeed(v!.sealed, "long enough", PK)).entropy).toEqual(entropy());
    expect((await db.get("snapshots"))?.[0]?.settings.capUsdPerDay).toBe(5n);
    await db.eraseAll();
    expect(await db.get("vault")).toBeUndefined();
  });

  it("keeps the last 200 log entries", async () => {
    for (let i = 0; i < 205; i++) await db.appendLog({ at: i, kind: "signed", summary: String(i) });
    const log = (await db.get("log"))!;
    expect(log).toHaveLength(200);
    expect(log[0]!.summary).toBe("5");
  });
});
