import type { ReactNode } from "react";

/**
 * Hover popover that teaches a button's keyboard shortcut. Wrap any control
 * whose action also has a shortcut — the hint appears after a hover delay
 * (CSS transition-delay, so no timers) and never intercepts the pointer.
 * Use this instead of the native `title` attribute for shortcut-bearing
 * buttons so all shortcut hints look and behave the same.
 */
export function ShortcutHint({
  label,
  shortcut,
  side = "bottom",
  children,
}: {
  /** Short action name, e.g. "Toggle sidebar". */
  label: string;
  /** Display form of the shortcut, e.g. "⌘B". */
  shortcut: string;
  side?: "bottom" | "top";
  children: ReactNode;
}) {
  return (
    <span className="group/hint relative inline-flex">
      {children}
      <span
        role="tooltip"
        className={`pointer-events-none absolute left-1/2 z-50 flex -translate-x-1/2 items-center gap-1.5 whitespace-nowrap rounded-md border border-border-strong bg-bg-overlay px-2 py-1 text-[11px] text-fg opacity-0 shadow-lg transition-opacity duration-150 delay-0 group-hover/hint:opacity-100 group-hover/hint:delay-500 ${
          side === "bottom" ? "top-full mt-1.5" : "bottom-full mb-1.5"
        }`}
      >
        {label}
        <kbd className="rounded border border-border-strong bg-bg-inset px-1 py-px font-sans text-[10px] text-fg-muted">
          {shortcut}
        </kbd>
      </span>
    </span>
  );
}
