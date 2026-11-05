import { useState } from "react";

/** Mono chip; click copies (ux-spec §6.4). */
export function ReasonCode({ id, explanation }: { id: string; explanation?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      title={explanation ?? "Copy reason code"}
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1200);
        });
      }}
      className="t-mono rounded-sm bg-surface-2 px-1.5 py-0.5 text-fg"
    >
      {id}
      <span className="sr-only" aria-live="polite">
        {copied ? " copied" : ""}
      </span>
    </button>
  );
}
