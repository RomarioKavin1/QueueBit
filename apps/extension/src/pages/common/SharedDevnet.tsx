import { useState } from "react";
import { browser } from "wxt/browser";
import { SHARED_DEVNET_BASE } from "../../shared/build";
import { requestFaucet, sharedOriginPattern, sharedUrls, SharedDevnetError } from "../../shared/sharedDevnet";
import { sharedDevnetState, setSharedBase } from "../../shared/sharedDevnetRuntime";
export { ensureSharedDevnet, sharedDevnetState } from "../../shared/sharedDevnetRuntime";
import { Button, RiskBanner, TextField } from "../../ui";

/**
 * Shared-devnet flavour only (callers render these under `SHARED_DEVNET`): the "Get test ETH" faucet buttons and
 * Settings › Shared devnet (the URL in use, the companion link, entering a new URL when the tunnel moved).
 */
const currentBase = () => sharedDevnetState().config?.base ?? SHARED_DEVNET_BASE;

/** The devnet's relay, companion and faucet (onboarding v2), from the base URL in use. */
export function sharedEndpoints(): { relay: string; companion: string; faucet: string } {
  const u = sharedUrls(currentBase());
  return { relay: `${currentBase().replace(/\/+$/u, "")}/relay`, companion: u.companion, faucet: u.faucet };
}

/** Asks (once, from the click) for access to the devnet's origin. Requests also work without it (the devnet sends CORS). */
function askHostPermission(base: string) {
  try {
    void browser.permissions.request({ origins: [sharedOriginPattern(base)] }).catch(() => undefined);
  } catch {
    // not available in this context
  }
}

export function FaucetCard({
  chainId,
  targets,
  onFunded,
}: {
  chainId: number;
  /** What to fund: e.g. the fee tank (activation and everyday fees) and the account itself. */
  targets: { label: string; address: string }[];
  onFunded?: () => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (chainId !== 1337 && chainId !== 31337) return null;
  const run = async (t: { label: string; address: string }) => {
    const base = currentBase();
    askHostPermission(base);
    setBusy(t.address);
    setMsg(null);
    try {
      await requestFaucet(base, t.address, chainId, fetch.bind(globalThis));
      setMsg({
        ok: true,
        text: `1 test ETH is on its way to your ${t.label.toLowerCase()}. It arrives in a few seconds.`,
      });
      onFunded?.();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof SharedDevnetError ? e.message : "The faucet didn't answer. Try again." });
    } finally {
      setBusy(null);
    }
  };
  return (
    <section
      aria-labelledby="faucet-h"
      className="flex flex-col gap-2 rounded-md border border-line p-3"
      data-testid="faucet"
    >
      <h2 id="faucet-h" className="t-strong">
        Get test ETH
      </h2>
      <p className="t-small text-muted">
        Free test money from the shared devnet&apos;s faucet: 1 ETH per request, one request per 10 minutes.
      </p>
      <div className="flex flex-wrap gap-2">
        {targets.map((t) => (
          <Button
            key={t.address}
            size="sm"
            variant="secondary"
            loading={busy === t.address}
            disabled={busy !== null}
            onClick={() => void run(t)}
          >
            {`Get test ETH: ${t.label}`}
          </Button>
        ))}
      </div>
      {msg && (
        <p role="status" className={`t-small ${msg.ok ? "text-muted" : "text-limit"}`} data-testid="faucet-result">
          {msg.text}
        </p>
      )}
    </section>
  );
}

export function SharedDevnetSection() {
  const st = sharedDevnetState();
  const base = currentBase();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const urls = (() => {
    try {
      return sharedUrls(base);
    } catch {
      return undefined;
    }
  })();
  return (
    <section className="flex flex-col gap-2" aria-labelledby="shared-h" data-testid="settings-shared-devnet">
      <h2 id="shared-h" className="t-small font-semibold tracking-wide text-muted uppercase">
        Shared devnet
      </h2>
      <p className="t-small break-all">
        Connected to <span className="t-mono">{base}</span>
      </p>
      {st.error ? (
        <RiskBanner level="limit" title="The shared devnet isn't available" body={st.error} />
      ) : (
        <p className="t-small text-muted">Contract addresses loaded and checked against this build.</p>
      )}
      {urls && (
        <p className="t-small text-muted">
          Vault app for your phone:{" "}
          <a className="underline underline-offset-2" href={urls.companion} target="_blank" rel="noreferrer">
            {urls.companion}
          </a>
        </p>
      )}
      {open ? (
        <div className="flex flex-col gap-2">
          <TextField
            label="New shared devnet URL"
            placeholder="https://….trycloudflare.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            description="The URL changes when the devnet's tunnel restarts. QueueBit checks the new one before using it, then restarts."
            {...(error ? { error } : {})}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              loading={busy}
              onClick={async () => {
                setError(null);
                try {
                  askHostPermission(value);
                } catch {
                  // normalizeBase below reports a bad URL
                }
                setBusy(true);
                try {
                  await setSharedBase(value);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "That URL didn't work.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              Check and use
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          The URL changed
        </Button>
      )}
    </section>
  );
}
