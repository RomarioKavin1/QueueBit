import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { HDKey } from "@scure/bip32";
import { entropyToMnemonic, generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
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
 * The extension keyring (plan §70). One BIP-39 seed (24 words) holds every key the wallet uses:
 *   - the owner key: leanSPHINCS (leanVM), seeded with
 *       HKDF-SHA256(ikm = BIP-39 seed, salt = "queuebit.leanaccount.owner.v1", info = "leanSPHINCS/0", 32 bytes)
 *     It is the account's ADMIN|SPEND key; its payments are approved through a LeanPool node. Quantum-safe.
 *   - the setup key       m/44'/60'/1'/0/0  secp256k1: sends the ordinary transactions an account can't send for
 *     itself (creating it, a move's last step, a Safe's execTransaction). It holds only what those cost.
 *   - session keys        m/44'/60'/2'/0/i  secp256k1: one per session; the account lets each one call only its
 *     sites' contracts within its limits, until it ends.
 *   - the privacy payer   m/44'/60'/4'/0/0  secp256k1: signs Privacy Pools note envelopes (its signatures are the
 *     notes' spend keys), never transactions.
 *   - the identity key    m/44'/60'/0'/0/0  secp256k1: signs nothing; its address binds the encrypted blob (AAD).
 * Paths and labels are fixed: the same words restore the same keys and the same account address.
 *
 * A passkey keyring has no password and stores no secret: the passkey's WebAuthn PRF output (32 bytes, for the fixed
 * input PASSKEY_PRF_SALT) is the 24 words' entropy. Every unlock asks the passkey again; the words exist only in memory
 * while unlocked, and the same passkey (or its words) restores the same keys.
 */
export const IDENTITY_PATH = (index = 0) => `m/44'/60'/0'/0/${index}`;
export const SETUP_PATH = `m/44'/60'/1'/0/0`;
export const SESSION_PATH = (index: number) => `m/44'/60'/2'/0/${index}`;
export const PRIVACY_PAYER_PATH = `m/44'/60'/4'/0/0`;
export const OWNER_SEED_SALT = "queuebit.leanaccount.owner.v1";
export const OWNER_SEED_INFO = (index = 0) => `leanSPHINCS/${index}`;

/** The WebAuthn PRF input every QueueBit passkey is evaluated at: sha256("queuebit.passkey.prf.v1"). */
export const PASSKEY_PRF_SALT: Uint8Array = sha256(utf8ToBytes("queuebit.passkey.prf.v1"));

export const MIN_PASSWORD_LENGTH = 8;
export const MNEMONIC_STRENGTH_BITS = 256; // 24 words

export interface KeyringAccounts {
  /** The identity key's address (binds the encrypted blob). */
  everyday: Address;
  /** The setup key's address (pays for account creation and moves). */
  setup: Address;
}

export interface PasskeyInfo {
  /** The WebAuthn credential id (base64url), so unlock can ask for this passkey. */
  credentialId: string;
}

export type KeyringRecord = {
  v: 1;
  accounts: KeyringAccounts;
  createdAt: number;
} & (
  | { source: "created" | "imported"; blob: EncryptedBlob; passkey?: undefined }
  | { source: "passkey"; passkey: PasskeyInfo; blob?: undefined }
);

/** Lives in chrome.storage.session: in memory only, cleared on browser restart, hidden from content scripts. */
export interface SessionRecord {
  /** The blob's data key; for a passkey keyring, the passkey's PRF output (the words' entropy). */
  dek: string;
  unlockedAt: number;
  lastActivity: number;
}

interface Secret {
  mnemonic: string;
}

export class KeyringError extends Error {
  constructor(
    readonly reason:
      | "exists"
      | "missing"
      | "locked"
      | "weak-password"
      | "bad-mnemonic"
      | "wrong-password"
      | "damaged"
      | "bad-passkey"
      | "wrong-passkey"
      | "passkey"
      | "not-passkey",
    message: string,
  ) {
    super(message);
    this.name = "KeyringError";
  }
}

export function normalizeMnemonic(words: string): string {
  return words.trim().toLowerCase().split(/\s+/u).join(" ");
}

/** The 24 words a passkey's 32-byte PRF output stands for (BIP-39 entropy). */
export function passkeyMnemonic(entropy: Uint8Array): string {
  if (entropy.length !== 32) {
    throw new KeyringError("bad-passkey", "This passkey didn't return a 32-byte secret (WebAuthn PRF).");
  }
  return entropyToMnemonic(entropy, wordlist);
}

function derivePrivateKey(seed: Uint8Array, path: string): Uint8Array {
  const key = HDKey.fromMasterSeed(seed).derive(path).privateKey;
  if (!key) throw new Error("derivation failed");
  return key;
}

const addressAt = (seed: Uint8Array, path: string): Address => {
  const k = derivePrivateKey(seed, path);
  try {
    return privateKeyToAccount(`0x${bytesToHex(k)}`).address;
  } finally {
    k.fill(0);
  }
};

export function deriveAccounts(mnemonic: string): KeyringAccounts {
  const seed = mnemonicToSeedSync(mnemonic);
  try {
    return { everyday: addressAt(seed, IDENTITY_PATH(0)), setup: addressAt(seed, SETUP_PATH) };
  } finally {
    seed.fill(0);
  }
}

/** The owner key's 32-byte leanSPHINCS seed (see the keyring comment). The caller zeroes it. */
export function ownerSeedFrom(seed: Uint8Array, index = 0): Uint8Array {
  return hkdf(sha256, seed, utf8ToBytes(OWNER_SEED_SALT), utf8ToBytes(OWNER_SEED_INFO(index)), 32);
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
    return (await this.record())?.accounts;
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

  private async store(mnemonic: string, password: string, source: "created" | "imported"): Promise<KeyringAccounts> {
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

  /** Create a keyring from a passkey's PRF output. Stores only the credential id and the public addresses. */
  async createFromPasskey(entropy: Uint8Array, credentialId: string): Promise<KeyringAccounts> {
    if (await this.isInitialized()) throw new KeyringError("exists", "This browser already has a QueueBit account.");
    const accounts = deriveAccounts(passkeyMnemonic(entropy));
    const record: KeyringRecord = {
      v: 1,
      accounts,
      createdAt: this.now(),
      source: "passkey",
      passkey: { credentialId },
    };
    await this.local.set(StorageKeys.keyring, record);
    await this.startSession(entropy.slice());
    return accounts;
  }

  /** The passkey this keyring needs, or undefined for a password keyring. */
  async passkeyInfo(): Promise<PasskeyInfo | undefined> {
    return (await this.record())?.passkey;
  }

  async unlockWithPasskey(entropy: Uint8Array): Promise<KeyringAccounts> {
    const record = await this.requirePasskeyRecord();
    this.assertSamePasskey(record, entropy);
    await this.startSession(entropy.slice());
    return record.accounts;
  }

  /** A passkey keyring's words, for an offline backup. Needs the same passkey again. */
  async revealWordsWithPasskey(entropy: Uint8Array): Promise<string> {
    const record = await this.requirePasskeyRecord();
    this.assertSamePasskey(record, entropy);
    return passkeyMnemonic(entropy);
  }

  private async requirePasskeyRecord(): Promise<KeyringRecord & { source: "passkey" }> {
    const record = await this.requireRecord();
    if (record.source !== "passkey") {
      throw new KeyringError("not-passkey", "This wallet uses a password, not a passkey.");
    }
    return record;
  }

  private assertSamePasskey(record: KeyringRecord, entropy: Uint8Array): void {
    if (deriveAccounts(passkeyMnemonic(entropy)).everyday !== record.accounts.everyday) {
      throw new KeyringError("wrong-passkey", "That passkey belongs to a different wallet.");
    }
  }

  async unlock(password: string): Promise<KeyringAccounts> {
    const record = await this.requirePasswordRecord();
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

  /** The backup words, for "Back up your words". Needs the password again. */
  async revealWords(password: string): Promise<string> {
    const record = await this.requirePasswordRecord();
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
    const record = await this.requirePasswordRecord();
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
    if (record.source === "passkey") return fn(passkeyMnemonic(hexToBytes(s.dek)));
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

  /** Run `fn` with the secp256k1 private key at `path` (zeroed afterwards; it never leaves the service worker). */
  async withKey<T>(path: string, fn: (privateKey: `0x${string}`) => T | Promise<T>): Promise<T> {
    return this.withMnemonic(async (mnemonic) => {
      const seed = mnemonicToSeedSync(mnemonic);
      const key = derivePrivateKey(seed, path);
      seed.fill(0);
      try {
        return await fn(`0x${bytesToHex(key)}`);
      } finally {
        key.fill(0);
      }
    });
  }

  /** The address of the secp256k1 key at `path` (needs the wallet unlocked). */
  async addressOf(path: string): Promise<Address> {
    return this.withKey(path, (k) => privateKeyToAccount(k).address);
  }

  /** The owner key's leanSPHINCS seed (needs the wallet unlocked). The caller zeroes it. */
  async ownerSeed(index = 0): Promise<Uint8Array> {
    return this.withMnemonic((mnemonic) => {
      const seed = mnemonicToSeedSync(mnemonic);
      try {
        return ownerSeedFrom(seed, index);
      } finally {
        seed.fill(0);
      }
    });
  }

  /**
   * A 32-byte storage key for one purpose (`label`), derived from the seed with HKDF-SHA256 (unlocked only). It is
   * not any signing key: exporting a signing key does not reveal it (the private balance's encrypted
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

  /** Danger zone: remove the keys from this browser. Money stays in the account. */
  async reset(): Promise<void> {
    await this.lock();
    await this.local.remove(StorageKeys.keyring);
  }

  private async requirePasswordRecord(): Promise<KeyringRecord & { blob: EncryptedBlob }> {
    const record = await this.requireRecord();
    if (record.source === "passkey") {
      throw new KeyringError("passkey", "This wallet uses a passkey, not a password.");
    }
    return record;
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
