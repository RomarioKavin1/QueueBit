import { useEffect, useState } from "react";
import { LogoMark, Spinner } from "../../ui";
import { useTheme, useWalletState } from "../lib/hooks";
import { UnlockForm } from "../common/Unlock";
import { PopupApp } from "../popup/PopupApp";
import { BUILD } from "../../shared/build";
import { Gallery } from "./Gallery";
import { VaultPlaceholder } from "./VaultPlaceholder";
import { Onboarding, type Step } from "./Onboarding";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const on = () => setHash(location.hash);
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return hash;
}

const STEPS: Step[] = ["welcome", "create", "import", "words", "limit", "network", "vault", "recovery", "done"];

/** Full-tab app (ux-spec §2.3). M0 holds onboarding; the rest of the wallet is the popup UI, centred. */
export function AppMain() {
  const { state } = useWalletState();
  useTheme(state?.settings.theme);
  const hash = useHash();
  const [, route = "", sub = ""] = /^#([^/]*)\/?(.*)$/u.exec(hash) ?? [];

  useEffect(() => {
    document.title = route === "onboarding" ? "Set up LEAKED" : "LEAKED";
  }, [route]);

  if (!state) {
    return (
      <div className="grid min-h-screen place-items-center text-muted">
        <Spinner size={28} label="Loading LEAKED" />
      </div>
    );
  }
  // The component gallery is a development tool: production builds do not route to it (UX review M1).
  if (route === "design" && BUILD.designGallery) return <Gallery />;
  if (route === "vault") return <VaultPlaceholder />;

  const go = (s: Step) => {
    location.hash = `#onboarding/${s}`;
  };

  // Decide the onboarding step from state, so a reload or a closed tab resumes where the user left off.
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
  if (route === "onboarding" || !state.setup.completedAt) {
    let step = STEPS.includes(sub as Step) ? (sub as Step) : "limit";
    if (["welcome", "create", "import"].includes(step)) step = state.setup.completedAt ? "done" : "limit";
    if (step === "done" && !state.setup.completedAt) step = "limit";
    return <Onboarding state={state} step={step} go={go} />;
  }
  return (
    <div className="grid min-h-screen place-items-center bg-surface p-6">
      <div className="flex flex-col items-center gap-4">
        <div className="flex items-center gap-2">
          <LogoMark size={28} />
          <span className="t-title">LEAKED</span>
        </div>
        <div className="overflow-hidden rounded-lg border border-line">
          <PopupApp inTab {...(route === "activity" ? { initialTab: "activity" as const } : {})} />
        </div>
      </div>
    </div>
  );
}
