import { useCallback, useEffect, useRef, useState } from "react";
import { browser, type Browser } from "wxt/browser";
import { StorageKeys } from "../../shared/kv";
import type { Theme, WalletState } from "../../shared/types";
import { call } from "./api";

/**
 * Wallet state for extension pages. Pages read state from the service worker and refresh when storage changes, so
 * they survive service-worker restarts (plan §30 §2.3). Session writes that only bump the auto-lock timer are ignored.
 */
export function useWalletState() {
  const [state, setState] = useState<WalletState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setState(await call("state:get"));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
    const onChanged = (changes: Record<string, Browser.storage.StorageChange>, area: string) => {
      const keys = Object.keys(changes);
      if (area === "session") {
        const s = changes[StorageKeys.session];
        // Lock/unlock only: presence changed.
        if (s && (s.oldValue === undefined) !== (s.newValue === undefined)) void refresh();
        return;
      }
      if (area === "local" && keys.some((k) => k.startsWith("queuebit:"))) void refresh();
    };
    browser.storage.onChanged.addListener(onChanged);
    return () => browser.storage.onChanged.removeListener(onChanged);
  }, [refresh]);

  return { state, error, refresh };
}

/** Run an async loader; re-run when `deps` change. Keeps the last good value while reloading. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const run = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    try {
      const v = await fn();
      if (mine === seq.current) {
        setData(v);
        setError(null);
      }
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (mine === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void run();
  }, [run]);
  return { data, error, loading, reload: run };
}

export function useTheme(theme: Theme | undefined) {
  useEffect(() => {
    const root = document.documentElement;
    if (!theme || theme === "system") delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
}

/**
 * Re-run `reload` every `ms` while `active` (e.g. while a payment is confirming). The latest `reload` is kept in a
 * ref, so an inline callback on a page that re-renders often (a countdown) does not restart the interval forever
 * (a page that re-renders every second, such as a countdown, would otherwise never poll).
 */
export function usePoll(reload: () => unknown, ms: number, active: boolean) {
  const latest = useRef(reload);
  latest.current = reload;
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => void latest.current(), ms);
    return () => clearInterval(t);
  }, [ms, active]);
}
