import { useState } from "react";
import type { WalletState } from "../../shared/types";
import type { AccountStatus } from "../../shared/views";
import { Button, CheckIcon } from "../../ui";
import { cx } from "../../ui/cx";
import { call } from "../lib/api";

/**
 * "Secure your wallet" (onboarding v2): what onboarding no longer asks up front, as a checklist on Home with one
 * plain reason per item and progress. Stays until every item is done (optional ones can be skipped).
 */
export interface ChecklistItem {
  id: "backup" | "recovery" | "guardian" | "limit";
  title: string;
  why: string;
  optional?: boolean;
  done: boolean;
  action: { label: string; hash: string; mark?: "limitReviewedAt" };
  skip?: "guardianSkippedAt" | "limitReviewedAt";
}

export function checklistItems(state: WalletState, status: AccountStatus | undefined): ChecklistItem[] {
  const s = state.setup;
  return [
    {
      id: "backup",
      title: "Back up your everyday words",
      why: "≈1 min. Restores this browser's spending on a new computer.",
      done: Boolean(s.backupConfirmedAt),
      action: { label: "Show words", hash: "#backup" },
    },
    {
      id: "recovery",
      title: "Add a Recovery key",
      why: "≈2 min, on a second device. If your phone is lost, it replaces your Vault.",
      done: Boolean(status?.recoverySigner) || (Boolean(s.recovery?.testedAt) && !status?.deployed),
      action: { label: "Add", hash: "#recovery" },
    },
    {
      id: "guardian",
      title: "Add a Guardian",
      why: "Someone you trust who can pause spending if something looks wrong.",
      optional: true,
      done: Boolean(s.guardian || s.guardianSkippedAt),
      action: { label: "Add", hash: "#security" },
      skip: "guardianSkippedAt",
    },
    {
      id: "limit",
      title: "Adjust your daily limit",
      why: `It's ${`$${s.dailyLimitUsd.toLocaleString("en-US")}`} a day now. Lower is safer, higher asks your phone less.`,
      optional: true,
      done: Boolean(s.limitReviewedAt),
      action: { label: "Review", hash: "#limits", mark: "limitReviewedAt" },
      skip: "limitReviewedAt",
    },
  ];
}

export function SecureChecklist({
  state,
  status,
  open,
}: {
  state: WalletState;
  status: AccountStatus | undefined;
  open: (hash: string) => void;
}) {
  const items = checklistItems(state, status);
  const done = items.filter((i) => i.done).length;
  const [busy, setBusy] = useState<string | null>(null);
  const [all, setAll] = useState(false);
  if (done === items.length)
    return (
      <p className="t-small inline-flex items-center gap-2 text-safe" data-testid="fully-secured">
        <CheckIcon size={16} /> Fully secured ✓
      </p>
    );
  const pct = Math.round((done / items.length) * 100);
  return (
    <section
      aria-labelledby="secure-h"
      className="flex flex-col gap-3 rounded-md border border-line p-3"
      data-testid="secure-checklist"
      data-done={done}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 id="secure-h" className="t-strong">
          Secure your wallet
        </h2>
        <span className="t-small text-muted">
          {done} of {items.length} done
        </span>
      </div>
      <div
        role="progressbar"
        aria-label="Secure your wallet"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        className="h-1.5 overflow-hidden rounded-full bg-surface-2"
      >
        <div className="h-full bg-safe transition-all" style={{ width: `${pct}%` }} />
      </div>
      <ul className="flex flex-col gap-2">
        {(all ? items : items.filter((i) => !i.done).slice(0, 1)).map((i) => (
          <li key={i.id} className="flex items-start gap-2" data-testid={`check-${i.id}`} data-done={i.done}>
            <span
              aria-hidden="true"
              className={cx(
                "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
                i.done ? "border-safe bg-safe text-white" : "border-line",
              )}
            >
              {i.done && <CheckIcon size={12} />}
            </span>
            <div className="min-w-0 flex-1">
              <p className={cx("t-strong", i.done && "text-muted line-through")}>
                {i.title}
                {i.optional && <span className="t-small ml-1 font-normal text-muted">(optional)</span>}
                <span className="sr-only">{i.done ? ", done" : ", to do"}</span>
              </p>
              {!i.done && <p className="t-small text-muted">{i.why}</p>}
            </div>
            {!i.done && (
              <div className="flex shrink-0 gap-1">
                {i.skip && (
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busy === i.id}
                    onClick={async () => {
                      setBusy(i.id);
                      try {
                        await call("setup:update", { [i.skip!]: Date.now() });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {i.id === "limit" ? "Keep" : "Skip"}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    if (i.action.mark) void call("setup:update", { [i.action.mark]: Date.now() });
                    open(i.action.hash);
                  }}
                >
                  {i.action.label}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
      <button
        type="button"
        className="t-small self-start text-muted underline underline-offset-2"
        aria-expanded={all}
        onClick={() => setAll((a) => !a)}
        data-testid="checklist-toggle"
      >
        {all ? "Show only the next step" : `Show all ${items.length}`}
      </button>
    </section>
  );
}
