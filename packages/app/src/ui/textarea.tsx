import type { ComponentProps } from "react";
import { cx } from "./cx.js";
import { useFieldContext } from "./field.js";

/**
 * Multi-line text input (vertical resize only). Inherits {@link Field}
 * wiring like {@link Input}; `invalid` forces the danger ring.
 */
export function Textarea({
  invalid,
  className,
  id,
  ...rest
}: {
  /** Marks the control invalid (`aria-invalid` + danger ring). */
  invalid?: boolean;
} & ComponentProps<"textarea">) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <textarea
      {...rest}
      id={id ?? field?.controlId}
      aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
      aria-invalid={isInvalid || undefined}
      className={cx("cat-textarea", className)}
    />
  );
}
