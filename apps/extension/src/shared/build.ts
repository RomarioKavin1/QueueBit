/**
 * Build flavour, fixed at build time.
 *  - `VITE_QUEUEBIT_LOCAL_DEVNET=1`: chain 1337 is the local devnet fork (devnet/) with the devnet/deploy contracts.
 *    Used by the e2e suite and local development.
 *  - The design gallery (`app.html#design`) exists in development and when `VITE_QUEUEBIT_DESIGN=1` (screenshots);
 *    production builds do not ship it.
 * The extension build (wxt.config.ts) replaces `__QUEUEBIT_LOCAL_DEVNET__` / `__QUEUEBIT_DESIGN__` with literals, so a
 * production bundle folds every `BUILD.*` branch away and carries no devnet or gallery code (checked by
 * scripts/release-check.mjs). Outside that build (vitest, scripts) the flags come from `import.meta.env`.
 */
declare const __QUEUEBIT_LOCAL_DEVNET__: boolean | undefined;
declare const __QUEUEBIT_DESIGN__: boolean | undefined;

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};

/** Use these (not `BUILD.*`) in a branch that must vanish from a production bundle: the bundler inlines them. */
export const LOCAL_DEVNET: boolean =
  typeof __QUEUEBIT_LOCAL_DEVNET__ === "boolean" ? __QUEUEBIT_LOCAL_DEVNET__ : env.VITE_QUEUEBIT_LOCAL_DEVNET === "1";
export const DESIGN_GALLERY: boolean =
  typeof __QUEUEBIT_DESIGN__ === "boolean" ? __QUEUEBIT_DESIGN__ : env.DEV === true || env.VITE_QUEUEBIT_DESIGN === "1";

export const BUILD = { localDevnet: LOCAL_DEVNET, designGallery: DESIGN_GALLERY } as const;
