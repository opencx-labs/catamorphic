import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.js";

/**
 * Small status label (11px). Low-chroma by design — a tinted background at
 * ~13% of the status color — so run states inform without screaming.
 */
export function Badge({
  variant = "neutral",
  className,
  children,
  ...rest
}: {
  variant?: "neutral" | "success" | "warning" | "danger" | "info";
  children?: ReactNode;
} & ComponentProps<"span">) {
  return (
    <span
      {...rest}
      className={cx("cat-badge", `cat-badge--${variant}`, className)}
    >
      {children}
    </span>
  );
}
