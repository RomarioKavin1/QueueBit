/**
 * Build flavour, fixed at build time.
 *  - `VITE_QUEUEBIT_LOCAL_DEVNET=1`: chain 1337 is the local devnet fork (devnet/) with the devnet/deploy contracts.
 *    Used by the e2e suite and local development.
 *  - `VITE_QUEUEBIT_SHARED_BASE=https://….trycloudflare.com` (`build:shared`): the "QueueBit devnet (shared)" flavour
 *    for friends: chain 1337 (frame backend) and the 4337 chain point at that public devnet, and the contract
 *    addresses are read from `<base>/addresses.json` at runtime and checked before use (src/shared/sharedDevnet.ts).
 *  - The design gallery (`app.html#design`) exists in development and when `VITE_QUEUEBIT_DESIGN=1` (screenshots);
 *    production builds do not ship it.
 * The extension build (wxt.config.ts) replaces `__QUEUEBIT_LOCAL_DEVNET__` / `__QUEUEBIT_DESIGN__` with literals, so a
 * production bundle folds every `BUILD.*` branch away and carries no devnet or gallery code (checked by
 * scripts/release-check.mjs). Outside that build (vitest, scripts) the flags come from `import.meta.env`.
 */
declare const __QUEUEBIT_LOCAL_DEVNET__: boolean | undefined;
declare const __QUEUEBIT_DESIGN__: boolean | undefined;
declare const __QUEUEBIT_SHARED_BASE__: string | undefined;
declare const __QUEUEBIT_SHARED_DEVNET__: boolean | undefined;
declare const __QUEUEBIT_RELAY_URL__: string | undefined;
declare const __QUEUEBIT_COMPANION_URL__: string | undefined;
declare const __QUEUEBIT_FAUCET_URL__: string | undefined;

const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env ?? {};

/** Use these (not `BUILD.*`) in a branch that must vanish from a production bundle: the bundler inlines them. */
export const LOCAL_DEVNET: boolean =
  typeof __QUEUEBIT_LOCAL_DEVNET__ === "boolean" ? __QUEUEBIT_LOCAL_DEVNET__ : env.VITE_QUEUEBIT_LOCAL_DEVNET === "1";
export const DESIGN_GALLERY: boolean =
  typeof __QUEUEBIT_DESIGN__ === "boolean" ? __QUEUEBIT_DESIGN__ : env.DEV === true || env.VITE_QUEUEBIT_DESIGN === "1";

/** The shared-devnet flavour: guard every shared-only branch with this boolean (it folds away like LOCAL_DEVNET). */
export const SHARED_DEVNET: boolean =
  typeof __QUEUEBIT_SHARED_DEVNET__ === "boolean" ? __QUEUEBIT_SHARED_DEVNET__ : false;
/** The shared devnet's default public base URL ("" outside the shared flavour). A value, not a guard. */
export const SHARED_DEVNET_BASE: string = typeof __QUEUEBIT_SHARED_BASE__ === "string" ? __QUEUEBIT_SHARED_BASE__ : "";

export const BUILD = {
  localDevnet: LOCAL_DEVNET,
  designGallery: DESIGN_GALLERY,
  sharedDevnet: SHARED_DEVNET,
} as const;

/**
 * Onboarding v2 endpoints fixed at build time outside the shared flavour (which derives them from its base URL):
 * `VITE_QUEUEBIT_RELAY_URL` (the relay), `VITE_QUEUEBIT_COMPANION_URL` (where the phone's camera opens the pairing
 * link) and, on a local devnet, `VITE_QUEUEBIT_FAUCET_URL` (the gateway-style `?address=` faucet). "" when unset.
 */
const str = (v: unknown, k: string): string =>
  typeof v === "string" ? v : typeof env[k] === "string" ? (env[k] as string) : "";
export const BUILD_RELAY_URL: string = str(
  typeof __QUEUEBIT_RELAY_URL__ === "string" ? __QUEUEBIT_RELAY_URL__ : undefined,
  "VITE_QUEUEBIT_RELAY_URL",
);
export const BUILD_COMPANION_URL: string = str(
  typeof __QUEUEBIT_COMPANION_URL__ === "string" ? __QUEUEBIT_COMPANION_URL__ : undefined,
  "VITE_QUEUEBIT_COMPANION_URL",
);
export const BUILD_FAUCET_URL: string = str(
  typeof __QUEUEBIT_FAUCET_URL__ === "string" ? __QUEUEBIT_FAUCET_URL__ : undefined,
  "VITE_QUEUEBIT_FAUCET_URL",
);
