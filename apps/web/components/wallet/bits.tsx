"use client";

import type { ReactNode } from "react";
import { LineArrow, Working } from "@/components/onboarding/ui";
import { ago, eth } from "@/lib/format";
import { Mark } from "@/components/paper/Logo";
import { Identicon } from "./Identicon";
import type { ActivityEntry } from "./state";

/** A label/value line in a ruled list. */
export function Row({ k, children, strong }: { k: string; children: ReactNode; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-rule py-3">
      <dt className="mono-label shrink-0 text-ink-3">{k}</dt>
      <dd className={`min-w-0 text-right text-[1rem] tnum ${strong ? "font-medium" : ""}`}>{children}</dd>
    </div>
  );
}

/** A section heading in the manual's voice: mono label over a hairline. */
export function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-9">
      <div className="mb-2 flex items-baseline justify-between">
        <h2 className="mono-label text-ink-2">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

/**
 * The quantum-safe key's signatures, drawn as a strip of ticks: hash-based keys can sign a fixed number of times,
 * so the count is shown openly, like a fuel gauge.
 */
export function SignatureGauge({ left, budget }: { left: number; budget: number | null }) {
  const total = budget ?? left;
  const ticks = 48;
  const lit = total > 0 ? Math.ceil((left / total) * ticks) : 0;
  return (
    <div>
      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={left}
        aria-valuetext={`${left.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} signatures left`}
        className="flex h-6 items-stretch gap-[2px]"
      >
        {Array.from({ length: ticks }, (_, i) => (
          <span key={i} className={`flex-1 ${i < lit ? "bg-blue" : "bg-rule-soft"}`} />
        ))}
      </div>
      <p className="mt-2.5 flex items-baseline justify-between gap-3">
        <span className="text-[1.05rem] tnum">
          {left.toLocaleString("en-US")}
          {budget ? <span className="text-ink-3"> of {budget.toLocaleString("en-US")}</span> : null}
        </span>
        <span className="mono-label text-[11px] text-ink-3">One per payment</span>
      </p>
    </div>
  );
}

const sumWei = (e: ActivityEntry) => e.calls.reduce((s, c) => s + BigInt(c.value), 0n);

/** What a row says, now: the headline while it's under way, the done line after. */
export function entryTitle(e: ActivityEntry) {
  return e.status === "confirmed" ? (e.doneHeadline ?? e.headline) : e.headline;
}

export function entryState(e: ActivityEntry): { label: string; tone: "ink" | "blue" | "red" } {
  if (e.status === "failed") return { label: "Failed", tone: "red" };
  if (e.status === "confirmed") return { label: "Done", tone: "ink" };
  return { label: "On its way", tone: "blue" };
}

/** A payment's value out of the account (null for entries that don't move value out). */
export function entryOut(e: ActivityEntry): bigint | null {
  if (e.kind !== "payment") return null;
  const v = sumWei(e);
  return v > 0n ? v : null;
}

/** One line of the logbook: what happened, when, and how much left the account. */
export function EntryRow({ e, onOpen }: { e: ActivityEntry; onOpen: () => void }) {
  const st = entryState(e);
  const out = entryOut(e);
  return (
    <li className="border-b border-rule">
      <button
        type="button"
        onClick={onOpen}
        className="grid min-h-[68px] w-full grid-cols-[auto_1fr_auto_auto] items-center gap-3 py-3 text-left active:bg-blue-wash"
      >
        {e.kind === "payment" && e.calls.length === 1 ? (
          <Identicon address={e.calls[0]!.target} size={34} />
        ) : (
          <Mark size={34} variant="line" />
        )}
        <span className="min-w-0">
          <span className="block truncate text-[1.02rem] leading-snug">{entryTitle(e)}</span>
          <span className="mt-1 flex items-center gap-2 mono-label text-[11px] text-ink-3">
            {ago(e.createdAt)}
            <span aria-hidden>·</span>
            <span className={st.tone === "red" ? "text-red" : st.tone === "blue" ? "text-blue" : ""}>{st.label}</span>
            {st.tone === "blue" && (
              <span className="text-blue">
                <Working />
              </span>
            )}
          </span>
        </span>
        <span className="text-[1rem] tnum">{out !== null ? `−${eth(out)}` : ""}</span>
        <LineArrow className="text-ink-3" />
      </button>
    </li>
  );
}

/** The dotted outline of the seal: an account that exists only as an address so far. */
export function GhostSeal({ size = 44 }: { size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden className="shrink-0">
      <circle
        cx="50"
        cy="50"
        r="46"
        fill="none"
        stroke="var(--blue)"
        strokeWidth="2.4"
        strokeDasharray="0.01 7"
        strokeLinecap="round"
      />
      <circle cx="50" cy="50" r="34" fill="none" stroke="var(--blue-t3)" strokeWidth="1.6" strokeDasharray="4 4" />
    </svg>
  );
}

export interface Recipient {
  address: `0x${string}`;
  count: number;
  last: number;
}

/** Everyone this wallet paid (plain one-call payments that didn't fail), most recent first. */
export function recipients(activity: ActivityEntry[]): Recipient[] {
  const by = new Map<string, Recipient>();
  for (const e of activity) {
    if (e.kind !== "payment" || e.status === "failed" || e.calls.length !== 1) continue;
    const c = e.calls[0]!;
    if (BigInt(c.value) === 0n || c.data !== "0x") continue;
    const k = c.target.toLowerCase();
    const r = by.get(k);
    if (r) {
      r.count++;
      r.last = Math.max(r.last, e.createdAt);
    } else by.set(k, { address: c.target, count: 1, last: e.createdAt });
  }
  return [...by.values()].sort((a, b) => b.last - a.last);
}
