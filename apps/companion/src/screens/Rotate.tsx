import { useState } from "react";
import { useNav, useStore } from "../app/state.js";
import { keyState, nextChainScope } from "../app/vaultKey.js";
import { last8 } from "../core/format.js";
import { keyNumberOf } from "../core/keys.js";
import { CheckIcon, RecoveryIcon, RotateIcon, VaultIcon } from "../ui/icons.js";
import { Banner, Button, Card, KeyCheck, PassphraseField, ProgressBar, Screen } from "../ui/kit.js";
import { StaticQr } from "../ui/qr.js";
import { call, type WorkerError } from "../worker/client.js";
import { pairingUr } from "./Onboarding.js";
import { healthText } from "./Vault.js";

/**
 * Replace the Vault key (leanSphincs-s usage guard; pq-signer README "Usage counter and key rotation"). The new key
 * comes from the same 24 words with the next derivation label (key #n+1), so there is nothing new to back up. On chain
 * the switch is the Recovery key's "Replace the Vault" (7 days, ux-spec J7): the browser builds it with the new key's
 * pairing code. Until the browser's requests name the new key, this phone keeps approving with the old one (unless
 * the old one is used up); the first request for the new key switches this phone over.
 */
export function Rotate() {
  const nav = useNav();
  const store = useStore();
  const v = store.vault!;
  const k = keyState(v);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const h = healthText(k);

  const prepare = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const chainScope = nextChainScope(v);
      const r = await call({
        op: "prepareKey",
        sealed: v.sealed,
        vaultPk: v.sealedFor ?? v.vaultPk,
        passphrase: pass,
        schemeId: v.schemeId,
        chainScope,
      });
      setPass("");
      await store.saveVault({
        ...v,
        next: { chainScope, pk: r.pk, ...(r.usage ? { usage: r.usage } : {}), preparedAt: Date.now() },
      });
    } catch (e) {
      setError((e as WorkerError).message);
    } finally {
      setBusy(false);
    }
  };

  const step = (done: boolean, n: number, icon: React.ReactNode, title: string, body: React.ReactNode) => (
    <li className="flex gap-3">
      <span
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${done ? "bg-safe text-on-safe" : "bg-vault-bg text-vault"}`}
        aria-hidden="true"
      >
        {done ? <CheckIcon size={18} /> : icon}
      </span>
      <div className="min-w-0">
        <p className="t-strong">
          <span className="sr-only">{done ? "Done: " : `Step ${n}: `}</span>
          {title}
        </p>
        <div className="t-body text-muted">{body}</div>
      </div>
    </li>
  );

  const nextNumber = v.next ? keyNumberOf(v.next.chainScope) : k.keyNumber + 1;
  return (
    <Screen title="Replace the Vault key" onBack={nav.back}>
      <Card className="flex flex-col gap-2">
        <p className="t-small text-muted">Current key #{k.keyNumber}</p>
        <p className="t-strong" data-testid="rotate-state">
          {h.text}
        </p>
        {k.status && !k.status.unknown && (
          <ProgressBar value={Math.min(1, k.status.fraction)} label="Safe signatures used" />
        )}
        <p className="t-small text-muted">
          This key type allows about {k.scheme.SIGNATURE_BUDGET.toLocaleString("en-US")} safe signatures per key. A new
          key starts from zero. Nothing new to write down: it comes from your same 24 words.
        </p>
      </Card>

      <ol className="flex flex-col gap-4" aria-label="Steps">
        {step(
          !!v.next,
          1,
          <RotateIcon size={18} />,
          v.next ? `New key #${nextNumber} made on this phone` : `Make key #${nextNumber} on this phone`,
          v.next ? (
            <>
              It ends in <span className="t-mono">…{last8(v.next.pk)}</span>.
            </>
          ) : (
            "Takes a second. Needs your passphrase."
          ),
        )}
        {step(
          false,
          2,
          <VaultIcon size={18} />,
          "Show it to the browser",
          "In the browser: Security › Replace the Vault, then scan the new key's code below and check the last 8 characters.",
        )}
        {step(
          false,
          3,
          <RecoveryIcon size={18} />,
          "Approve the switch with your Recovery key",
          "On this phone: Recovery key › Use Recovery key, then scan the browser's request. It takes effect after 7 days; everyday spending is paused until then.",
        )}
      </ol>

      {!v.next ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void prepare();
          }}
        >
          <PassphraseField
            label="Passphrase"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            error={error}
            data-testid="rotate-pass"
          />
          <Button type="submit" variant="vault" disabled={busy || pass.length === 0} data-testid="rotate-prepare">
            {busy ? "Making the new key…" : `Make key #${nextNumber}`}
          </Button>
        </form>
      ) : (
        <section className="flex flex-col gap-3" data-testid="rotate-pair">
          <p className="t-body">Check the browser shows the same last 8 characters:</p>
          <KeyCheck value={last8(v.next.pk)} />
          <StaticQr
            text={pairingUr(v.next.pk, v.payerAddress, v.schemeId)}
            label="New Vault key code for the browser"
          />
          <Banner level="info" title="Until the browser switches">
            {k.status && (k.status.level === "exceeded" || k.status.unknown)
              ? "The old key can't approve any more. Requests for the new key work as soon as the browser sends them."
              : "This phone keeps approving with the old key. The first request the browser makes for the new key switches this phone over by itself."}
          </Banner>
        </section>
      )}
      <Button variant="secondary" onClick={nav.back}>
        Done
      </Button>
    </Screen>
  );
}
