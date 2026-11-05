import type { Address } from "viem";
import { StorageKeys, type KV } from "../shared/kv";
import type { KnownSite, OriginPermission } from "../shared/types";

/**
 * Per-origin connection permissions (EIP-2255-style, plan §30 §2.2 PermissionsController) and the local "known sites"
 * list that drives first-visit warnings. Both live in storage.local; origins come from the port sender, never from the
 * page (plan §30 §9.1).
 */
export class PermissionsStore {
  constructor(
    private readonly kv: KV,
    private readonly now: () => number = Date.now,
  ) {}

  private async all(): Promise<Record<string, OriginPermission>> {
    return (await this.kv.get<Record<string, OriginPermission>>(StorageKeys.permissions)) ?? {};
  }

  async get(origin: string): Promise<OriginPermission | undefined> {
    return (await this.all())[normalizeOrigin(origin)];
  }

  async isPermitted(origin: string): Promise<boolean> {
    return (await this.get(origin)) !== undefined;
  }

  async list(): Promise<OriginPermission[]> {
    return Object.values(await this.all()).sort((a, b) => b.grantedAt - a.grantedAt);
  }

  async grant(origin: string, accounts: Address[]): Promise<OriginPermission> {
    const o = normalizeOrigin(origin);
    const all = await this.all();
    const perm: OriginPermission = { origin: o, accounts: [...accounts], grantedAt: all[o]?.grantedAt ?? this.now() };
    await this.kv.set(StorageKeys.permissions, { ...all, [o]: perm });
    await this.markKnown(o);
    return perm;
  }

  async revoke(origin: string): Promise<boolean> {
    const o = normalizeOrigin(origin);
    const all = await this.all();
    if (!(o in all)) return false;
    delete all[o];
    await this.kv.set(StorageKeys.permissions, all);
    return true;
  }

  async revokeAll(): Promise<void> {
    await this.kv.remove(StorageKeys.permissions);
  }

  // ---- known sites (first-visit warnings) ----

  private async sites(): Promise<Record<string, KnownSite>> {
    return (await this.kv.get<Record<string, KnownSite>>(StorageKeys.knownSites)) ?? {};
  }

  async knownSite(origin: string): Promise<KnownSite | undefined> {
    return (await this.sites())[normalizeOrigin(origin)];
  }

  async isFirstVisit(origin: string): Promise<boolean> {
    return (await this.knownSite(origin)) === undefined;
  }

  async markKnown(origin: string): Promise<KnownSite> {
    const o = normalizeOrigin(origin);
    const sites = await this.sites();
    const now = this.now();
    const site: KnownSite = { origin: o, firstSeenAt: sites[o]?.firstSeenAt ?? now, lastConnectedAt: now };
    await this.kv.set(StorageKeys.knownSites, { ...sites, [o]: site });
    return site;
  }
}

/** Accept only a bare web origin (`scheme://host[:port]`), the form `MessageSender.origin` gives us. */
export function normalizeOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new Error(`Not an origin: ${origin}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error(`Unsupported origin scheme: ${origin}`);
  if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new Error(`Not a bare origin: ${origin}`);
  }
  return url.origin;
}
