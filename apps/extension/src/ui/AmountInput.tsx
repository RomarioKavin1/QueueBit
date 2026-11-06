import { useId } from "react";
import { cx } from "./cx";
import { inputClass } from "./Field";
import { formatUsd } from "./format";

export interface AmountInputProps {
  label?: string;
  asset: { symbol: string };
  /** Spendable balance in whole units, as a decimal string. */
  balance?: string;
  /** USD per unit, if known. */
  fiatRate?: number;
  perTxMaxUsd?: number;
  value: string;
  onChange: (value: string) => void;
}

const DECIMAL = /^\d*(?:\.\d*)?$/u;

/**
 * Amount entry (ux-spec §3.3.1, §6.4): `inputmode="decimal"`, live fiat line in aria-describedby, MAX, inline
 * validation. Going over the per-payment limit is a hint (the owner key signs it), not an error.
 */
export function AmountInput({
  label = "Amount",
  asset,
  balance,
  fiatRate,
  perTxMaxUsd,
  value,
  onChange,
}: AmountInputProps) {
  const id = useId();
  const n = Number(value);
  const hasValue = value !== "" && Number.isFinite(n);
  const usd = hasValue && fiatRate !== undefined ? n * fiatRate : undefined;
  const insufficient = hasValue && balance !== undefined && n > Number(balance);
  const overPerPayment = usd !== undefined && perTxMaxUsd !== undefined && usd > perTxMaxUsd;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="t-strong">
        {label}
      </label>
      <div className="relative flex items-center">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          placeholder="0.00"
          value={value}
          aria-invalid={insufficient || undefined}
          aria-describedby={`${id}-fiat`}
          onChange={(e) => {
            const v = e.target.value.replace(",", ".");
            if (DECIMAL.test(v)) onChange(v);
          }}
          className={cx(inputClass, "tabular pr-24")}
        />
        <span className="t-small pointer-events-none absolute right-14 text-muted">{asset.symbol}</span>
        {balance !== undefined && (
          <button
            type="button"
            className="t-strong absolute right-1 min-h-9 rounded-sm px-2 text-brand hover:bg-surface-2"
            onClick={() => onChange(balance)}
            aria-label={`Use maximum, ${balance} ${asset.symbol}`}
          >
            MAX
          </button>
        )}
      </div>
      <p id={`${id}-fiat`} className="t-small text-muted" aria-live="polite">
        {usd !== undefined
          ? `≈ ${formatUsd(Math.round(usd * 100) / 100)}`
          : balance !== undefined
            ? `Balance ${balance} ${asset.symbol}`
            : ""}
      </p>
      {insufficient && (
        <p className="t-small text-danger" role="alert">
          Not enough {asset.symbol}. You have {balance}.
        </p>
      )}
      {!insufficient && overPerPayment && (
        <p className="t-small text-owner">
          Above your {formatUsd(perTxMaxUsd)} per-payment limit: your owner key signs it.
        </p>
      )}
    </div>
  );
}
