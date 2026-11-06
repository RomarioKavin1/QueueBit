import { useEffect, useState, type ReactNode } from "react";
import { AppsIcon, HomeIcon, LogoMark, RecoveryIcon, SendIcon, SettingsIcon, ShieldIcon, Spinner } from "../../ui";
import { cx } from "../../ui/cx";
import { useTheme, useWalletState } from "../lib/hooks";
import { UnlockForm } from "../common/Unlock";
import { PopupApp } from "../popup/PopupApp";
import { DESIGN_GALLERY } from "../../shared/build";
import { Gallery } from "./Gallery";
import { Keys } from "./Keys";
import { Migrate } from "./Migrate";
import { BackupWords, Onboarding, type Step } from "./Onboarding";
import { Privacy } from "./Privacy";
import { Sessions } from "./Sessions";
import { SettingsScreen } from "../popup/Settings";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

/** Full-tab app (ux-spec §2.3): onboarding and the pages that need room. */
export function AppMain() {
  const { state } = useWalletState();
  useTheme(state?.settings.theme);
  const hash = useHash();
  const [, route = "", sub = ""] = /^#([^/?]*)\/?([^?]*)\??(.*)$/u.exec(hash) ?? [];

  useEffect(() => {
    document.title =
      route === "onboarding"
        ? "Set up QueueBit"
        : route === "sessions"
          ? "Sessions · QueueBit"
          : route === "keys"
            ? "Keys & recovery · QueueBit"
            : route === "migrate"
              ? "Move to quantum-safe · QueueBit"
              : route === "privacy"
                ? "Private balance · QueueBit"
                : "QueueBit";
  }, [route]);

  if (!state) {
    return (
      <div className="grid min-h-screen place-items-center text-muted">
        <Spinner size={28} label="Loading QueueBit" />
      </div>
    );
  }
  // The component gallery is a development tool: production builds do not route to it (UX review M1).
  if (route === "design" && DESIGN_GALLERY) return <Gallery />;

  const go = (s: Step) => {
    location.hash = `#onboarding/${s}`;
  };

  if (!state.initialized) {
    const step = sub === "import" ? "import" : "welcome";
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
  if (route === "onboarding" || !state.setup.completedAt) return <Onboarding state={state} step="account" go={go} />;
  const page =
    route === "sessions" ? (
      <Sessions state={state} />
    ) : route === "keys" ? (
      <Keys state={state} />
    ) : route === "migrate" ? (
      <Migrate state={state} />
    ) : route === "privacy" ? (
      <Privacy />
    ) : route === "settings" ? (
      <div className="-m-6">
        <SettingsScreen state={state} onBack={() => (location.hash = "#home")} />
      </div>
    ) : route === "backup" ? (
      <BackupWords onDone={() => (location.hash = "#keys")} />
    ) : (
      <div className="flex justify-center">
        <div className="overflow-hidden rounded-lg border border-line">
          <PopupApp inTab {...(route === "activity" ? { initialTab: "activity" as const } : {})} />
        </div>
      </div>
    );
  return <Shell route={route}>{page}</Shell>;
}

function Shell({ route, children }: { route: string; children: ReactNode }) {
  const items: Array<{ id: string; label: string; icon: ReactNode }> = [
    { id: "home", label: "Home", icon: <HomeIcon size={18} /> },
    { id: "sessions", label: "Sessions", icon: <AppsIcon size={18} /> },
    { id: "keys", label: "Keys & recovery", icon: <RecoveryIcon size={18} /> },
    { id: "migrate", label: "Move to quantum-safe", icon: <SendIcon size={18} /> },
    { id: "privacy", label: "Private balance", icon: <ShieldIcon size={18} /> },
    { id: "settings", label: "Settings", icon: <SettingsIcon size={18} /> },
  ];
  const current = route === "" || route === "activity" ? "home" : route;
  return (
    <div className="min-h-screen bg-surface">
      <div className="mx-auto flex max-w-[1040px] gap-6 px-6 py-8">
        <nav aria-label="QueueBit" className="flex w-44 shrink-0 flex-col gap-1">
          <div className="mb-4 flex items-center gap-2">
            <LogoMark size={26} />
            <span className="t-title">QueueBit</span>
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
        </nav>
        <main className="min-w-0 flex-1 rounded-lg border border-line bg-bg p-6">{children}</main>
      </div>
    </div>
  );
}
