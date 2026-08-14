import type { ReactNode } from "react";
import { Button } from "./button.js";
import { cx } from "./cx.js";

/**
 * Human copy for the small closed set of error codes apps commonly meet.
 * Exported so apps can extend it: spread it into your own map and add
 * project-specific codes.
 */
export const ERROR_STATE_COPY: Record<string, string> = {
  not_found: "Nothing to show here yet.",
  forbidden: "You don't have access to this.",
  timeout: "That took too long — try again.",
};

/** The fallback line when a code has no mapping (or none is given). */
export const ERROR_STATE_DEFAULT_COPY = "Couldn't load — please try again.";

/**
 * The quiet error state — same shape as {@link EmptyState}: one muted
 * sentence and at most one action. `code` maps through
 * {@link ERROR_STATE_COPY} (pass `copy` to extend the mapping); `message`
 * overrides both; `onRetry` renders a ghost "Try again" button.
 */
export function ErrorState({
  code,
  message,
  copy = ERROR_STATE_COPY,
  onRetry,
  action,
  className,
}: {
  /** Machine error code, e.g. "not_found"; unmapped codes use the default copy. */
  code?: string;
  /** Explicit message; wins over `code`. */
  message?: ReactNode;
  /** Code → copy mapping; defaults to {@link ERROR_STATE_COPY}. */
  copy?: Record<string, string>;
  /** Renders a "Try again" button wired to this callback. */
  onRetry?: () => void;
  /** Extra action slot (rendered after the retry button). */
  action?: ReactNode;
  className?: string;
}) {
  const text =
    message ?? (code ? copy[code] : undefined) ?? ERROR_STATE_DEFAULT_COPY;
  return (
    <div className={cx("cat-empty", className)} role="alert">
      <p className="cat-empty-message">{text}</p>
      {onRetry ? (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
      {action}
    </div>
  );
}
