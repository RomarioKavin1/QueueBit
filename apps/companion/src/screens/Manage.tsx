import { PK_LENGTH, SIGNATURE_BUDGET, WASM_HASH, schemes } from "@leaked/pq-signer";
import { randomUuid } from "@leaked/ur";
import { useEffect, useState } from "react";
import { getAddress, isAddress, type Address } from "viem";
import { useNav, useStore } from "../app/state.js";
import { keyState } from "../app/vaultKey.js";
import type { LogEntry } from "../core/db.js";
import { REGISTRY_HASH, REGISTRY_VERSION, chainName } from "../core/registry.js";
import { last8, shortHex } from "../core/format.js";
import { BookIcon, LockIcon, ShieldIcon, TrashIcon } from "../ui/icons.js";
import {
  AddressBlock,
  Banner,
  Button,
  Card,
  IconButton,
  PassphraseField,
  ProgressBar,
  Row,
  Screen,
  Sheet,
  TextField,
} from "../ui/kit.js";
import { Scanner } from "../ui/Scanner.js";
import { UpdateBanner, buildLabel, useAppUpdate } from "../ui/update.js";
import { call, terminate, type WorkerError } from "../worker/client.js";
import { healthText } from "./Vault.js";

// ---------------------------------------------------------------------------------------------------------------
// Address book (ux-spec §4.9): typed or scanned here; never imported from a request.
// ---------------------------------------------------------------------------------------------------------------

export function AddressBook() {
  const nav = useNav();
  const store = useStore();
  const [adding, setAdding] = useState(false);
  const [toDelete, setToDelete] = useState<string>();
  const entries = [...store.addressBook].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <Screen title="Address book" onBack={nav.back}>
      <p className="t-body text-muted">
        When an approval pays one of these addresses, this phone shows the name. Names never come from the browser.
      </p>
      {entries.length === 0 ? (
        <Card className="flex flex-col items-center gap-2 py-8 text-center">
          <BookIcon size={32} className="text-muted" />
          <p className="t-strong">No addresses yet</p>
          <p className="t-small text-muted">Add the people and services you pay often.</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="book-list">
          {entries.map((e) => (
            <li key={e.id} className="flex items-start gap-2">
              <div className="min-w-0 flex-1">
                <AddressBlock address={e.address} name={e.name} />
                <p className="mt-1 t-small text-muted">
                  {e.chains.length === 0 ? "All networks" : e.chains.map((c) => chainName(BigInt(c))).join(", ")} ·
                  added {new Date(e.addedAt).toLocaleDateString()}
                </p>
              </div>
              <IconButton label={`Delete ${e.name}`} onClick={() => setToDelete(e.id)}>
                <TrashIcon />
              </IconButton>
            </li>
          ))}
        </ul>
      )}
      <Button onClick={() => setAdding(true)} data-testid="book-add">
        Add an address
      </Button>
      {adding && (
        <AddSheet
          onClose={() => setAdding(false)}
          onSave={async (name, address, chains) => {
            await store.saveAddressBook([
              ...store.addressBook,
              { id: randomUuid(), name, address, chains, addedAt: Date.now() },
            ]);
            setAdding(false);
          }}
        />
      )}
      {toDelete && (
        <Sheet title="Delete this address?" onClose={() => setToDelete(undefined)}>
          <div className="flex flex-col gap-2 pb-2">
            <p className="t-body">Approvals to it will show the bare address and a “new recipient” badge.</p>
            <Button
              variant="danger"
              onClick={async () => {
                await store.saveAddressBook(store.addressBook.filter((e) => e.id !== toDelete));
                setToDelete(undefined);
              }}
            >
              Delete
            </Button>
            <Button variant="secondary" onClick={() => setToDelete(undefined)}>
              Keep it
            </Button>
          </div>
        </Sheet>
      )}
    </Screen>
  );
}

function AddSheet({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (name: string, a: Address, chains: number[]) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [addr, setAddr] = useState("");
  const [scan, setScan] = useState(false);
  const [tried, setTried] = useState(false);
  const clean =
    addr
      .trim()
      .replace(/^ethereum:/i, "")
      .split(/[@?]/)[0] ?? "";
  const validAddr = isAddress(clean, { strict: false });
  const errAddr = tried && !validAddr ? "That doesn't look like an address." : undefined;
  const errName = tried && !name.trim() ? "Give it a name you'll recognise." : undefined;
  return (
    <Sheet title="Add an address" onClose={onClose}>
      <form
        className="flex flex-col gap-3 pb-2"
        onSubmit={(e) => {
          e.preventDefault();
          setTried(true);
          if (validAddr && name.trim()) void onSave(name.trim().slice(0, 40), getAddress(clean), []);
        }}
      >
        <TextField
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errName}
          autoComplete="off"
          data-testid="book-name"
        />
        {scan ? (
          <Scanner
            hint="Scan an address code from a different device or a printed invoice."
            onText={(t) => {
              setAddr(t);
              setScan(false);
            }}
          />
        ) : (
          <TextField
            label="Address"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            error={errAddr}
            spellCheck={false}
            autoCapitalize="off"
            autoComplete="off"
            placeholder="0x…"
            hint="Type it, or scan it from a different channel than the browser asking for approvals."
            data-testid="book-address"
          />
        )}
        {!scan && (
          <Button variant="secondary" onClick={() => setScan(true)}>
            Scan an address code
          </Button>
        )}
        <Button type="submit" data-testid="book-save">
          Save
        </Button>
      </form>
    </Sheet>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Key health
// ---------------------------------------------------------------------------------------------------------------

export function Health() {
  const nav = useNav();
  const store = useStore();
  const v = store.vault!;
  const k = keyState(v);
  const h = healthText(k);
  const st = k.status;
  return (
    <Screen title="Key health" onBack={nav.back}>
      <Card className="flex items-start gap-3">
        <ShieldIcon
          size={28}
          className={`shrink-0 ${{ safe: "text-safe", limit: "text-limit", danger: "text-danger" }[h.tone]}`}
        />
        <div className="min-w-0 flex-1">
          <p className="t-title" data-testid="health-state">
            {h.text}
          </p>
          {!k.counted ? (
            <>
              <p className="mt-1 t-body">
                Your Vault key is <strong>stateless</strong>: every signature is independent, so there is no signature
                counter to keep, lose or back up. Restoring from your words, or keeping a copy on a second phone, can
                never make it unsafe.
              </p>
              <p className="mt-2 t-small text-muted">
                The design limit is {SIGNATURE_BUDGET.toLocaleString("en-US")} signatures per key across all copies:
                more than 1,000 years at 10 approvals a day.
              </p>
            </>
          ) : (
            st && (
              <>
                <div className="mt-2">
                  <ProgressBar value={Math.min(1, st.fraction)} label="Safe signatures used" />
                </div>
                <p className="mt-2 t-body" data-testid="health-count">
                  {st.unknown
                    ? "Unknown: this key was restored from words and may have signed on another phone."
                    : `${st.used.toLocaleString("en-US")} of ${st.budget.toLocaleString("en-US")} safe signatures used (${Math.floor(st.fraction * 100)}%).`}
                </p>
                <p className="mt-1 t-small text-muted">
                  This key type has a limited number of safe signatures per key. This phone counts every signature it
                  makes (a retry counts too) and asks you to replace the key at 90%; at 100% it stops. The count lives
                  on this phone only: if you restore the phone from a backup, the count goes back with it, so replace
                  the key after any such restore.
                  {st.estimatedSecurityBits !== undefined &&
                    Number.isFinite(st.estimatedSecurityBits) &&
                    !st.unknown &&
                    ` Estimated security now: about ${Math.floor(st.estimatedSecurityBits)} bits (an estimate, not a proof).`}
                </p>
              </>
            )
          )}
        </div>
      </Card>
      {k.counted && (
        <Button
          variant={st && st.level !== "ok" ? "vault" : "secondary"}
          onClick={() => nav.push({ name: "rotate" })}
          data-testid="health-rotate"
        >
          {v.next ? "See the replacement steps" : "Replace the key"}
        </Button>
      )}
      {k.scheme.experimental && (
        <Banner level="limit" title={k.scheme.warning ?? "Experimental key type"}>
          Not for real funds. The on-chain checker for this key type has no formal proof yet.
        </Banner>
      )}
      {v.restored && !k.counted && (
        <Banner level="info" title="Restored from words">
          This key may also exist on another phone. That is safe for this key type.
        </Banner>
      )}
      <dl className="divide-y divide-line rounded-md border border-line px-3">
        <Row label="Scheme" value={`${k.scheme.name} (hash-based, quantum-safe)`} />
        <Row label="Scheme id" value={shortHex(k.scheme.SCHEME_ID, 8)} mono />
        <Row label="Signature size" value={`${k.scheme.SIG_LENGTH.toLocaleString("en-US")} bytes`} />
        {k.counted && <Row label="Key number" value={`#${k.keyNumber}`} />}
        <Row label="Public key" value={<span data-testid="health-pk">{v.vaultPk}</span>} mono />
        <Row label="Key size" value={`${PK_LENGTH} bytes`} />
        <Row label="Ends in" value={`…${last8(v.vaultPk)}`} mono />
        {v.next && <Row label="Replacement key ends in" value={`…${last8(v.next.pk)}`} mono />}
        <Row label="Fee-payment address" value={v.payerAddress} mono />
        <Row label="Fee-payment key" value="classical (secp256k1): used only for the network fee step" />
        <Row label="Created on this phone" value={new Date(v.createdAt).toLocaleString()} />
        <Row label="Signing time here" value={v.signMs ? `${(v.signMs / 1000).toFixed(1)} s` : "not measured yet"} />
      </dl>
    </Screen>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Settings and about
// ---------------------------------------------------------------------------------------------------------------

function useServiceWorkerState(): string {
  const [s, setS] = useState("checking…");
  useEffect(() => {
    if (!("serviceWorker" in navigator)) {
      setS("not supported in this browser");
      return;
    }
    navigator.serviceWorker
      .getRegistration()
      .then((r) => setS(r?.active ? "ready: works without a connection" : "not installed yet"));
  }, []);
  return s;
}

function Segmented<T extends string>({
  legend,
  name,
  options,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  options: readonly (readonly [T, string])[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset
      className="grid gap-1 rounded-md bg-surface p-1"
      style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
    >
      <legend className="sr-only">{legend}</legend>
      {options.map(([t, label]) => (
        <label
          key={t}
          className={`tap flex cursor-pointer items-center justify-center rounded-sm text-center t-strong ${value === t ? "bg-bg" : "text-muted"}`}
        >
          <input type="radio" className="sr-only" name={name} checked={value === t} onChange={() => onChange(t)} />
          {label}
        </label>
      ))}
    </fieldset>
  );
}

export function Settings() {
  const nav = useNav();
  const store = useStore();
  const sw = useServiceWorkerState();
  const update = useAppUpdate();
  const [erase, setErase] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  return (
    <Screen title="Settings and about" onBack={nav.back}>
      <UpdateBanner />
      <Card className="flex flex-col gap-1">
        <p className="t-small text-muted">This app's build</p>
        <p className="t-title t-mono break-all" data-testid="build-id">
          {buildLabel(update.running)}
        </p>
        <p className="t-small text-muted">
          Commit · fingerprint of every file. Updates never install by themselves: when a new build is ready you'll see
          both ids and choose.
        </p>
      </Card>

      <section className="flex flex-col gap-2">
        <h2 className="t-strong">Appearance</h2>
        <Segmented
          legend="Theme"
          name="theme"
          options={[
            ["system", "System"],
            ["light", "Light"],
            ["dark", "Dark"],
          ]}
          value={store.settings.theme}
          onChange={(t) => void store.saveSettings({ ...store.settings, theme: t })}
        />
        <h2 className="mt-2 t-strong">Animated code speed</h2>
        <Segmented
          legend="Speed"
          name="speed"
          options={[
            ["normal", "Normal"],
            ["slow", "Slow (older webcams)"],
          ]}
          value={store.settings.qrSpeed}
          onChange={(t) => void store.saveSettings({ ...store.settings, qrSpeed: t })}
        />
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="t-strong">Experimental</h2>
        <label className="tap flex cursor-pointer items-start gap-3 rounded-md border border-line px-3 py-3">
          <input
            type="checkbox"
            className="mt-1 shrink-0 accent-[var(--vault)]"
            checked={!!store.settings.experimental}
            onChange={(e) => void store.saveSettings({ ...store.settings, experimental: e.target.checked })}
            data-testid="experimental-toggle"
          />
          <span>
            <span className="block t-strong">Offer experimental key types</span>
            <span className="block t-small text-muted">
              Adds leanSphincs-s when you create or restore a Vault. {schemes.leanSphincsS.warning}.
            </span>
          </span>
        </label>
      </section>

      <section>
        <h2 className="mb-1 t-strong">About</h2>
        <dl className="divide-y divide-line rounded-md border border-line px-3" data-testid="about">
          <Row label="App" value={`LEAKED Vault ${__APP_VERSION__}`} />
          <Row label="Network access" value="none: the app's security policy blocks every connection" />
          <Row label="Leaving the app" value="links and pages that would open another site are blocked" />
          <Row label="Offline" value={sw} />
          <Row label="Clear-signing registry" value={REGISTRY_VERSION} />
          <Row label="Registry fingerprint" value={shortHex(REGISTRY_HASH, 8)} mono />
          <Row label="Signer (WASM) sha256" value={shortHex(`0x${WASM_HASH.replace(/^0x/, "")}`, 8)} mono />
          <Row label="Build" value={buildLabel(update.running)} mono />
        </dl>
        <p className="mt-2 t-small text-muted">
          Not audited. The quantum-safe scheme and its on-chain verifier are research software: don't keep more than you
          can afford to lose.
        </p>
      </section>

      {store.vault && store.logCount > 0 && <Activity />}

      {store.vault && (
        <section className="mt-4 flex flex-col gap-2">
          <h2 className="t-strong text-danger">Danger zone</h2>
          <Button variant="secondary" className="!text-danger" onClick={() => setErase(true)}>
            Erase this Vault from this phone
          </Button>
        </section>
      )}
      {erase && (
        <Sheet title="Erase this Vault?" onClose={() => setErase(false)}>
          <div className="flex flex-col gap-3 pb-2">
            <Banner level="danger" title="Only with your 24 words can you get it back.">
              Erasing removes the key, address book and history from this phone.
            </Banner>
            <TextField
              label="Type ERASE to confirm"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              autoComplete="off"
            />
            <Button
              variant="danger"
              disabled={confirmText.trim().toUpperCase() !== "ERASE"}
              onClick={async () => {
                terminate();
                await store.eraseAll();
                nav.reset({ name: "welcome" });
              }}
            >
              Erase
            </Button>
          </div>
        </Sheet>
      )}
    </Screen>
  );
}

/** The activity log, encrypted on this phone: opened with the passphrase, shown, forgotten when you leave. */
function Activity() {
  const store = useStore();
  const v = store.vault!;
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [entries, setEntries] = useState<LogEntry[]>();
  const unlockLog = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const raw = await store.logForUnlock();
      const r = await call({
        op: "readLog",
        sealed: v.sealed,
        vaultPk: v.sealedFor ?? v.vaultPk,
        passphrase: pass,
        entries: raw.sealed,
        legacy: raw.legacy,
        wantLogKey: !v.logKey,
        ...(v.logKey ? { logKey: v.logKey.sealed } : {}),
      });
      setPass("");
      if (r.logKey) await store.saveVault({ ...v, logKey: r.logKey });
      if (raw.legacy.length > 0 && r.resealed.length === raw.legacy.length) await store.replaceLegacyLog(r.resealed);
      setEntries(r.entries);
    } catch (e) {
      setError((e as WorkerError).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="rounded-md border border-line px-3 py-2" data-testid="activity">
      <button
        type="button"
        className="tap flex w-full items-center justify-between t-strong"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        <span className="inline-flex items-center gap-2">
          <LockIcon size={18} /> Activity on this phone ({store.logCount})
        </span>
        <span className="t-small font-normal text-muted">{entries ? "unlocked" : "encrypted"}</span>
      </button>
      {open && !entries && (
        <form
          className="mt-2 flex flex-col gap-2 pb-1"
          onSubmit={(e) => {
            e.preventDefault();
            void unlockLog();
          }}
        >
          <p className="t-small text-muted">
            The history (amounts, recipients) is stored encrypted. Enter your passphrase to read it here.
          </p>
          <PassphraseField
            label="Passphrase"
            value={pass}
            onChange={(e) => setPass(e.target.value)}
            error={error}
            data-testid="activity-pass"
          />
          <Button type="submit" variant="secondary" disabled={busy || pass.length === 0} data-testid="activity-unlock">
            {busy ? "Unlocking…" : "Show activity"}
          </Button>
        </form>
      )}
      {open && entries && (
        <ul className="mt-2 flex flex-col gap-2 pb-1" data-testid="activity-list">
          {[...entries]
            .reverse()
            .slice(0, 50)
            .map((e, i) => (
              <li key={i} className="t-small">
                <span className="text-muted">{new Date(e.at).toLocaleString()} · </span>
                <span className={e.kind === "signed-unknown" ? "text-danger" : ""}>
                  {e.kind.replace("-", " ")}
                </span>: {e.summary}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
