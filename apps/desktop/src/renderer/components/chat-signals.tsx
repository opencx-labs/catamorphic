import {
  Bot,
  Hourglass,
  LoaderCircle,
  type LucideIcon,
  Pencil,
  SquareTerminal,
} from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { ChatWaiting } from "../../shared/chat.js";
import type { SidebarActivity } from "../../shared/sidebar.js";

export type { ChatWaiting };

/**
 * The shared indicator vocabulary for chat surfaces. Every place that
 * represents a chat as an icon — bottom-strip bubbles, workspace tabs,
 * sidebar rows, chips, the collapsed aggregate bubble — renders the same
 * signals the same way, on two corners of the icon, so a chat can say what
 * it is doing and what needs the person at once.
 *
 * The lower corner says what it is doing (`activity`, decided by the chat):
 * - working:       a small spinner (the agent is busy); the icon stays,
 *                  so the surface keeps its identity
 * - waiting:       what it waits on, whether its turn does nothing but wait
 *                  or it rests with something left running: an hourglass for a
 *                  watch, a bot for subagents, a terminal for a background
 *                  command
 *
 * The upper corner says what needs the person:
 * - awaitingInput: pulsing accent "?" badge (the agent asked and is waiting)
 * - attention:     pulsing accent dot (a workflow asked the user to open it)
 * - unread:        filled accent dot (a reply landed while the surface was
 *                  hidden)
 * - draft:         pencil badge (unsent composer text — also used for
 *                  editor tabs with unsaved changes)
 *
 * One mark shows per corner, most-urgent first: awaitingInput > attention >
 * unread > draft above; below, a blocking question stops the spinner.
 * `SignalGlyph` renders the icon with its lower corner;
 * `SignalBadge` renders the upper corner's badge — hosts position it
 * (bubbles pin it to the button corner, tabs to the icon).
 */
export interface ChatSignals {
  /** A turn runs: its end is the agent finishing. */
  working?: boolean;
  unread?: boolean;
  draft?: boolean;
  awaitingInput?: boolean;
  attention?: boolean;
  /** The lower corner's mark. */
  activity?: SidebarActivity | null;
}

/** What a chat waits on, most telling first. */
const WAITING_ORDER: readonly ChatWaiting[] = ["watch", "subagent", "command"];

const WAITING_ICONS: Record<ChatWaiting, LucideIcon> = {
  watch: Hourglass,
  subagent: Bot,
  command: SquareTerminal,
};

/** The most telling of what several chats, or one chat's tasks, wait on. */
export const firstWaiting = (
  list: readonly (ChatWaiting | null | undefined)[],
): ChatWaiting | null =>
  WAITING_ORDER.find((kind) => list.includes(kind)) ?? null;

/**
 * The mark on a chat's lower corner: while a turn runs, working, unless a
 * question holds it or all it does is wait (`waitingNow`); while it rests,
 * what it left running.
 */
export const chatActivity = ({
  working,
  awaitingInput,
  waitingNow,
  leftRunning,
}: {
  working: boolean;
  awaitingInput: boolean;
  waitingNow: ChatWaiting | null;
  leftRunning: ChatWaiting | null;
}): SidebarActivity | null =>
  working ? (awaitingInput ? null : (waitingNow ?? "working")) : leftRunning;

/** What the lower corner says, in words (screen readers, hover cards). */
export const ACTIVITY_LABELS: Record<SidebarActivity, string> = {
  working: "Working",
  watch: "Watching",
  subagent: "Waiting on subagents",
  command: "Running a command",
};

/** Several chats as one icon: any at work spins, else the most telling wait. */
export const combineSignals = (list: ChatSignals[]): ChatSignals => ({
  working: list.some((signals) => signals.working),
  unread: list.some((signals) => signals.unread),
  draft: list.some((signals) => signals.draft),
  awaitingInput: list.some((signals) => signals.awaitingInput),
  attention: list.some((signals) => signals.attention),
  activity: list.some((signals) => signals.activity === "working")
    ? "working"
    : firstWaiting(
        list.map((signals) =>
          signals.activity === "working" ? null : signals.activity,
        ),
      ),
});

/**
 * Marks are drawn from the first time one shows, and stay from then on so
 * each arrival and departure animates. Until then they are not in the
 * document: most icons (a page's tab, a file's) never show one, and a
 * strip of a hundred tabs held some thirty hidden elements for each. One
 * that first shows after the icon was drawn starts from the hidden pose
 * (`starting:`), as the hidden element it replaces did; one drawn showing
 * appears as it is.
 */
function useMarks(showing: boolean): { drawn: boolean; arrives: string } {
  const drawn = useRef<"with-icon" | "later" | null>(
    showing ? "with-icon" : null,
  );
  if (showing && !drawn.current) drawn.current = "later";
  // The starting pose is for the frame the marks are added in. Kept on, it
  // would replay each time something hidden around the icon (a sidebar's
  // panel) is shown again.
  const [arrived, setArrived] = useState(false);
  const arriving = drawn.current === "later" && !arrived;
  useEffect(() => {
    if (!arriving) return;
    const frame = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(frame);
  }, [arriving]);
  return {
    drawn: drawn.current !== null,
    arrives: arriving ? "starting:scale-0 starting:opacity-0" : "",
  };
}

/**
 * Base icon with what the chat is doing on its lower-right corner: the
 * working spinner, or the glyph of what it waits on. The icon stays, so a
 * busy chat, tab or chip still shows which one it is; the mark cuts its
 * own gap out of the icon so it reads on any background. The upper corner
 * is `SignalBadge`'s.
 */
export function SignalGlyph({
  activity = null,
  className = "size-4",
  children,
}: {
  /** The lower corner's mark, if any. */
  activity?: SidebarActivity | null;
  /** Size of the icon box. */
  className?: string;
  /** The base icon (lucide icon, favicon img, …), sized to fill the box. */
  children: ReactNode;
}) {
  const mark = activity;
  const busy = mark === "working";
  const marks = useMarks(mark !== null);
  const visibility = (kind: SidebarActivity) =>
    mark === kind
      ? `scale-100 opacity-100 ${marks.arrives}`
      : "scale-0 opacity-0";
  const transition =
    "col-start-1 row-start-1 transition-[opacity,scale] duration-200 ease-standard";
  return (
    <span className={`relative grid shrink-0 place-items-center ${className}`}>
      <span
        className="signal-cutout grid size-full place-items-center"
        data-cut={mark ? true : undefined}
      >
        {children}
      </span>
      {marks.drawn && (
        <span
          className="absolute -bottom-1 -right-1 grid size-3 place-items-center"
          data-activity={mark ?? undefined}
          aria-hidden="true"
        >
          <LoaderCircle
            strokeWidth={3}
            className={`${transition} ${visibility("working")} size-2 text-accent ${busy ? "animate-spin" : ""}`}
          />
          {WAITING_ORDER.map((kind) => {
            const Icon = WAITING_ICONS[kind];
            return (
              <Icon
                key={kind}
                strokeWidth={2.5}
                className={`${transition} ${visibility(kind)} size-2.5 text-fg-muted`}
              />
            );
          })}
        </span>
      )}
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
 * so arrivals and departures animate, shown whether or not the agent works.
 * Host wraps it in an absolutely positioned span at the corner it wants.
 */
export function SignalBadge({
  signals,
  size = "md",
}: {
  signals: ChatSignals;
  size?: keyof typeof BADGE_SIZES;
}) {
  const spec = BADGE_SIZES[size];
  const active = signals.awaitingInput
    ? "question"
    : signals.attention
      ? "attention"
      : signals.unread
        ? "unread"
        : signals.draft
          ? "draft"
          : null;
  const marks = useMarks(active !== null);
  const visibility = (kind: string) =>
    active === kind
      ? `scale-100 opacity-100 ${marks.arrives}`
      : "scale-0 opacity-0";
  const transition =
    "col-start-1 row-start-1 transition-[opacity,scale] duration-200 ease-standard";
  if (!marks.drawn) return null;
  return (
    <span className="grid place-items-center">
      {/* Agent question waiting: the most urgent signal — it pulses
          (sanctioned loop: the turn is suspended, indeterminate until the
          user answers). */}
      <span
        className={`${transition} ${visibility("question")} ${spec.badge} ${active === "question" ? "animate-pulse" : ""} grid place-items-center rounded-full bg-accent font-bold leading-none text-accent-fg`}
        aria-hidden={active !== "question"}
      >
        ?
      </span>
      <span
        className={`${transition} ${visibility("attention")} ${spec.dot} ${active === "attention" ? "animate-pulse" : ""} rounded-full bg-accent`}
        aria-hidden={active !== "attention"}
      />
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
