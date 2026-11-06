"use client";

import { useState } from "react";
import { getAddress, isAddress } from "viem";
import { Field, Notice, Primary, Screen, Title } from "@/components/onboarding/ui";
import { engine } from "@/lib/engine/client";
import { eth, short, units } from "@/lib/format";
import { LineArrow } from "@/components/onboarding/ui";
import { errText, useWallet, type TokenBalance } from "./state";
import type { Nav } from "./Wallet";

/**
 * Assets: ETH and every ERC-20 the account holds or the network lists, each one a tap from sending it. Any other
 * token can be added by its contract address; its symbol, name and decimals are read from the chain, never typed.
 */
export function Assets({ nav }: { nav: Nav }) {
  const { status, tokens } = useWallet();
  const wei = BigInt(status?.accountWei ?? "0");
  // Held tokens first, then the rest of the list, so what you have is what you see.
  const sorted = [...tokens].sort((a, b) => Number(BigInt(b.balance) > 0n) - Number(BigInt(a.balance) > 0n));
  return (
    <ul className="border-t border-ink">
      <AssetRow
        symbol="ETH"
        name="Ether"
        sub="ETH · pays every fee"
        amount={status ? eth(wei, 6) : "…"}
        onClick={() => nav.open({ id: "send" })}
      />
      {sorted.map((t) => (
        <AssetRow
          key={t.token}
          token={t.token}
          symbol={t.symbol}
          name={t.name}
          sub={`${t.symbol} · ${short(t.token)}`}
          amount={units(t.balance, t.decimals, 6)}
          muted={BigInt(t.balance) === 0n}
          onClick={() => nav.open({ id: "send", token: t.token })}
        />
      ))}
      <li>
        <button
          type="button"
          onClick={() => nav.open({ id: "add-token" })}
          className="flex min-h-[56px] w-full items-center gap-3.5 border-b border-rule py-3 text-left active:bg-blue-wash"
        >
          <span className="grid size-[38px] shrink-0 place-items-center border border-dashed border-blue text-blue">
            <svg viewBox="0 0 14 14" aria-hidden className="size-3.5 fill-none stroke-current [stroke-width:1.3]">
              <path d="M7 1.5v11M1.5 7h11" />
            </svg>
          </span>
          <span className="flex-1 text-[1rem] text-blue">Add a token</span>
          <LineArrow className="text-ink-3" />
        </button>
      </li>
    </ul>
  );
}

function AssetRow({
  token,
  symbol,
  name,
  sub,
  amount,
  muted,
  onClick,
}: {
  token?: `0x${string}`;
  symbol: string;
  name: string;
  sub: string;
  amount: string;
  muted?: boolean;
  onClick: () => void;
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-label={`${name}: ${amount} ${symbol}. Send ${symbol}`}
        className="flex min-h-[64px] w-full items-center gap-3.5 border-b border-rule py-3 text-left active:bg-blue-wash"
      >
        <TokenGlyph symbol={symbol} token={token} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[1.02rem] leading-snug">{name}</span>
          <span className="mono-label block truncate text-[11px] text-ink-3">{sub}</span>
        </span>
        <span className={`text-[1.05rem] tnum ${muted ? "text-ink-3" : ""}`}>{amount}</span>
      </button>
    </li>
  );
}

/**
 * A token's face. Ether gets its octahedron; any other token a seal with its symbol set in mono, tinted from its
 * contract address so two tokens with the same symbol still look different.
 */
export function TokenGlyph({ symbol, token, size = 38 }: { symbol: string; token?: string; size?: number }) {
  if (!token)
    return (
      <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden className="shrink-0">
        <circle cx="20" cy="20" r="19" fill="var(--blue-t1)" stroke="var(--blue)" strokeWidth="1.2" />
        <path
          d="M20 8l-7 12.2L20 24l7-3.8z"
          fill="var(--blue-t2)"
          stroke="var(--blue)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
        <path
          d="M13 21.8L20 32l7-10.2L20 25.6z"
          fill="var(--blue-t3)"
          stroke="var(--blue)"
          strokeWidth="1"
          strokeLinejoin="round"
        />
      </svg>
    );
  const n = parseInt(token.slice(-2), 16);
  const tint = ["var(--paper)", "var(--blue-t1)", "var(--blue-t2)"][n % 3];
  const label =
    symbol
      .replace(/[^A-Za-z0-9]/gu, "")
      .slice(0, 4)
      .toUpperCase() || "?";
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden className="shrink-0">
      <circle cx="20" cy="20" r="19" fill={tint} stroke="var(--blue)" strokeWidth="1.2" />
      <circle
        cx="20"
        cy="20"
        r="15.5"
        fill="none"
        stroke="var(--blue)"
        strokeWidth="0.9"
        strokeDasharray="0.01 2.6"
        strokeLinecap="round"
        opacity="0.55"
      />
      <text
        x="20"
        y="20"
        textAnchor="middle"
        dominantBaseline="central"
        fill="var(--ink)"
        style={{ font: `500 ${label.length > 3 ? 8.4 : 10}px var(--font-mono, ui-monospace)`, letterSpacing: "0.02em" }}
      >
        {label}
      </text>
    </svg>
  );
}

/** Add a token by its contract address: the chain says what it is; the person checks it before it's kept. */
export function AddToken({ nav }: { nav: Nav }) {
  const { net, refresh, tokens } = useWallet();
  const [addr, setAddr] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [added, setAdded] = useState<TokenBalance | null>(null);
  const valid = isAddress(addr.trim(), { strict: false });
  const custom = tokens.filter((t) => t.custom);

  const add = async () => {
    if (!valid) return setErr("A token's contract address starts with 0x and has 40 more characters.");
    setBusy(true);
    setErr(null);
    try {
      const t = await engine().call("tokens:add", { token: getAddress(addr.trim()) });
      setAdded(t);
      setAddr("");
      await refresh();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (token: `0x${string}`) => {
    await engine().call("tokens:remove", { token });
    if (added?.token === token) setAdded(null);
    await refresh();
  };

  return (
    <Screen
      onBack={nav.back}
      method="Tokens"
      actions={
        <Primary onClick={() => void add()} busy={busy} busyLabel="Reading the token" disabled={!addr.trim()}>
          Add token
        </Primary>
      }
    >
      <Title sub={`Any ERC-20 on ${net?.name ?? "this network"}. Its name, symbol and decimals come from the chain.`}>
        Add a token
      </Title>
      <Field
        label="Token contract address"
        placeholder="0x…"
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        value={addr}
        onChange={(e) => {
          setAddr(e.target.value);
          setErr(null);
        }}
        onKeyDown={(e) => e.key === "Enter" && void add()}
        className="font-mono"
        error={err}
      />
      {added && (
        <Notice>
          Added {added.name} ({added.symbol}). This account holds {units(added.balance, added.decimals, 6)}{" "}
          {added.symbol}.
        </Notice>
      )}

      {custom.length > 0 && (
        <section className="mt-9">
          <h2 className="mono-label mb-2 text-ink-2">Added on this device</h2>
          <ul className="border-t border-ink">
            {custom.map((t) => (
              <li key={t.token} className="flex min-h-[60px] items-center gap-3 border-b border-rule py-2.5">
                <TokenGlyph symbol={t.symbol} token={t.token} size={32} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[1rem]">{t.name}</span>
                  <span className="mono-label block text-[11px] text-ink-3">
                    {t.symbol} · {short(t.token)}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => void remove(t.token)}
                  className="mono-label h-10 px-2 text-[11px] text-ink-2 active:text-red"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Screen>
  );
}
