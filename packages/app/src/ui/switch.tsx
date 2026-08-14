import type { ComponentProps } from "react";
import { cx } from "./cx.js";
import { useFieldContext } from "./field.js";

/**
 * On/off toggle: a real `button[role="switch"]` with `aria-checked`, thumb
 * sliding at 150ms on the standard easing. Controlled only — pass `checked`
 * and `onCheckedChange`. Inherits {@link Field} wiring.
 */
export function Switch({
  checked,
  onCheckedChange,
  className,
  id,
  disabled,
  ...rest
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
} & Omit<ComponentProps<"button">, "onChange" | "role" | "type">) {
  const field = useFieldContext();
  return (
    <button
      {...rest}
      type="button"
      role="switch"
      aria-checked={checked}
      id={id ?? field?.controlId}
      aria-describedby={rest["aria-describedby"] ?? field?.describedBy}
      disabled={disabled}
      onClick={(event) => {
        rest.onClick?.(event);
        if (!event.defaultPrevented) onCheckedChange(!checked);
      }}
      className={cx("cat-switch", className)}
    />
  );
}
