"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { engine, EngineCallError } from "@/lib/engine/client";
import type { NetworkInfo, UiApi, WalletsView } from "@/lib/engine/protocol";

export type AccountStatus = UiApi["account:status"]["res"];
export type ActivityEntry = UiApi["activity:list"]["res"][number];
export type TokenBalance = UiApi["tokens:list"]["res"][number];
export type WalletRow = WalletsView["wallets"][number];
export type PrivacyView = UiApi["privacy:view"]["res"];

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
  /** The private balance (null until read, or where this network has none). */
  privacy: PrivacyView | null;
  error: string | null;
  refresh: () => Promise<void>;
  /** Re-reads the private balance; `sync` also reads the chain (new deposits, approvals). */
  refreshPrivacy: (sync?: boolean) => Promise<void>;
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
  const [privacy, setPrivacy] = useState<PrivacyView | null>(null);
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
      setBudget(s.ownerSignatureBudget);
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

  const refreshPrivacy = useCallback(async (sync = false) => {
    const e = engine();
    try {
      setPrivacy(await e.call(sync ? "privacy:sync" : "privacy:view", {}));
    } catch {
      // A failed chain read keeps the last balance; the view itself is local and cheap.
      if (sync) await e.call("privacy:view", {}).then(setPrivacy, () => undefined);
    }
  }, []);

  useEffect(() => {
    const e = engine();
    // The last known status first (instant), then the chain's (seconds on a slow node).
    void e
      .cachedStatus()
      .then((s) => s && setStatus((cur) => cur ?? s))
      .catch(() => undefined);
    void refresh();
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

  // The private balance: read from the chain on open and every minute; every 20 s while a deposit is getting ready;
  // the local view every 3 s while something private is on its way.
  const privOk = privacy?.availability.ok === true;
  const privBusy = Boolean(privacy?.op && privacy.op.step !== "done" && privacy.op.step !== "failed");
  const privWaiting = BigInt(privacy?.pendingWei ?? "0") > 0n;
  useEffect(() => {
    void refreshPrivacy(true);
  }, [refreshPrivacy, status?.address]);
  useEffect(() => {
    if (!privOk) return;
    const t = setInterval(
      () => document.visibilityState === "visible" && void refreshPrivacy(!privBusy),
      privBusy ? 3000 : privWaiting ? 20_000 : 60_000,
    );
    return () => clearInterval(t);
  }, [privOk, privBusy, privWaiting, refreshPrivacy]);

  const wallet = wallets?.wallets.find((w) => w.id === wallets.active) ?? null;
  const value = useMemo(
    () => ({
      net,
      status,
      activity,
      budget,
      backedUp,
      lockedWith,
      tokens,
      wallets,
      wallet,
      privacy,
      error,
      refresh,
      refreshPrivacy,
      guard,
    }),
    [
      net,
      status,
      activity,
      budget,
      backedUp,
      lockedWith,
      tokens,
      wallets,
      wallet,
      privacy,
      error,
      refresh,
      refreshPrivacy,
      guard,
    ],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
