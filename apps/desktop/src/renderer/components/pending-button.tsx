import type { ButtonHTMLAttributes, ReactNode } from "react";

/**
 * Button whose size never changes when it enters a pending state: the idle
 * and pending labels are both rendered (stacked in one grid cell) so the
 * button always reserves the width of the widest one, and swapping merely
 * toggles visibility. App standard — see DESIGN.md "Buttons".
 */
export function PendingButton({
  pending,
  pendingLabel,
  children,
  className,
  disabled,
  ...rest
}: {
  pending: boolean;
  pendingLabel: ReactNode;
  children: ReactNode;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button {...rest} disabled={disabled || pending} className={className}>
      <span className="grid place-items-center">
        <span
          className={`col-start-1 row-start-1 ${pending ? "invisible" : ""}`}
        >
          {children}
        </span>
        <span
          aria-hidden={!pending}
          className={`col-start-1 row-start-1 ${pending ? "" : "invisible"}`}
        >
          {pendingLabel}
        </span>
      </span>
    </button>
  );
}
