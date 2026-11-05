import { cx } from "./cx";
import { formatUsd } from "./format";
import { LockIcon, TriangleIcon } from "./icons";

export type LimitState = "ok" | "low" | "empty" | "paused" | "none";

export interface LimitMeterProps {
  capUsd: number;
  usedUsd: number;
  perTxMaxUsd: number;
  nextRefill?: { usd: number; at: Date };
  /** Derived from the remaining fraction when omitted. */
  state?: LimitState;
  /** Label shown while the numbers are a preview (no on-chain bucket yet). */
  previewNote?: string;
  pausedUntil?: Date;
  className?: string;
}

export function limitStateFor(capUsd: number, usedUsd: number): Exclude<LimitState, "paused" | "none"> {
  const left = Math.max(0, capUsd - usedUsd);
  const frac = capUsd > 0 ? left / capUsd : 0;
  if (frac < 0.1) return "empty";
  if (frac < 0.4) return "low";
  return "ok";
}

const fillFor: Record<"ok" | "low" | "empty" | "paused", string> = {
  ok: "var(--meter-safe)",
  low: "var(--meter-limit)",
  empty: "var(--meter-empty)",
  paused: "var(--text-muted)",
};

function time(d: Date): string {
  const sameDay = d.toDateString() === new Date().toDateString();
  const t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? t : `${t} tomorrow`;
}

/**
 * The everyday-spending meter (ux-spec §3.2, §6.4). Rolling bucket: "Left" = cap − used in any 24 hours.
 * `role="meter"` with a full-sentence `aria-valuetext`; the fill colour is always accompanied by text.
 */
export function LimitMeter({
  capUsd,
  usedUsd,
  perTxMaxUsd,
  nextRefill,
  state,
  previewNote,
  pausedUntil,
  className,
}: LimitMeterProps) {
  const s = state ?? limitStateFor(capUsd, usedUsd);
  if (s === "none") {
    return (
      <div role="status" className={cx("flex gap-3 rounded-md bg-limit-bg p-3", className)}>
        <span className="text-limit">
          <TriangleIcon />
        </span>
        <div>
          <p className="t-strong text-limit">No daily limit</p>
          <p className="t-small">Set up the Vault so a stolen browser can only spend a little.</p>
        </div>
      </div>
    );
  }
  const left = Math.max(0, capUsd - usedUsd);
  const pct = capUsd > 0 ? Math.min(100, (left / capUsd) * 100) : 0;
  const valueText = `${formatUsd(left)} of ${formatUsd(capUsd)} left`;
  const fill = fillFor[s];
  return (
    <div className={cx("rounded-md border border-line p-3", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="t-strong tabular">
          <span className={cx(s === "paused" && "text-muted")}>{formatUsd(left)}</span>
          <span className="t-body text-muted"> left of {formatUsd(capUsd)}</span>
        </p>
        {s === "paused" && (
          <span className="t-small inline-flex items-center gap-1 text-muted">
            <LockIcon size={14} /> Paused
          </span>
        )}
      </div>
      <div
        role="meter"
        aria-label="Everyday spending left in any 24 hours"
        aria-valuemin={0}
        aria-valuemax={capUsd}
        aria-valuenow={left}
        aria-valuetext={valueText}
        className="mt-2 h-2 overflow-hidden rounded-full bg-meter-track"
      >
        <div
          className="h-full rounded-full transition-[width] duration-[200ms] ease-out"
          style={{ width: `${pct}%`, background: fill }}
        />
      </div>
      <p className="t-small mt-2 text-muted">
        {s === "paused" && pausedUntil
          ? `Paused until ${time(pausedUntil)}`
          : s === "empty" && left < perTxMaxUsd
            ? "Over the limit today: next payment needs your phone"
            : nextRefill
              ? `${formatUsd(nextRefill.usd)} frees up at ${time(nextRefill.at)}`
              : usedUsd > 0
                ? `${formatUsd(usedUsd)} used in the last 24 hours.`
                : "Nothing used in the last 24 hours."}
      </p>
      <p className="t-small text-muted">Up to {formatUsd(perTxMaxUsd)} per payment.</p>
      {previewNote && <p className="t-small mt-2 border-t border-line pt-2 text-muted">{previewNote}</p>}
    </div>
  );
}
