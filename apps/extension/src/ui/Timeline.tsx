import { cx } from "./cx";
import { CheckIcon, CloseIcon } from "./icons";

export type StepStatus = "done" | "active" | "failed" | "skipped" | "pending" | "soon";

export interface TimelineStep {
  label: string;
  status: StepStatus;
  hint?: string;
}

const word: Record<StepStatus, string> = {
  done: "done",
  active: "current step",
  failed: "failed",
  skipped: "skipped",
  pending: "not started",
  soon: "coming soon",
};

/** Ordered steps with glyph + word per status (ux-spec §6.4); used for the onboarding rail and, later, frame steps. */
export function Timeline({
  steps,
  orientation = "vertical",
  label,
}: {
  steps: TimelineStep[];
  orientation?: "vertical" | "horizontal";
  label: string;
}) {
  return (
    <ol
      aria-label={label}
      className={cx(
        orientation === "horizontal" ? "flex flex-wrap items-center gap-x-1 gap-y-2" : "flex flex-col gap-3",
      )}
    >
      {steps.map((s, i) => (
        <li
          key={s.label}
          aria-current={s.status === "active" ? "step" : undefined}
          className={cx(
            "flex items-center gap-2",
            orientation === "horizontal" &&
              i > 0 &&
              "before:mr-1 before:h-px before:w-4 before:bg-line before:content-['']",
          )}
        >
          <span
            className={cx(
              "grid size-6 shrink-0 place-items-center rounded-full text-[12px] font-semibold",
              s.status === "done" && "bg-safe text-on-safe",
              s.status === "active" && "bg-brand text-on-brand",
              s.status === "failed" && "bg-danger text-on-danger",
              (s.status === "pending" || s.status === "skipped" || s.status === "soon") &&
                "border border-line bg-bg text-muted",
            )}
            aria-hidden="true"
          >
            {s.status === "done" ? <CheckIcon size={14} /> : s.status === "failed" ? <CloseIcon size={14} /> : i + 1}
          </span>
          <span className={cx("t-small", s.status === "active" ? "t-strong text-fg" : "text-muted")}>
            {s.label}
            <span className="sr-only">, {word[s.status]}</span>
            {s.hint && <span className="ml-1 text-muted">({s.hint})</span>}
          </span>
        </li>
      ))}
    </ol>
  );
}
