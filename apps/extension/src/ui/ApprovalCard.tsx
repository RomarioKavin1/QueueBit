import type { ReactNode } from "react";
import { cx } from "./cx";
import { formatUsd } from "./format";
import { ReasonCode } from "./ReasonCode";
import { FAMILY_TEXT, StatusGlyph, type StatusFamily } from "./StatusGlyph";

/** Router results (plan §30 §5.2) the card can show, with the ux-spec §3.3.1 copy table. */
export type RouteResult =
  | { kind: "hot-ok" }
  | { kind: "session"; app: string; allowanceLeftUsd: number }
  | { kind: "vault-cap" }
  | { kind: "vault-per-payment"; perTxMaxUsd: number }
  | { kind: "vault-not-allowed"; what: string }
  | { kind: "vault-timelock"; thresholdUsd: number }
  | { kind: "frozen"; resumes: string }
  | { kind: "bunker" };

export interface ApprovalCardProps {
  route: RouteResult;
  amountUsd: number;
  remainingUsd: number;
  ruleIds: string[];
  lane: "standard" | "staked";
  /** Max fee the fee tank can lose if the advisory pre-check is wrong. */
  maxFeeText?: string;
  details?: ReactNode;
}

function copy(
  r: RouteResult,
  amountUsd: number,
  remainingUsd: number,
): { family: StatusFamily; head: string; line: string } {
  switch (r.kind) {
    case "hot-ok":
      return {
        family: "safe",
        head: "Within your daily limit",
        line: `Uses ${formatUsd(amountUsd)} of ${formatUsd(remainingUsd)} left today`,
      };
    case "session":
      return {
        family: "safe",
        head: `Covered by ${r.app}'s allowance`,
        line: `Uses ${formatUsd(amountUsd)} of ${formatUsd(r.allowanceLeftUsd)} allowance; doesn't touch your daily limit`,
      };
    case "vault-cap":
      return {
        family: "vault",
        head: "Needs your phone",
        line: `Over what's left today (${formatUsd(remainingUsd)}). Your phone approves it in about 30 seconds.`,
      };
    case "vault-per-payment":
      return {
        family: "vault",
        head: "Needs your phone",
        line: `Above your ${formatUsd(r.perTxMaxUsd)} per-payment limit.`,
      };
    case "vault-not-allowed":
      return { family: "vault", head: "Needs your phone", line: `${r.what} isn't on your allowed list yet.` };
    case "vault-timelock":
      return {
        family: "vault",
        head: "Needs your phone, then a 48-hour wait",
        line: `Payments over ${formatUsd(r.thresholdUsd)} wait 48 hours. You can cancel during the wait.`,
      };
    case "frozen":
      return {
        family: "limit",
        head: "Everyday spending is paused",
        line: `Resumes ${r.resumes}, or your phone can resume it now.`,
      };
    case "bunker":
      return { family: "danger", head: "Lockdown is on", line: "Everyday spending is off. Open Security." };
  }
}

const bg: Record<StatusFamily, string> = {
  info: "bg-surface",
  safe: "bg-safe-bg",
  limit: "bg-limit-bg",
  vault: "bg-vault-bg",
  danger: "bg-danger-bg",
};

/** The route preview (ux-spec §3.3.1, §6.4): one headline, one consequence line, reason codes one tap away. */
export function ApprovalCard({
  route,
  amountUsd,
  remainingUsd,
  ruleIds,
  lane,
  maxFeeText,
  details,
}: ApprovalCardProps) {
  const c = copy(route, amountUsd, remainingUsd);
  return (
    <div role="status" className={cx("rounded-md p-3", bg[c.family])}>
      <div className="flex gap-2">
        <span className={cx("mt-px shrink-0", FAMILY_TEXT[c.family])}>
          <StatusGlyph family={c.family} size={18} />
        </span>
        <div className="min-w-0">
          <p className={cx("t-strong", FAMILY_TEXT[c.family])}>{c.head}</p>
          <p className="t-small mt-0.5">{c.line}</p>
        </div>
      </div>
      <details className="group mt-2">
        <summary className="t-small cursor-pointer select-none text-muted marker:content-none">
          <span className="underline underline-offset-2">Details</span>
        </summary>
        <div className="t-small mt-2 space-y-2 text-muted">
          <div className="flex flex-wrap gap-1" aria-label="Reason codes">
            {ruleIds.map((id) => (
              <ReasonCode key={id} id={id} />
            ))}
          </div>
          <p>Lane: {lane === "standard" ? "Standard lane" : "Staked lane"}</p>
          {(route.kind === "hot-ok" || route.kind === "session") && (
            <p>
              This check is an estimate. If the limit changed from another device, the payment can still fail and cost
              up to {maxFeeText ?? "the maximum fee"} from the fee tank.
            </p>
          )}
          {details}
        </div>
      </details>
    </div>
  );
}
