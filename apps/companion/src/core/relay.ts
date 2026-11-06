import { RelayClient, fingerprintWords, linkSecretOf, requestChannel, type Channel } from "@queuebit/relay-client";
import { decodeSignature, toHex } from "@queuebit/ur";

/**
 * The relay link to the browser (docs/design/onboarding-v2.md): the pairing code and each signature travel to the
 * browser end-to-end encrypted, so the browser never needs a camera. The relay URL is fixed at build time
 * (`VITE_QUEUEBIT_RELAY_URL`) and is the only origin the page's CSP lets it connect to; builds without one have no
 * relay at all (`connect-src 'none'`). Settings › "Offline phone (no relay)" turns it off at runtime.
 */
declare const __QUEUEBIT_RELAY_URL__: string | undefined;
export const RELAY_URL: string = typeof __QUEUEBIT_RELAY_URL__ === "string" ? __QUEUEBIT_RELAY_URL__ : "";

/** A browser this phone paired with over the relay: the secret its approval channels derive from. */
export interface BrowserLink {
  secret: string;
  linkedAt: number;
}
export const MAX_LINKS = 4;

export function relayAvailable(settings: { offline?: boolean }, url = RELAY_URL): boolean {
  return Boolean(url) && !settings.offline;
}

/** The 4 words both screens show after pairing. */
export const pairWords = (vaultPk: string, payer: string): string[] => fingerprintWords(vaultPk, payer);

/** Sends the pairing code over the pairing channel; returns the link to keep (newest first, at most MAX_LINKS). */
export async function sendPairing(
  client: RelayClient,
  channel: Channel,
  pairingUr: string,
  links: BrowserLink[],
  now = Date.now(),
): Promise<BrowserLink[]> {
  await client.send(channel, { t: "pair", ur: pairingUr });
  const secret = linkSecretOf(channel);
  return [{ secret, linkedAt: now }, ...links.filter((l) => l.secret !== secret)].slice(0, MAX_LINKS);
}

/**
 * Sends a signature to every linked browser, on the channel for its request id (only the browser that asked is
 * listening there). Resolves with how many sends worked; throws only if all failed.
 */
export async function sendSignature(
  client: RelayClient,
  links: BrowserLink[],
  signatureCbor: Uint8Array,
): Promise<number> {
  if (links.length === 0) return 0;
  const { requestId } = decodeSignature(signatureCbor);
  const cbor = toHex(signatureCbor);
  const results = await Promise.allSettled(
    links.map((l) => client.send(requestChannel(l.secret, requestId), { t: "sig", cbor })),
  );
  const ok = results.filter((r) => r.status === "fulfilled").length;
  if (ok === 0) throw (results[0] as PromiseRejectedResult).reason;
  return ok;
}

export const relayClient = (): RelayClient => new RelayClient(RELAY_URL);
