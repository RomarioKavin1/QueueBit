/**
 * The LeanPool node for the post-quantum everyday key (`VITE_QUEUEBIT_LEANPOOL_URL`, services/leanpool-node) on chain
 * 1337, fixed at build time (wxt.config.ts defines `__QUEUEBIT_LEANPOOL_URL__`); "" when this build has none (the
 * Security screen then says the quantum-safe key isn't available here). Its own module, so tests that mock
 * `./build` need not know about it.
 */
declare const __QUEUEBIT_LEANPOOL_URL__: string | undefined;

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};

export const BUILD_LEANPOOL_URL: string =
  typeof __QUEUEBIT_LEANPOOL_URL__ === "string"
    ? __QUEUEBIT_LEANPOOL_URL__
    : typeof env.VITE_QUEUEBIT_LEANPOOL_URL === "string"
      ? env.VITE_QUEUEBIT_LEANPOOL_URL
      : "";
