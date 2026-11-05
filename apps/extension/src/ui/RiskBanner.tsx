import { useState, type ReactNode } from "react";
import { cx } from "./cx";
import { CloseIcon } from "./icons";
import { FAMILY_TEXT, StatusGlyph } from "./StatusGlyph";

export interface RiskBannerProps {
  level: "info" | "limit" | "vault" | "danger";
  title: ReactNode;
  body?: ReactNode;
  action?: { label: string; onClick: () => void };
  /** `alert` only for Lockdown / Replacing the Vault / scam warnings (ux-spec §3.2 A11y). */
  role?: "status" | "alert";
  dismissible?: boolean;
  onDismiss?: () => void;
  className?: string;
}

const bg = {
  info: "bg-surface",
  limit: "bg-limit-bg",
  vault: "bg-vault-bg",
  danger: "bg-danger-bg",
} as const;

/** Full-width status strip: glyph + words, never colour alone (ux-spec §6.4). */
export function RiskBanner({
  level,
  title,
  body,
  action,
  role = level === "danger" ? "alert" : "status",
  dismissible,
  onDismiss,
  className,
}: RiskBannerProps) {
  const [hidden, setHidden] = useState(false);
  if (hidden) return null;
  return (
    <div role={role} className={cx("flex gap-3 rounded-md px-3 py-2.5", bg[level], className)}>
      <span className={cx("mt-px shrink-0", FAMILY_TEXT[level])}>
        <StatusGlyph family={level} size={20} />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cx("t-strong", level === "info" ? "text-fg" : FAMILY_TEXT[level])}>{title}</p>
        {body && <div className="t-small mt-0.5 text-fg">{body}</div>}
        {action && (
          <button
            type="button"
            onClick={action.onClick}
            className={cx("t-strong mt-1 underline underline-offset-2", FAMILY_TEXT[level])}
          >
            {action.label}
          </button>
        )}
      </div>
      {dismissible && (
        <button
          type="button"
          aria-label="Dismiss"
          className="-m-1 grid size-8 shrink-0 place-items-center rounded-sm text-muted hover:bg-surface-2"
          onClick={() => {
            setHidden(true);
            onDismiss?.();
          }}
        >
          <CloseIcon size={16} />
        </button>
      )}
    </div>
  );
}
