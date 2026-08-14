import type { ReactNode } from "react";
import { createContext, useContext, useId, useMemo } from "react";
import { cx } from "./cx.js";

export interface FieldContextValue {
  /** id the labeled control should take (label's htmlFor points here). */
  controlId: string;
  /** id list for aria-describedby (hint or error line). */
  describedBy?: string;
  /** True while the field shows an error; controls inherit aria-invalid. */
  invalid: boolean;
}

const FieldContext = createContext<FieldContextValue | null>(null);

/** Read the enclosing Field's wiring; null outside a Field. */
export function useFieldContext(): FieldContextValue | null {
  return useContext(FieldContext);
}

/**
 * Label + control + hint/error line, with the accessibility wiring done:
 * a generated id links `<label htmlFor>` to the control, and the hint or
 * error line is announced through `aria-describedby`. Kit controls (Input,
 * Textarea, Select, Checkbox, Switch, DatePicker) pick the wiring up from
 * context automatically; any other element can call `useFieldContext()`.
 *
 * `error` replaces the hint and renders in the danger color; while present,
 * kit controls inside also become `aria-invalid`.
 */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  /** Quiet guidance under the control; hidden while `error` is set. */
  hint?: ReactNode;
  /** Validation message; danger-colored, replaces the hint. */
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const controlId = useId();
  const descriptionId = useId();
  const hasDescription = Boolean(error ?? hint);
  const value = useMemo<FieldContextValue>(
    () => ({
      controlId,
      describedBy: hasDescription ? descriptionId : undefined,
      invalid: Boolean(error),
    }),
    [controlId, descriptionId, hasDescription, error],
  );
  return (
    <div className={cx("cat-field", className)}>
      <label className="cat-field-label" htmlFor={controlId}>
        {label}
      </label>
      <FieldContext.Provider value={value}>{children}</FieldContext.Provider>
      {error ? (
        <p className="cat-field-error" id={descriptionId}>
          {error}
        </p>
      ) : hint ? (
        <p className="cat-field-hint" id={descriptionId}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
