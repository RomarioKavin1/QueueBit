import { useState } from "react";
import { isAddress, isHex, type Address, type Hex } from "viem";
import { Button, Card, RiskBanner, Sheet, Skeleton, TextField } from "../../ui";
import { formatUsd } from "../../ui/format";
import { call, UiCallError } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { eth } from "../lib/money";
import { startVault } from "./vaultStart";

const hours = (s: number) =>
  s >= 86_400 && s % 3600 === 0
    ? `${s / 3600} hours`
    : s >= 3600
      ? `${Math.round(s / 3600)} h`
      : `${Math.round(s / 60)} min`;

/**
 * Limits & allowed lists (ux-spec §3.8) plus app allowances (§3.9): every change is a Vault approval; the effect line
 * says, before the button, whether it is instant (safer) or waits (riskier).
 */
export function Limits() {
  const p = useAsync(() => call("vault:policy", {}), []);
  const [sheet, setSheet] = useState<"limits" | "mode" | "session" | null>(null);
  const [daily, setDaily] = useState("");
  const [perPayment, setPerPayment] = useState("");
  const [sTarget, setSTarget] = useState("");
  const [sSelector, setSSelector] = useState("");
  const [sAmount, setSAmount] = useState("100");
  const [sDays, setSDays] = useState("30");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const v = p.data;
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof UiCallError ? e.message : "Something went wrong.");
      setBusy(false);
    }
  };
  if (!v) return p.error ? <RiskBanner level="limit" title={p.error} /> : <Skeleton className="h-64" />;
  const wait = hours(v.timelockDelaySec);
  const d = Number(daily);
  const pp = Number(perPayment);
  const limitsValid = Number.isFinite(d) && d >= 10 && Number.isFinite(pp) && pp > 0 && pp <= d;
  const tightening = limitsValid && d <= v.capUsd && pp <= v.perTxMaxUsd;

  return (
    <div className="flex flex-col gap-5">
      <h1 className="t-headline">Limits</h1>
      {!v.deployed && (
        <RiskBanner
          level="info"
          title="Your account isn't active yet"
          body="Limits shown are what activation will set. Changes need an active account."
        />
      )}
      {error && <RiskBanner level="danger" title={error} />}
      <Card>
        <dl className="flex flex-col divide-y divide-line">
          <Line
            k="Daily limit"
            v={`${formatUsd(v.capUsd)} in any 24 hours`}
            sub={v.deployed ? `${formatUsd(v.availableUsd)} left right now` : undefined}
            action={
              <Button
                size="sm"
                variant="vault"
                disabled={!v.deployed}
                onClick={() => (setDaily(String(v.capUsd)), setPerPayment(String(v.perTxMaxUsd)), setSheet("limits"))}
              >
                Change
              </Button>
            }
          />
          <Line k="Per-payment limit" v={formatUsd(v.perTxMaxUsd)} />
          <Line
            k="Large-payment threshold"
            v={`${formatUsd(v.vaultAvailableUsd)} a day instantly with your phone; more waits ${wait}`}
          />
          <Line
            k="Who you can pay"
            v={v.recipientMode === "open" ? "Anyone (Open)" : "Only allowed recipients (Strict)"}
            sub={
              v.recipientMode === "open"
                ? "Everyday payments can go to any address, within your limits. A stolen browser can still take at most your daily limit."
                : "Everyday payments only go to addresses your Vault allowed. Anything else needs your phone."
            }
            action={
              <Button size="sm" variant="vault" disabled={!v.deployed} onClick={() => setSheet("mode")}>
                Change
              </Button>
            }
          />
          <Line k="Fee tank" v={eth(v.tankWei, 5)} />
        </dl>
      </Card>

      <section aria-labelledby="tok-h" className="flex flex-col gap-2">
        <h2 id="tok-h" className="t-small font-semibold tracking-wide text-muted uppercase">
          Allowed tokens
        </h2>
        <Card>
          {v.tokens.length === 0 ? (
            <p className="t-small text-muted">None yet.</p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {v.tokens.map((t) => (
                <li key={t.token} className="flex items-center justify-between gap-2 py-2">
                  <span className="t-body">
                    {t.symbol}{" "}
                    <span className="t-small text-muted">at {formatUsd(t.usdPerToken)} (set by your Vault)</span>
                  </span>
                  {t.symbol !== "ETH" && (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() =>
                        run(() =>
                          startVault({
                            type: "setToken",
                            token: t.token,
                            allowed: false,
                            decimals: t.decimals,
                            usdPerToken: "0",
                            symbol: t.symbol,
                          }),
                        )
                      }
                    >
                      Remove
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </section>

      <section aria-labelledby="apps-h" className="flex flex-col gap-2">
        <h2 id="apps-h" className="t-small font-semibold tracking-wide text-muted uppercase">
          Apps that can spend without asking
        </h2>
        <Card>
          {v.sessions.length === 0 ? (
            <p className="t-small text-muted">
              No allowances. An allowance lets one app spend a set amount without asking your phone each time.
            </p>
          ) : (
            <ul className="flex flex-col divide-y divide-line">
              {v.sessions.map((s) => (
                <li key={`${s.target}:${s.selector}`} className="flex items-center justify-between gap-2 py-2">
                  <span className="t-body">
                    {s.label} · up to {formatUsd(s.allowanceUsd)}{" "}
                    <span className="t-small text-muted">
                      until {new Date(s.expiry * 1000).toLocaleDateString("en-GB")}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() =>
                      run(() =>
                        startVault({
                          type: "setSession",
                          target: s.target,
                          selector: s.selector,
                          allowanceUsd: 0,
                          expiry: 0,
                          label: s.label,
                        }),
                      )
                    }
                  >
                    Revoke
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-2">
            <Button size="sm" variant="vault" disabled={!v.deployed} onClick={() => setSheet("session")}>
              New allowance
            </Button>
          </div>
        </Card>
      </section>

      <p className="t-small text-muted">
        Lowering a limit or removing an item is instant. Raising or adding waits {wait} (your phone approves, then it
        waits; you can cancel during the wait).
      </p>

      <Sheet open={sheet === "limits"} title="Change your limits" onClose={() => setSheet(null)}>
        <div className="flex flex-col gap-3">
          <TextField
            label="Daily limit (USD, in any 24 hours)"
            inputMode="decimal"
            value={daily}
            onChange={(e) => setDaily(e.target.value)}
          />
          <TextField
            label="Per-payment limit (USD)"
            inputMode="decimal"
            value={perPayment}
            onChange={(e) => setPerPayment(e.target.value)}
          />
          <p className="t-body" data-testid="effect-line" role="status">
            {!limitsValid
              ? "The per-payment limit must be more than $0 and at most the daily limit (at least $10)."
              : tightening
                ? "Instant (this makes your account safer)."
                : `Waits ${wait} after your phone approves. You can cancel it during the wait.`}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={() => setSheet(null)}>
              Go back
            </Button>
            <Button
              block
              variant="vault"
              loading={busy}
              disabled={!limitsValid}
              onClick={() => run(() => startVault({ type: "setLimits", dailyUsd: d, perPaymentUsd: pp }))}
            >
              Apply with Vault
            </Button>
          </div>
        </div>
      </Sheet>
      <Sheet open={sheet === "mode"} title="Who can you pay without your phone?" onClose={() => setSheet(null)}>
        <div className="flex flex-col gap-3">
          <Card className={v.recipientMode === "open" ? "border-brand" : ""}>
            <p className="t-strong">Open (recommended)</p>
            <p className="t-small text-muted">
              Pay anyone within your limits. Simple. If this browser is stolen, the thief can send at most your daily
              limit, to anyone.
            </p>
          </Card>
          <Card className={v.recipientMode === "strict" ? "border-brand" : ""}>
            <p className="t-strong">Strict</p>
            <p className="t-small text-muted">
              Everyday payments only to addresses your Vault allowed. Safer against a stolen browser, but every new
              recipient needs your phone (and adding one waits {wait}).
            </p>
          </Card>
          <p className="t-body" role="status">
            {v.recipientMode === "open"
              ? "Switching to Strict is instant."
              : `Switching back to Open waits ${wait} after your phone approves.`}
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={() => setSheet(null)}>
              Go back
            </Button>
            <Button
              block
              variant="vault"
              loading={busy}
              onClick={() =>
                run(() =>
                  startVault({ type: "setRecipientMode", mode: v.recipientMode === "open" ? "strict" : "open" }),
                )
              }
            >
              {v.recipientMode === "open" ? "Switch to Strict with Vault" : "Switch to Open with Vault"}
            </Button>
          </div>
        </div>
      </Sheet>
      <Sheet open={sheet === "session"} title="New app allowance" onClose={() => setSheet(null)}>
        <div className="flex flex-col gap-3">
          <p className="t-small text-muted">
            This app could spend up to the amount without asking you each time, only on this contract and action.
          </p>
          <TextField
            label="App contract address"
            value={sTarget}
            onChange={(e) => setSTarget(e.target.value.trim())}
            spellCheck={false}
          />
          <TextField
            label="Action (function selector, 0x + 8 hex)"
            value={sSelector}
            onChange={(e) => setSSelector(e.target.value.trim())}
            spellCheck={false}
          />
          <TextField
            label="Amount (USD)"
            inputMode="decimal"
            value={sAmount}
            onChange={(e) => setSAmount(e.target.value)}
          />
          <TextField
            label="For how many days"
            inputMode="numeric"
            value={sDays}
            onChange={(e) => setSDays(e.target.value)}
          />
          <p className="t-body" role="status">
            Waits {wait} after your phone approves. Revoking is instant.
          </p>
          <div className="flex gap-2">
            <Button variant="secondary" block onClick={() => setSheet(null)}>
              Go back
            </Button>
            <Button
              block
              variant="vault"
              loading={busy}
              disabled={
                !isAddress(sTarget) ||
                !(isHex(sSelector) && sSelector.length === 10) ||
                !(Number(sAmount) > 0) ||
                !(Number(sDays) > 0)
              }
              onClick={() =>
                run(() =>
                  startVault({
                    type: "setSession",
                    target: sTarget as Address,
                    selector: sSelector as Hex,
                    allowanceUsd: Number(sAmount),
                    expiry: Math.floor(Date.now() / 1000) + Number(sDays) * 86_400,
                  }),
                )
              }
            >
              Grant on phone
            </Button>
          </div>
        </div>
      </Sheet>
    </div>
  );
}

function Line({ k, v, sub, action }: { k: string; v: string; sub?: string | undefined; action?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5">
      <div>
        <dt className="t-strong">{k}</dt>
        <dd className="t-body" data-testid={`limits-${k.toLowerCase().replace(/\s+/gu, "-")}`}>
          {v}
        </dd>
        {sub && <dd className="t-small text-muted">{sub}</dd>}
      </div>
      {action}
    </div>
  );
}
