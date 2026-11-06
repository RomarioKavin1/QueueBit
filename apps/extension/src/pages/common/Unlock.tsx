import { useEffect, useRef, useState } from "react";
import { Button, LogoMark, PasswordField, Sheet } from "../../ui";
import { call, UiCallError } from "../lib/api";

/** ux-spec §3.14: password only, scrypt progress hint after 1 s, and a way out that keeps the money safe. */
export function UnlockForm({ onUnlocked, compact }: { onUnlocked?: () => void; compact?: boolean }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setBusy(true);
    setError(null);
    const t = setTimeout(() => setSlow(true), 1000);
    try {
      await call("keyring:unlock", { password });
      setPassword("");
      onUnlocked?.();
    } catch (err) {
      setError(err instanceof UiCallError ? err.message : "That password didn't work.");
      inputRef.current?.select();
    } finally {
      clearTimeout(t);
      setSlow(false);
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {!compact && (
        <div className="flex flex-col items-center gap-3 pt-6 pb-2 text-center">
          <LogoMark size={56} />
          <div>
            <h1 className="t-title">Welcome back</h1>
            <p className="t-small text-muted">Unlock QueueBit in this browser.</p>
          </div>
        </div>
      )}
      <form onSubmit={submit} className="flex flex-col gap-3" aria-label="Unlock QueueBit">
        <PasswordField
          ref={inputRef}
          label="Password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={error ?? undefined}
          description={slow ? "Checking your password… this takes a second or two." : undefined}
        />
        <Button type="submit" block loading={busy} loadingLabel="Unlocking…" disabled={!password}>
          Unlock
        </Button>
      </form>
      <p className="t-small text-center text-muted">
        Forgot it?{" "}
        <button type="button" className="text-brand underline underline-offset-2" onClick={() => setResetOpen(true)}>
          Reset this browser
        </button>{" "}
        (your money stays in the account)
      </p>
      <ResetSheet open={resetOpen} onClose={() => setResetOpen(false)} />
    </div>
  );
}

export function ResetSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet open={open} title="Reset this browser?" onClose={onClose}>
      <p className="t-body">
        Removes the everyday key from this browser. Your money stays in the account; your phone and Recovery key are
        untouched.
      </p>
      <p className="t-small mt-2 text-muted">
        Without a Vault yet, the only way back to this account is your everyday backup words. Make sure you have them.
      </p>
      <div className="mt-4 flex gap-2">
        <Button variant="secondary" block onClick={onClose}>
          Go back
        </Button>
        <Button
          variant="destructive"
          block
          loading={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await call("keyring:reset");
              onClose();
            } finally {
              setBusy(false);
            }
          }}
        >
          Reset browser
        </Button>
      </div>
    </Sheet>
  );
}
