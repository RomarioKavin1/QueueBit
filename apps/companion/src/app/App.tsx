import { parsePairFragment } from "@queuebit/relay-client";
import { useEffect, useState } from "react";
import { useNav, useStore, NavProvider, StoreProvider, type Route } from "./state.js";
import { LinkScreen } from "../screens/Link.js";
import { Backup, Create, Pair, Restore, Welcome } from "../screens/Onboarding.js";
import { AddressBook, Health, Settings } from "../screens/Manage.js";
import { Ceremony, RecoveryHub, RecoveryTest, RecoveryUse } from "../screens/Recovery.js";
import { Rotate } from "../screens/Rotate.js";
import { Home, ReviewRoute, Scan, Signed } from "../screens/Vault.js";
import { Spinner } from "../ui/kit.js";

/** A `#pair=<id>.<key>` link from the browser's QR code, read once and removed from the address bar. */
function takePairLink(): Route | undefined {
  const channel = parsePairFragment(location.hash);
  if (!location.hash.includes("pair=")) return undefined;
  history.replaceState(history.state, "", location.pathname + location.search);
  return channel ? { name: "link", channel } : undefined;
}

function Router() {
  const nav = useNav();
  const { route } = nav;
  const store = useStore();
  // The app was already open when the phone opened another pairing link.
  useEffect(() => {
    const on = () => {
      const r = takePairLink();
      if (r) nav.reset(r);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, [nav]);
  // Screens that need a Vault fall back to Welcome when there is none (e.g. after "Erase").
  const needsVault = ![
    "welcome",
    "create",
    "link",
    "restore",
    "recovery",
    "ceremony",
    "recoveryTest",
    "recoveryUse",
    "settings",
  ].includes(route.name);
  if (needsVault && !store.vault) return <Welcome />;
  switch (route.name) {
    case "welcome":
      return <Welcome />;
    case "create":
      return <Create />;
    case "link":
      return <LinkScreen channel={route.channel} />;
    case "restore":
      return <Restore />;
    case "backup":
      return <Backup />;
    case "pair":
      return <Pair />;
    case "home":
      return <Home />;
    case "scan":
      return <Scan />;
    case "review":
      return <ReviewRoute review={route.review} cbor={route.cbor} />;
    case "signed":
      return <Signed built={route.built} />;
    case "recovery":
      return <RecoveryHub />;
    case "ceremony":
      return <Ceremony />;
    case "recoveryTest":
      return <RecoveryTest />;
    case "recoveryUse":
      return <RecoveryUse />;
    case "addressBook":
      return <AddressBook />;
    case "health":
      return <Health />;
    case "rotate":
      return <Rotate />;
    case "settings":
      return <Settings />;
  }
}

function Boot() {
  const store = useStore();
  const [link] = useState(takePairLink);
  if (!store.loaded)
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Loading" />
      </div>
    );
  return (
    <NavProvider initial={link ?? (store.vault ? { name: "home" } : { name: "welcome" })}>
      <Router />
    </NavProvider>
  );
}

export function App() {
  return (
    <StoreProvider>
      <Boot />
    </StoreProvider>
  );
}
