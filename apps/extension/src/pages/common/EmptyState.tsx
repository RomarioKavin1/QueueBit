import type { ReactNode } from "react";

export function EmptyState({
  icon,
  title,
  body,
  children,
}: {
  icon: ReactNode;
  title: string;
  body: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-10 text-center">
      <span className="grid size-12 place-items-center rounded-full bg-surface-2 text-muted">{icon}</span>
      <h2 className="t-strong mt-1">{title}</h2>
      <p className="t-small max-w-[260px] text-muted">{body}</p>
      {children}
    </div>
  );
}

/** "Coming in the next update": used wherever M0 shows a later feature, so nothing pretends to work. */
export function SoonBadge({ children = "Coming in the next update" }: { children?: ReactNode }) {
  return (
    <span className="t-small inline-flex items-center rounded-full bg-owner-bg px-2 py-0.5 font-semibold text-owner">
      {children}
    </span>
  );
}
