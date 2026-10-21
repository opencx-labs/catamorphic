import {
  Bot,
  Eye,
  LoaderCircle,
  type LucideIcon,
  Pencil,
  SquareTerminal,
} from "lucide-react";
import type { ReactNode } from "react";
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
 * The lower corner says what it is doing:
 * - working:       a small spinner (the agent is busy); the icon stays,
 *                  so the surface keeps its identity
 * - waiting:       while not working, what it left running and waits on:
 *                  an eye for a watch, a bot for subagents, a terminal for
 *                  a background command
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
 * unread > draft above, working > waiting below; a blocking question
 * stops the spinner. `SignalGlyph` renders the icon with its lower corner;
 * `SignalBadge` renders the upper corner's badge — hosts position it
 * (bubbles pin it to the button corner, tabs to the icon).
 */
export interface ChatSignals {
  working?: boolean;
  unread?: boolean;
  draft?: boolean;
  awaitingInput?: boolean;
  attention?: boolean;
  waiting?: ChatWaiting | null;
}

/** What a chat waits on, most telling first. */
const WAITING_ORDER: readonly ChatWaiting[] = ["watch", "subagent", "command"];

const WAITING_ICONS: Record<ChatWaiting, LucideIcon> = {
  watch: Eye,
  subagent: Bot,
  command: SquareTerminal,
};

/** The most telling of what several chats, or one chat's tasks, wait on. */
export const firstWaiting = (
  list: readonly (ChatWaiting | null | undefined)[],
): ChatWaiting | null =>
  WAITING_ORDER.find((kind) => list.includes(kind)) ?? null;

/**
 * The mark on the icon's lower corner: working, unless a question holds
 * the turn; while not working, what it waits on.
 */
export const activityOf = ({
  working = false,
  awaitingInput = false,
  waiting = null,
}: Pick<
  ChatSignals,
  "working" | "awaitingInput" | "waiting"
>): SidebarActivity | null =>
  working ? (awaitingInput ? null : "working") : (waiting ?? null);

/** What the lower corner says, in words (screen readers, hover cards). */
export const ACTIVITY_LABELS: Record<SidebarActivity, string> = {
  working: "Working",
  watch: "Watching",
  subagent: "Waiting on subagents",
  command: "Running a command",
};

export const combineSignals = (list: ChatSignals[]): ChatSignals => ({
  working: list.some((signals) => signals.working),
  unread: list.some((signals) => signals.unread),
  draft: list.some((signals) => signals.draft),
  awaitingInput: list.some((signals) => signals.awaitingInput),
  attention: list.some((signals) => signals.attention),
  waiting: firstWaiting(list.map((signals) => signals.waiting)),
});

/**
 * Base icon with what the chat is doing on its lower-right corner: the
 * working spinner, or the glyph of what it waits on. The icon stays, so a
 * busy chat, tab or chip still shows which one it is; the mark cuts its
 * own gap out of the icon so it reads on any background. The upper corner
 * is `SignalBadge`'s.
 */
export function SignalGlyph({
  working = false,
  awaitingInput = false,
  waiting = null,
  className = "size-4",
  children,
}: {
  working?: boolean;
  awaitingInput?: boolean;
  /** What it waits on while not working. */
  waiting?: ChatWaiting | null;
  /** Size of the icon box. */
  className?: string;
  /** The base icon (lucide icon, favicon img, …), sized to fill the box. */
  children: ReactNode;
}) {
  const mark = activityOf({ working, awaitingInput, waiting });
  const busy = mark === "working";
  const visibility = (kind: SidebarActivity) =>
    mark === kind ? "scale-100 opacity-100" : "scale-0 opacity-0";
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
  const visibility = (kind: string) =>
    active === kind ? "scale-100 opacity-100" : "scale-0 opacity-0";
  const transition =
    "col-start-1 row-start-1 transition-[opacity,scale] duration-200 ease-standard";
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
