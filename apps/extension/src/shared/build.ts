/**
 * Build flavour, fixed at build time.
 *  - `VITE_QUEUEBIT_LOCAL_DEVNET=1`: chain 1337 is the local devnet fork (devnet/) with the devnet/deploy contracts.
 *    Used by the e2e suite and local development.
 *  - `VITE_QUEUEBIT_LEANPOOL_URL`: the LeanPool node owner-signed payments go to (default http://127.0.0.1:8701).
 *  - The design gallery (`app.html#design`) exists in development and when `VITE_QUEUEBIT_DESIGN=1` (screenshots);
 *    production builds do not ship it.
 * The extension build (wxt.config.ts) replaces the `__QUEUEBIT_*__` names with literals, so a production bundle folds
 * every devnet and gallery branch away (checked by scripts/release-check.mjs). Outside that build (vitest, scripts)
 * the values come from `import.meta.env`.
 */
declare const __QUEUEBIT_LOCAL_DEVNET__: boolean | undefined;
declare const __QUEUEBIT_DESIGN__: boolean | undefined;
declare const __QUEUEBIT_LEANPOOL_URL__: string | undefined;
declare const __QUEUEBIT_FAUCET_URL__: string | undefined;

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};

/** Use these (not `BUILD.*`) in a branch that must vanish from a production bundle: the bundler inlines them. */
export const LOCAL_DEVNET: boolean =
  typeof __QUEUEBIT_LOCAL_DEVNET__ === "boolean" ? __QUEUEBIT_LOCAL_DEVNET__ : env.VITE_QUEUEBIT_LOCAL_DEVNET === "1";
export const DESIGN_GALLERY: boolean =
  typeof __QUEUEBIT_DESIGN__ === "boolean" ? __QUEUEBIT_DESIGN__ : env.DEV === true || env.VITE_QUEUEBIT_DESIGN === "1";

export const BUILD = {
  localDevnet: LOCAL_DEVNET,
  designGallery: DESIGN_GALLERY,
} as const;

const str = (v: unknown, k: string): string =>
  typeof v === "string" ? v : typeof env[k] === "string" ? (env[k] as string) : "";

/** The default LeanPool node: a node running next to the browser (services/leanpool-node). */
export const DEFAULT_LEANPOOL_URL = "http://127.0.0.1:8701";
/** The LeanPool node this build sends owner-signed payments to (`VITE_QUEUEBIT_LEANPOOL_URL`). */
export const BUILD_LEANPOOL_URL: string =
  str(
    typeof __QUEUEBIT_LEANPOOL_URL__ === "string" ? __QUEUEBIT_LEANPOOL_URL__ : undefined,
    "VITE_QUEUEBIT_LEANPOOL_URL",
  ).replace(/\/+$/u, "") || DEFAULT_LEANPOOL_URL;
/** A local devnet's gateway-style `?address=` faucet (`VITE_QUEUEBIT_FAUCET_URL`), "" when unset. */
export const BUILD_FAUCET_URL: string = str(
  typeof __QUEUEBIT_FAUCET_URL__ === "string" ? __QUEUEBIT_FAUCET_URL__ : undefined,
  "VITE_QUEUEBIT_FAUCET_URL",
);
