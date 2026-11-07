"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { isAddress, type Address as Addr, type Hex } from "viem";
import { grantPaymentCall, type Grant } from "@queuebit/extension/src/background/lean/grants";
import { explorerTxLink } from "@queuebit/extension/src/shared/chains";
import { Address, Field, Notice, Primary, Screen, Secondary, Title, Working } from "@/components/onboarding/ui";
import { Identicon } from "@/components/wallet/Identicon";
import { Row, Section } from "@/components/wallet/bits";
import { check, follow, grantsFor, net, payWithin } from "@/lib/delegate";
import { endsIn, untilText } from "@/lib/grant-format";
import { parseAmountInput, short, units } from "@/lib/format";
import { useConnectedWallet } from "@/lib/wallets";

const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

interface AssetRow {
  asset: "ETH" | Addr;
  symbol: string;
  decimals: number;
  perPayment: bigint;
  perDay: bigint;
  leftToday: bigint;
  /** ETH: the only recipients. Tokens: undefined (anyone). */
  recipients?: Addr[];
}

function assetsOf(g: Grant): AssetRow[] {
  const rows: AssetRow[] = [];
  if (g.eth) rows.push({ asset: "ETH", symbol: "ETH", decimals: 18, ...g.eth });
  for (const t of g.tokens) {
    const meta = net.tokens.find((x) => x.token.toLowerCase() === t.token.toLowerCase());
    rows.push({
      asset: t.token,
      symbol: meta?.symbol ?? short(t.token),
      decimals: meta?.decimals ?? 18,
      perPayment: t.perPayment,
      perDay: t.perDay,
      leftToday: t.leftToday,
    });
  }
  return rows;
}

/**
 * /delegate: for the person someone let spend from their QueueBit account. They connect the wallet the owner named;
 * the page finds every account that granted it (on chain), and sends payments within a grant: their wallet signs
 * the exact calls as typed data, the account pays the fees.
 */
export function Delegate() {
  // AppKit (the wallet connector) exists only in the browser: render after mount, never on the server.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted)
    return (
      <Screen method="Spend from an account">
        <div className="flex h-[50dvh] items-center justify-center gap-3 mono-label text-ink-3">
          <Working /> Opening
        </div>
      </Screen>
    );
  return <DelegatePage />;
}

function DelegatePage() {
  const router = useRouter();
  const connected = useConnectedWallet();
  const [only, setOnly] = useState<Addr | null>(null);
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const a = new URLSearchParams(window.location.search).get("account");
    if (a && isAddress(a, { strict: false })) setOnly(a as Addr);
  }, []);

  const load = useCallback(async () => {
    if (!connected.address) return setGrants(null);
    setErr(null);
    try {
      setGrants(await grantsFor(connected.address));
    } catch (e) {
      setErr(errText(e));
    }
  }, [connected.address]);
  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    if (!grants) return null;
    const list = [...grants];
    // The linked account first.
    if (only)
      list.sort(
        (a, b) =>
          Number(b.account.toLowerCase() === only.toLowerCase()) -
          Number(a.account.toLowerCase() === only.toLowerCase()),
      );
    return list;
  }, [grants, only]);
  const linkedMissing = only && grants && !grants.some((g) => g.account.toLowerCase() === only.toLowerCase());

  return (
    <Screen method="Spend from an account" onBrand={() => router.push("/")}>
      <Title sub="Someone let your wallet spend from their QueueBit account, up to limits they chose. Connect that wallet to see what you can send. You pay no network fees: their account does.">
        Spend from an account
      </Title>

      {!connected.address ? (
        <div className="space-y-3">
          {only && (
            <Notice>
              The account <span className="font-mono">{short(only)}</span> shared this link with you. Connect the wallet
              they gave permission to.
            </Notice>
          )}
          <Primary onClick={connected.open}>Connect your wallet</Primary>
        </div>
      ) : (
        <>
          <dl className="border-t border-ink">
            <Row k="Your wallet">
              <span className="font-mono text-[0.95rem]">{short(connected.address)}</span>
            </Row>
            <Row k="Network">{net.name}</Row>
          </dl>
          <div className="mt-3 flex gap-2">
            <Secondary onClick={connected.open}>Change wallet</Secondary>
            <Secondary onClick={() => void load()}>Refresh</Secondary>
          </div>

          {linkedMissing && (
            <Notice tone="error">
              {short(only!)} hasn&rsquo;t given {short(connected.address)} a permission, or it was removed. Is this the
              wallet they named?
            </Notice>
          )}

          <Section title={`Accounts you can spend from · ${shown?.length ?? "…"}`}>
            {shown === null && !err ? (
              <p className="flex items-center gap-3 mono-label text-ink-3">
                <Working /> Looking for permissions on the chain
              </p>
            ) : shown?.length ? (
              <ul className="space-y-6">
                {shown.map((g) => (
                  <GrantCard key={g.account} g={g} onPaid={load} />
                ))}
              </ul>
            ) : (
              <p className="text-[1rem] text-ink-3">No account has given this wallet a permission yet.</p>
            )}
          </Section>
        </>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

function GrantCard({ g, onPaid }: { g: Grant; onPaid: () => Promise<void> }) {
  const connected = useConnectedWallet();
  const assets = assetsOf(g);
  const [assetKey, setAssetKey] = useState<string>(assets[0]?.asset ?? "ETH");
  const a = assets.find((x) => x.asset === assetKey) ?? assets[0];
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<{ hash: Hex; state: string } | null>(null);
  const ended = g.validUntil * 1000 <= Date.now();

  useEffect(() => {
    // ETH can only go to a listed address: start on the first one.
    if (a?.recipients?.length) setTo(a.recipients[0]!);
    else setTo("");
  }, [a?.asset, a?.recipients]);

  if (!a) return null;
  const parsed = amount ? parseAmountInput(amount, a.decimals, a.symbol) : null;
  const toOk = isAddress(to.trim(), { strict: false });
  const calls = parsed && "wei" in parsed && toOk ? [grantPaymentCall(a.asset, to.trim() as Addr, parsed.wei)] : null;
  const verdict = calls ? check(g, calls) : null;
  const problem =
    parsed && "error" in parsed
      ? parsed.error
      : to.trim() && !toOk
        ? "That isn't an address (0x + 40 characters)."
        : verdict && !verdict.ok
          ? verdict.reason
          : null;

  const send = async () => {
    if (!calls) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const hash = await payWithin(await connected.get(), g, calls);
      setResult({ hash, state: "Sent. Waiting for a block…" });
      const r = await follow(hash);
      setResult({
        hash,
        state:
          r === "mined"
            ? "Done: the payment is on the chain."
            : r === "reverted"
              ? "The account stopped it in execution (its daily limit or end time). Nothing moved; the account paid the fee."
              : r === "dropped"
                ? "The network dropped it before a block took it. Nothing was spent: send it again."
                : "Still on its way. Check the explorer.",
      });
      setAmount("");
      await onPaid();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const link = result ? explorerTxLink(net, result.hash) : undefined;
  return (
    <li className="border-t border-ink pt-4">
      <div className="flex items-center gap-3">
        <Identicon address={g.account} size={36} />
        <div className="min-w-0 flex-1">
          <Address value={g.account} className="block truncate text-[1rem]" />
          <span className={`mono-label text-[11px] ${ended ? "text-red" : "text-ink-3"}`}>
            {endsIn(g.validUntil)} · until {untilText(g.validUntil)}
          </span>
        </div>
      </div>

      <dl className="mt-3">
        {assets.map((x) => (
          <div key={x.asset} className="border-b border-rule py-3">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-[1rem]">{x.symbol}</dt>
              <dd className="text-right tnum">
                {units(x.leftToday, x.decimals)} left today
                <span className="block mono-label text-[11px] text-ink-3">
                  {units(x.perPayment, x.decimals)} per payment · {units(x.perDay, x.decimals)} a day
                </span>
              </dd>
            </div>
            <p className="mt-1 text-[0.9rem] text-ink-3">
              {x.recipients ? `Only to ${x.recipients.map((r) => short(r)).join(", ")}` : "To anyone"}
            </p>
          </div>
        ))}
      </dl>

      {ended ? (
        <Notice>This permission has ended. Ask the owner for a new one.</Notice>
      ) : (
        <div className="mt-4 space-y-4">
          {assets.length > 1 && (
            <label className="block">
              <span className="mono-label text-ink-2">Send</span>
              <select
                value={a.asset}
                onChange={(e) => setAssetKey(e.target.value)}
                className="mt-2 block h-12 w-full border border-ink bg-paper px-3 text-[1rem]"
              >
                {assets.map((x) => (
                  <option key={x.asset} value={x.asset}>
                    {x.symbol}
                  </option>
                ))}
              </select>
            </label>
          )}
          {a.recipients ? (
            <label className="block">
              <span className="mono-label text-ink-2">To</span>
              <select
                value={to}
                onChange={(e) => setTo(e.target.value)}
                className="mt-2 block h-12 w-full border border-ink bg-paper px-3 font-mono text-[0.95rem]"
              >
                {a.recipients.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <Field
              label="To"
              hint="Any address."
              value={to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
            />
          )}
          <Field
            label={`Amount (${a.symbol})`}
            hint={`Up to ${units(a.perPayment < a.leftToday ? a.perPayment : a.leftToday, a.decimals)} ${a.symbol} now.`}
            inputMode="decimal"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.01"
          />
          {problem && <Notice tone="error">{problem}</Notice>}
          <Primary
            busy={busy}
            busyLabel="Sign in your wallet"
            disabled={!calls || !verdict?.ok || busy}
            onClick={() => void send()}
          >
            {calls && verdict?.ok ? `Send ${amount} ${a.symbol}` : "Send"}
          </Primary>
          <p className="text-[0.9rem] text-ink-3">
            Your wallet shows the exact payment to sign. The account pays the network fee.
          </p>
        </div>
      )}
      {result && (
        <Notice>
          {result.state}{" "}
          {link ? (
            <a href={link} target="_blank" rel="noreferrer" className="underline">
              View it
            </a>
          ) : (
            <span className="font-mono">{short(result.hash)}</span>
          )}
        </Notice>
      )}
      {err && <Notice tone="error">{err}</Notice>}
    </li>
  );
}
