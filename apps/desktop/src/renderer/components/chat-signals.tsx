import { LoaderCircle, Pencil } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The shared indicator vocabulary for chat surfaces. Every place that
 * represents a chat as an icon — bottom-strip bubbles, workspace tabs, the
 * collapsed aggregate bubble — renders the same signals the same way:
 *
 * - working:       the icon cross-fades to a spinner (the agent is busy)
 * - awaitingInput: pulsing accent "?" badge (the agent asked and is waiting)
 * - unread:        filled accent dot (a reply landed while the surface was
 *                  hidden)
 * - draft:         pencil badge (unsent composer text — also used for
 *                  editor tabs with unsaved changes)
 *
 * One badge shows at a time, most-urgent first: awaitingInput > unread >
 * draft; all badges yield to the spinner. `SignalGlyph` renders the
 * icon/spinner stack; `SignalBadge` renders the badge cluster — hosts
 * position it (bubbles pin it to the button corner, tabs to the icon).
 */
export interface ChatSignals {
  working?: boolean;
  unread?: boolean;
  draft?: boolean;
  awaitingInput?: boolean;
}

export const combineSignals = (list: ChatSignals[]): ChatSignals => ({
  working: list.some((signals) => signals.working),
  unread: list.some((signals) => signals.unread),
  draft: list.some((signals) => signals.draft),
  awaitingInput: list.some((signals) => signals.awaitingInput),
});

/** Base icon that cross-fades to a spinner while the agent works. */
export function SignalGlyph({
  working = false,
  className = "size-4",
  children,
}: {
  working?: boolean;
  /** Size of the icon box (the icon and spinner share it). */
  className?: string;
  /** The base icon (lucide icon, favicon img, …), sized to fill the box. */
  children: ReactNode;
}) {
  return (
    <span className={`relative grid shrink-0 place-items-center ${className}`}>
      <span
        className={`col-start-1 row-start-1 grid size-full place-items-center transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          working ? "scale-50 opacity-0" : "scale-100 opacity-100"
        }`}
      >
        {children}
      </span>
      <LoaderCircle
        className={`col-start-1 row-start-1 size-full animate-spin text-accent transition-[opacity] duration-200 ${
          working ? "opacity-100" : "opacity-0"
        }`}
      />
    </span>
  );
}

const BADGE_SIZES = {
  /** Workspace tabs (3.5 icon). */
  sm: { dot: "size-1.5", badge: "size-3 text-[8px]", pencil: "size-2" },
  /** Bottom-strip bubbles (36px buttons). */
  md: { dot: "size-2", badge: "size-3.5 text-[9px]", pencil: "size-2.5" },
} as const;

/**
 * The badge cluster: at most one badge visible, scale/opacity-transitioned
 * so arrivals and departures animate. Host wraps it in an absolutely
 * positioned span at the corner it wants.
 */
export function SignalBadge({
  signals,
  size = "md",
}: {
  signals: ChatSignals;
  size?: keyof typeof BADGE_SIZES;
}) {
  const spec = BADGE_SIZES[size];
  const active = signals.working
    ? null
    : signals.awaitingInput
      ? "question"
      : signals.unread
        ? "unread"
        : signals.draft
          ? "draft"
          : null;
  const visibility = (kind: string) =>
    active === kind ? "scale-100 opacity-100" : "scale-0 opacity-0";
  const transition =
    "col-start-1 row-start-1 transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";
  return (
    <span className="grid place-items-center">
      {/* Agent question waiting: the most urgent signal — it pulses
          (sanctioned loop: the turn is suspended, indeterminate until the
          user answers). */}
      <span
        className={`${transition} ${visibility("question")} ${spec.badge} grid animate-pulse place-items-center rounded-full bg-accent font-bold leading-none text-accent-fg`}
        aria-hidden={active !== "question"}
      >
        ?
      </span>
      <span
        className={`${transition} ${visibility("unread")} ${spec.dot} rounded-full bg-accent`}
        aria-hidden={active !== "unread"}
      />
      <span
        className={`${transition} ${visibility("draft")} ${spec.pencil} grid place-items-center rounded-full border border-border bg-bg-overlay`}
        aria-hidden={active !== "draft"}
      >
        <Pencil className="size-[60%] text-fg-muted" />
      </span>
    </span>
  );
}
