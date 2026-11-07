"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress, type Address as Addr } from "viem";
import { grantSentence, delegateLink } from "@queuebit/extension/src/background/lean/grants";
import { Address, Field, Notice, Primary, Screen, Secondary, Title, Working } from "@/components/onboarding/ui";
import { engine } from "@/lib/engine/client";
import type { UiApi } from "@/lib/engine/protocol";
import { DURATIONS, endsIn, localInput, untilText } from "@/lib/grant-format";
import { parseAmountInput, short, units } from "@/lib/format";
import { signProof } from "@/lib/proof";
import { Section } from "./bits";
import { Identicon } from "./Identicon";
import { errText, useWallet } from "./state";
import type { Nav } from "./Wallet";

type GrantView = UiApi["grants:list"]["res"][number];
type Asset = { asset: "ETH" | Addr; symbol: string; decimals: number };

/**
 * Spending permissions: let someone else's wallet (MetaMask or any browser wallet) spend from this account, within
 * limits, until a time. Each change is an owner payment (the quantum-safe key, through LeanPool); the list is read
 * from the chain, so it is the same on every device. The person spends on the /delegate page.
 */
export function Permissions({ nav }: { nav: Nav }) {
  const { status, lockedWith, tokens, net } = useWallet();
  const [grants, setGrants] = useState<GrantView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [sent, setSent] = useState<{ id: string; what: string } | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [, tick] = useState(0);

  const load = useCallback(async () => {
    setGrants(await engine().call("grants:list", {}));
  }, []);
  useEffect(() => {
    void load().catch((e) => setErr(errText(e)));
    const t = setInterval(() => tick((n) => n + 1), 30_000); // the countdowns
    return () => clearInterval(t);
  }, [load]);

  const assets: Asset[] = useMemo(
    () => [
      { asset: "ETH", symbol: "ETH", decimals: 18 },
      ...tokens.map((t) => ({ asset: t.token as Addr, symbol: t.symbol, decimals: t.decimals })),
    ],
    [tokens],
  );

  const proof = async () => (lockedWith ? signProof(lockedWith, pw) : undefined);

  const revoke = async (g: GrantView) => {
    setBusy(`revoke:${g.delegate}`);
    setErr(null);
    try {
      const p = await proof();
      const entry = await engine().call("grants:revoke", { delegate: g.delegate, ...(p ? { proof: p } : {}) });
      setSent({ id: entry.id, what: `Removing ${short(g.delegate)}'s permission.` });
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const copyLink = (g: GrantView) => {
    const link = delegateLink(window.location.origin, g.account);
    void navigator.clipboard?.writeText(link).then(() => {
      setCopied(g.delegate);
      setTimeout(() => setCopied(null), 1600);
    });
  };

  const deployed = status?.deployed ?? false;
  const needPw = lockedWith === "password";
  return (
    <Screen onBack={nav.back} method="Spending permissions">
      <Title sub="Let someone else's wallet (MetaMask or any browser wallet) spend from this account, up to limits you set, until a time you pick. You can remove it whenever you like.">
        Let someone spend
      </Title>

      <Section title={`Active · ${grants?.length ?? "…"}`}>
        {grants === null && !err ? (
          <p className="flex items-center gap-3 mono-label text-ink-3">
            <Working /> Reading permissions from the chain
          </p>
        ) : grants?.length ? (
          <ul className="border-t border-ink">
            {grants.map((g) => (
              <li key={g.delegate} className="border-b border-rule py-4">
                <div className="flex items-center gap-3">
                  <Identicon address={g.delegate} size={36} />
                  <div className="min-w-0 flex-1">
                    <Address value={g.delegate} className="block truncate text-[1rem]" />
                    <span
                      className={`mono-label text-[11px] ${g.validUntil * 1000 <= Date.now() ? "text-red" : "text-ink-3"}`}
                    >
                      {endsIn(g.validUntil)} · {untilText(g.validUntil)}
                    </span>
                  </div>
                </div>
                <ul className="mt-3 space-y-3">
                  {g.assets.map((a) => (
                    <li key={a.asset} className="border-l-2 border-blue pl-3">
                      <p className="text-[1rem]">
                        {grantSentence(a, (v) => units(v, a.decimals), untilText(g.validUntil))}.
                      </p>
                      <p className="mono-label mt-1 text-[11px] text-ink-3">
                        Spent today {units(a.spentToday, a.decimals)} · left today {units(a.leftToday, a.decimals)}{" "}
                        {a.symbol}
                      </p>
                      {a.recipients && (
                        <p className="mt-1 text-[0.9rem] text-ink-2">
                          To: {a.recipients.map((r) => short(r)).join(", ")}
                        </p>
                      )}
                    </li>
                  ))}
                </ul>
                <div className="mt-3 flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => copyLink(g)}
                    className="mono-label h-10 border border-ink bg-paper px-3 text-[11px] active:bg-paper-3"
                  >
                    {copied === g.delegate ? "Copied" : `Copy link for ${short(g.delegate)}`}
                  </button>
                  <button
                    type="button"
                    disabled={busy !== null || (needPw && !pw)}
                    onClick={() => void revoke(g)}
                    className="mono-label h-10 border border-rule bg-paper px-3 text-[11px] text-red active:bg-paper-3 disabled:text-ink-3"
                  >
                    {busy === `revoke:${g.delegate}` ? "Removing…" : "Remove"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[1rem] text-ink-3">Nobody can spend from this account but you.</p>
        )}
      </Section>

      {deployed ? (
        <GrantForm
          assets={assets}
          own={status?.address}
          existing={grants ?? []}
          busy={busy === "grant"}
          disabled={busy !== null || (needPw && !pw)}
          onGrant={async (req, what) => {
            setBusy("grant");
            setErr(null);
            try {
              const p = await proof();
              const entry = await engine().call("grants:create", { ...req, ...(p ? { proof: p } : {}) });
              setSent({ id: entry.id, what });
              return true;
            } catch (e) {
              setErr(errText(e));
              return false;
            } finally {
              setBusy(null);
            }
          }}
        />
      ) : (
        <Notice>
          Your account isn&rsquo;t created yet: it is created with your first payment. Then you can let someone spend.
        </Notice>
      )}

      {deployed && needPw && (
        <div className="mt-6">
          <Field
            label="Password"
            hint="Each change is signed by your quantum-safe key."
            type="password"
            value={pw}
            onChange={(e) => setPw(e.target.value)}
          />
        </div>
      )}
      {sent && (
        <div className="mt-6 space-y-3">
          <Notice>{sent.what} It takes effect once it&rsquo;s on the chain (usually within a minute).</Notice>
          <div className="flex gap-2">
            <Secondary onClick={() => nav.open({ id: "entry", entryId: sent.id })}>See the change</Secondary>
            <Secondary onClick={() => void load().catch((e) => setErr(errText(e)))}>Refresh the list</Secondary>
          </div>
        </div>
      )}
      {err && <Notice tone="error">{err}</Notice>}
      {net && (
        <p className="mt-8 text-[0.9rem] text-ink-3">
          Their payments come out of this account, and so do their network fees (they pay nothing). The limits cover
          what they send, not those fees: only let someone you trust spend, and remove a permission when it has ended
          (until then the network still accepts their payments, which then fail and cost this account a fee). A day is a
          calendar day in UTC: the daily limit starts again at midnight UTC.
        </p>
      )}
    </Screen>
  );
}

type GrantReq = Omit<UiApi["grants:create"]["req"], "proof">;

/** The new-permission form: who, what, how much, for how long, where to; then one sentence that says it. */
function GrantForm({
  assets,
  own,
  existing,
  busy,
  disabled,
  onGrant,
}: {
  assets: Asset[];
  own: string | undefined;
  existing: GrantView[];
  busy: boolean;
  disabled: boolean;
  onGrant: (req: GrantReq, what: string) => Promise<boolean>;
}) {
  const [who, setWho] = useState("");
  const [assetKey, setAssetKey] = useState<string>("ETH");
  const [perPayment, setPerPayment] = useState("");
  const [perDay, setPerDay] = useState("");
  const [duration, setDuration] = useState<string>("1d");
  const [custom, setCustom] = useState(() => localInput(Math.floor(Date.now() / 1000) + 86_400));
  const [recipients, setRecipients] = useState<Addr[]>([]);
  const [draft, setDraft] = useState("");
  const [formErr, setFormErr] = useState<string | null>(null);

  const asset = assets.find((a) => a.asset === assetKey) ?? assets[0]!;
  const isEth = asset.asset === "ETH";
  const validUntil = (() => {
    const preset = DURATIONS.find((d) => d.key === duration);
    if (preset) return Math.floor(Date.now() / 1000) + preset.seconds;
    const t = new Date(custom).getTime();
    return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
  })();

  const whoTrim = who.trim();
  const whoErr =
    whoTrim && !isAddress(whoTrim, { strict: false })
      ? "That isn't an address (0x + 40 characters)."
      : own && whoTrim.toLowerCase() === own.toLowerCase()
        ? "That's this account: pick someone else's wallet."
        : null;
  const prior = existing.find((g) => g.delegate.toLowerCase() === whoTrim.toLowerCase());
  const pp = perPayment ? parseAmountInput(perPayment, asset.decimals, asset.symbol) : null;
  const pd = perDay ? parseAmountInput(perDay, asset.decimals, asset.symbol) : null;
  const amountErr =
    pp && "error" in pp
      ? pp.error
      : pd && "error" in pd
        ? pd.error
        : pp && pd && "wei" in pp && "wei" in pd && pp.wei > pd.wei
          ? "The per-payment limit can't be more than the daily one."
          : null;
  const timeErr = validUntil <= Math.floor(Date.now() / 1000) ? "Pick an end time in the future." : null;
  const ready =
    whoTrim && !whoErr && pp && pd && !amountErr && !timeErr && (!isEth || recipients.length > 0) && !disabled;

  const sentence =
    pp && pd && "wei" in pp && "wei" in pd && !amountErr
      ? grantSentence(
          {
            symbol: asset.symbol,
            perPayment: pp.wei.toString(),
            perDay: pd.wei.toString(),
            ...(isEth ? { recipients } : {}),
          },
          (v) => units(v, asset.decimals),
          untilText(validUntil),
        )
      : null;

  const addRecipient = () => {
    const a = draft.trim();
    if (!isAddress(a, { strict: false })) return setFormErr("That isn't an address (0x + 40 characters).");
    if (own && a.toLowerCase() === own.toLowerCase())
      return setFormErr("Payments to this account itself make no sense.");
    if (recipients.some((r) => r.toLowerCase() === a.toLowerCase())) return setFormErr("Already on the list.");
    setFormErr(null);
    setRecipients((l) => [...l, a as Addr]);
    setDraft("");
  };

  const submit = async () => {
    const ok = await onGrant(
      {
        delegate: whoTrim as Addr,
        asset: asset.asset,
        perPayment: perPayment.trim().replace(",", "."),
        perDay: perDay.trim().replace(",", "."),
        validUntil,
        ...(isEth ? { recipients } : {}),
      },
      `Letting ${short(whoTrim)} spend ${asset.symbol}.`,
    );
    if (ok) {
      setPerPayment("");
      setPerDay("");
    }
  };

  const chip = (on: boolean) =>
    `mono-label h-10 border px-3 text-[11px] ${on ? "border-blue bg-blue text-paper" : "border-rule bg-paper active:bg-paper-3"}`;

  return (
    <Section title="New permission">
      <div className="space-y-5">
        <Field
          label="Who"
          hint="Their wallet address (MetaMask or any browser wallet). Not this account."
          value={who}
          onChange={(e) => setWho(e.target.value)}
          placeholder="0x…"
          autoComplete="off"
          spellCheck={false}
          error={whoErr}
        />

        <label className="block">
          <span className="mono-label text-ink-2">What</span>
          <select
            value={asset.asset}
            onChange={(e) => setAssetKey(e.target.value)}
            className="mt-2 block h-12 w-full border border-ink bg-paper px-3 text-[1rem]"
          >
            {assets.map((a) => (
              <option key={a.asset} value={a.asset}>
                {a.symbol}
                {a.asset === "ETH" ? "" : ` (${short(a.asset)})`}
              </option>
            ))}
          </select>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <Field
            label={`Per payment (${asset.symbol})`}
            inputMode="decimal"
            value={perPayment}
            onChange={(e) => setPerPayment(e.target.value)}
            placeholder="0.01"
          />
          <Field
            label={`Per day (${asset.symbol})`}
            inputMode="decimal"
            value={perDay}
            onChange={(e) => setPerDay(e.target.value)}
            placeholder="0.05"
          />
        </div>

        <fieldset>
          <legend className="mono-label text-ink-2">For how long</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            {DURATIONS.map((d) => (
              <button key={d.key} type="button" className={chip(duration === d.key)} onClick={() => setDuration(d.key)}>
                {d.label}
              </button>
            ))}
            <button type="button" className={chip(duration === "custom")} onClick={() => setDuration("custom")}>
              Until…
            </button>
          </div>
          {duration === "custom" && (
            <input
              type="datetime-local"
              aria-label="Ends at"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
              className="mt-3 block h-12 w-full border border-ink bg-paper px-3 text-[1rem]"
            />
          )}
        </fieldset>

        <fieldset>
          <legend className="mono-label text-ink-2">Where to</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <button type="button" className={chip(!isEth)} disabled={isEth} aria-pressed={!isEth}>
              Anyone
            </button>
            <button type="button" className={chip(isEth)} disabled={!isEth} aria-pressed={isEth}>
              Only these addresses
            </button>
          </div>
          <p className="mt-2 text-[0.9rem] text-ink-3">
            {isEth
              ? "ETH can only go to addresses you list: the account checks every ETH payment against this list. List people's wallets, not contracts: on a listed contract they could call more than a payment."
              : `${asset.symbol} can go to anyone: the account checks how much is sent, not who receives it.`}
          </p>
          {isEth && (
            <div className="mt-3">
              {recipients.length > 0 && (
                <ul className="mb-3 border-t border-rule">
                  {recipients.map((r) => (
                    <li key={r} className="flex items-center gap-3 border-b border-rule py-2">
                      <Identicon address={r} size={28} />
                      <Address value={r} className="min-w-0 flex-1 truncate text-[0.95rem]" />
                      <button
                        type="button"
                        aria-label={`Remove ${r}`}
                        onClick={() => setRecipients((l) => l.filter((x) => x !== r))}
                        className="mono-label h-9 border border-rule px-2.5 text-[11px] active:bg-paper-3"
                      >
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <Field
                label="Recipient"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && addRecipient()}
                placeholder="0x…"
                autoComplete="off"
                spellCheck={false}
              />
              <div className="mt-2">
                <Secondary onClick={addRecipient} disabled={!draft.trim()}>
                  Add recipient
                </Secondary>
              </div>
            </div>
          )}
        </fieldset>

        {sentence && whoTrim && !whoErr && (
          <div className="plate-grid px-4 py-4">
            <p className="mono-label text-[11px] text-ink-3">{short(whoTrim)} may spend</p>
            <p className="mt-1 text-[1.1rem]">{sentence}.</p>
          </div>
        )}
        {prior && (
          <Notice>
            {short(prior.delegate)} already has a permission ({prior.assets.map((a) => a.symbol).join(", ")}). This{" "}
            {prior.assets.some((a) => a.asset === asset.asset) ? "replaces their" : "adds"} {asset.symbol}
            {prior.assets.some((a) => a.asset === asset.asset) ? " limits" : ""}, and the new end time applies to all of
            it.
          </Notice>
        )}
        {(amountErr || timeErr || formErr) && <Notice tone="error">{amountErr ?? timeErr ?? formErr}</Notice>}

        <Primary
          busy={busy}
          busyLabel="Signing with your quantum-safe key"
          disabled={!ready}
          onClick={() => void submit()}
        >
          {isEth && !recipients.length ? "Add a recipient first" : "Grant"}
        </Primary>
      </div>
    </Section>
  );
}
