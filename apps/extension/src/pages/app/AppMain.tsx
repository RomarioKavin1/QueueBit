import { useEffect, useState, type ReactNode } from "react";
import type { WalletState } from "../../shared/types";
import {
  BellIcon,
  HomeIcon,
  HourglassIcon,
  LockIcon,
  LogoMark,
  SettingsIcon,
  ShieldIcon,
  Spinner,
  VaultIcon,
} from "../../ui";
import { browser, type Browser } from "wxt/browser";
import { cx } from "../../ui/cx";
import { useAsync, useTheme, useWalletState } from "../lib/hooks";
import { call } from "../lib/api";
import { UnlockForm } from "../common/Unlock";
import { PopupApp } from "../popup/PopupApp";
import { DESIGN_GALLERY } from "../../shared/build";
import { Alerts } from "./Alerts";
import { Gallery } from "./Gallery";
import { Limits } from "./Limits";
import { Onboarding, type Step } from "./Onboarding";
import { Pending } from "./Pending";
import { Privacy } from "./Privacy";
import { SettingsScreen } from "../popup/Settings";
import { Security } from "./Security";
import { VaultHandoff } from "./VaultHandoff";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const STEPS: Step[] = [
  "welcome",
  "create",
  "import",
  "words",
  "vault",
  "recovery",
  "guardian",
  "limit",
  "network",
  "tokens",
  "done",
];

/** Where onboarding resumes after a reload or a closed tab. */
function resumeStep(state: WalletState): Step {
  const s = state.setup;
  if (!s.vault) return "vault";
  if (!s.recovery?.testedAt && !s.recoverySkippedAt) return "recovery";
  if (!s.guardian && !s.guardianSkippedAt) return "guardian";
  return "limit";
}

/** Full-tab app (ux-spec §2.3): onboarding, the Vault hand-off and the pages that need room or a camera. */
export function AppMain() {
  const { state } = useWalletState();
  useTheme(state?.settings.theme);
  const hash = useHash();
  const [, route = "", sub = "", query = ""] = /^#([^/?]*)\/?([^?]*)\??(.*)$/u.exec(hash) ?? [];
  const back = new URLSearchParams(query).get("back");

  useEffect(() => {
    document.title =
      route === "onboarding"
        ? "Set up LEAKED"
        : route === "vault"
          ? "Approve on your phone · LEAKED"
          : route === "privacy"
            ? "Private balance · LEAKED"
            : route === "alerts"
              ? "Alerts · LEAKED"
              : "LEAKED";
  }, [route]);

  if (!state) {
    return (
      <div className="grid min-h-screen place-items-center text-muted">
        <Spinner size={28} label="Loading LEAKED" />
      </div>
    );
  }
  // The component gallery is a development tool: production builds do not route to it (UX review M1).
  if (route === "design" && DESIGN_GALLERY) return <Gallery />;

  const go = (s: Step) => {
    location.hash = `#onboarding/${s}`;
  };

  if (!state.initialized) {
    const step = (["welcome", "create", "import"] as Step[]).includes(sub as Step) ? (sub as Step) : "welcome";
    return <Onboarding state={state} step={step} go={go} />;
  }
  if (!state.unlocked) {
    return (
      <div className="grid min-h-screen place-items-center bg-surface p-6">
        <div className="w-full max-w-[360px] rounded-lg border border-line bg-bg p-6">
          <UnlockForm />
        </div>
      </div>
    );
  }
  if (route === "onboarding" || (!state.setup.completedAt && route !== "vault")) {
    let step = STEPS.includes(sub as Step) ? (sub as Step) : resumeStep(state);
    if (["welcome", "create", "import"].includes(step)) step = resumeStep(state);
    if (!state.setup.vault && !["words", "vault"].includes(step)) step = "vault";
    return <Onboarding state={state} step={step} go={go} />;
  }
  const page =
    route === "vault" ? (
      <VaultHandoff
        id={sub}
        {...(back === "privacy" ? { backLabel: "Back to private balance" } : {})}
        onDone={(to) => (location.hash = to === "pending" ? "#pending" : back === "privacy" ? "#privacy" : "#home")}
      />
    ) : route === "pending" ? (
      <Pending {...(sub ? { highlight: sub } : {})} />
    ) : route === "privacy" ? (
      <Privacy />
    ) : route === "alerts" ? (
      <Alerts />
    ) : route === "settings" ? (
      <div className="-m-6">
        <SettingsScreen state={state} onBack={() => (location.hash = "#home")} />
      </div>
    ) : route === "security" ? (
      <Security state={state} />
    ) : route === "limits" ? (
      <Limits />
    ) : (
      <div className="flex justify-center">
        <div className="overflow-hidden rounded-lg border border-line">
          <PopupApp inTab {...(route === "activity" ? { initialTab: "activity" as const } : {})} />
        </div>
      </div>
    );
  return <Shell route={route}>{page}</Shell>;
}

/** Unread alerts (the rail's count mirrors the toolbar badge, ux-spec §2.2). */
function useUnreadAlerts(route: string): number {
  const list = useAsync(
    async () => (await call("alerts:list").catch(() => [])).filter((r) => !r.readAt && !r.retracted).length,
    [route],
  );
  const { reload } = list;
  useEffect(() => {
    const on = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      if (area === "local" && "leaked:alerts" in changes) void reload();
    };
    browser.storage.onChanged.addListener(on);
    return () => browser.storage.onChanged.removeListener(on);
  }, [reload]);
  return list.data ?? 0;
}

function Shell({ route, children }: { route: string; children: ReactNode }) {
  const queued = useAsync(
    async () => (await call("vault:queue", {}).catch(() => [])).filter((q) => q.state === "pending").length,
    [route],
  );
  const unread = useUnreadAlerts(route);
  const items: Array<{ id: string; label: string; icon: ReactNode }> = [
    { id: "home", label: "Home", icon: <HomeIcon size={18} /> },
    { id: "limits", label: "Limits", icon: <VaultIcon size={18} /> },
    { id: "pending", label: `Pending${queued.data ? ` (${queued.data})` : ""}`, icon: <HourglassIcon size={18} /> },
    { id: "alerts", label: `Alerts${unread ? ` (${unread})` : ""}`, icon: <BellIcon size={18} /> },
    { id: "security", label: "Security", icon: <LockIcon size={18} /> },
    { id: "privacy", label: "Private balance", icon: <ShieldIcon size={18} /> },
    { id: "settings", label: "Settings", icon: <SettingsIcon size={18} /> },
  ];
  const current = route === "" || route === "activity" ? "home" : route;
  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto flex max-w-[1040px] gap-6 px-6 py-8">
        <nav aria-label="LEAKED" className="flex w-44 shrink-0 flex-col gap-1">
          <div className="mb-4 flex items-center gap-2">
            <LogoMark size={26} />
            <span className="t-title">LEAKED</span>
          </div>
          {items.map((i) => (
            <a
              key={i.id}
              href={`#${i.id}`}
              aria-current={current === i.id ? "page" : undefined}
              className={cx(
                "t-strong flex min-h-10 items-center gap-2 rounded-md px-3",
                current === i.id ? "bg-bg text-brand" : "text-fg hover:bg-surface-2",
              )}
            >
              <span aria-hidden="true">{i.icon}</span>
              {i.label}
            </a>
          ))}
          {route === "vault" && (
            <span className="t-strong mt-2 flex min-h-10 items-center gap-2 rounded-md bg-vault-bg px-3 text-vault">
              <VaultIcon size={18} /> Vault approval
            </span>
          )}
        </nav>
        <main className="min-w-0 flex-1 rounded-lg border border-line bg-bg p-6">{children}</main>
      </div>
    </div>
  );
}
