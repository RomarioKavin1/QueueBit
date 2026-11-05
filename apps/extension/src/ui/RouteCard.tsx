import type { ReactNode } from "react";
import type { RouteView } from "../shared/views";
import { cx } from "./cx";
import { ReasonCode } from "./ReasonCode";
import { FAMILY_TEXT, StatusGlyph, type StatusFamily } from "./StatusGlyph";

const bg: Record<StatusFamily, string> = {
  info: "bg-surface",
  safe: "bg-safe-bg",
  limit: "bg-limit-bg",
  vault: "bg-vault-bg",
  danger: "bg-danger-bg",
};

/**
 * The live route preview (ux-spec §3.3.1 / §3.5.2) for a decision of the routing engine: one headline, one
 * consequence line, and the reason codes one tap away under Details (principle 2).
 */
export function RouteCard({
  route,
  feeText,
  maxFeeText,
  children,
  details,
}: {
  route: RouteView;
  /** "Network fee ≈ 0.0001 ETH from your fee tank" */
  feeText?: string;
  maxFeeText?: string;
  children?: ReactNode;
  details?: ReactNode;
}) {
  const family: StatusFamily = route.copy.tone;
  return (
    <div
      role="status"
      aria-live="polite"
      className={cx("rounded-md p-3", bg[family])}
      data-testid="route-card"
      data-route={route.route}
    >
      <div className="flex gap-2">
        <span className={cx("mt-px shrink-0", FAMILY_TEXT[family])}>
          <StatusGlyph family={family} size={18} />
        </span>
        <div className="min-w-0">
          <p className={cx("t-strong", FAMILY_TEXT[family])}>{route.copy.headline}</p>
          <p className="t-small mt-0.5">{route.copy.detail}</p>
          {feeText && <p className="t-small mt-0.5 text-muted">{feeText}</p>}
        </div>
      </div>
      {children}
      <details className="mt-2">
        <summary className="t-small cursor-pointer text-muted select-none">
          <span className="underline underline-offset-2">Details</span>
        </summary>
        <div className="t-small mt-2 space-y-2 text-muted">
          <div className="flex flex-wrap gap-1" aria-label="Reason codes">
            {route.rules.map((id) => (
              <ReasonCode key={id} id={id} />
            ))}
          </div>
          <p>Lane: Standard lane</p>
          {route.route === "hot" && (
            <p>
              This check is an estimate. If the limit changed from another device, the payment can still fail and cost
              up to {maxFeeText ?? "the maximum fee"} from the fee tank.
            </p>
          )}
          {route.simulationReason && <p>Network said: {route.simulationReason}</p>}
          {details}
        </div>
      </details>
    </div>
  );
}
