import { useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import { checksum } from "../core/format.js";
import { BackIcon, CheckIcon, CloseIcon, DangerIcon, InfoIcon, VaultIcon, WarnIcon } from "./icons.js";

// ---------------------------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------------------------

export function Screen({
  title,
  onBack,
  onClose,
  right,
  children,
  footer,
  tone,
  banner,
}: {
  title?: ReactNode;
  onBack?: () => void;
  onClose?: () => void;
  right?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  tone?: "recovery";
  banner?: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  // Move focus to the new screen's title so screen readers announce it (and keyboard users start at the top).
  useEffect(() => {
    headingRef.current?.focus();
  }, []);
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[460px] flex-col bg-bg">
      {tone === "recovery" && (
        <div role="alert" className="bg-danger px-4 py-2 text-center t-strong text-on-danger">
          RECOVERY MODE: this phone will sign one recovery action, then forget the key.
        </div>
      )}
      {banner}
      {(title || onBack || onClose) && (
        <header className="sticky top-0 z-10 flex items-center gap-1 border-b border-line bg-bg/95 px-2 py-2 backdrop-blur">
          {onBack ? (
            <IconButton label="Back" onClick={onBack}>
              <BackIcon />
            </IconButton>
          ) : (
            <span className="w-11" />
          )}
          <h1 ref={headingRef} tabIndex={-1} className="min-w-0 flex-1 truncate text-center t-title outline-none">
            {title}
          </h1>
          {onClose ? (
            <IconButton label="Close" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          ) : (
            (right ?? <span className="w-11" />)
          )}
        </header>
      )}
      <main className="flex flex-1 flex-col gap-4 px-4 pt-4 pb-6">{children}</main>
      {footer && <footer className="sticky bottom-0 border-t border-line bg-bg px-4 pt-3 safe-bottom">{footer}</footer>}
    </div>
  );
}

export function IconButton({
  label,
  children,
  ...rest
}: { label: string; children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className="tap inline-flex items-center justify-center rounded-md text-fg hover:bg-surface"
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Buttons
// ---------------------------------------------------------------------------------------------------------------

type Variant = "primary" | "secondary" | "danger" | "dangerOutline" | "ghost" | "vault";

const variants: Record<Variant, string> = {
  primary: "bg-brand text-on-brand hover:bg-brand-hover",
  vault: "bg-vault text-on-vault hover:opacity-90",
  secondary: "border border-line bg-bg text-fg shadow-press hover:bg-surface-2",
  danger: "bg-danger text-on-danger hover:opacity-90",
  /** A destructive path that must not look like the main call to action (the unknown-step long-press). */
  dangerOutline: "border border-danger bg-bg text-danger shadow-press hover:bg-danger-bg",
  ghost: "text-brand hover:bg-surface",
};

export function Button({
  variant = "primary",
  big,
  block = true,
  className = "",
  children,
  ...rest
}: { variant?: Variant; big?: boolean; block?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      className={`tap inline-flex items-center justify-center gap-2 rounded-md px-4 t-strong transition-colors duration-[120ms] disabled:cursor-not-allowed disabled:opacity-50 ${
        big ? "min-h-[56px] text-[17px]" : "min-h-[48px]"
      } ${block ? "w-full" : ""} ${variants[variant]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}

/**
 * Press and hold for `ms` to fire (ux-spec §4.4 rule 6: the unknown-step escape hatch). Works with touch, mouse and
 * keyboard (hold Space/Enter). Releasing early cancels.
 */
export function HoldButton({
  ms = 1500,
  onDone,
  children,
  variant = "danger",
}: {
  ms?: number;
  onDone: () => void;
  children: ReactNode;
  variant?: Variant;
}) {
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const start = () => {
    if (timer.current !== undefined) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = undefined;
      setHolding(false);
      onDone();
    }, ms);
  };
  const stop = () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = undefined;
    setHolding(false);
  };
  useEffect(() => stop, []);
  return (
    <button
      type="button"
      className={`tap relative w-full overflow-hidden rounded-md px-4 min-h-[52px] t-strong select-none ${variants[variant]}`}
      onPointerDown={start}
      onPointerUp={stop}
      onPointerLeave={stop}
      onPointerCancel={stop}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          start();
        }
      }}
      onKeyUp={stop}
      onContextMenu={(e) => e.preventDefault()}
      aria-describedby="hold-hint"
    >
      {holding && (
        <span
          className="absolute inset-0 origin-left bg-[var(--text)] opacity-25"
          style={{ animation: `press-fill ${ms}ms linear forwards` }}
          aria-hidden="true"
        />
      )}
      <span className="relative">{holding ? "Keep holding…" : children}</span>
      <span id="hold-hint" className="sr-only">
        Press and hold for {ms / 1000} seconds.
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Banners and cards
// ---------------------------------------------------------------------------------------------------------------

type Level = "info" | "limit" | "vault" | "danger" | "safe";

const bannerStyle: Record<Level, { box: string; icon: ReactNode }> = {
  info: { box: "bg-surface border-line text-fg", icon: <InfoIcon className="text-muted" /> },
  limit: { box: "bg-limit-bg border-limit text-fg", icon: <WarnIcon className="text-limit" /> },
  vault: { box: "bg-vault-bg border-vault text-fg", icon: <VaultIcon className="text-vault" /> },
  danger: { box: "bg-danger-bg border-danger text-fg", icon: <DangerIcon className="text-danger" /> },
  safe: { box: "bg-safe-bg border-safe text-fg", icon: <CheckIcon className="text-safe" /> },
};

/** RiskBanner (ux-spec §6.4): glyph + text, never colour alone. */
export function Banner({
  level,
  title,
  children,
  action,
  role,
  testId,
}: {
  level: Level;
  title: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  role?: "status" | "alert";
  testId?: string;
}) {
  const s = bannerStyle[level];
  return (
    <div
      role={role ?? (level === "danger" ? "alert" : "status")}
      data-testid={testId}
      className={`flex gap-3 rounded-md border px-3 py-3 ${s.box}`}
    >
      <span className="mt-0.5 shrink-0">{s.icon}</span>
      <div className="min-w-0 flex-1">
        <p className="t-strong">{title}</p>
        {children && <div className="mt-1 t-body text-fg">{children}</div>}
        {action && <div className="mt-2">{action}</div>}
      </div>
    </div>
  );
}

export function Card({
  children,
  className = "",
  as: As = "section",
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div";
}) {
  return <As className={`rounded-md border border-line bg-bg p-3 ${className}`}>{children}</As>;
}

export function Row({ label, value, mono }: { label: ReactNode; value: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-4 py-2">
      <dt className="min-w-0 t-body text-muted">{label}</dt>
      <dd className={`max-w-[62%] shrink-0 text-right break-words ${mono ? "t-mono break-all" : "t-body"}`}>{value}</dd>
    </div>
  );
}

export function NavRow({
  icon,
  label,
  hint,
  onClick,
  testId,
}: {
  icon: ReactNode;
  label: string;
  hint?: string;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="tap flex w-full items-center gap-3 rounded-md px-3 py-3 text-left hover:bg-surface"
    >
      <span className="text-muted">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block t-strong">{label}</span>
        {hint && <span className="block t-small text-muted">{hint}</span>}
      </span>
      <span className="text-muted" aria-hidden="true">
        ›
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------------------------

export function ProgressBar({ value, label }: { value?: number; label: string }) {
  const determinate = value !== undefined;
  return (
    <div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        {...(determinate ? { "aria-valuenow": Math.round(value * 100) } : {})}
        className="h-2 w-full overflow-hidden rounded-full bg-meter-track"
      >
        {determinate ? (
          <div
            className="h-full rounded-full bg-vault transition-[width] duration-200"
            style={{ width: `${Math.max(2, Math.min(100, value * 100))}%` }}
          />
        ) : (
          <div
            className="h-full w-2/5 rounded-full bg-vault"
            style={{ animation: "progress-indeterminate 1.2s ease-in-out infinite" }}
          />
        )}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label: string }) {
  return (
    <span
      role="status"
      aria-label={label}
      className="inline-block h-5 w-5 rounded-full border-2 border-line border-t-vault"
      style={{ animation: "spin 0.8s linear infinite" }}
    />
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Sheet (modal)
// ---------------------------------------------------------------------------------------------------------------

export function Sheet({ title, onClose, children }: { title: string; onClose?: () => void; children: ReactNode }) {
  const id = useId();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>("input, button, textarea, [tabindex]");
    first?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && onClose) onClose();
      if (e.key === "Tab" && ref.current) {
        const items = [
          ...ref.current.querySelectorAll<HTMLElement>("input, button, textarea, a, [tabindex]:not([tabindex='-1'])"),
        ].filter((x) => !x.hasAttribute("disabled"));
        if (items.length === 0) return;
        const a = items[0]!;
        const z = items[items.length - 1]!;
        if (e.shiftKey && document.activeElement === a) {
          e.preventDefault();
          z.focus();
        } else if (!e.shiftKey && document.activeElement === z) {
          e.preventDefault();
          a.focus();
        }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-[var(--scrim)]"
      onClick={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        className="w-full max-w-[460px] rounded-t-lg bg-bg px-4 pt-4 safe-bottom shadow-sheet"
        style={{ animation: "sheet-in 200ms var(--ease)" }}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id={id} className="t-title">
            {title}
          </h2>
          {onClose && (
            <IconButton label="Close" onClick={onClose}>
              <CloseIcon />
            </IconButton>
          )}
        </div>
        {children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Keys and addresses
// ---------------------------------------------------------------------------------------------------------------

/** The 8-character comparison (ux-spec §3.1.2): large monospace, read character by character. */
export function KeyCheck({ value }: { value: string }) {
  return (
    <p className="key-check text-center" aria-label={`Ends in ${value.split("").join(" ")}`} data-testid="key-check">
      …{value}
    </p>
  );
}

/** Full checksummed address in groups of 4, first and last 4 characters highlighted (ux-spec §4.4 rule 3). */
export function AddressBlock({
  address,
  name,
  isNew,
}: {
  address: string;
  name?: string | undefined;
  isNew?: boolean;
}) {
  const c = checksum(address);
  const body = c.slice(2);
  const head = body.slice(0, 4);
  const mid = body.slice(4, -4);
  const tail = body.slice(-4);
  const groups = (mid.match(/.{1,4}/g) ?? []).join(" ");
  return (
    <div className="rounded-md border border-line bg-surface px-3 py-2" data-testid="recipient">
      {name && <p className="t-strong">{name}</p>}
      <p className="t-mono" aria-label={`Address ${c.split("").join(" ")}`}>
        0x<span className="addr-hl">{head}</span> {groups} <span className="addr-hl">{tail}</span>
      </p>
      <p className="mt-1 flex flex-wrap items-center gap-x-1 t-small">
        {name ? (
          <>
            <CheckIcon size={16} className="text-safe" /> <span>In your address book</span>
          </>
        ) : isNew ? (
          <>
            <WarnIcon size={16} className="text-limit" />{" "}
            <span className="whitespace-nowrap t-strong text-limit">NEW RECIPIENT</span>
            <span className="text-muted">· not in this phone's address book</span>
          </>
        ) : null}
      </p>
    </div>
  );
}

export function TextField({
  label,
  hint,
  error,
  ...rest
}: { label: string; hint?: string; error?: string | undefined } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div>
      <label htmlFor={id} className="mb-1 block t-strong">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={!!error}
        aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined}
        className={`tap w-full rounded-md border bg-bg px-3 py-3 text-[16px] ${error ? "border-danger" : "border-line"}`}
        {...rest}
      />
      {hint && !error && (
        <p id={`${id}-h`} className="mt-1 t-small text-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-e`} role="alert" className="mt-1 flex items-center gap-1 t-small text-danger">
          <DangerIcon size={14} /> {error}
        </p>
      )}
    </div>
  );
}

/**
 * A passphrase input. Deliberately not `autocomplete="current-password"` / `"new-password"`: those invite the
 * browser's or a password manager's offer to save (and sync to a cloud account) the one secret that, with this phone's
 * storage, opens the Vault key. `off` plus the managers' own opt-out attributes (1Password, LastPass, Bitwarden,
 * Dashlane) keep them out; no username field is ever next to it, which is what most save prompts key on.
 */
export function PassphraseField(props: Parameters<typeof TextField>[0]) {
  return (
    <TextField
      type="password"
      autoComplete="off"
      autoCapitalize="off"
      autoCorrect="off"
      spellCheck={false}
      data-1p-ignore=""
      data-lpignore="true"
      data-bwignore="true"
      data-form-type="other"
      {...props}
    />
  );
}
