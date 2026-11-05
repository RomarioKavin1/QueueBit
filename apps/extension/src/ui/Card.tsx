import type { HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export type Tone = "neutral" | "safe" | "limit" | "vault" | "danger";

const tones: Record<Tone, string> = {
  neutral: "bg-bg border-line",
  safe: "bg-safe-bg border-transparent",
  limit: "bg-limit-bg border-transparent",
  vault: "bg-vault-bg border-transparent",
  danger: "bg-danger-bg border-transparent",
};

export interface CardProps extends HTMLAttributes<HTMLElement> {
  tone?: Tone;
  as?: "div" | "section" | "article" | "li";
  /** Optional heading rendered at the top of the card. */
  heading?: ReactNode;
  headingLevel?: 2 | 3;
  padded?: boolean;
}

/** Cards use a 1 px border and no shadow in the popup (ux-spec §6.3); 12 px padding, 10 px radius. */
export function Card({
  tone = "neutral",
  as: Tag = "div",
  heading,
  headingLevel = 3,
  padded = true,
  className,
  children,
  ...rest
}: CardProps) {
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <Tag className={cx("rounded-md border", padded && "p-3", tones[tone], className)} {...rest}>
      {heading && <H className="t-strong mb-1">{heading}</H>}
      {children}
    </Tag>
  );
}
