"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { LineArrow, Notice, Working } from "@/components/onboarding/ui";
import { askFaucet, waitForWei } from "@/lib/faucet";
import { ago, eth, short } from "@/lib/format";
import { engine } from "@/lib/engine/client";
import { EntryRow, GhostSeal, Section, SignatureGauge } from "./bits";
import { Identicon } from "./Identicon";
import { errText, useWallet } from "./state";
import type { Nav } from "./Wallet";

/**
 * Home, laid out the way MetaMask and Phantom taught everyone: who you are (avatar, address, copy), what you have
 * (one big balance), what you can do (a row of actions), then assets and recent activity. The quantum-safe parts
 * ride along quietly: the account's state and the signatures left.
 */
export function Home({ nav }: { nav: Nav }) {
  const router = useRouter();
  const { status, activity, budget, backedUp, net, error, refresh } = useWallet();
  const [faucet, setFaucet] = useState<"idle" | "asking">("idle");
  const [faucetErr, setFaucetErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const wei = BigInt(status?.accountWei ?? "0");
  const empty = status !== null && wei === 0n;
  const canFaucet = net !== undefined && !net.localDevnet;
  const address = status?.address;

  const copy = () =>
    address &&
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });

  const getTestEth = async () => {
    if (!address) return;
    setFaucet("asking");
    setFaucetErr(null);
    try {
      await askFaucet(address);
      await waitForWei(async () => BigInt((await engine().call("account:status", {})).accountWei ?? "0"), wei + 1n, 20);
      await refresh();
    } catch (e) {
      setFaucetErr(errText(e));
    } finally {
      setFaucet("idle");
    }
  };

  return (
    <>
      {/* Who: the account's face, its address, one tap to copy */}
      <button
        type="button"
        onClick={copy}
        disabled={!address}
        className="flex w-full items-center gap-3 text-left active:opacity-70"
        aria-label={address ? `Copy address ${address}` : "Reading your account"}
      >
        {address ? <Identicon address={address} size={40} /> : <span className="size-10 bg-paper-3" />}
        <span className="min-w-0 flex-1">
          <span className="block text-[1.05rem] leading-tight font-medium">My account</span>
          <span className="mt-0.5 flex items-center gap-1.5 font-mono text-[13px] text-ink-2">
            {address ? short(address) : "…"}
            <CopyIcon />
            {copied && <span className="mono-label text-[11px] text-blue">Copied</span>}
          </span>
        </span>
        {status && (
          <span
            className={`mono-label shrink-0 border px-2 py-1 text-[10.5px] ${
              status.deployed ? "border-blue text-blue" : "border-rule text-ink-3"
            }`}
          >
            {status.deployed ? "Quantum-safe" : "Not created"}
          </span>
        )}
      </button>

      {/* What you have */}
      <section aria-label="Balance" className="mt-9 text-center">
        {status ? (
          <p className="flex items-baseline justify-center gap-2.5">
            <span className="text-[clamp(3rem,15vw,4rem)] leading-none tracking-[-0.02em] tnum">{eth(wei, 5)}</span>
            <span className="mono-label text-[14px] text-ink-2">ETH</span>
          </p>
        ) : (
          <p className="flex h-16 items-center justify-center gap-3 mono-label text-ink-3">
            <Working /> Reading your account
          </p>
        )}
        <p className="mt-3 mono-label text-[11px] text-ink-3">
          {net?.name ?? "Test network"} · updated {status ? ago(status.readAt) : "…"}
        </p>
      </section>

      {/* What you can do */}
      <div className={`mt-8 grid gap-2 ${canFaucet ? "grid-cols-3" : "grid-cols-2"}`}>
        <Action label="Send" onClick={() => nav.open({ id: "send" })} disabled={!address} primary>
          <path d="M4 16L16 4M7 4h9v9" />
        </Action>
        <Action label="Receive" onClick={() => nav.open({ id: "receive" })} disabled={!address}>
          <path d="M16 4L4 16M13 16H4V7" />
        </Action>
        {canFaucet && (
          <Action
            label={faucet === "asking" ? "Asking…" : "Test ETH"}
            onClick={() => void getTestEth()}
            disabled={!address || faucet === "asking"}
          >
            <path d="M10 2.5c3 4 5 6.6 5 9.3a5 5 0 0 1-10 0c0-2.7 2-5.3 5-9.3z" />
          </Action>
        )}
      </div>
      {faucetErr && <Notice tone="error">{faucetErr}</Notice>}
      {error && !address && <Notice tone="error">{error}</Notice>}

      {/* Things to do once, as quiet strips */}
      {status && !status.deployed && (
        <Strip
          icon={<GhostSeal size={34} />}
          onClick={empty && canFaucet ? () => void getTestEth() : () => nav.open({ id: "send" })}
        >
          <b className="font-medium">Your account isn&apos;t on the network yet.</b>{" "}
          {empty ? "Add ETH, then your first payment creates it." : "Your first payment creates it."}
        </Strip>
      )}
      {backedUp === false && (
        <Strip icon={<Num>24</Num>} onClick={() => router.push("/start#backup")}>
          <b className="font-medium">Back up your 24 words.</b> Lose the phone without them, lose the wallet.
        </Strip>
      )}

      <Section title="Assets">
        <ul className="border-t border-ink">
          <li className="flex min-h-[64px] items-center gap-3.5 border-b border-rule py-3">
            <EthGlyph />
            <span className="flex-1">
              <span className="block text-[1.02rem] leading-snug">Ether</span>
              <span className="mono-label block text-[11px] text-ink-3">ETH · test</span>
            </span>
            <span className="text-[1.05rem] tnum">{status ? eth(wei, 6) : "…"}</span>
          </li>
        </ul>
      </Section>

      {status && (
        <Section title="Quantum-safe signatures left">
          <SignatureGauge left={status.ownerSignaturesLeft} budget={budget} />
        </Section>
      )}

      <Section
        title="Recent"
        aside={
          activity.length > 3 ? (
            <button type="button" onClick={() => nav.setTab("activity")} className="mono-label h-9 text-blue">
              See all
            </button>
          ) : undefined
        }
      >
        {activity.length ? (
          <ul className="border-t border-ink">
            {activity.slice(0, 3).map((e) => (
              <EntryRow key={e.id} e={e} onOpen={() => nav.open({ id: "entry", entryId: e.id })} />
            ))}
          </ul>
        ) : (
          <p className="border-t border-ink py-4 text-[0.98rem] text-ink-3">Payments you send show up here.</p>
        )}
      </Section>
    </>
  );
}

/** A square action tile: drawn icon over a mono label. Send is the filled one. */
function Action({
  label,
  onClick,
  disabled,
  primary,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`mono-label flex h-[76px] flex-col items-center justify-center gap-2 border text-[12px] disabled:border-rule disabled:bg-paper-3 disabled:text-ink-3 ${
        primary ? "border-blue bg-blue text-on-blue active:brightness-90" : "border-ink bg-paper active:bg-paper-3"
      }`}
    >
      <svg
        viewBox="0 0 20 20"
        aria-hidden
        className="size-5 fill-none stroke-current [stroke-linecap:round] [stroke-linejoin:round] [stroke-width:1.4]"
      >
        {children}
      </svg>
      {label}
    </button>
  );
}

function Strip({ icon, onClick, children }: { icon: ReactNode; onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-3 flex w-full items-center gap-3.5 border border-rule bg-paper-2 px-3.5 py-3 text-left text-[0.95rem] leading-[1.45] text-ink-2 active:bg-blue-wash"
    >
      {icon}
      <span className="flex-1">{children}</span>
      <LineArrow className="shrink-0 text-ink-3" />
    </button>
  );
}

function Num({ children }: { children: ReactNode }) {
  return (
    <span className="grid size-[34px] shrink-0 place-items-center border border-blue font-mono text-[13px] text-blue">
      {children}
    </span>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 14 14" aria-hidden className="size-3.5 fill-none stroke-current [stroke-width:1.2]">
      <rect x="4.5" y="4.5" width="8" height="8" />
      <path d="M2 9.5V2h7.5" />
    </svg>
  );
}

/** Ether's octahedron, drawn as a line figure in the plates' blue. */
function EthGlyph() {
  return (
    <svg viewBox="0 0 40 40" width={38} height={38} aria-hidden className="shrink-0">
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
}
