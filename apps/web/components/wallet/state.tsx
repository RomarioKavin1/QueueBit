"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { engine, EngineCallError } from "@/lib/engine/client";
import type { NetworkInfo, UiApi, WalletsView } from "@/lib/engine/protocol";

export type AccountStatus = UiApi["account:status"]["res"];
export type ActivityEntry = UiApi["activity:list"]["res"][number];
export type TokenBalance = UiApi["tokens:list"]["res"][number];
export type WalletRow = WalletsView["wallets"][number];

interface WalletData {
  net: NetworkInfo | undefined;
  status: AccountStatus | null;
  activity: ActivityEntry[];
  /** The owner key's lifetime signature budget. */
  budget: number | null;
  backedUp: boolean | null;
  lockedWith: "passkey" | "password" | null;
  /** The account's tokens (the network's and any added), with balances. */
  tokens: TokenBalance[];
  /** The wallets on this device; `wallet` is the open one. */
  wallets: WalletsView | null;
  wallet: WalletRow | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** Runs an engine call; a locked wallet sends the person back to unlock. */
  guard: <T>(p: Promise<T>) => Promise<T>;
}

const Ctx = createContext<WalletData | null>(null);

export function useWallet(): WalletData {
  const v = useContext(Ctx);
  if (!v) throw new Error("useWallet outside <WalletProvider>");
  return v;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong.");

const isFinal = (e: ActivityEntry) => e.status === "confirmed" || e.status === "failed";

/**
 * What every wallet screen reads: the account, its activity and the network. Refreshed when the page comes back to
 * the front, every 20 s, and every 3 s while something is still on its way.
 */
export function WalletProvider({ net, children }: { net: NetworkInfo | undefined; children: ReactNode }) {
  const router = useRouter();
  const [status, setStatus] = useState<AccountStatus | null>(null);
  const [activity, setActivity] = useState<ActivityEntry[]>([]);
  const [budget, setBudget] = useState<number | null>(null);
  const [backedUp, setBackedUp] = useState<boolean | null>(null);
  const [lockedWith, setLockedWith] = useState<"passkey" | "password" | null>(null);
  const [tokens, setTokens] = useState<TokenBalance[]>([]);
  const [wallets, setWallets] = useState<WalletsView | null>(null);
  const [error, setError] = useState<string | null>(null);

  const guard = useCallback(
    async <T,>(p: Promise<T>): Promise<T> => {
      try {
        return await p;
      } catch (e) {
        if (e instanceof EngineCallError && e.reason === "locked") router.replace("/start");
        throw e;
      }
    },
    [router],
  );

  const refresh = useCallback(async () => {
    const e = engine();
    try {
      const [s, a, st] = await guard(
        Promise.all([e.call("account:status", {}), e.call("activity:list"), e.call("state:get")]),
      );
      setStatus(s);
      setActivity(a);
      setBackedUp(Boolean(st.setup.backupConfirmedAt));
      setError(s.error ?? null);
      // Token balances and the wallet list are extras: a slow token never holds the balance back.
      void e
        .call("tokens:list", {})
        .then(setTokens)
        .catch(() => undefined);
      void e
        .wallets()
        .then(setWallets)
        .catch(() => undefined);
    } catch (err) {
      setError(errText(err));
    }
  }, [guard]);

  useEffect(() => {
    void refresh();
    const e = engine();
    void e
      .call("keys:view", {})
      .then((k) => setBudget(k.ownerSignatureBudget))
      .catch(() => undefined);
    void e
      .call("keyring:passkeyInfo")
      .then((i) => setLockedWith(i ? "passkey" : "password"))
      .catch(() => undefined);
    const onVisible = () => document.visibilityState === "visible" && void refresh();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refresh]);

  const busy = activity.some((a) => !isFinal(a));
  const timer = useRef<ReturnType<typeof setInterval>>(undefined);
  useEffect(() => {
    timer.current = setInterval(() => document.visibilityState === "visible" && void refresh(), busy ? 3000 : 20_000);
    return () => clearInterval(timer.current);
  }, [busy, refresh]);

  const wallet = wallets?.wallets.find((w) => w.id === wallets.active) ?? null;
  const value = useMemo(
    () => ({ net, status, activity, budget, backedUp, lockedWith, tokens, wallets, wallet, error, refresh, guard }),
    [net, status, activity, budget, backedUp, lockedWith, tokens, wallets, wallet, error, refresh, guard],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
