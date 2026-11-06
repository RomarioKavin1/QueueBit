import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fromHex } from "@queuebit/ur";
import * as db from "../core/db.js";
import type { LogEntry, Settings, VaultRecord } from "../core/db.js";
import { sealLogEntry } from "../core/logCrypto.js";
import type { AccountSnapshot, AddressBookEntry } from "../core/types.js";
import type { Review } from "../core/clearsign.js";
import type { Built } from "./routes.js";

/**
 * App-wide state: what is in IndexedDB, plus a navigation stack. No secrets ever live here. The activity log is
 * stored sealed (logCrypto.ts): the store only knows how many entries there are, appends new ones sealed to the
 * Vault's log key, and holds decrypted entries only after the user unlocked them (Settings › Activity).
 */

export interface Store {
  loaded: boolean;
  vault: VaultRecord | undefined;
  addressBook: AddressBookEntry[];
  snapshots: AccountSnapshot[];
  settings: Settings;
  /** Number of activity entries on this phone (sealed + any legacy plaintext ones). */
  logCount: number;
  saveVault(v: VaultRecord | undefined): Promise<void>;
  saveAddressBook(a: AddressBookEntry[]): Promise<void>;
  saveSnapshots(s: AccountSnapshot[]): Promise<void>;
  saveSettings(s: Settings): Promise<void>;
  /** Appends an activity entry, sealed. Without a Vault log key (no Vault, or one made before it existed) it is dropped. */
  log_(e: LogEntry, vault?: VaultRecord): Promise<void>;
  /** The raw log for the worker to open: sealed entries and legacy plaintext ones. */
  logForUnlock(): Promise<{ sealed: Uint8Array[]; legacy: LogEntry[] }>;
  /** After an unlock: store re-sealed legacy entries and drop the plaintext copy. */
  replaceLegacyLog(resealed: Uint8Array[]): Promise<void>;
  eraseAll(): Promise<void>;
}

const StoreCtx = createContext<Store | undefined>(undefined);

export function StoreProvider({ children }: { children: ReactNode }) {
  const [loaded, setLoaded] = useState(false);
  const [vault, setVault] = useState<VaultRecord>();
  const [addressBook, setAddressBook] = useState<AddressBookEntry[]>([]);
  const [snapshots, setSnapshots] = useState<AccountSnapshot[]>([]);
  const [settings, setSettings] = useState<Settings>(db.DEFAULT_SETTINGS);
  const [logCount, setLogCount] = useState(0);

  useEffect(() => {
    void (async () => {
      setVault(await db.get("vault"));
      setAddressBook((await db.get("addressBook")) ?? []);
      setSnapshots((await db.get("snapshots")) ?? []);
      setSettings({ ...db.DEFAULT_SETTINGS, ...(await db.get("settings")) });
      setLogCount(((await db.get("logSealed")) ?? []).length + ((await db.get("log")) ?? []).length);
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
    logCount,
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
      setSettings(s); // optimistic: a toggle reflects the tap at once
      await db.put("settings", s);
    },
    log_: async (e, v = vault) => {
      if (!v?.logKey) return;
      const n = await db.appendSealedLog(await sealLogEntry(fromHex(v.logKey.publicKey), e));
      setLogCount(n + ((await db.get("log")) ?? []).length);
    },
    logForUnlock: async () => ({ sealed: (await db.get("logSealed")) ?? [], legacy: (await db.get("log")) ?? [] }),
    replaceLegacyLog: async (resealed) => {
      const all = [...resealed, ...((await db.get("logSealed")) ?? [])].slice(-db.LOG_LIMIT);
      await db.put("logSealed", all);
      await db.del("log");
      setLogCount(all.length);
    },
    eraseAll: async () => {
      await db.eraseAll();
      setVault(undefined);
      setAddressBook([]);
      setSnapshots([]);
      setSettings(db.DEFAULT_SETTINGS);
      setLogCount(0);
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
  | { name: "rotate" }
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
