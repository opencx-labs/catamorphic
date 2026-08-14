import type { ReactNode } from "react";
import { cx } from "./cx.js";

/**
 * One label/value line done right for narrow columns: the label never
 * shrinks, the value truncates with an ellipsis and right-aligns. No
 * `flex-1`, no fixed grid columns — the value takes exactly the space the
 * label leaves.
 */
export function KeyValueRow({
  label,
  children,
  className,
  title,
}: {
  label: ReactNode;
  /** The value; truncates when the row runs out of room. */
  children?: ReactNode;
  className?: string;
  /** Full-text hover title for truncated values. */
  title?: string;
}) {
  return (
    <div className={cx("cat-kv-row", className)}>
      <span className="cat-kv-label">{label}</span>
      <span className="cat-kv-value" title={title}>
        {children}
      </span>
    </div>
  );
}

/** Stack of {@link KeyValueRow}s with hairline separators between rows. */
export function KeyValueList({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("cat-kv-list", className)}>{children}</div>;
}
