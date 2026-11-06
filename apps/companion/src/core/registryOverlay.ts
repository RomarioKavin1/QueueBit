/**
 * A build-time overlay over the bundled registry (the shared-devnet flavour, scripts/shared-overlay.mjs): chain
 * names, tokens and 4337 modules for the shared devnet, baked in at build time; nothing is fetched at runtime.
 */
export interface RegistryOverlay {
  chains?: Record<string, string>;
  tokens?: Record<string, Record<string, { symbol: string; decimals: number }>>;
  aaModules?: Record<string, { executor: string; hook: string }>;
}

interface Mergeable {
  chains: Record<string, string>;
  tokens: Record<string, Record<string, unknown>>;
  aaModules: Record<string, unknown>;
}

export function applyOverlay<T extends Mergeable>(raw: T, o: RegistryOverlay | null | undefined): T {
  if (!o) return raw;
  const tokens: Record<string, Record<string, unknown>> = { ...raw.tokens };
  for (const [chain, list] of Object.entries(o.tokens ?? {})) tokens[chain] = { ...(raw.tokens[chain] ?? {}), ...list };
  return {
    ...raw,
    chains: { ...raw.chains, ...(o.chains ?? {}) },
    tokens,
    aaModules: { ...raw.aaModules, ...(o.aaModules ?? {}) },
  };
}
