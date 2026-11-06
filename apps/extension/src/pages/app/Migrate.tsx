import { useState } from "react";
import { getNetwork } from "../../shared/chains";
import type { MigrationRequest } from "../../shared/messages";
import type { WalletState } from "../../shared/types";
import type { MigrationPreview } from "../../shared/views";
import { AddressChip, Button, Card, PasswordField, RiskBanner, TextField } from "../../ui";
import { cx } from "../../ui/cx";
import { formatAmount } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { eth } from "../lib/money";

type Kind = MigrationRequest["kind"];

const KINDS: Array<{ id: Kind; label: string; body: string }> = [
  { id: "eoa", label: "An ordinary address", body: "MetaMask or any wallet with a private key." },
  { id: "safe", label: "A Safe", body: "Its owners' keys sign one transaction that moves everything." },
  {
    id: "smart-account",
    label: "Another smart account",
    body: "One with an owner key; upgraded in place when it can be.",
  },
];

/**
 * Move to quantum-safe: bring an address's money into your account. The keys typed here are used for this move
 * only and never stored.
 */
export function Migrate({ state }: { state: WalletState }) {
  const chainId = state.settings.selectedChainId;
  const net = getNetwork(chainId);
  const [kind, setKind] = useState<Kind>("eoa");
  const [address, setAddress] = useState("");
  const [keys, setKeys] = useState<string[]>([""]);
  const [keepAddress, setKeepAddress] = useState(false);
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [busy, setBusy] = useState<"preview" | "run" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string[] | null>(null);

  const req = (): MigrationRequest => ({
    chainId,
    kind,
    ...(address.trim() ? { address: address.trim() as `0x${string}` } : {}),
    ...(kind === "eoa" && keepAddress ? { keepAddress: true } : {}),
    keys: keys
      .map((k) => k.trim())
      .filter(Boolean)
      .map((k) => (k.startsWith("0x") ? k : `0x${k}`) as `0x${string}`),
  });
  const reset = () => (setPreview(null), setDone(null), setError(null));

  return (
    <div className="flex max-w-[640px] flex-col gap-5">
      <div>
        <h1 className="text-[24px] leading-[30px] font-semibold">Move to quantum-safe</h1>
        <p className="t-body mt-1 text-muted">
          Bring money from another address on {net.name} into your quantum-safe account.
        </p>
      </div>

      <fieldset className="grid gap-2 sm:grid-cols-3">
        <legend className="t-strong mb-2">Move from</legend>
        {KINDS.map((k) => (
          <label
            key={k.id}
            className={cx(
              "flex cursor-pointer flex-col gap-1 rounded-md border p-3",
              kind === k.id ? "border-brand bg-surface" : "border-line",
            )}
          >
            <input
              type="radio"
              name="kind"
              className="sr-only"
              checked={kind === k.id}
              onChange={() => (setKind(k.id), setKeys([""]), reset())}
            />
            <span className="t-strong">{k.label}</span>
            <span className="t-small text-muted">{k.body}</span>
          </label>
        ))}
      </fieldset>

      {kind !== "eoa" && (
        <TextField
          label={kind === "safe" ? "Safe address" : "Account address"}
          value={address}
          onChange={(e) => (setAddress(e.target.value), reset())}
          placeholder="0x…"
          spellCheck={false}
        />
      )}
      {keys.map((k, i) => (
        <PasswordField
          key={i}
          label={kind === "safe" ? `Owner key ${i + 1}` : kind === "eoa" ? "The address's private key" : "Owner key"}
          value={k}
          autoComplete="off"
          onChange={(e) => {
            const next = [...keys];
            next[i] = e.target.value;
            setKeys(next);
            reset();
          }}
          description={i === 0 ? "Used for this move only, never stored." : undefined}
        />
      ))}
      {kind === "safe" && (
        <Button variant="secondary" size="sm" className="self-start" onClick={() => setKeys([...keys, ""])}>
          Add another owner key
        </Button>
      )}
      {kind === "eoa" && (
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            className="mt-1 size-4 accent-[var(--brand)]"
            checked={keepAddress}
            onChange={(e) => (setKeepAddress(e.target.checked), reset())}
          />
          <span>
            <span className="t-strong block">Keep the same address instead (advanced)</span>
            <span className="t-small text-muted">
              The address becomes an account with your owner key. Same address, ready for quantum-safe keys but not
              quantum-safe: the old key still works.
            </span>
          </span>
        </label>
      )}

      {error && <RiskBanner level="danger" title={error} />}

      {!preview ? (
        <Button
          className="self-start"
          loading={busy === "preview"}
          disabled={!keys[0]?.trim()}
          onClick={async () => {
            setBusy("preview");
            setError(null);
            try {
              setPreview(await call("migrate:preview", req()));
            } catch (e) {
              setError(e instanceof UiCallError ? e.message : "Couldn't read that address.");
            } finally {
              setBusy(null);
            }
          }}
        >
          Check what moves
        </Button>
      ) : (
        <Card heading="What happens" data-testid="migration-preview">
          <div className="flex flex-col gap-3">
            <p className="t-small">
              From <AddressChip address={preview.source} copyable={false} /> to{" "}
              <AddressChip address={preview.destination} copyable={false} />
            </p>
            <ul className="t-small list-disc pl-5">
              <li>{eth(preview.ethWei)}</li>
              {preview.tokens.map((t) => {
                const p = net.tokens.find((x) => x.token.toLowerCase() === t.token.toLowerCase());
                return (
                  <li key={t.token}>
                    {p ? `${formatAmount(t.amount, p.decimals)} ${p.symbol}` : `${t.amount} of token ${t.token}`}
                  </li>
                );
              })}
            </ul>
            {preview.safe && (
              <p className="t-small text-muted">
                The Safe has {preview.safe.owners.length} owners and needs {preview.safe.threshold}.
              </p>
            )}
            <ol className="t-small list-decimal pl-5">
              {preview.steps.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {preview.warning && <RiskBanner level="limit" title={preview.warning} />}
            {done ? (
              <RiskBanner
                level="info"
                title="Sent"
                body={`${done.length} transaction${done.length > 1 ? "s" : ""} went through. Activity has the details.`}
              />
            ) : (
              <div className="flex gap-2">
                <Button variant="secondary" onClick={reset}>
                  Change
                </Button>
                <Button
                  loading={busy === "run"}
                  loadingLabel="Moving…"
                  onClick={async () => {
                    setBusy("run");
                    setError(null);
                    try {
                      const r = await call("migrate:run", req());
                      setDone(r.hashes);
                      setKeys(keys.map(() => ""));
                    } catch (e) {
                      setError(
                        e instanceof UiCallError ? e.message : "The move stopped. Activity shows what was sent.",
                      );
                    } finally {
                      setBusy(null);
                    }
                  }}
                >
                  {preview.mode.startsWith("7702") ? "Keep the address" : "Move now"}
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}
    </div>
  );
}
