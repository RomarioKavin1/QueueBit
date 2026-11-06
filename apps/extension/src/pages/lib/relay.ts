import { useEffect, useRef, useState } from "react";
import { RelayClient, type Channel, type RelayMessage } from "@queuebit/relay-client";
import { BUILD_COMPANION_URL, BUILD_FAUCET_URL, BUILD_RELAY_URL, SHARED_DEVNET } from "../../shared/build";
import { sharedUi } from "./boot";

/**
 * Onboarding v2 plumbing for extension pages: where the relay and the phone's Vault app are, and a hook that waits
 * for the phone's message. Pages (not the service worker) poll the relay: they are open while the user waits, and
 * whatever arrives still goes through the service worker's own checks (`pair:vault`, `vault:submit`).
 */
export interface Endpoints {
  relay: string;
  companion: string;
  /** Gateway-style faucet (`?address=&chain=`), devnets only; "" when there is none. */
  faucet: string;
}

export function endpoints(): Endpoints | null {
  if (SHARED_DEVNET && sharedUi) return sharedUi.sharedEndpoints();
  if (BUILD_RELAY_URL && BUILD_COMPANION_URL)
    return { relay: BUILD_RELAY_URL, companion: BUILD_COMPANION_URL, faucet: BUILD_FAUCET_URL };
  return null;
}

/** The devnet faucet, if this build has one (shared devnet, or a local devnet build with a faucet URL). */
export function faucetUrl(): string {
  if (SHARED_DEVNET && sharedUi) return sharedUi.sharedEndpoints().faucet;
  return BUILD_FAUCET_URL;
}

export async function askFaucet(address: string, chainId: number): Promise<void> {
  const u = new URL(faucetUrl());
  u.searchParams.set("address", address);
  if (chainId !== 1337) u.searchParams.set("chain", String(chainId));
  let res: Response;
  try {
    res = await fetch(u.toString(), { cache: "no-store", credentials: "omit" });
  } catch {
    throw new Error("The faucet didn't answer. Try again in a moment.");
  }
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  if (!res.ok || body.error)
    throw new Error(typeof body.error === "string" ? `Faucet: ${body.error}` : `The faucet answered ${res.status}.`);
}

/**
 * Long-polls `channel` while it is set; calls `onMessage` once with the first message that decrypts. `status` is
 * "waiting" normally and "trouble" while the relay can't be reached (it keeps retrying).
 */
export function useRelayMessage(
  relay: string | undefined,
  channel: Channel | null,
  onMessage: (m: RelayMessage) => void,
): { status: "idle" | "waiting" | "trouble"; badMessage: boolean } {
  const [status, setStatus] = useState<"idle" | "waiting" | "trouble">("idle");
  const [badMessage, setBad] = useState(false);
  const cb = useRef(onMessage);
  cb.current = onMessage;
  const id = channel?.id;
  useEffect(() => {
    if (!relay || !channel) {
      setStatus("idle");
      return;
    }
    const ctl = new AbortController();
    const client = new RelayClient(relay);
    setStatus("waiting");
    setBad(false);
    client
      .waitFor(channel, {
        signal: ctl.signal,
        onBadMessage: () => setBad(true),
        onError: () => setStatus("trouble"),
      })
      .then((m) => {
        if (!ctl.signal.aborted) cb.current(m);
      })
      .catch(() => undefined);
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [relay, id]);
  return { status, badMessage };
}
