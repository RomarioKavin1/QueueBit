"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";
import { Mark } from "@/components/paper/Logo";

/**
 * Onboarding building blocks, mobile first: the PWA runs full screen on phones, so every screen is one column with
 * its action pinned to the bottom above the home indicator, 48px targets, and 16px inputs (iOS never zooms them).
 * The look is the manual's: paper, serif reading text, Geist Mono for labels and controls, square corners.
 */

export function LineArrow({ dir = "right", className = "" }: { dir?: "right" | "left"; className?: string }) {
  return (
    <svg
      width="14"
      height="10"
      viewBox="0 0 14 10"
      aria-hidden
      className={className}
      style={dir === "left" ? { transform: "scaleX(-1)" } : undefined}
    >
      <path
        d="M1 5h11M8.5 1.5 12 5 8.5 8.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The screen frame: a top bar (back, step, method), the column, and a bottom action bar. */
export function Screen({
  step,
  of,
  method,
  onBack,
  children,
  actions,
}: {
  step?: number;
  of?: number;
  method?: string;
  onBack?: () => void;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-10 bg-paper pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex h-14 max-w-[560px] items-center gap-3 px-5">
          {onBack ? (
            <button
              type="button"
              onClick={onBack}
              className="mono-label -ml-2 flex h-11 items-center gap-2 px-2 text-ink-2 active:text-blue"
            >
              <LineArrow dir="left" />
              Back
            </button>
          ) : (
            <span className="flex items-center gap-2.5">
              <Mark size={24} />
              <span className="font-display text-[1.25rem] leading-none font-light tracking-[-0.01em] text-blue">
                QueueBit
              </span>
            </span>
          )}
          <span className="ml-auto mono-label text-ink-3">
            {method}
            {step && of ? `${method ? " · " : ""}${step} / ${of}` : ""}
          </span>
        </div>
        {step && of ? (
          <div className="mx-auto flex max-w-[560px] gap-1 px-5" aria-hidden>
            {Array.from({ length: of }, (_, i) => (
              <span key={i} className={`h-[3px] flex-1 ${i < step ? "bg-blue" : "bg-rule-soft"}`} />
            ))}
          </div>
        ) : null}
      </header>
      <main className="mx-auto w-full max-w-[560px] flex-1 px-5 pt-8 pb-10">{children}</main>
      {actions && (
        <footer className="sticky bottom-0 z-10 bg-paper pb-[max(16px,env(safe-area-inset-bottom))]">
          <div className="mx-auto flex max-w-[560px] flex-col gap-2 px-5 pt-3">{actions}</div>
        </footer>
      )}
    </div>
  );
}

export function Title({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-7">
      <h1 className="text-[1.65rem] leading-[1.2] font-medium tracking-[-0.01em] text-balance">{children}</h1>
      {sub && <p className="mt-3 text-[1.02rem] leading-[1.7] text-ink-2">{sub}</p>}
    </div>
  );
}

export function Primary({
  children,
  busy,
  busyLabel,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean; busyLabel?: string }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={rest.disabled || busy}
      className="mono-label flex h-12 w-full items-center justify-center gap-2.5 border border-blue bg-blue text-[13px] text-on-blue transition-[filter] active:brightness-90 disabled:border-rule disabled:bg-paper-3 disabled:text-ink-3"
    >
      {busy ? (
        <>
          <Working />
          {busyLabel ?? "Working"}
        </>
      ) : (
        <>
          {children}
          <LineArrow />
        </>
      )}
    </button>
  );
}

export function Secondary({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className="mono-label flex h-12 w-full items-center justify-center border border-ink bg-paper text-[13px] text-ink active:bg-paper-3 disabled:text-ink-3"
    >
      {children}
    </button>
  );
}

export function TextButton({ children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      {...rest}
      className="mono-label flex h-11 w-full items-center justify-center text-ink-2 underline decoration-dotted underline-offset-4 active:text-blue"
    >
      {children}
    </button>
  );
}

/** Three blinking dots: work in progress. */
export function Working() {
  return (
    <span aria-hidden className="inline-flex gap-[3px]">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="size-[5px] animate-pulse rounded-full bg-current"
          style={{ animationDelay: `${i * 160}ms` }}
        />
      ))}
    </span>
  );
}

/** A ruled list of choices, each a full-width row: number, title, one line, arrow. */
export function Choices({
  items,
}: {
  items: Array<{ key: string; title: string; body: string; onSelect: () => void; disabled?: boolean; note?: string }>;
}) {
  return (
    <ul className="border-t border-ink">
      {items.map((it, i) => (
        <li key={it.key} className="border-b border-rule">
          <button
            type="button"
            onClick={it.onSelect}
            disabled={it.disabled}
            className="group grid min-h-[84px] w-full grid-cols-[2.2rem_1fr_auto] items-center gap-2 py-4 text-left active:bg-blue-wash disabled:opacity-50"
          >
            <span className="self-start pt-1 font-mono text-[13px] text-blue">{String(i + 1).padStart(2, "0")}</span>
            <span>
              <span className="block text-[1.12rem] leading-snug font-medium">{it.title}</span>
              <span className="mt-1 block text-[0.95rem] leading-[1.5] text-ink-2">{it.body}</span>
              {it.note && <span className="mt-1.5 block mono-label text-[12px] text-ink-3">{it.note}</span>}
            </span>
            <LineArrow className="mr-1 text-ink-3 group-active:text-blue" />
          </button>
        </li>
      ))}
    </ul>
  );
}

export function Field({
  label,
  hint,
  error,
  className = "",
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string; error?: string | null }) {
  return (
    <label className="block">
      <span className="mono-label text-ink-2">{label}</span>
      <input
        {...rest}
        className={`mt-2 block h-12 w-full border bg-paper px-3 text-[16px] outline-none focus:border-blue ${
          error ? "border-red" : "border-ink"
        } ${className}`}
      />
      {error ? (
        <span className="mt-1.5 block text-[0.9rem] text-red">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[0.9rem] text-ink-3">{hint}</span>
      ) : null}
    </label>
  );
}

export function Area({
  label,
  hint,
  error,
  value,
  onChange,
  rows = 4,
  placeholder,
}: {
  label: string;
  hint?: ReactNode;
  error?: string | null;
  value: string;
  onChange: (v: string) => void;
  rows?: number;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="mono-label text-ink-2">{label}</span>
      <textarea
        value={value}
        rows={rows}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        autoCapitalize="none"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        className={`mt-2 block w-full resize-none border bg-paper p-3 font-mono text-[16px] leading-[1.6] outline-none focus:border-blue ${
          error ? "border-red" : "border-ink"
        }`}
      />
      {error ? (
        <span className="mt-1.5 block text-[0.9rem] text-red">{error}</span>
      ) : hint ? (
        <span className="mt-1.5 block text-[0.9rem] text-ink-3">{hint}</span>
      ) : null}
    </label>
  );
}

/** An inline message: problem plus what to do, never colour alone. */
export function Notice({ tone = "info", children }: { tone?: "info" | "error"; children: ReactNode }) {
  return (
    <p
      role={tone === "error" ? "alert" : "status"}
      className={`mt-5 border px-3.5 py-3 text-[0.95rem] leading-[1.55] ${
        tone === "error" ? "border-red bg-red-wash text-ink" : "border-rule bg-paper-2 text-ink-2"
      }`}
    >
      {tone === "error" && <span className="mono-label mr-2 text-red">Error</span>}
      {children}
    </p>
  );
}

/** A numbered list of what happens next. */
export function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="space-y-3">
      {items.map((it, i) => (
        <li key={i} className="grid grid-cols-[2.2rem_1fr] text-[1rem] leading-[1.6]">
          <span className="pt-[3px] font-mono text-[13px] text-blue">{String(i + 1).padStart(2, "0")}</span>
          <span>{it}</span>
        </li>
      ))}
    </ol>
  );
}

/** An address set in groups of four, so it can be read aloud and checked by eye; lines break only between groups. */
export function Address({ value, className = "" }: { value: string; className?: string }) {
  const groups = value.slice(2).match(/.{1,4}/gu) ?? [];
  return (
    <span className={`font-mono ${className}`} aria-label={value}>
      {groups.map((g, i) => (
        <span key={i} className={`inline-block whitespace-nowrap ${i % 2 ? "text-blue" : ""}`}>
          {i === 0 && <span className="text-ink-3">0x</span>}
          {g}
          {i < groups.length - 1 ? "\u00a0" : ""}
        </span>
      ))}
    </span>
  );
}

/** The 24 words, numbered, two columns on a phone, three from 480px. */
export function WordGrid({ words }: { words: string[] }) {
  return (
    <ol className="grid grid-cols-2 gap-x-4 border-t border-ink min-[480px]:grid-cols-3">
      {words.map((w, i) => (
        <li key={i} className="flex items-baseline gap-2.5 border-b border-rule py-2.5">
          <span className="w-6 shrink-0 text-right font-mono text-[12px] text-ink-3">{i + 1}</span>
          <span className="font-mono text-[15px] tracking-[0.01em]">{w}</span>
        </li>
      ))}
    </ol>
  );
}
