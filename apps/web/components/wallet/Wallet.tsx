"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Mark } from "@/components/paper/Logo";
import { Screen, Title, Working } from "@/components/onboarding/ui";
import { engine } from "@/lib/engine/client";
import type { NetworkInfo } from "@/lib/engine/protocol";
import { AccountTab } from "./Account";
import { ActivityTab, EntryDetail } from "./Activity";
import { Home } from "./Home";
import { Receive } from "./Receive";
import { Guardians } from "./Guardians";
import { Permissions } from "./Permissions";
import { Send } from "./Send";
import { WalletProvider } from "./state";
import { AddToken } from "./Tokens";
import { NetworkMenu, WalletsScreen } from "./Wallets";

/**
 * The wallet, after onboarding: three tabs (Home, Activity, Account) and full screens on top of them (Send, Receive,
 * an activity entry). Everything stays in one page so the engine worker, and the unlocked keys it holds in memory,
 * live as long as the tab; the phone's back gesture walks the same stack.
 */

export type Tab = "home" | "activity" | "account";
export type View =
  | { id: "send"; token?: `0x${string}` }
  | { id: "receive" }
  | { id: "guardians" }
  | { id: "permissions" }
  | { id: "entry"; entryId: string }
  | { id: "wallets" }
  | { id: "add-token" };

export interface Nav {
  tab: Tab;
  setTab: (t: Tab) => void;
  open: (v: View) => void;
  back: () => void;
}

export function Wallet() {
  const router = useRouter();
  const [gate, setGate] = useState<"loading" | "other-tab" | "open">("loading");
  const [net, setNet] = useState<NetworkInfo>();

  useEffect(() => {
    const e = engine();
    void e.start().then(async (s) => {
      if (s === "other-tab") return setGate("other-tab");
      const st = await e.call("state:get");
      if (!st.initialized || !st.unlocked) return router.replace("/start");
      setNet(await e.getNetwork());
      setGate("open");
    });
  }, [router]);

  if (gate === "loading")
    return (
      <Screen>
        <div className="flex h-[50dvh] items-center justify-center gap-3 mono-label text-ink-3">
          <Working /> Opening QueueBit
        </div>
      </Screen>
    );
  if (gate === "other-tab")
    return (
      <Screen>
        <Title sub="Only one tab runs the wallet at a time, so the quantum-safe key's signature count is never raced. Close the other tab, then reload this one.">
          QueueBit is open in another tab
        </Title>
      </Screen>
    );
  return (
    <WalletProvider net={net}>
      <Shell />
    </WalletProvider>
  );
}

function Shell() {
  const [tab, setTabState] = useState<Tab>("home");
  const [stack, setStack] = useState<View[]>([]);
  const view = stack[stack.length - 1];

  const open = useCallback((v: View) => setStack((s) => [...s, v]), []);
  const back = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  const setTab = useCallback((t: Tab) => {
    setStack([]);
    setTabState(t);
    window.scrollTo(0, 0);
  }, []);

  // The phone's back gesture closes the screen on top.
  const depth = useRef(0);
  useEffect(() => {
    if (stack.length > depth.current) history.pushState({ qbw: stack.length }, "");
    depth.current = stack.length;
  }, [stack.length]);
  useEffect(() => {
    const on = () => setStack((s) => s.slice(0, -1));
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [view]);

  const nav: Nav = { tab, setTab, open, back };
  if (view?.id === "send") return <Send nav={nav} {...(view.token ? { token: view.token } : {})} />;
  if (view?.id === "wallets") return <WalletsScreen nav={nav} />;
  if (view?.id === "add-token") return <AddToken nav={nav} />;
  if (view?.id === "receive") return <Receive nav={nav} />;
  if (view?.id === "guardians") return <Guardians nav={nav} />;
  if (view?.id === "permissions") return <Permissions nav={nav} />;
  if (view?.id === "entry") return <EntryDetail nav={nav} entryId={view.entryId} />;

  return (
    <TabFrame tab={tab} setTab={setTab}>
      {tab === "home" && <Home nav={nav} />}
      {tab === "activity" && <ActivityTab nav={nav} />}
      {tab === "account" && <AccountTab nav={nav} />}
    </TabFrame>
  );
}

function TabFrame({ tab, setTab, children }: { tab: Tab; setTab: (t: Tab) => void; children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 bg-paper pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 max-w-[560px] items-center gap-2.5 px-5">
          <button
            type="button"
            onClick={() => setTab("home")}
            aria-label="QueueBit, home"
            className="-ml-1 flex h-11 items-center gap-2.5 px-1 active:opacity-70"
          >
            <Mark size={24} />
            <span className="font-display text-[1.25rem] leading-none font-light tracking-[-0.01em] text-blue">
              QueueBit
            </span>
          </button>
          <NetworkMenu />
          <LockButton />
        </div>
      </header>
      <main className="mx-auto w-full max-w-[560px] flex-1 px-5 pt-6 pb-10">{children}</main>
      <nav
        aria-label="Wallet"
        className="sticky bottom-0 z-10 border-t border-ink bg-paper pb-[env(safe-area-inset-bottom)]"
      >
        <ul className="mx-auto grid max-w-[560px] grid-cols-3">
          {(
            [
              ["home", "Home", <IconHome key="h" />],
              ["activity", "Activity", <IconList key="a" />],
              ["account", "Account", <IconKey key="k" />],
            ] as const
          ).map(([id, label, icon]) => (
            <li key={id}>
              <button
                type="button"
                onClick={() => setTab(id)}
                aria-current={tab === id ? "page" : undefined}
                className={`mono-label flex h-[60px] w-full flex-col items-center justify-center gap-1.5 text-[11px] ${
                  tab === id ? "text-blue" : "text-ink-3 active:text-ink"
                }`}
              >
                {icon}
                {label}
                <span aria-hidden className={`h-[3px] w-6 ${tab === id ? "bg-blue" : "bg-transparent"}`} />
              </button>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

/** Locks the wallet now: the keys leave memory and the passkey (or password) opens it again. */
function LockButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void engine()
          .call("keyring:lock")
          .finally(() => router.replace("/start"));
      }}
      className="mono-label -mr-1 flex h-11 items-center gap-1.5 border border-ink px-2.5 text-[11px] active:bg-paper-3 disabled:text-ink-3"
    >
      <svg viewBox="0 0 14 16" aria-hidden className="h-3.5 w-3 fill-none stroke-current [stroke-width:1.3]">
        <path d="M3.5 7V4.8a3.5 3.5 0 0 1 7 0V7" />
        <rect x="1.5" y="7" width="11" height="8" />
      </svg>
      Lock
    </button>
  );
}

const icon = "size-[20px] fill-none stroke-current [stroke-width:1.3] [stroke-linejoin:round] [stroke-linecap:round]";

function IconHome() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={icon}>
      <circle cx="10" cy="10" r="7.5" />
      <circle cx="10" cy="10" r="4.5" strokeDasharray="0.01 2.4" />
    </svg>
  );
}

function IconList() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={icon}>
      <path d="M3 5h14M3 10h14M3 15h9" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden className={icon}>
      <circle cx="7" cy="10" r="3.6" />
      <path d="M10.6 10H17.5M15 10v3M17.5 10v2.2" />
    </svg>
  );
}
