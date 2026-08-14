import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.js";
import { Spinner } from "./spinner.js";

/**
 * The kit's button. Four variants only — `primary` (the one accent action
 * per view), `ghost` (bordered neutral), `danger` (destructive), `subtle`
 * (quiet, borderless) — and two sizes.
 *
 * `loading` follows the shell's PendingButton rule: the idle and pending
 * labels are BOTH rendered, stacked in one grid cell, so the button always
 * reserves the width of the widest label and never changes size when it
 * enters the pending state. Pending also disables the button and shows a
 * spinner.
 */
export function Button({
  variant = "ghost",
  size = "md",
  loading = false,
  loadingLabel,
  className,
  disabled,
  children,
  type,
  ...rest
}: {
  variant?: "primary" | "ghost" | "danger" | "subtle";
  size?: "sm" | "md";
  /** Pending state: spinner + disabled, width unchanged. */
  loading?: boolean;
  /** Label shown while pending; defaults to the idle label. */
  loadingLabel?: ReactNode;
  children?: ReactNode;
} & Omit<ComponentProps<"button">, "children">) {
  return (
    <button
      {...rest}
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx(
        "cat-btn",
        `cat-btn--${variant}`,
        `cat-btn--${size}`,
        className,
      )}
    >
      <span className="cat-btn-stack">
        <span data-hidden={loading ? "true" : undefined}>{children}</span>
        <span data-hidden={loading ? undefined : "true"} aria-hidden={!loading}>
          <Spinner size={size === "sm" ? 11 : 12} />
          {loadingLabel ?? children}
        </span>
      </span>
    </button>
  );
}
