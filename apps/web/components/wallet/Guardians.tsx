"use client";

import { useCallback, useEffect, useState } from "react";
import { isAddress, type Address as Addr } from "viem";
import { Address, Field, Notice, Primary, Screen, Secondary, Title, Working } from "@/components/onboarding/ui";
import { engine } from "@/lib/engine/client";
import { signProof } from "@/lib/proof";
import { Row, Section } from "./bits";
import { errText, useWallet } from "./state";
import type { Nav } from "./Wallet";

/**
 * Guardians: the people (or wallets) who can reset this account's keys if the passkey is lost. Enough of them approve,
 * then a 2-day delay lets you cancel before anything changes. Before the account exists they are part of its creation;
 * after, the owner key signs one change (a fresh guardian set: recoveries the old set started end with it).
 */
export function Guardians({ nav }: { nav: Nav }) {
  const { status, lockedWith } = useWallet();
  const [current, setCurrent] = useState<{ address: Addr; active: boolean }[] | null>(null);
  const [list, setList] = useState<Addr[]>([]);
  const [threshold, setThreshold] = useState(1);
  const [draft, setDraft] = useState("");
  const [pw, setPw] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  const load = useCallback(async () => {
    const v = await engine().call("keys:view", {});
    setCurrent(v.guardians);
    setList(v.guardians.map((g) => g.address));
    setThreshold((t) => Math.min(Math.max(t, 1), Math.max(v.guardians.length, 1)));
  }, []);
  useEffect(() => {
    void load().catch((e) => setErr(errText(e)));
  }, [load]);

  const add = () => {
    const a = draft.trim();
    if (!isAddress(a, { strict: false })) return setErr("That isn't an address (0x + 40 characters).");
    if (list.some((g) => g.toLowerCase() === a.toLowerCase())) return setErr("Already a guardian.");
    if (status?.address && a.toLowerCase() === status.address.toLowerCase())
      return setErr("Your own account can't be its guardian.");
    setErr(null);
    setList((l) => [...l, a as Addr]);
    setDraft("");
  };
  const remove = (a: Addr) => {
    setList((l) => l.filter((g) => g !== a));
    setThreshold((t) => Math.min(t, Math.max(list.length - 1, 1)));
  };

  const same =
    current !== null &&
    current.length === list.length &&
    current.every((g, i) => g.address.toLowerCase() === list[i]!.toLowerCase());

  // Like every signature: the passkey (or password) again, so an open wallet can't change its guardians alone.
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const proof = status?.deployed && lockedWith ? await signProof(lockedWith, pw) : undefined;
      const r = await engine().call("account:updateGuardians", {
        guardians: list,
        threshold: list.length ? threshold : 0,
        ...(proof ? { proof } : {}),
      });
      setSent(r.entry?.id ?? "saved");
      await load();
    } catch (e) {
      setErr(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const deployed = status?.deployed ?? false;
  return (
    <Screen
      onBack={nav.back}
      method="Guardians"
      actions={
        sent && sent !== "saved" ? (
          <Primary onClick={() => nav.open({ id: "entry", entryId: sent })}>See the change</Primary>
        ) : (
          <Primary
            busy={busy}
            busyLabel={deployed ? "Signing with your quantum-safe key" : "Saving"}
            disabled={same || (deployed && lockedWith === "password" && !pw)}
            onClick={() => void save()}
          >
            {list.length ? `Save ${list.length} guardian${list.length > 1 ? "s" : ""}` : "Remove all guardians"}
          </Primary>
        )
      }
    >
      <Title sub="If you lose your passkey, they can reset your account's keys. Enough of them approve, then a 2-day wait lets you cancel before anything changes.">
        Guardians
      </Title>

      {current === null && !err && (
        <p className="flex items-center gap-3 mono-label text-ink-3">
          <Working /> Reading your guardians
        </p>
      )}

      <Section title={`Guardians · ${list.length}`}>
        {list.length === 0 ? (
          <p className="text-[1rem] text-ink-3">None yet. Add a friend&rsquo;s wallet, or another account of yours.</p>
        ) : (
          <ul className="border-t border-ink">
            {list.map((g) => {
              const live = current?.find((c) => c.address.toLowerCase() === g.toLowerCase());
              return (
                <li key={g} className="flex items-center justify-between gap-4 border-b border-rule py-3">
                  <div className="min-w-0">
                    <Address value={g} className="block truncate text-[1rem]" />
                    <span className="mono-label text-[11px] text-ink-3">
                      {live ? (live.active ? "Active" : deployed ? "Pending" : "At creation") : "New"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => remove(g)}
                    className="mono-label h-10 shrink-0 border border-rule bg-paper px-3 active:bg-paper-3"
                  >
                    Remove
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <div className="mt-6 flex items-end gap-2">
        <div className="min-w-0 flex-1">
          <Field
            label="Add a guardian"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && add()}
            placeholder="0x…"
          />
        </div>
        <Secondary onClick={add}>Add</Secondary>
      </div>

      {list.length > 0 && (
        <dl className="mt-6 border-t border-ink">
          <Row k="Approvals needed">
            <span className="inline-flex items-center gap-3">
              <button
                type="button"
                aria-label="Fewer"
                onClick={() => setThreshold((t) => Math.max(1, t - 1))}
                className="mono-label h-9 w-9 border border-rule active:bg-paper-3"
              >
                −
              </button>
              {threshold} of {list.length}
              <button
                type="button"
                aria-label="More"
                onClick={() => setThreshold((t) => Math.min(list.length, t + 1))}
                className="mono-label h-9 w-9 border border-rule active:bg-paper-3"
              >
                +
              </button>
            </span>
          </Row>
          <Row k="Waiting period">2 days, you can cancel</Row>
        </dl>
      )}

      {deployed && lockedWith === "password" && !same && (
        <div className="mt-6">
          <Field label="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        </div>
      )}
      {!deployed && (
        <Notice>
          Your account isn&rsquo;t created yet: guardians become part of it, so its address changes when they do.
        </Notice>
      )}
      {deployed && !same && (
        <Notice>Your quantum-safe key signs this change. Recoveries the old guardians started end with it.</Notice>
      )}
      {sent && <Notice>{sent === "saved" ? "Saved." : "Sent. It takes effect once it's on the chain."}</Notice>}
      {err && <Notice tone="error">{err}</Notice>}
    </Screen>
  );
}
