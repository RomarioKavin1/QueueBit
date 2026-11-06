import type { Hex } from "viem";
import type { Keystore } from "./types.js";

export class KeystorePathNotAllowedError extends Error {
  constructor(readonly path: string) {
    super(
      `Keystore path ${path} is not a vault delegation path: QueueBit never derives pool keys from the hot seed ` +
        "(note secrets come from the vault's envelope signature)",
    );
    this.name = "KeystorePathNotAllowedError";
  }
}

/** A key the vault flow released for one path (e.g. a fresh PoolPayer sender derived from a note signature). */
export type DelegationResolver = () => Promise<Hex>;

/**
 * The Host `keystore` (plan §1.4 item 4). It is **not** backed by the hot seed: every `deriveAt` throws
 * `KeystorePathNotAllowedError` unless the exact path was registered by a vault-approved flow with `delegate()`.
 * Kohaku's default note scheme would call `deriveAt("m/28784'/1'/<account>'")` for the software envelope signer;
 * that path is never registered here, so a misconfigured plugin fails loudly instead of using a hot key.
 */
export class VaultKeystore implements Keystore {
  private readonly delegations = new Map<string, DelegationResolver>();

  delegate(path: string, resolve: DelegationResolver): void {
    if (!/^m(\/\d+'?)+$/.test(path)) throw new Error(`not a BIP-32 path: ${path}`);
    this.delegations.set(path, resolve);
  }

  revoke(path: string): void {
    this.delegations.delete(path);
  }

  revokeAll(): void {
    this.delegations.clear();
  }

  async deriveAt(path: string): Promise<Hex> {
    const r = this.delegations.get(path);
    if (!r) throw new KeystorePathNotAllowedError(path);
    return r();
  }
}
