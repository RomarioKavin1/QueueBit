"use client";

import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { EngineCallError } from "@/lib/engine/client";

/** Bare-bones building blocks for /test: a test harness, not the product UI. */

export interface LogEntry {
  at: number;
  label: string;
  ms: number;
  ok: boolean;
  result: unknown;
}

const LogContext = createContext<(e: LogEntry) => void>(() => undefined);
export const LogProvider = LogContext.Provider;

/** JSON with bigints as strings. */
export function json(v: unknown): string {
  if (v === undefined) return "undefined";
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? x.toString() : x), 2);
}

function errorOf(e: unknown) {
  if (e instanceof EngineCallError)
    return { error: e.message, ...(e.reason ? { reason: e.reason } : {}), ...(e.code ? { code: e.code } : {}) };
  return { error: e instanceof Error ? e.message : String(e) };
}

/** Runs actions for one panel: keeps the last result, and logs every call. */
export function useRunner() {
  const log = useContext(LogContext);
  const [out, setOut] = useState<{ label: string; ok: boolean; value: unknown; ms: number } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback(
    async <T,>(label: string, fn: () => Promise<T>): Promise<T | undefined> => {
      setBusy(label);
      const t = performance.now();
      try {
        const value = await fn();
        const ms = Math.round(performance.now() - t);
        setOut({ label, ok: true, value, ms });
        log({ at: Date.now(), label, ms, ok: true, result: value });
        return value;
      } catch (e) {
        const ms = Math.round(performance.now() - t);
        const value = errorOf(e);
        setOut({ label, ok: false, value, ms });
        log({ at: Date.now(), label, ms, ok: false, result: value });
        return undefined;
      } finally {
        setBusy(null);
      }
    },
    [log],
  );
  return { run, out, busy };
}

export function Panel({
  id,
  title,
  hint,
  children,
  runner,
}: {
  id: string;
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  runner: ReturnType<typeof useRunner>;
}) {
  return (
    <section id={id} className="scroll-mt-4 rounded-lg border border-line bg-bg">
      <header className="border-b border-line px-4 py-3">
        <h2 className="text-[15px] font-semibold">{title}</h2>
        {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
      </header>
      <div className="flex flex-col gap-3 p-4">{children}</div>
      {runner.out && (
        <div className="border-t border-line px-4 py-3">
          <p className={`mb-1 text-[12px] font-semibold ${runner.out.ok ? "text-safe" : "text-danger"}`}>
            {runner.out.ok ? "✓" : "✗"} {runner.out.label} · {runner.out.ms} ms
          </p>
          <pre className="max-h-80 overflow-auto rounded-md bg-surface p-3 font-mono text-[12px] leading-5 break-all whitespace-pre-wrap">
            {json(runner.out.value)}
          </pre>
        </div>
      )}
    </section>
  );
}

export function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-end gap-2">{children}</div>;
}

export function Field({
  label,
  value,
  onChange,
  placeholder,
  type = "text",
  wide,
  area,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  wide?: boolean;
  area?: boolean;
}) {
  const cls =
    "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 font-mono text-[13px] outline-none focus:border-brand";
  return (
    <label className={`flex flex-col gap-1 text-[12px] text-muted ${wide ? "min-w-full" : "min-w-44 flex-1"}`}>
      {label}
      {area ? (
        <textarea
          className={`${cls} min-h-20`}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      ) : (
        <input
          className={cls}
          type={type}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </label>
  );
}

export function Select({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: readonly string[];
}) {
  return (
    <label className="flex min-w-36 flex-col gap-1 text-[12px] text-muted">
      {label}
      <select
        className="rounded-md border border-line bg-bg px-2.5 py-1.5 text-[13px] text-fg"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

export function Check({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 py-1.5 text-[13px]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Btn({
  children,
  onClick,
  busy,
  tone = "default",
}: {
  children: ReactNode;
  onClick: () => void;
  busy?: boolean;
  tone?: "default" | "primary" | "danger";
}) {
  const tones = {
    default: "border-line bg-surface hover:bg-surface-2",
    primary: "border-brand bg-brand text-on-brand hover:opacity-90",
    danger: "border-danger text-danger hover:bg-danger-bg",
  };
  return (
    <button
      type="button"
      disabled={busy}
      onClick={onClick}
      className={`rounded-md border px-3 py-1.5 text-[13px] font-medium disabled:opacity-50 ${tones[tone]}`}
    >
      {busy ? "…" : children}
    </button>
  );
}

/** "a, b\nc" → ["a", "b", "c"] */
export const list = (s: string) =>
  s
    .split(/[\s,]+/u)
    .map((x) => x.trim())
    .filter(Boolean);
