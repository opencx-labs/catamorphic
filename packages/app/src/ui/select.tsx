import type { ComponentProps } from "react";
import { cx } from "./cx.js";
import { useFieldContext } from "./field.js";

/**
 * Styled native `<select>` — full keyboard and screen-reader behavior for
 * free, dressed to match the kit (inset surface, custom chevron). Children
 * are regular `<option>`/`<optgroup>` elements. Inherits {@link Field}
 * wiring; `invalid` forces the danger ring.
 */
export function Select({
  invalid,
  className,
  id,
  children,
  ...rest
}: {
  /** Marks the control invalid (`aria-invalid` + danger ring). */
  invalid?: boolean;
} & ComponentProps<"select">) {
  const field = useFieldContext();
  const isInvalid = invalid ?? field?.invalid ?? false;
  return (
    <span className={cx("cat-select", className)}>
      <select
        {...rest}
        id={id ?? field?.controlId}
        aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
        aria-invalid={isInvalid || undefined}
      >
        {children}
      </select>
    </span>
  );
}
