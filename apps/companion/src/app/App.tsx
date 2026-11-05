import { useNav, useStore, NavProvider, StoreProvider } from "./state.js";
import { Backup, Create, Pair, Restore, Welcome } from "../screens/Onboarding.js";
import { AddressBook, Health, Settings } from "../screens/Manage.js";
import { Ceremony, RecoveryHub, RecoveryTest, RecoveryUse } from "../screens/Recovery.js";
import { Home, ReviewRoute, Scan, Signed } from "../screens/Vault.js";
import { Spinner } from "../ui/kit.js";

function Router() {
  const { route } = useNav();
  const store = useStore();
  // Screens that need a Vault fall back to Welcome when there is none (e.g. after "Erase").
  const needsVault = ![
    "welcome",
    "create",
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
    case "settings":
      return <Settings />;
  }
}

function Boot() {
  const store = useStore();
  if (!store.loaded)
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Spinner label="Loading" />
      </div>
    );
  return (
    <NavProvider initial={store.vault ? { name: "home" } : { name: "welcome" }}>
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
