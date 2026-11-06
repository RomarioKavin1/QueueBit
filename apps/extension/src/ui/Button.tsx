import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { VaultIcon } from "./icons";
import { Spinner } from "./Spinner";

export type ButtonVariant = "primary" | "secondary" | "vault" | "destructive" | "danger-outline" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
  /** Shows a spinner and replaces the label with `loadingLabel` (announced to screen readers). */
  loading?: boolean;
  loadingLabel?: string;
  icon?: ReactNode;
  block?: boolean;
}

const variants: Record<ButtonVariant, string> = {
  primary: "bg-brand text-on-brand hover:bg-brand-hover",
  secondary: "bg-bg text-fg border border-line shadow-press hover:bg-surface-2",
  vault: "bg-vault text-on-vault hover:opacity-90",
  destructive: "bg-danger text-on-danger hover:opacity-90",
  "danger-outline": "bg-bg text-danger border border-danger shadow-press hover:bg-danger-bg",
  ghost: "bg-transparent text-fg hover:bg-surface-2",
};

/**
 * ux-spec §3 conventions: primary = filled terracotta; secondary = outline; destructive = filled danger; "needs Vault" =
 * filled vault cobalt with the phone glyph. Minimum target 44 px (md) / 36 px (sm, inline actions only).
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "md", loading, loadingLabel, icon, block, className, children, disabled, ...rest },
  ref,
) {
  const glyph = variant === "vault" && !icon ? <VaultIcon size={18} /> : icon;
  return (
    <button
      ref={ref}
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md t-strong select-none",
        "transition-[background-color,opacity,box-shadow] duration-[120ms] ease-out",
        "disabled:cursor-not-allowed disabled:opacity-50",
        size === "md" ? "min-h-11 px-4" : "min-h-9 px-3",
        block && "w-full",
        variants[variant],
        className,
      )}
    >
      {loading ? <Spinner size={16} /> : glyph}
      <span>{loading && loadingLabel ? loadingLabel : children}</span>
    </button>
  );
});
