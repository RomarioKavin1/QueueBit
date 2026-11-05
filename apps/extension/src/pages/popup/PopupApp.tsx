import { useState } from "react";
import { browser } from "wxt/browser";
import { NETWORKS } from "../../shared/chains";
import type { WalletState } from "../../shared/types";
import {
  ActivityIcon,
  AppsIcon,
  Button,
  ChevronDownIcon,
  ExternalIcon,
  HomeIcon,
  LockIcon,
  LogoMark,
  MoreIcon,
  SendIcon,
  SettingsIcon,
  Spinner,
} from "../../ui";
import { cx } from "../../ui/cx";
import { call } from "../lib/api";
import { useTheme, useWalletState } from "../lib/hooks";
import { MenuButton } from "../common/Menu";
import { UnlockForm } from "../common/Unlock";
import { ActivateScreen } from "./Activate";
import { Home } from "./Home";
import { SendScreen } from "./Send";
import { SettingsScreen } from "./Settings";
import { ActivityTab, AppsTab } from "./Tabs";

export type Tab = "home" | "send" | "activity" | "apps";

export function openFullApp(hash = "") {
  void browser.tabs.create({ url: browser.runtime.getURL(`/app.html${hash}`) });
}

/** The 360 × 600 popup (ux-spec §2.2). Also rendered inside the full-tab app for M0. */
export function PopupApp({ inTab = false, initialTab = "home" }: { inTab?: boolean; initialTab?: Tab }) {
  const { state, error } = useWalletState();
  useTheme(state?.settings.theme);

  const close = () => {
    if (!inTab) window.close();
  };

  if (!state) {
    return (
      <Frame>
        <div className="grid flex-1 place-items-center text-muted">
          {error ? <p className="t-small p-4 text-center">{error}</p> : <Spinner size={24} label="Loading LEAKED" />}
        </div>
      </Frame>
    );
  }
  if (!state.initialized) {
    return (
      <Frame>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6 text-center">
          <LogoMark size={64} />
          <div>
            <h1 className="t-title">Welcome to LEAKED</h1>
            <p className="t-body mt-1 text-muted">Small payments are instant. Your phone approves the rest.</p>
          </div>
          <Button
            block
            onClick={() => {
              openFullApp("#onboarding");
              close();
            }}
          >
            Set up LEAKED
          </Button>
        </div>
      </Frame>
    );
  }
  if (!state.unlocked) {
    return (
      <Frame>
        <div className="flex-1 overflow-y-auto p-4">
          <UnlockForm />
        </div>
      </Frame>
    );
  }
  return <Unlocked state={state} close={close} initialTab={initialTab} />;
}

function Unlocked({ state, close, initialTab }: { state: WalletState; close: () => void; initialTab: Tab }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [screen, setScreen] = useState<"tabs" | "settings" | "activate">("tabs");
  const [sendPrefill, setSendPrefill] = useState<{ to: string } | undefined>(undefined);

  if (screen !== "tabs") {
    return (
      <Frame>
        <div className="flex-1 overflow-y-auto">
          {screen === "settings" ? (
            <SettingsScreen state={state} onBack={() => setScreen("tabs")} />
          ) : (
            <ActivateScreen state={state} onBack={() => setScreen("tabs")} />
          )}
        </div>
      </Frame>
    );
  }

  return (
    <Frame>
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-line pr-1 pl-3">
        <LogoMark size={22} />
        <h1 className="t-strong">LEAKED</h1>
        <NetworkSwitcher chainId={state.settings.selectedChainId} />
        <MenuButton
          label="More"
          icon={<MoreIcon />}
          items={[
            { label: "Settings", icon: <SettingsIcon size={18} />, onSelect: () => setScreen("settings") },
            { label: "Lock now", icon: <LockIcon size={18} />, onSelect: () => void call("keyring:lock") },
            {
              label: "Open full app",
              icon: <ExternalIcon size={18} />,
              onSelect: () => {
                openFullApp(state.setup.completedAt ? "" : "#onboarding");
                close();
              },
            },
          ]}
        />
      </header>
      <main className="flex-1 overflow-y-auto" id="main">
        {tab === "home" && (
          <Home
            state={state}
            onSend={(prefill) => (setSendPrefill(prefill), setTab("send"))}
            onActivate={() => setScreen("activate")}
            onOpenApp={() => (openFullApp("#onboarding"), close())}
          />
        )}
        {tab === "send" && (
          <SendScreen
            key={sendPrefill?.to ?? "send"}
            state={state}
            {...(sendPrefill ? { prefill: sendPrefill } : {})}
            onExit={() => (setSendPrefill(undefined), setTab("home"))}
            onActivity={() => (setSendPrefill(undefined), setTab("activity"))}
          />
        )}
        {tab === "activity" && <ActivityTab />}
        {tab === "apps" && <AppsTab />}
      </main>
      <TabBar tab={tab} onChange={(t) => (setSendPrefill(undefined), setTab(t))} />
    </Frame>
  );
}

function NetworkSwitcher({ chainId }: { chainId: number }) {
  return (
    <div className="relative ml-auto">
      <label htmlFor="network-switcher" className="sr-only">
        Network
      </label>
      <select
        id="network-switcher"
        value={String(chainId)}
        onChange={(e) => void call("settings:update", { selectedChainId: Number(e.target.value) })}
        className="t-small min-h-9 cursor-pointer appearance-none rounded-full border border-line bg-surface py-1 pr-7 pl-3 font-semibold text-fg hover:bg-surface-2"
      >
        {NETWORKS.map((n) => (
          <option key={n.chainId} value={n.chainId}>
            {n.shortName}
          </option>
        ))}
      </select>
      <span aria-hidden="true" className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 text-muted">
        <ChevronDownIcon size={14} />
      </span>
    </div>
  );
}

const TABS: Array<{ id: Tab; label: string; icon: React.ReactNode }> = [
  { id: "home", label: "Home", icon: <HomeIcon /> },
  { id: "send", label: "Send", icon: <SendIcon /> },
  { id: "activity", label: "Activity", icon: <ActivityIcon /> },
  { id: "apps", label: "Apps", icon: <AppsIcon /> },
];

function TabBar({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  return (
    <nav aria-label="Main" className="grid h-12 shrink-0 grid-cols-4 border-t border-line bg-bg">
      {TABS.map((t) => (
        <button
          key={t.id}
          type="button"
          aria-current={tab === t.id ? "page" : undefined}
          onClick={() => onChange(t.id)}
          className={cx(
            "flex flex-col items-center justify-center gap-0.5 text-[12px] leading-4",
            tab === t.id ? "font-semibold text-brand" : "text-muted hover:text-fg",
          )}
        >
          <span aria-hidden="true">{t.icon}</span>
          {t.label}
        </button>
      ))}
    </nav>
  );
}

/**
 * The 360 × 600 surface. The action popup is sized by its content, so the frame fixes its own height; the approval
 * window is created 360 × 600 *outer* (`chrome.windows.create`), so its viewport is shorter by the title bar and the
 * frame fills the viewport instead (`fill`), otherwise the Cancel / Connect footer sits below the fold.
 */
export function Frame({ children, fill = false }: { children: React.ReactNode; fill?: boolean }) {
  return (
    <div className={cx("flex w-[360px] flex-col overflow-hidden bg-bg text-fg", fill ? "h-dvh" : "h-[600px]")}>
      {children}
    </div>
  );
}
