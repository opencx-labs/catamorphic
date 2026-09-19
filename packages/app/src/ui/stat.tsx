import type { ComponentProps, ReactNode } from "react";
import { cx } from "./cx.js";

/**
 * One number that matters: a small muted label over a large value, with an
 * optional detail line (a delta, a period, a unit). Compose a row of Stats
 * at the top of a dashboard; each one sits in its own Card-like surface so
 * the grid reads as tiles on the app background.
 */
export function Stat({
  label,
  value,
  detail,
  tone = "neutral",
  className,
  ...rest
}: {
  /** What the number counts (11px, muted). */
  label: ReactNode;
  /** The number itself, formatted by the caller. */
  value: ReactNode;
  /** Optional line under the value: a delta, a range, a unit. */
  detail?: ReactNode;
  /** Colors the detail line; the value itself stays in the text color. */
  tone?: "neutral" | "success" | "warning" | "danger" | "info";
} & Omit<ComponentProps<"div">, "children">) {
  return (
    <div {...rest} className={cx("cat-stat", className)}>
      <span className="cat-stat-label">{label}</span>
      <span className="cat-stat-value">{value}</span>
      {detail != null ? (
        <span className={cx("cat-stat-detail", `cat-stat-detail--${tone}`)}>
          {detail}
        </span>
      ) : null}
    </div>
  );
}
