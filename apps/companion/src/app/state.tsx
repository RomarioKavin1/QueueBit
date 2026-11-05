import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import * as db from "../core/db.js";
import type { LogEntry, Settings, VaultRecord } from "../core/db.js";
import type { AccountSnapshot, AddressBookEntry } from "../core/types.js";
import type { Review } from "../core/clearsign.js";
import type { Built } from "./routes.js";

/** App-wide state: what is in IndexedDB, plus a navigation stack. No secrets ever live here. */

export interface Store {
  loaded: boolean;
  vault: VaultRecord | undefined;
  addressBook: AddressBookEntry[];
  snapshots: AccountSnapshot[];
  settings: Settings;
  log: LogEntry[];
  saveVault(v: VaultRecord | undefined): Promise<void>;
  saveAddressBook(a: AddressBookEntry[]): Promise<void>;
  saveSnapshots(s: AccountSnapshot[]): Promise<void>;
  saveSettings(s: Settings): Promise<void>;
  log_(e: LogEntry): Promise<void>;
  eraseAll(): Promise<void>;
}

const StoreCtx = createContext<Store | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [vault, setVault] = useState<VaultRecord>();
  const [addressBook, setAddressBook] = useState<AddressBookEntry[]>([]);
  const [snapshots, setSnapshots] = useState<AccountSnapshot[]>([]);
  const [settings, setSettings] = useState<Settings>(db.DEFAULT_SETTINGS);
  const [log, setLog] = useState<LogEntry[]>([]);

  useEffect(() => {
    void (async () => {
      setVault(await db.get("vault"));
      setAddressBook((await db.get("addressBook")) ?? []);
      setSnapshots((await db.get("snapshots")) ?? []);
      setSettings({ ...db.DEFAULT_SETTINGS, ...(await db.get("settings")) });
      setLog((await db.get("log")) ?? []);
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (settings.theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", settings.theme);
  }, [settings.theme]);

  const store: Store = {
    loaded,
    vault,
    addressBook,
    snapshots,
    settings,
    log,
    saveVault: async (v) => {
      if (v) await db.put("vault", v);
      else await db.del("vault");
      setVault(v);
    },
    saveAddressBook: async (a) => {
      await db.put("addressBook", a);
      setAddressBook(a);
    },
    saveSnapshots: async (s) => {
      await db.put("snapshots", s);
      setSnapshots(s);
    },
    saveSettings: async (s) => {
      await db.put("settings", s);
      setSettings(s);
    },
    log_: async (e) => {
      await db.appendLog(e);
      setLog((l) => [...l, e].slice(-200));
    },
    eraseAll: async () => {
      await db.eraseAll();
      setVault(undefined);
      setAddressBook([]);
      setSnapshots([]);
      setSettings(db.DEFAULT_SETTINGS);
      setLog([]);
    },
  };
  return <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>;
}

export function useStore(): Store {
  const s = useContext(StoreCtx);
  if (!s) throw new Error("no store");
  return s;
}

// ---------------------------------------------------------------------------------------------------------------
// Navigation: a small stack; the browser Back button pops it.
// ---------------------------------------------------------------------------------------------------------------

export type Route =
  | { name: "welcome" }
  | { name: "create" }
  | { name: "restore" }
  | { name: "backup"; afterCreate?: boolean }
  | { name: "pair"; firstTime?: boolean }
  | { name: "home" }
  | { name: "scan"; recovery?: boolean }
  | { name: "review"; review: Review; cbor: Uint8Array }
  | { name: "signed"; built: Built }
  | { name: "recovery" }
  | { name: "ceremony" }
  | { name: "recoveryTest" }
  | { name: "recoveryUse" }
  | { name: "addressBook" }
  | { name: "health" }
  | { name: "settings" };

interface Nav {
  route: Route;
  depth: number;
  push(r: Route): void;
  replace(r: Route): void;
  back(): void;
  reset(r: Route): void;
}

const NavCtx = createContext<Nav | undefined>(undefined);

export function NavProvider({ initial, children }: { initial: Route; children: ReactNode }) {
  const [stack, setStack] = useState<Route[]>([initial]);
  const push = useCallback((r: Route) => {
    setStack((s) => [...s, r]);
    history.pushState({ depth: Date.now() }, "");
  }, []);
  const back = useCallback(() => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s)), []);
  const replace = useCallback((r: Route) => setStack((s) => [...s.slice(0, -1), r]), []);
  const reset = useCallback((r: Route) => setStack([r]), []);
  useEffect(() => {
    const onPop = () => back();
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [back]);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [stack.length]);
  const nav = useMemo(
    () => ({ route: stack[stack.length - 1]!, depth: stack.length, push, replace, back, reset }),
    [stack, push, replace, back, reset],
  );
  return <NavCtx.Provider value={nav}>{children}</NavCtx.Provider>;
}

export function useNav(): Nav {
  const n = useContext(NavCtx);
  if (!n) throw new Error("no nav");
  return n;
}
