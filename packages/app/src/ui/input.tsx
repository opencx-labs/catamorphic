import type { ComponentProps } from "react";
import { cx } from "./cx.js";
import { useFieldContext } from "./field.js";

/**
 * Single-line text input on the inset surface. Inside a {@link Field} it
 * inherits the label's id, `aria-describedby`, and `aria-invalid` wiring
 * automatically; `invalid` forces the danger ring anywhere.
 */
export function Input({
  invalid,
  className,
  id,
  ...rest
}: {
  /** Marks the control invalid (`aria-invalid` + danger ring). */
  invalid?: boolean;
} & ComponentProps<"input">) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <input
      {...rest}
      id={id ?? field?.controlId}
      aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cx("cat-input", className)}
    />
  );
}
