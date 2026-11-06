import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import type { Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { StorageKeys, type KV } from "../shared/kv";
import {
  DEFAULT_SCRYPT,
  DecryptionError,
  aadFor,
  decryptWithKey,
  decryptWithPassword,
  encryptWithPassword,
  type EncryptedBlob,
  type ScryptParams,
} from "./encryption";

/**
 * The extension keyring (plan §30 §2.4). One BIP-39 seed (24 words) holds:
 *   - the everyday key  m/44'/60'/0'/0/0  (signs everyday payments; bounded by the on-chain daily limit)
 *   - the fee-tank key  m/44'/60'/1'/0/k  (pays network fees for everyday payments; separate branch so a rotation of
 *     the everyday key never moves the tank and exporting the tank never reveals the everyday key)
 * No Vault or Recovery key material ever enters the extension.
 */
export const EVERYDAY_PATH = (index = 0) => `m/44'/60'/0'/0/${index}`;
export const FEE_TANK_PATH = (index = 0) => `m/44'/60'/1'/0/${index}`;

export const MIN_PASSWORD_LENGTH = 8;
export const MNEMONIC_STRENGTH_BITS = 256; // 24 words

export interface KeyringAccounts {
  everyday: Address;
  feeTank: Address;
}

export interface KeyringRecord {
  v: 1;
  blob: EncryptedBlob;
  accounts: KeyringAccounts;
  createdAt: number;
  source: "created" | "imported";
  /**
   * After "Replace everyday key" (`vaultSetHotKey`): the index and address of the everyday key in use. `accounts`
   * keeps the original (it binds the encrypted blob), so this is separate.
   */
  hot?: { index: number; address: Address };
}

/** Lives in chrome.storage.session: in memory only, cleared on browser restart, hidden from content scripts. */
export interface SessionRecord {
  dek: string;
  unlockedAt: number;
  lastActivity: number;
}

interface Secret {
  mnemonic: string;
}

export class KeyringError extends Error {
  constructor(
    readonly reason: "exists" | "missing" | "locked" | "weak-password" | "bad-mnemonic" | "wrong-password" | "damaged",
    message: string,
  ) {
    super(message);
    this.name = "KeyringError";
  }
}

export function normalizeMnemonic(words: string): string {
  return words.trim().toLowerCase().split(/\s+/u).join(" ");
}

function derivePrivateKey(seed: Uint8Array, path: string): Uint8Array {
  const key = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!key) throw new Error("derivation failed");
  return key;
}

export function deriveAccounts(mnemonic: string): KeyringAccounts {
  const seed = mnemonicToSeedSync(mnemonic);
  try {
    const everydayKey = derivePrivateKey(seed, EVERYDAY_PATH(0));
    const tankKey = derivePrivateKey(seed, FEE_TANK_PATH(0));
    const accounts = {
      everyday: privateKeyToAccount(`0x${bytesToHex(everydayKey)}`).address,
      feeTank: privateKeyToAccount(`0x${bytesToHex(tankKey)}`).address,
    };
    everydayKey.fill(0);
    tankKey.fill(0);
    return accounts;
  } finally {
    seed.fill(0);
  }
}

export interface KeyringOptions {
  scrypt?: ScryptParams;
  now?: () => number;
}

export class KeyringController {
  private readonly scrypt: ScryptParams;
  private readonly now: () => number;

  constructor(
    private readonly local: KV,
    private readonly session: KV,
    opts: KeyringOptions = {},
  ) {
    this.scrypt = opts.scrypt ?? DEFAULT_SCRYPT;
    this.now = opts.now ?? Date.now;
  }

  async record(): Promise<KeyringRecord | undefined> {
    return this.local.get<KeyringRecord>(StorageKeys.keyring);
  }

  async isInitialized(): Promise<boolean> {
    return (await this.record()) !== undefined;
  }

  async isUnlocked(): Promise<boolean> {
    return (await this.session.get<SessionRecord>(StorageKeys.session)) !== undefined;
  }

  async accounts(): Promise<KeyringAccounts | undefined> {
    const r = await this.record();
    if (!r) return undefined;
    return r.hot ? { ...r.accounts, everyday: r.hot.address } : r.accounts;
  }

  /** The everyday key index in use (0 until a "Replace everyday key"). */
  async everydayIndex(): Promise<number> {
    return (await this.record())?.hot?.index ?? 0;
  }

  /** The address of the everyday key at `index` (needs the wallet unlocked). */
  async everydayAt(index: number): Promise<Address> {
    return this.withMnemonic((mnemonic) => {
      const seed = mnemonicToSeedSync(mnemonic);
      try {
        const k = derivePrivateKey(seed, EVERYDAY_PATH(index));
        const a = privateKeyToAccount(`0x${bytesToHex(k)}`).address;
        k.fill(0);
        return a;
      } finally {
        seed.fill(0);
      }
    });
  }

  /** Switch to the everyday key at `index` once the account accepted it on-chain. */
  async useEverydayIndex(index: number): Promise<void> {
    const record = await this.requireRecord();
    const address = await this.everydayAt(index);
    await this.local.set(StorageKeys.keyring, { ...record, hot: { index, address } } satisfies KeyringRecord);
  }

  /** Create a new 24-word seed. Returns the words once so onboarding can offer to show them. */
  async create(password: string): Promise<{ mnemonic: string; accounts: KeyringAccounts }> {
    const mnemonic = generateMnemonic(wordlist, MNEMONIC_STRENGTH_BITS);
    const accounts = await this.store(mnemonic, password, "created");
    return { mnemonic, accounts };
  }

  async import(words: string, password: string): Promise<KeyringAccounts> {
    const mnemonic = normalizeMnemonic(words);
    if (!validateMnemonic(mnemonic, wordlist)) {
      throw new KeyringError("bad-mnemonic", "Those words aren't a valid backup phrase. Check the spelling and order.");
    }
    return this.store(mnemonic, password, "imported");
  }

  private async store(mnemonic: string, password: string, source: KeyringRecord["source"]): Promise<KeyringAccounts> {
    if (await this.isInitialized()) throw new KeyringError("exists", "This browser already has a QueueBit account.");
    assertPassword(password);
    const accounts = deriveAccounts(mnemonic);
    const plaintext = utf8ToBytes(JSON.stringify({ mnemonic } satisfies Secret));
    const { blob, dek } = await encryptWithPassword(password, plaintext, aadFor(accounts.everyday), this.scrypt);
    plaintext.fill(0);
    const record: KeyringRecord = { v: 1, blob, accounts, createdAt: this.now(), source };
    await this.local.set(StorageKeys.keyring, record);
    await this.startSession(dek);
    return accounts;
  }

  async unlock(password: string): Promise<KeyringAccounts> {
    const record = await this.requireRecord();
    let dek: Uint8Array;
    try {
      ({ dek } = await decryptWithPassword(password, record.blob, aadFor(record.accounts.everyday)));
    } catch (err) {
      if (err instanceof DecryptionError) throw new KeyringError("wrong-password", "That password didn't work.");
      throw new KeyringError("damaged", "The stored keyring is damaged and can't be unlocked.");
    }
    await this.startSession(dek);
    return record.accounts;
  }

  /** The everyday backup words, for the "Back up your everyday words" checklist item. Needs the password again. */
  async revealWords(password: string): Promise<string> {
    const record = await this.requireRecord();
    let plaintext: Uint8Array;
    try {
      ({ plaintext } = await decryptWithPassword(password, record.blob, aadFor(record.accounts.everyday)));
    } catch (err) {
      if (err instanceof DecryptionError) throw new KeyringError("wrong-password", "That password didn't work.");
      throw new KeyringError("damaged", "The stored keyring is damaged and can't be unlocked.");
    }
    const secret = JSON.parse(new TextDecoder().decode(plaintext)) as Secret;
    plaintext.fill(0);
    return secret.mnemonic;
  }

  async lock(): Promise<void> {
    await this.session.remove(StorageKeys.session);
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<void> {
    assertPassword(newPassword);
    const record = await this.requireRecord();
    const aad = aadFor(record.accounts.everyday);
    let plaintext: Uint8Array;
    try {
      ({ plaintext } = await decryptWithPassword(oldPassword, record.blob, aad));
    } catch (err) {
      if (err instanceof DecryptionError)
        throw new KeyringError("wrong-password", "Your current password didn't work.");
      throw new KeyringError("damaged", "The stored keyring is damaged and can't be unlocked.");
    }
    const { blob, dek } = await encryptWithPassword(newPassword, plaintext, aad, this.scrypt);
    plaintext.fill(0);
    await this.local.set(StorageKeys.keyring, { ...record, blob } satisfies KeyringRecord);
    await this.startSession(dek);
  }

  /** Record user activity for the auto-lock timer. No-op while locked. */
  async touch(): Promise<void> {
    const s = await this.session.get<SessionRecord>(StorageKeys.session);
    if (s) await this.session.set(StorageKeys.session, { ...s, lastActivity: this.now() });
  }

  /** Lock if idle for longer than `minutes`. Returns true if it locked. */
  async autoLockIfIdle(minutes: number): Promise<boolean> {
    const s = await this.session.get<SessionRecord>(StorageKeys.session);
    if (!s) return false;
    if (this.now() - s.lastActivity >= minutes * 60_000) {
      await this.lock();
      return true;
    }
    return false;
  }

  /**
   * Run `fn` with the decrypted secret (for signing, M1+). The secret is only ever held for the duration of `fn`, in
   * the service worker, and never leaves it.
   */
  async withMnemonic<T>(fn: (mnemonic: string) => T | Promise<T>): Promise<T> {
    const record = await this.requireRecord();
    const s = await this.session.get<SessionRecord>(StorageKeys.session);
    if (!s) throw new KeyringError("locked", "QueueBit is locked.");
    let plaintext: Uint8Array;
    try {
      plaintext = await decryptWithKey(hexToBytes(s.dek), record.blob, aadFor(record.accounts.everyday));
    } catch {
      throw new KeyringError("damaged", "The stored keyring could not be decrypted.");
    }
    const secret = JSON.parse(new TextDecoder().decode(plaintext)) as Secret;
    plaintext.fill(0);
    return fn(secret.mnemonic);
  }

  /**
   * Run `fn` with the everyday and fee-tank private keys (signing, plan §30 §4.2). Both are derived for the call and
   * zeroed afterwards; they never leave the service worker.
   */
  async withHotKeys<T>(fn: (keys: { everyday: `0x${string}`; feeTank: `0x${string}` }) => T | Promise<T>): Promise<T> {
    const index = await this.everydayIndex();
    return this.withMnemonic(async (mnemonic) => {
      const seed = mnemonicToSeedSync(mnemonic);
      const everyday = derivePrivateKey(seed, EVERYDAY_PATH(index));
      const feeTank = derivePrivateKey(seed, FEE_TANK_PATH(0));
      seed.fill(0);
      try {
        return await fn({ everyday: `0x${bytesToHex(everyday)}`, feeTank: `0x${bytesToHex(feeTank)}` });
      } finally {
        everyday.fill(0);
        feeTank.fill(0);
      }
    });
  }

  /**
   * A 32-byte storage key for one purpose (`label`), derived from the seed with HKDF-SHA256 (unlocked only). It is
   * not any signing key: exporting the everyday or fee-tank key does not reveal it (the private balance's encrypted
   * store, plan §40 §1.2 "a separate key"). Stable across password changes; the caller zeroes it after import.
   */
  async deriveStorageKey(label: string): Promise<Uint8Array> {
    return this.withMnemonic((mnemonic) => {
      const seed = mnemonicToSeedSync(mnemonic);
      try {
        return hkdf(sha256, seed, utf8ToBytes("queuebit.storage-key.v1"), utf8ToBytes(label), 32);
      } finally {
        seed.fill(0);
      }
    });
  }

  /** Danger zone: remove the everyday key from this browser. Money stays in the account. */
  async reset(): Promise<void> {
    await this.lock();
    await this.local.remove(StorageKeys.keyring);
  }

  private async requireRecord(): Promise<KeyringRecord> {
    const r = await this.record();
    if (!r) throw new KeyringError("missing", "No QueueBit account in this browser yet.");
    return r;
  }

  private async startSession(dek: Uint8Array): Promise<void> {
    const now = this.now();
    await this.session.set(StorageKeys.session, {
      dek: bytesToHex(dek),
      unlockedAt: now,
      lastActivity: now,
    } satisfies SessionRecord);
    dek.fill(0);
  }
}

function assertPassword(password: string): void {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    throw new KeyringError("weak-password", `Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
}
