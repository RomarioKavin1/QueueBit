"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { createPublicClient, http } from "viem";
import { Field, Notice, Primary, Screen, Secondary, Title } from "@/components/onboarding/ui";
import { engine } from "@/lib/engine/client";
import { short } from "@/lib/format";
import { GhostSeal } from "./bits";
import { Identicon } from "./Identicon";
import { errText, useWallet, type WalletRow } from "./state";
import type { Nav } from "./Wallet";

/**
 * The wallets on this phone. Each has its own passkey or password, its own quantum-safe key and account; one is open
 * at a time. Opening another locks this one, then asks for that wallet's passkey or password.
 */
export function WalletsScreen({ nav }: { nav: Nav }) {
  const router = useRouter();
  const { wallets, refresh } = useWallet();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const list = wallets?.wallets ?? [];

  const open = async (w: WalletRow) => {
    if (w.id === wallets?.active) return nav.back();
    setBusy(w.id);
    setErr(null);
    try {
      await engine().switchWallet(w.id);
      router.replace("/start");
    } catch (e) {
      setErr(errText(e));
      setBusy(null);
    }
  };

  const remove = async (w: WalletRow) => {
    setErr(null);
    try {
      await engine().removeWallet(w.id);
      await refresh();
    } catch (e) {
      setErr(errText(e));
    }
  };

  if (adding) return <AddWallet count={list.length} onBack={() => setAdding(false)} />;

  return (
    <Screen
      onBack={nav.back}
      method="Wallets"
      actions={<Primary onClick={() => setAdding(true)}>Add a wallet</Primary>}
    >
      <Title sub="Each has its own passkey or password and its own quantum-safe account. Opening another locks this one.">
        Your wallets
      </Title>
      <ul className="border-t border-ink">
        {list.map((w) => {
          const active = w.id === wallets?.active;
          return (
            <li key={w.id} className="border-b border-rule">
              {renaming === w.id ? (
                <RenameField
                  wallet={w}
                  onDone={async () => {
                    setRenaming(null);
                    await refresh();
                  }}
                />
              ) : (
                <div className="flex min-h-[72px] items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void open(w)}
                    disabled={busy !== null}
                    aria-current={active ? "true" : undefined}
                    aria-label={active ? `${w.name}, open now` : `Open ${w.name}`}
                    className="flex min-w-0 flex-1 items-center gap-3 py-3 text-left active:bg-blue-wash"
                  >
                    {w.address ? <Identicon address={w.address} size={38} /> : <GhostSeal size={38} />}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[1.05rem] leading-snug font-medium">{w.name}</span>
                        {active && (
                          <span className="mono-label shrink-0 border border-blue px-1.5 py-0.5 text-[10px] text-blue">
                            Open
                          </span>
                        )}
                      </span>
                      <span className="mono-label mt-0.5 block text-[11px] text-ink-3">
                        {!w.initialized
                          ? "Not set up yet"
                          : `${w.address ? short(w.address) : "Address after unlock"} · ${w.lockedWith === "passkey" ? "Passkey" : "Password"}`}
                      </span>
                    </span>
                    {busy === w.id && <span className="mono-label text-[11px] text-blue">Opening…</span>}
                  </button>
                  {w.initialized || active ? (
                    <button
                      type="button"
                      onClick={() => setRenaming(w.id)}
                      className="mono-label h-11 px-2 text-[11px] text-blue"
                    >
                      Rename
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void remove(w)}
                      className="mono-label h-11 px-2 text-[11px] text-ink-2 active:text-red"
                    >
                      Remove
                    </button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

/** A wallet's name, edited in place. */
export function RenameField({ wallet, onDone }: { wallet: WalletRow; onDone: () => void | Promise<void> }) {
  const [name, setName] = useState(wallet.name);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    try {
      await engine().renameWallet(wallet.id, name);
      await onDone();
    } catch (e) {
      setErr(errText(e));
    }
  };
  return (
    <div className="flex items-end gap-2 py-3">
      <div className="flex-1">
        <Field
          label="Name"
          value={name}
          maxLength={32}
          autoFocus
          onChange={(e) => {
            setName(e.target.value);
            setErr(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") void onDone();
          }}
          error={err}
        />
      </div>
      <button
        type="button"
        onClick={() => void save()}
        disabled={!name.trim()}
        className="mono-label mb-[1px] h-12 border border-blue bg-blue px-3.5 text-on-blue disabled:border-rule disabled:bg-paper-3 disabled:text-ink-3"
      >
        Save
      </button>
    </div>
  );
}

/**
 * Add a wallet: name it, then set it up like the first one (a passkey, 24 words, or a move from another wallet).
 * The wallet open now is locked and stays on this phone, untouched.
 */
function AddWallet({ count, onBack }: { count: number; onBack: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(`Wallet ${count + 1}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await engine().addWallet(name);
      router.replace("/start");
    } catch (e) {
      setErr(errText(e));
      setBusy(false);
    }
  };
  return (
    <Screen
      onBack={onBack}
      method="Add a wallet"
      actions={
        <>
          <Primary onClick={() => void go()} busy={busy} busyLabel="Making room" disabled={!name.trim()}>
            Continue
          </Primary>
          <Secondary onClick={onBack}>Cancel</Secondary>
        </>
      }
    >
      <Title sub="Next you choose how it's locked and where it starts: a new passkey, 24 words, or a move from another wallet. This wallet locks and stays on this phone as it is.">
        Name the new wallet
      </Title>
      <Field
        label="Name"
        value={name}
        maxLength={32}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && name.trim() && void go()}
        hint="Only on this phone. You can change it later."
      />
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}

// ---- network ------------------------------------------------------------------------------------------------------

/**
 * The network, as a drop-down in the top bar: the list (one network for now, the alt-mempool devnet) and, under it,
 * what the wallet talks to on that chain, each endpoint copyable, plus the chain's latest block read live.
 */
export function NetworkMenu() {
  const { net } = useWallet();
  const [open, setOpen] = useState(false);
  const [block, setBlock] = useState<bigint | null | "error">(null);
  const ref = useRef<HTMLDivElement>(null);
  const panel = useId();

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !net) return;
    setBlock(null);
    const c = createPublicClient({ transport: http(net.rpcUrl, { timeout: 10_000, retryCount: 0 }) });
    void c.getBlockNumber().then(setBlock, () => setBlock("error"));
  }, [open, net]);

  const label = net ? (net.localDevnet ? "Local devnet" : "Devnet") : "Network";
  return (
    <div ref={ref} className="ml-auto">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-controls={panel}
        aria-label={`Network: ${net?.name ?? "loading"}. Show networks and chain details`}
        className="mono-label flex h-11 items-center gap-1.5 px-1.5 text-[11px] text-ink-2 active:text-ink"
      >
        <svg viewBox="0 0 6 6" aria-hidden className="size-1.5 text-blue">
          <circle cx="3" cy="3" r="3" fill="currentColor" />
        </svg>
        {label}
        <svg viewBox="0 0 10 6" aria-hidden className={`w-2.5 transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="M1 1l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      </button>
      {open && net && (
        <div
          id={panel}
          className="absolute inset-x-0 top-full border-y border-ink bg-paper shadow-[0_12px_24px_-16px_rgb(0_0_0/0.25)]"
        >
          <div className="mx-auto max-h-[calc(100dvh-8rem)] max-w-[560px] overflow-y-auto px-5 pt-4 pb-5">
            <h2 className="mono-label text-[11px] text-ink-3">Networks</h2>
            <ul className="mt-2 border-t border-ink" role="listbox" aria-label="Networks">
              <li
                role="option"
                aria-selected
                className="flex min-h-[56px] items-center gap-3 border-b border-rule py-2.5"
              >
                <span
                  aria-hidden
                  className="grid size-8 place-items-center border border-blue font-mono text-[10px] text-blue"
                >
                  {net.chainId}
                </span>
                <span className="flex-1">
                  <span className="block text-[1rem] leading-snug">{net.name}</span>
                  <span className="mono-label block text-[10.5px] text-ink-3">Test network · test money only</span>
                </span>
                <span className="mono-label text-[11px] text-blue">✓</span>
              </li>
            </ul>
            <p className="mt-2 text-[0.85rem] leading-[1.5] text-ink-3">
              QueueBit runs where quantum-safe accounts are deployed. More networks come as they get the contracts.
            </p>

            <h2 className="mono-label mt-6 text-[11px] text-ink-3">Chain information</h2>
            <dl className="mt-2 border-t border-ink">
              <Info k="Chain ID">
                {net.chainId} <span className="text-ink-3">(0x{net.chainId.toString(16)})</span>
              </Info>
              <Info k="Currency">ETH · 18 decimals</Info>
              <Info k="Latest block">
                {block === null ? "Reading…" : block === "error" ? "Node didn't answer" : block.toLocaleString("en-US")}
              </Info>
              <Info k="RPC" copy={net.rpcUrl}>
                {host(net.rpcUrl)}
              </Info>
              <Info k="LeanPool node" copy={net.leanpoolUrl}>
                {host(net.leanpoolUrl)}
              </Info>
              <Info k="Alt-mempool" copy={net.sidecarUrl}>
                {host(net.sidecarUrl)}
              </Info>
              {net.aggregator && (
                <Info k="Aggregator" copy={net.aggregator}>
                  {short(net.aggregator)}
                </Info>
              )}
              {net.explorerTxUrl && (
                <Info k="Explorer" copy={new URL(net.explorerTxUrl.replace("{hash}", "")).origin}>
                  {host(net.explorerTxUrl)}
                </Info>
              )}
            </dl>
          </div>
        </div>
      )}
    </div>
  );
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function Info({ k, copy, children }: { k: string; copy?: string; children: React.ReactNode }) {
  const [done, setDone] = useState(false);
  return (
    <div className="flex min-h-11 items-center justify-between gap-3 border-b border-rule py-2">
      <dt className="mono-label shrink-0 text-[11px] text-ink-3">{k}</dt>
      <dd className="flex min-w-0 items-center gap-2 text-right text-[0.95rem] tnum">
        <span className="truncate">{children}</span>
        {copy && (
          <button
            type="button"
            aria-label={`Copy ${k}`}
            onClick={() =>
              void navigator.clipboard?.writeText(copy).then(() => {
                setDone(true);
                setTimeout(() => setDone(false), 1400);
              })
            }
            className="mono-label h-8 shrink-0 px-1 text-[10.5px] text-blue"
          >
            {done ? "Copied" : "Copy"}
          </button>
        )}
      </dd>
    </div>
  );
}
