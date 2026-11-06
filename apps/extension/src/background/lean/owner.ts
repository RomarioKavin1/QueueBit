import { LeanSphincsKey, SIGNATURE_BUDGET } from "@queuebit/lean-sphincs";
import { bytesToHex, hexToBytes, type Hex } from "viem";
import { StorageKeys, type KV } from "../../shared/kv";
import type { KeyringController } from "../keyring";

/** What the extension keeps about the owner key: its public key and how many signatures it has made. */
export interface OwnerRecord {
  /** The leanSPHINCS public key (the keystore's `a` field, EIP-8288 vk). */
  vk: Hex;
  /** Signatures made so far. leanSPHINCS is safe up to SIGNATURE_BUDGET signatures per key. */
  used: number;
}

export class OwnerKeyError extends Error {
  constructor(
    readonly reason: "budget",
    message: string,
  ) {
    super(message);
    this.name = "OwnerKeyError";
  }
}

/** The part of a leanSPHINCS key the wallet uses (the WASM key, or a stand-in in tests). */
export interface PqKey {
  readonly publicKey: Uint8Array;
  sign(message: Uint8Array): Uint8Array;
  dispose(): void;
}

/**
 * The owner key (leanSPHINCS, seeded from the backup words: keyring.ts). Built once per unlock in the service worker
 * (the kept subtree takes a moment) and freed on lock. Every signature is counted in storage BEFORE it is made, so a
 * crash can only over-count; past SIGNATURE_BUDGET the key refuses to sign.
 */
export class OwnerKey {
  private key: PqKey | undefined;
  private building: Promise<PqKey> | undefined;

  constructor(
    private readonly kv: KV,
    private readonly keyring: KeyringController,
    private readonly load: (seed: Uint8Array) => PqKey = (seed) => LeanSphincsKey.fromSeed(seed),
    readonly budget: number = SIGNATURE_BUDGET,
  ) {}

  async record(): Promise<OwnerRecord | undefined> {
    return this.kv.get<OwnerRecord>(StorageKeys.owner);
  }

  /** The owner's public key (builds the key the first time; needs the wallet unlocked then). */
  async vk(): Promise<Hex> {
    const r = await this.record();
    if (r) return r.vk;
    const key = await this.open();
    const vk = bytesToHex(key.publicKey);
    await this.kv.set(StorageKeys.owner, { vk, used: 0 } satisfies OwnerRecord);
    return vk;
  }

  /** Signatures left before the key must be replaced. */
  async remaining(): Promise<number> {
    return Math.max(0, this.budget - ((await this.record())?.used ?? 0));
  }

  /** Signs a 32-byte message (a frame transaction's sig hash). */
  async sign(message: Hex): Promise<Hex> {
    const key = await this.open();
    const vk = bytesToHex(key.publicKey);
    const r = (await this.record()) ?? { vk, used: 0 };
    if (r.vk.toLowerCase() !== vk.toLowerCase()) throw new Error("The stored owner key doesn't match these words.");
    if (r.used >= this.budget) {
      throw new OwnerKeyError(
        "budget",
        "Your owner key has made all the signatures it safely can. Add a new owner key before sending more.",
      );
    }
    await this.kv.set(StorageKeys.owner, { vk, used: r.used + 1 } satisfies OwnerRecord);
    return bytesToHex(key.sign(hexToBytes(message)));
  }

  /** Lock: free the key's memory. */
  lock(): void {
    this.key?.dispose();
    this.key = undefined;
    this.building = undefined;
  }

  /** Reset: forget the key and its counter. */
  async clear(): Promise<void> {
    this.lock();
    await this.kv.remove(StorageKeys.owner);
  }

  private async open(): Promise<PqKey> {
    if (this.key) return this.key;
    this.building ??= (async () => {
      const seed = await this.keyring.ownerSeed();
      try {
        const k = this.load(seed);
        this.key = k;
        return k;
      } finally {
        seed.fill(0);
        this.building = undefined;
      }
    })();
    return this.building;
  }
}
