import { useState } from "react";
import { isAddress } from "viem";
import type { SessionRecord } from "../../background/lean/sessions";
import { getNetwork } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import { AddressChip, Button, Card, RiskBanner, TextField } from "../../ui";
import { formatAmount, hostOf } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync, usePoll } from "../lib/hooks";
import { eth } from "../lib/money";

const STATUS_TEXT: Record<SessionRecord["status"], string> = {
  adding: "Being added…",
  active: "Active",
  revoking: "Ending…",
  revoked: "Ended",
  failed: "Couldn't be added",
};

/**
 * Sessions (replaces Limits): a key this browser holds that one site may use on its own: only the contracts listed,
 * at most so much per payment and per day, until it ends. Adding and ending one is a change your owner key signs.
 */
export function Sessions({ state }: { state: WalletState }) {
  const chainId = state.settings.selectedChainId;
  const list = useAsync(() => call("sessions:list", { chainId }), [chainId]);
  const sessions = list.data ?? [];
  const busy = sessions.some((s) => s.status === "adding" || s.status === "revoking");
  usePoll(list.reload, 3000, busy);
  const now = Date.now();
  const live = sessions.filter((s) => s.status !== "revoked");
  const ended = sessions.filter((s) => s.status === "revoked");

  return (
    <div className="flex max-w-[640px] flex-col gap-5">
      <div>
        <h1 className="text-[24px] leading-[30px] font-semibold">Sessions</h1>
        <p className="t-body mt-1 text-muted">
          A session lets one site pay from your account without asking, within the limits you set here. Anything outside
          them asks you, and your owner key signs it.
        </p>
      </div>
      <NewSession chainId={chainId} onCreated={() => void list.reload()} />
      <section aria-labelledby="active-h" className="flex flex-col gap-2">
        <h2 id="active-h" className="t-strong">
          Your sessions
        </h2>
        {list.error && <RiskBanner level="danger" title={list.error} />}
        {live.length === 0 ? (
          <p className="t-small text-muted">No sessions yet.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {live.map((s) => (
              <SessionRow key={s.id} s={s} now={now} onChanged={() => void list.reload()} />
            ))}
          </ul>
        )}
        {ended.length > 0 && <p className="t-small text-muted">{ended.length} ended session(s).</p>}
      </section>
    </div>
  );
}

function SessionRow({ s, now, onChanged }: { s: SessionRecord; now: number; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const expired = s.validUntil * 1000 <= now;
  const tokens = getNetwork(s.chainId).tokens;
  return (
    <li>
      <Card heading={hostOf(s.origin)} headingLevel={3}>
        <dl className="t-small grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted">Status</dt>
          <dd data-testid="session-status">
            {expired && s.status === "active" ? "Ended (time is up)" : STATUS_TEXT[s.status]}
          </dd>
          <dt className="text-muted">Ends</dt>
          <dd>{new Date(s.validUntil * 1000).toLocaleString()}</dd>
          <dt className="text-muted">Per payment</dt>
          <dd>{eth(s.perTxEth)}</dd>
          <dt className="text-muted">Per day</dt>
          <dd>{BigInt(s.dailyEth) > 0n ? eth(s.dailyEth) : "No daily limit"}</dd>
          {s.tokens.map((t) => {
            const p = tokens.find((x) => x.token.toLowerCase() === t.token.toLowerCase());
            const fmt = (v: string) => (p ? `${formatAmount(v, p.decimals)} ${p.symbol}` : v);
            return [
              <dt key={`${t.token}-k`} className="text-muted">
                {p?.symbol ?? "Token"}
              </dt>,
              <dd key={`${t.token}-v`}>
                {fmt(t.perTx)} per payment{BigInt(t.daily) > 0n ? `, ${fmt(t.daily)} per day` : ""}
              </dd>,
            ];
          })}
          <dt className="text-muted">May use</dt>
          <dd className="flex flex-wrap gap-1">
            {s.targets.map((t) => (
              <AddressChip key={t} address={t} copyable={false} />
            ))}
          </dd>
        </dl>
        {error && <p className="t-small mt-2 text-danger">{error}</p>}
        {(s.status === "active" || s.status === "failed") && (
          <div className="mt-3">
            <Button
              size="sm"
              variant="secondary"
              loading={busy}
              onClick={async () => {
                setBusy(true);
                setError(null);
                try {
                  await call("sessions:revoke", { id: s.id });
                  onChanged();
                } catch (e) {
                  setError(e instanceof UiCallError ? e.message : "Couldn't end the session.");
                } finally {
                  setBusy(false);
                }
              }}
            >
              End session now
            </Button>
          </div>
        )}
      </Card>
    </li>
  );
}

function NewSession({ chainId, onCreated }: { chainId: number; onCreated: () => void }) {
  const tokens = getNetwork(chainId).tokens;
  const [open, setOpen] = useState(false);
  const [origin, setOrigin] = useState("https://");
  const [targets, setTargets] = useState("");
  const [perTx, setPerTx] = useState("0.01");
  const [daily, setDaily] = useState("0.05");
  const [hours, setHours] = useState("24");
  const [tokenLimits, setTokenLimits] = useState<Record<string, { perTx: string; daily: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = targets
    .split(/[\s,]+/u)
    .map((x) => x.trim())
    .filter(Boolean);
  const bad = list.find((t) => !isAddress(t, { strict: false }));

  if (!open)
    return (
      <Button className="self-start" onClick={() => setOpen(true)}>
        New session
      </Button>
    );
  return (
    <Card heading="New session">
      <form
        className="flex flex-col gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await call("sessions:create", {
              chainId,
              origin: origin.trim().replace(/\/+$/u, ""),
              targets: list as `0x${string}`[],
              perTxEth: perTx,
              dailyEth: daily,
              hours: Number(hours),
              tokens: tokens
                .filter((t) => tokenLimits[t.token]?.perTx)
                .map((t) => ({
                  token: t.token,
                  perTx: tokenLimits[t.token]!.perTx,
                  daily: tokenLimits[t.token]!.daily,
                  decimals: t.decimals,
                })),
            });
            setOpen(false);
            onCreated();
          } catch (err) {
            setError(err instanceof UiCallError ? err.message : "Couldn't add the session.");
          } finally {
            setBusy(false);
          }
        }}
      >
        <TextField
          label="Site"
          value={origin}
          onChange={(e) => setOrigin(e.target.value)}
          placeholder="https://app.example"
        />
        <div className="flex flex-col gap-1">
          <label htmlFor="targets" className="t-strong">
            Contracts it may use
          </label>
          <textarea
            id="targets"
            rows={2}
            spellCheck={false}
            value={targets}
            onChange={(e) => setTargets(e.target.value)}
            className="t-mono rounded-md border border-line bg-bg p-2 focus:border-brand focus-visible:outline-none"
          />
          <p className="t-small text-muted">
            The site&apos;s contract addresses, or people it may pay. {bad ? `${bad} isn't an address.` : ""}
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2">
          <TextField
            label="ETH per payment"
            inputMode="decimal"
            value={perTx}
            onChange={(e) => setPerTx(e.target.value)}
          />
          <TextField label="ETH per day" inputMode="decimal" value={daily} onChange={(e) => setDaily(e.target.value)} />
          <TextField label="Hours" inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
        </div>
        {tokens.length > 0 && (
          <fieldset className="flex flex-col gap-2">
            <legend className="t-strong">Tokens (optional)</legend>
            <p className="t-small text-muted">
              Leave empty and the session can&apos;t move the token. With a limit it may only send it, never approve
              another app to spend it.
            </p>
            {tokens.map((t) => (
              <div key={t.token} className="grid grid-cols-3 items-end gap-2">
                <span className="t-strong pb-2">{t.symbol}</span>
                <TextField
                  label="Per payment"
                  inputMode="decimal"
                  value={tokenLimits[t.token]?.perTx ?? ""}
                  onChange={(e) =>
                    setTokenLimits((x) => ({
                      ...x,
                      [t.token]: { perTx: e.target.value, daily: x[t.token]?.daily ?? "" },
                    }))
                  }
                />
                <TextField
                  label="Per day"
                  inputMode="decimal"
                  value={tokenLimits[t.token]?.daily ?? ""}
                  onChange={(e) =>
                    setTokenLimits((x) => ({
                      ...x,
                      [t.token]: { perTx: x[t.token]?.perTx ?? "", daily: e.target.value },
                    }))
                  }
                />
              </div>
            ))}
          </fieldset>
        )}
        {error && <RiskBanner level="danger" title={error} />}
        <p className="t-small text-muted">Your owner key signs this change. The network fee comes from your account.</p>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="submit" loading={busy} loadingLabel="Signing…" disabled={!list.length || Boolean(bad)}>
            Add session
          </Button>
        </div>
      </form>
    </Card>
  );
}
