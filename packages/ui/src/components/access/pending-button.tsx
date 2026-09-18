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
  "data-disabled-reason": disabledReason,
  ...rest
}: {
  pending: boolean;
  pendingLabel?: ReactNode;
  done?: boolean;
  doneLabel?: ReactNode;
  children: ReactNode;
  "data-disabled-reason"?: string;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  const showIdle = !pending && !done;
  return (
    <button
      data-disabled-reason={
        pending
          ? "Wait for this action to finish"
          : done
            ? "This action is already complete"
            : disabledReason
      }
      {...rest}
      data-action-state={pending ? "pending" : done ? "done" : "idle"}
      disabled={disabled || pending || done}
      aria-busy={pending || undefined}
      className={className}
    >
      <span className="catamorphic-pending-stack grid min-w-max shrink-0 place-items-center whitespace-nowrap">
        <span
          aria-hidden={!showIdle}
          className={`catamorphic-pending-label col-start-1 row-start-1 whitespace-nowrap transition-opacity duration-150 motion-reduce:transition-none ${showIdle ? "opacity-100" : "opacity-0"}`}
        >
          {children}
        </span>
        <span
          aria-hidden={!pending}
          className={`catamorphic-pending-label col-start-1 row-start-1 grid place-items-center whitespace-nowrap transition-opacity duration-150 motion-reduce:transition-none ${pending ? "opacity-100" : "opacity-0"}`}
        >
          {pendingLabel ?? (
            <Loader2
              className={`catamorphic-pending-spinner size-3.5 ${pending ? "animate-spin motion-reduce:animate-none" : ""}`}
              aria-label="Working…"
            />
          )}
        </span>
        {doneLabel !== undefined && (
          <span
            aria-hidden={!done}
            className={`catamorphic-pending-label col-start-1 row-start-1 whitespace-nowrap transition-opacity duration-150 motion-reduce:transition-none ${done ? "opacity-100" : "opacity-0"}`}
          >
            {doneLabel}
          </span>
        )}
      </span>
    </button>
  );
}
