/**
 * Build flavour, fixed at build time (Vite replaces `import.meta.env.*`).
 *  - `VITE_LEAKED_LOCAL_DEVNET=1`: chain 1337 is the local devnet fork (devnet/) with the devnet/deploy contracts.
 *    Used by the e2e suite and local development.
 *  - The design gallery (`app.html#design`) exists in development and when `VITE_LEAKED_DESIGN=1` (screenshots);
 *    production builds do not ship it.
 */
const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};

export const BUILD = {
  localDevnet: env.VITE_LEAKED_LOCAL_DEVNET === "1",
  designGallery: env.DEV === true || env.VITE_LEAKED_DESIGN === "1",
} as const;
