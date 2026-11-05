import { profile as eip8141Current } from "./eip8141-current.js";
import { profile as ethrexEip8141Tracer } from "./ethrex-eip8141-tracer.js";
import { profile as ethrexHegotaDevnet } from "./ethrex-hegota-devnet.js";
import type { Profile } from "./types.js";

const list: readonly Profile[] = [ethrexEip8141Tracer, ethrexHegotaDevnet, eip8141Current];

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

/** Every known profile by id. Profiles are frozen: a profile never changes once a network depends on it. */
export const profiles: Readonly<Record<string, Profile>> = deepFreeze(Object.fromEntries(list.map((p) => [p.id, p])));

export type ProfileId = "ethrex-eip8141-tracer" | "ethrex-hegota-devnet" | "eip8141-current";

/** Looks a profile up by id and throws, listing the known ids, when there is none. */
export function getProfile(id: string): Profile {
  const found = profiles[id];
  if (!found) throw new Error(`Unknown profile "${id}". Known profiles: ${Object.keys(profiles).join(", ")}`);
  return found;
}

/**
 * The profile for a chain: the `current` profile whose network has this chain id. Throws for an unknown chain
 * unless `fallback` names a profile, so a wallet never signs with a guessed codec by accident.
 */
export function profileForChain(chainId: number | bigint, options: { fallback?: string } = {}): Profile {
  const id = Number(chainId);
  const found = list.filter((p) => p.status === "current" && p.devnet.chainId === id);
  if (found.length > 1) throw new Error(`Chain ${id} has more than one current profile: ${found.map((p) => p.id)}`);
  if (found[0]) return found[0];
  if (options.fallback !== undefined) return getProfile(options.fallback);
  throw new Error(
    `No frame-transaction profile for chain ${id}. Known chains: ${list
      .filter((p) => p.devnet.chainId !== undefined)
      .map((p) => `${p.devnet.chainId} (${p.id})`)
      .join(", ")}`,
  );
}
