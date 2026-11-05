import { useState } from "react";
import { cx } from "./cx";
import { groupedAddress, shortAddress } from "./format";
import { CheckIcon, CopyIcon } from "./icons";

export interface AddressChipProps {
  address: string;
  name?: string;
  known?: boolean;
  badge?: "new" | "book" | "contract";
  /** e.g. "Native account" */
  chain?: string;
  copyable?: boolean;
  className?: string;
}

const badgeText = { new: "New recipient", book: "In address book", contract: "Contract" } as const;

/** 0x1234…abcd with the full address in the tooltip and the accessible name (ux-spec §6.4). */
export function AddressChip({ address, name, badge, chain, copyable = true, className }: AddressChipProps) {
  const [copied, setCopied] = useState(false);
  return (
    <span
      className={cx("inline-flex max-w-full items-center gap-1.5 rounded-sm bg-surface-2 py-0.5 pr-1 pl-2", className)}
    >
      {name && <span className="t-strong truncate">{name}</span>}
      <span className="t-mono" title={address} aria-label={`Address ${groupedAddress(address)}`}>
        {shortAddress(address)}
      </span>
      {badge && <span className="t-small rounded-sm bg-bg px-1 text-muted">{badgeText[badge]}</span>}
      {chain && <span className="t-small text-muted">{chain}</span>}
      {copyable && (
        <button
          type="button"
          className="grid size-7 place-items-center rounded-sm text-muted hover:bg-bg hover:text-fg"
          aria-label={copied ? "Address copied" : "Copy address"}
          onClick={() => {
            void navigator.clipboard?.writeText(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Copied" : ""}
      </span>
    </span>
  );
}
