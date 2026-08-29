import { Loader2 } from "lucide-react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Button whose size never changes across its states: the idle label, the
 * pending content, and (optionally) the done label are all rendered,
 * stacked in one grid cell, so the button always reserves the width of the
 * widest one and switching merely toggles visibility. App standard — see
 * DESIGN.md "Buttons".
 *
 * Pending shows a spinner by default (the label's own footprint stays
 * reserved); pass `pendingLabel` when words help ("Cloning…"). `done` +
 * `doneLabel` cover the moment after — "Installed" — without the row
 * reflowing when the button stops being a button.
 */
export function PendingButton({
  pending,
  pendingLabel,
  done = false,
  doneLabel,
  children,
  className,
  disabled,
  ...rest
}: {
  pending: boolean;
  pendingLabel?: ReactNode;
  done?: boolean;
  doneLabel?: ReactNode;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const showIdle = !pending && !done;
  return (
    <button
      {...rest}
      disabled={disabled || pending || done}
      aria-busy={pending || undefined}
      className={className}
    >
      <span className="grid min-w-max shrink-0 place-items-center whitespace-nowrap">
        <span
          className={`col-start-1 row-start-1 whitespace-nowrap ${showIdle ? "" : "invisible"}`}
        >
          {children}
        </span>
        <span
          aria-hidden={!pending}
          className={`col-start-1 row-start-1 grid place-items-center whitespace-nowrap ${pending ? "" : "invisible"}`}
        >
          {pendingLabel ?? (
            <Loader2 className="size-3.5 animate-spin" aria-label="Working…" />
          )}
        </span>
        {doneLabel !== undefined && (
          <span
            aria-hidden={!done}
            className={`col-start-1 row-start-1 whitespace-nowrap ${done ? "" : "invisible"}`}
          >
            {doneLabel}
          </span>
        )}
      </span>
    </button>
  );
}
