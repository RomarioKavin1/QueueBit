import type { ReactNode } from "react";
import { cx } from "./cx";

/**
 * Where the animated QR / camera preview will go (QRHandoff, ux-spec §6.4, milestone M4). It is visibly a placeholder:
 * a dashed frame with a label, never a fake code.
 */
export function QrPlaceholder({
  label,
  children,
  size = 200,
  className,
}: {
  label: string;
  children?: ReactNode;
  size?: number;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={label}
      className={cx(
        "relative grid place-items-center rounded-md border-2 border-dashed border-line bg-surface text-center",
        className,
      )}
      style={{ width: size, height: size }}
    >
      <svg width={size * 0.45} height={size * 0.45} viewBox="0 0 24 24" aria-hidden="true" className="text-line">
        <path
          d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M7 8h3v3H7zM14 8h3v3h-3zM7 14h3v3H7zM14 14h3v3h-3z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
      {children && <div className="t-small absolute inset-x-3 bottom-3 text-muted">{children}</div>}
    </div>
  );
}
