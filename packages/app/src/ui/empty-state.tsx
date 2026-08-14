import type { ReactNode } from "react";
import { cx } from "./cx.js";

/**
 * The quiet empty state (shell doctrine): one muted sentence plus at most
 * one action. No illustrations, no exclamation marks — an empty list is a
 * normal state, not an event.
 */
export function EmptyState({
  message,
  action,
  className,
}: {
  /** One sentence, muted. */
  message: ReactNode;
  /** Optional single action (typically a ghost or primary Button). */
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("cat-empty", className)}>
      <p className="cat-empty-message">{message}</p>
      {action}
    </div>
  );
}
