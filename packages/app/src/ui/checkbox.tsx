import type { ComponentProps } from "react";
import { cx } from "./cx.js";
import { useFieldContext } from "./field.js";

/**
 * Styled native checkbox — real `<input type="checkbox">` semantics with the
 * kit's look (accent fill when checked). Inherits {@link Field} wiring.
 */
export function Checkbox({
  className,
  id,
  ...rest
}: Omit<ComponentProps<"input">, "type">) {
  const field = useFieldContext();
  return (
    <input
      {...rest}
      type="checkbox"
      id={id ?? field?.controlId}
      aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
      className={cx("cat-checkbox", className)}
    />
  );
}
