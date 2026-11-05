import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode } from "react";
import { cx } from "./cx";
import { EyeIcon, EyeOffIcon } from "./icons";

export interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  label: ReactNode;
  description?: ReactNode;
  error?: ReactNode;
  trailing?: ReactNode;
  leading?: ReactNode;
}

export const inputClass =
  "w-full min-h-11 rounded-md border border-line bg-bg px-3 text-fg placeholder:text-muted " +
  "transition-[border-color,box-shadow] duration-[120ms] focus:border-brand focus-visible:outline-none " +
  "aria-[invalid=true]:border-danger";

/** Labelled input with description and error wired through aria-describedby (ux-spec §3.1.1 A11y). */
export const TextField = forwardRef<HTMLInputElement, FieldProps>(function TextField(
  { label, description, error, trailing, leading, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const descId = `${inputId}-desc`;
  const errId = `${inputId}-err`;
  const describedBy = [description && descId, error && errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={inputId} className="t-strong">
        {label}
      </label>
      <div className="relative flex items-center">
        {leading && <span className="pointer-events-none absolute left-3 text-muted">{leading}</span>}
        <input
          ref={ref}
          id={inputId}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          className={cx(inputClass, leading ? "pl-7" : "", trailing ? "pr-12" : "")}
          {...rest}
        />
        {trailing && <span className="absolute right-1">{trailing}</span>}
      </div>
      {description && (
        <p id={descId} className="t-small text-muted">
          {description}
        </p>
      )}
      {error && (
        <p id={errId} className="t-small text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});

export const PasswordField = forwardRef<HTMLInputElement, Omit<FieldProps, "type" | "trailing">>(
  function PasswordField(props, ref) {
    const [visible, setVisible] = useState(false);
    return (
      <TextField
        ref={ref}
        type={visible ? "text" : "password"}
        spellCheck={false}
        autoCapitalize="off"
        {...props}
        trailing={
          <button
            type="button"
            className="grid size-9 place-items-center rounded-sm text-muted hover:text-fg"
            aria-label={visible ? "Hide password" : "Show password"}
            aria-pressed={visible}
            onClick={() => setVisible((v) => !v)}
          >
            {visible ? <EyeOffIcon size={18} /> : <EyeIcon size={18} />}
          </button>
        }
      />
    );
  },
);

export interface SelectFieldProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label: ReactNode;
  description?: ReactNode;
  options: Array<{ value: string; label: string }>;
}

export function SelectField({ label, description, options, id, className, ...rest }: SelectFieldProps) {
  const autoId = useId();
  const selId = id ?? autoId;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={selId} className="t-strong">
        {label}
      </label>
      <select
        id={selId}
        aria-describedby={description ? `${selId}-desc` : undefined}
        className={cx(inputClass, "appearance-auto pr-2")}
        {...rest}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {description && (
        <p id={`${selId}-desc`} className="t-small text-muted">
          {description}
        </p>
      )}
    </div>
  );
}
