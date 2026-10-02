"use client";

import {
  type AssistantMessageItem,
  answerRows,
  type ContextHandoffItem,
  type NoticeItem,
  type PendingAgentMessage,
  type QueuedMessage,
  type RuntimeRequest,
  type TimelineEntry,
  type TimelineTurn,
  type Turn,
  type UserMessageItem,
  type WorkItem,
} from "@catamorphic/react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  GitFork,
  KeyRound,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestionMark,
  MessageSquareText,
  Pencil,
  Radio,
  RotateCcw,
  SquareTerminal,
  Timer,
  Undo2,
  Wrench,
} from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { splitAttachmentMarkers } from "../../lib/composer-serialize";
import { formatElapsed, useNow } from "../../lib/elapsed";
import {
  DEFAULT_WORK_DISPLAY,
  type StepSource,
  type TurnRow,
  turnRows,
  type WorkDisplay,
} from "../../lib/turn-groups";
import { ActivityText } from "../activity-text";
import { ContextPill } from "../context-pill";
import { ShortcutHint } from "../shortcut-hint";
import { ChatQueue } from "./chat-queue.js";
import { SessionAttribution } from "./session-attribution.js";

export type { AgentQuestion, AgentQuestionOption } from "@catamorphic/react";

const REMARK_PLUGINS = [remarkGfm];

// Stable component identity keeps focused links and host preview state alive.
// Context updates callbacks without replacing the Markdown anchor component.
const LinkContext = createContext<
  Pick<ChatTimelineProps, "onLinkClick" | "renderLink">
>({});
function TimelineLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const { onLinkClick, renderLink } = useContext(LinkContext);
  if (href && onLinkClick && renderLink)
    return renderLink({ href, children, onOpen: onLinkClick });
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!onLinkClick || !href) return;
        event.preventDefault();
        onLinkClick(href, event);
      }}
    >
      {children}
    </a>
  );
}
const LINK_COMPONENTS = { a: TimelineLink };

export type ChatTextSourceView =
  | { type: "paste" }
  | {
      type: "selection";
      filePath: string;
      startLine?: number;
      endLine?: number;
    }
  | { type: "url"; url: string }
  | { type: "path"; path: string }
  | {
      type: "tab";
      key: string;
      kind: string;
      title: string;
      url?: string;
      filePath?: string;
    };

export type ChatAttachmentView =
  | {
      kind: "image" | "document";
      name: string;
      mediaType: string;
      dataBase64: string;
    }
  | {
      /** Text context: a paste, editor selection, URL, or file path. */
      kind: "text";
      name: string;
      text: string;
      source: ChatTextSourceView;
    };

/**
 * A background command's live state (ADR 0155): the host's view of the
 * process a `run_background_command` step started.
 */
export interface ChatBackgroundCommand {
  /** A background command, or a command watch (ADR 0156). */
  kind: "command" | "watch";
  command: string;
  description: string;
  status: "running" | "finished" | "stopped";
  exitCode: number | null;
}

type QueueAction<Args extends unknown[]> = (
  ...args: Args
) => undefined | boolean | Promise<undefined | boolean>;

type LinkModifiers = {
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

export interface ChatTimelineProps {
  focusMessageId?: string;
  /**
   * This chat's background commands, oldest first: their steps pulse while
   * they run and say how they ended.
   */
  backgroundCommands?: ChatBackgroundCommand[];
  /** The conversation as turns, oldest first (`useAgentChat().timeline`). */
  turns: TimelineTurn[];
  /** The session's runtime requests by id: request steps say how they ended. */
  requests?: Readonly<Record<string, RuntimeRequest>>;
  /** Messages this client sent that the session does not show yet. */
  pending?: PendingAgentMessage[];
  /** Live activity line ("Thinking...", tool progress) shown under the turns. */
  activity?: string;
  /** When the running turn started (ISO); the activity line counts from it. */
  activityStartedAt?: string | null;
  /**
   * When the running turn last reported progress (ISO). Hosts pass it only
   * while the agent is working, not while it waits on someone: a long
   * silence is then said on the activity line.
   */
  activityUpdatedAt?: string | null;
  /** Turns waiting to run, editable until they start. */
  queue?: QueuedMessage[];
  onEditQueued?: QueueAction<[turnId: string, text: string]>;
  onCancelQueued?: QueueAction<[turnId: string]>;
  /** Run a queued turn now: it goes next and stops the active one. */
  onSendQueuedNow?: QueueAction<[turnId: string]>;
  /** A queued message entered/left inline editing (null = none). */
  onHoldQueued?: QueueAction<[turnId: string | null]>;
  /** The turn the agent works on now; its work reads as live. */
  activeTurnId?: string | null;
  /** How a turn's work (notes and steps) reads; see lib/turn-groups. */
  workDisplay?: WorkDisplay;
  /** Run a failed or interrupted turn again. */
  onRetry?: (turnId: string) => void;
  /** Stop a turn that waits to retry. */
  onStopRetrying?: () => void;
  /**
   * Re-connect the agent's account (auth failures). Only offered when the
   * host can actually run a login flow for the current agent.
   */
  onReauth?: () => void;
  reauthLabel?: string;
  /**
   * Undo a turn and every later one, files included. Offered on a settled
   * turn's message once nothing is running; resolves true once undone.
   */
  onRollback?: (
    turnId: string,
    item: UserMessageItem,
  ) => undefined | boolean | Promise<boolean>;
  onResendFailed?: (commandId: string) => void;
  onDismissFailed?: (commandId: string) => void;
  /** Older history exists before the loaded turns. */
  hasOlder?: boolean;
  loadingOlder?: boolean;
  onLoadOlder?: () => void;
  error?: string | null;
  emptyState?: string;
  className?: string;
  /**
   * Extra classes for the scrolled content column. Lets hosts center a
   * max-width column while the scrollbar hugs the container edge.
   */
  contentClassName?: string;
  /** Names an agent id (agent-change notices); falls back to the notice text. */
  resolveAgentName?: (agentId: string) => string | undefined;
  /** Host-owned previews for sanitized Markdown links. */
  renderLink?: (props: {
    href: string;
    children: ReactNode;
    onOpen: NonNullable<ChatTimelineProps["onLinkClick"]>;
  }) => ReactNode;
  onLinkClick?: (url: string, modifiers: LinkModifiers) => void;
  /**
   * A file path in the turn-step log was clicked ("Edited docs/plan.md").
   * Hosts open the file in an editor surface; without it the rows stay
   * inert text.
   */
  onFileClick?: (path: string, modifiers?: LinkModifiers) => void;
  /**
   * Icon URL for a tool name (MCP tools are `server/tool`; the host maps
   * the server key to its connector icon). Undefined → generic glyph.
   */
  resolveToolIcon?: (toolName: string) => string | undefined;
  /**
   * Fork the conversation from one of the agent's replies (hover action):
   * the fork carries the transcript through that item.
   */
  onFork?: (itemId: string) => void;
  /**
   * Hands the host the "jump to my previous message" scroll action, so a
   * composer shortcut (PageUp) triggers the same move as the button.
   */
  registerJumpToPreviousUserMessage?: (jump: () => void) => void;
}

/** A turn's rows, worked out once per render. */
interface TurnView {
  group: TimelineTurn;
  rows: TurnRow[];
  /** The turn is still running: its work reads live. */
  live: boolean;
}

/**
 * Presentational conversation log (ADR 0196): each turn reads as its
 * input, its work, then its answer; notices as quiet dividers; failed and
 * interrupted turns close with their outcome; the editable outgoing queue,
 * live activity and stick-to-bottom scrolling. Owns no chat state: feed
 * it from `useAgentChat`.
 */
export function ChatTimeline({
  focusMessageId,
  backgroundCommands,
  turns,
  requests,
  pending = [],
  activity,
  activityStartedAt,
  activityUpdatedAt,
  queue,
  onEditQueued,
  onCancelQueued,
  onSendQueuedNow,
  onHoldQueued,
  activeTurnId,
  workDisplay = DEFAULT_WORK_DISPLAY,
  onRetry,
  onStopRetrying,
  onReauth,
  reauthLabel,
  onRollback,
  onResendFailed,
  onDismissFailed,
  hasOlder = false,
  loadingOlder = false,
  onLoadOlder,
  error,
  emptyState = "Ask the agent to build or change your project.",
  className = "",
  contentClassName = "",
  resolveAgentName,
  onLinkClick,
  renderLink,
  onFileClick,
  resolveToolIcon,
  onFork,
  registerJumpToPreviousUserMessage,
}: ChatTimelineProps) {
  const views: TurnView[] = turns.map((group) => {
    const live = Boolean(group.turn && group.turn.id === activeTurnId);
    return {
      group,
      live,
      rows: turnRows(group, { live, display: workDisplay }),
    };
  });
  const latestTurnId = [...turns].reverse().find((group) => group.turn)
    ?.turn?.id;
  const working = Boolean(activeTurnId);
  const hasUserMessages =
    pending.length > 0 ||
    turns.some((group) =>
      group.entries.some(
        (entry) => entry.kind === "input" && isPersonsMessage(entry.item),
      ),
    );
  const backgroundStates = assignBackgroundCommands(
    views,
    backgroundCommands ?? [],
  );
  const folding = useFoldingNotes(views);
  const queued = (queue ?? []).map((entry) => ({
    id: entry.turn.id,
    content: entry.item?.text ?? "",
    attachments: entry.item?.attachments ?? [],
  }));
  const context: RowContext = {
    requests: requests ?? {},
    resolveAgentName,
    onLinkClick,
    renderLink,
    onFileClick,
    resolveToolIcon,
    onFork,
    focusMessageId,
  };
  const empty = turns.length === 0 && pending.length === 0 && !activity;
  // One keyed list for the whole conversation, so a message sent from here
  // keeps its node when its item takes over from the pending bubble.
  const conversation: ReactNode[] = [];
  const shownSends = new Set<string>();
  views.forEach((view, index) => {
    const turn = view.group.turn;
    const undone = turn?.status === "rolled_back";
    if (undone && views[index - 1]?.group.turn?.status !== "rolled_back")
      conversation.push(<UndoneDivider key={`undone:${view.group.key}`} />);
    for (const row of view.rows) {
      const key = rowKey(view.group, row);
      if (key.startsWith("send:")) shownSends.add(key);
      conversation.push(
        <div
          key={key}
          className={undone ? "flex flex-col gap-3 opacity-50" : "contents"}
          data-turn-undone={undone || undefined}
        >
          {row.kind === "entry" && row.entry.kind === "input" ? (
            // Rendered here, not through the row view, so a pending
            // message's node and its item's are the same element.
            <UserMessage
              item={row.entry.item}
              context={context}
              rollback={
                onRollback &&
                turn &&
                !working &&
                !undone &&
                row.entry.item.id === turn.inputItemId
                  ? rollbackOf(onRollback, turn.id, row.entry.item)
                  : undefined
              }
            />
          ) : (
            <TurnRowView
              row={row}
              view={view}
              context={context}
              folding={folding}
            />
          )}
        </div>,
      );
    }
    if (turn)
      conversation.push(
        <TurnOutcome
          key={`outcome:${turn.id}`}
          turn={turn}
          group={view.group}
          latest={turn.id === latestTurnId}
          onRetry={onRetry}
          onStopRetrying={onStopRetrying}
          onReauth={onReauth}
          reauthLabel={reauthLabel}
        />,
      );
  });
  for (const message of pending) {
    const key = `send:${message.commandId}`;
    // Its item is already on screen: the item's row is this message now.
    if (shownSends.has(key)) continue;
    conversation.push(
      <div key={key} className="contents">
        <UserMessage
          pending={message}
          context={context}
          onResend={onResendFailed}
          onDismiss={onDismissFailed}
        />
      </div>,
    );
  }
  return (
    <BackgroundStates.Provider value={backgroundStates}>
      <StickToBottom
        className={`relative overflow-hidden ${className}`}
        initial="smooth"
        resize="smooth"
        role="log"
      >
        <StickToBottom.Content
          className={`flex min-h-full flex-col gap-3 p-5 ${contentClassName}`}
        >
          {hasOlder && onLoadOlder && (
            <LoadOlder loading={loadingOlder} onLoad={onLoadOlder} />
          )}
          {empty && (
            <div className="m-auto max-w-sm text-center text-sm leading-6 text-fg-muted">
              {emptyState}
            </div>
          )}
          {conversation}
          {activity && (
            <div
              className="flex animate-fade-in items-center gap-2 text-xs text-fg-muted"
              data-testid="chat-activity"
            >
              <LoaderCircle className="size-4 animate-spin" />
              <ActivityText text={activity} />
              <TurnClock
                startedAt={activityStartedAt}
                updatedAt={activityUpdatedAt}
              />
            </div>
          )}
          {queued.length > 0 && (
            <ChatQueue
              queue={queued}
              onUpdate={onEditQueued}
              onRemove={onCancelQueued}
              onSendNow={onSendQueuedNow}
              onHold={onHoldQueued}
              Hint={ShortcutHint}
              renderContent={(entry) => (
                <InlineMessage
                  content={entry.content}
                  attachments={entry.attachments}
                />
              )}
              renderAttachments={(entry) => (
                <AttachmentStrip
                  attachments={entry.attachments.slice(
                    inlineMarkerCount(entry.content, entry.attachments),
                  )}
                />
              )}
            />
          )}
          {error && (
            <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
              {error}
            </div>
          )}
        </StickToBottom.Content>
        {hasUserMessages && (
          <JumpToPreviousUserMessage
            register={registerJumpToPreviousUserMessage}
          />
        )}
        <FocusMessage
          messageId={focusMessageId}
          ready={Boolean(
            focusMessageId &&
              turns.some((group) =>
                group.entries.some(
                  (entry) => entryId(entry) === focusMessageId,
                ),
              ),
          )}
        />
        <ScrollToLatest />
        <FollowScrollerResize />
      </StickToBottom>
    </BackgroundStates.Provider>
  );
}

/** What every row needs from the timeline, passed once. */
interface RowContext {
  requests: Readonly<Record<string, RuntimeRequest>>;
  resolveAgentName?: (agentId: string) => string | undefined;
  onLinkClick?: ChatTimelineProps["onLinkClick"];
  renderLink?: ChatTimelineProps["renderLink"];
  onFileClick?: ChatTimelineProps["onFileClick"];
  resolveToolIcon?: (toolName: string) => string | undefined;
  onFork?: (itemId: string) => void;
  focusMessageId?: string;
}

/** The item id an entry reads at, for focus and deep links. */
function entryId(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "answer":
      return entry.id;
    case "steps":
      return entry.steps[0]?.id ?? "";
    default:
      return entry.item.id;
  }
}

/**
 * Rows key by an identity that survives their changes: a person's message
 * by the command that sent it (so its pending bubble and its item are one
 * node), the agent's writing by its first own step (live steps gain their
 * prose in place) or its own id.
 */
function rowKey(group: TimelineTurn, row: TurnRow): string {
  if (row.kind === "steps")
    return `work:${row.steps.find((step) => step.kind === "work")?.item.id ?? group.key}`;
  if (row.kind === "reply") {
    // Its own work: what follows the last folded note.
    let own = 0;
    row.steps.forEach((step, index) => {
      if (step.kind === "note") own = index + 1;
    });
    const first = row.steps.slice(own).find((step) => step.kind === "work");
    return first ? `work:${first.item.id}` : `id:${row.item.id}`;
  }
  if (row.entry.kind === "input") return userKey(row.entry.item);
  return `id:${entryId(row.entry)}`;
}

/** A person's message keys by its command, matching its pending bubble. */
function userKey(item: UserMessageItem): string {
  const commandId = sentWith(item);
  return commandId ? `send:${commandId}` : `id:${item.id}`;
}

/** The command a person's message was sent with, from its idempotency key. */
function sentWith(item: UserMessageItem): string | undefined {
  return item.idempotencyKey?.match(/^user:[^:]*:(.+)$/)?.[1];
}

function isPersonsMessage(item: UserMessageItem): boolean {
  return item.author.kind === "user";
}

/** "Load earlier messages": pages older history in at the top. */
function LoadOlder({
  loading,
  onLoad,
}: {
  loading: boolean;
  onLoad: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onLoad}
      disabled={loading}
      className="mx-auto flex cursor-pointer items-center gap-1.5 rounded-full border border-border bg-bg-inset px-3 py-1 text-[11px] text-fg-muted transition-colors duration-150 hover:text-fg disabled:cursor-default"
      data-testid="chat-load-older"
    >
      {loading && <LoaderCircle className="size-3 animate-spin" />}
      {loading ? "Loading earlier messages" : "Load earlier messages"}
    </button>
  );
}

/** Where undone turns begin: a calm divider, the turns below dimmed. */
function UndoneDivider() {
  return (
    <div
      className="flex items-center gap-3 py-1 text-[11px] text-fg-faint"
      data-testid="chat-undone-divider"
    >
      <span className="h-px flex-1 bg-border" />
      <span className="flex items-center gap-1">
        <Undo2 className="size-3" />
        Undone: the files went back to how they were before this
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** Undo a turn from its message, bound for the button. */
function rollbackOf(
  onRollback: NonNullable<ChatTimelineProps["onRollback"]>,
  turnId: string,
  item: UserMessageItem,
) {
  return () => onRollback(turnId, item);
}

function TurnRowView({
  row,
  view,
  context,
  folding,
}: {
  row: TurnRow;
  view: TurnView;
  context: RowContext;
  folding: Set<string>;
}) {
  // Live work and the reply it becomes render alike, so the node that
  // showed the steps gains the prose in place instead of remounting.
  if (row.kind === "steps" || row.kind === "reply") {
    const reply = row.kind === "reply" ? row : undefined;
    return (
      <>
        {(reply?.folded ?? [])
          .filter((note) => folding.has(note.id))
          .map((note) => (
            <div
              key={`folding:${note.id}`}
              aria-hidden
              inert
              className="animate-fold-away"
            >
              <AgentMessage item={note} steps={[]} context={context} />
            </div>
          ))}
        <AgentMessage
          item={reply?.item}
          steps={row.steps}
          live={view.live}
          answer={reply?.answer ?? false}
          openWork={
            reply?.folded.some((note) => note.id === context.focusMessageId) ??
            false
          }
          context={context}
        />
      </>
    );
  }
  const entry = row.entry;
  switch (entry.kind) {
    case "input":
      return <UserMessage item={entry.item} context={context} />;
    case "answer":
      return <AnswerCard entry={entry} />;
    case "notice":
      return <NoticeLine item={entry.item} context={context} />;
    case "handoff":
      return <HandoffLine item={entry.item} />;
  }
}

/** How long a folding note stays on screen: its fold-away animation. */
const FOLD_AWAY_MS = 220;

/**
 * Notes that were in place a moment ago and have just folded into their
 * answer's steps (the turn settled, or the setting changed). They stay on
 * screen for the fold-away animation, so settling closes them up instead
 * of snapping the conversation shorter.
 */
function useFoldingNotes(views: TurnView[]): Set<string> {
  const inPlace = useRef<Set<string>>(new Set());
  const timers = useRef<Set<number>>(new Set());
  const [folding, setFolding] = useState<Set<string>>(() => new Set());
  const shownIds: string[] = [];
  const foldedIds: string[] = [];
  for (const view of views)
    for (const row of view.rows) {
      if (row.kind !== "reply") continue;
      shownIds.push(row.item.id);
      for (const note of row.folded) foldedIds.push(note.id);
    }
  const signature = `${shownIds.join(",")}|${foldedIds.join(",")}`;
  // Before paint: the notes never leave the screen for a frame.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature carries the ids
  useLayoutEffect(() => {
    const arrived = foldedIds.filter((id) => inPlace.current.has(id));
    inPlace.current = new Set(shownIds);
    if (arrived.length === 0) return;
    setFolding((current) => new Set([...current, ...arrived]));
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setFolding((current) => {
        const next = new Set(current);
        for (const id of arrived) next.delete(id);
        return next;
      });
    }, FOLD_AWAY_MS);
    timers.current.add(timer);
  }, [signature]);
  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending) window.clearTimeout(timer);
    };
  }, []);
  return folding;
}

/**
 * Walks the conversation upward one user message per click: each press
 * scrolls the nearest user message above the current view to the top —
 * where its answer starts. The everyday use: "what did I even ask?"
 * while multitasking. PageUp in the composer triggers the same move.
 */
function JumpToPreviousUserMessage({
  register,
}: {
  register?: (jump: () => void) => void;
}) {
  const { scrollRef, contentRef, isAtBottom } = useStickToBottomContext();
  // A chat short enough to see whole needs no jump affordance; watch both
  // the scroller and its content so the button appears the moment the
  // conversation outgrows the viewport (and goes away if it shrinks).
  const [scrollable, setScrollable] = useState(false);
  useEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const measure = () =>
      setScrollable(scroller.scrollHeight > scroller.clientHeight + 16);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(content);
    return () => observer.disconnect();
  }, [scrollRef, contentRef]);
  const jump = useCallback(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    const targets = [
      ...content.querySelectorAll<HTMLElement>("[data-user-message]"),
    ];
    if (targets.length === 0) return;
    const viewTop = scroller.getBoundingClientRect().top;
    // The nearest user message strictly above the view top; from the
    // bottom of the chat the first press lands on the newest one.
    const above = targets.filter(
      (element) => element.getBoundingClientRect().top < viewTop - 8,
    );
    const target = above.at(-1) ?? targets.at(-1);
    if (!target) return;
    const offset = target.getBoundingClientRect().top - viewTop;
    if (above.length === 0 && offset <= 8) return; // already at the oldest
    scroller.scrollTo({
      top: scroller.scrollTop + offset - 12,
      behavior: "smooth",
    });
  }, [scrollRef, contentRef]);

  useEffect(() => {
    register?.(jump);
  }, [register, jump]);

  if (!scrollable) return null;
  return (
    <ShortcutHint label="Jump to your previous message" shortcut="⇞">
      <button
        type="button"
        className={`absolute bottom-4 grid size-8 place-items-center rounded-full border border-border-strong bg-bg-overlay text-fg shadow-xl transition-[right] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          isAtBottom ? "right-4" : "right-14"
        }`}
        onClick={jump}
        aria-label="Jump to your previous message"
        data-testid="chat-jump-previous"
      >
        <ArrowUp className="size-4" />
      </button>
    </ShortcutHint>
  );
}

/** The entrance every message plays once: a short rise and fade. */
function useEntered(already = false): string {
  const [entered, setEntered] = useState(already);
  // Double rAF: the first frame aligns with the commit, the second
  // guarantees the browser resolved the hidden pose before it flips; a
  // single rAF can fire before the mount frame ever paints.
  useEffect(() => {
    let second: number | undefined;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(first);
      if (second !== undefined) cancelAnimationFrame(second);
    };
  }, []);
  return `motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"}`;
}

/**
 * A message into the session: the person's own (right), or one an agent,
 * a workflow or a watcher delivered (left, with where it came from). A
 * host notice (a background command finished) reads as one quiet line.
 */
const UserMessage = memo(
  function UserMessage({
    item,
    pending,
    context,
    rollback,
    onResend,
    onDismiss,
  }: {
    /** The message as the session holds it. */
    item?: UserMessageItem;
    /** Sent from here and not in the session yet: shown at once. */
    pending?: PendingAgentMessage;
    context: RowContext;
    /** Undo this message's turn and every later one. */
    rollback?: () => undefined | boolean | Promise<boolean>;
    onResend?: (commandId: string) => void;
    onDismiss?: (commandId: string) => void;
  }) {
    const enterClasses = useEntered();
    const notice =
      typeof item?.metadata.notice === "string"
        ? item.metadata.notice
        : undefined;
    if (item?.author.kind === "system" && notice)
      return (
        <div
          className="flex items-center justify-center gap-1.5 text-center text-xs text-fg-faint"
          data-testid="chat-notice"
          data-message-id={item.id}
        >
          <Radio className="size-3 shrink-0" />
          <span className="truncate">{notice}</span>
        </div>
      );
    const text = item?.text ?? pending?.text ?? "";
    const attachments = item?.attachments ?? pending?.attachments ?? [];
    const own = item ? isPersonsMessage(item) : true;
    const failed = pending?.status === "failed";
    const strip = attachments.slice(inlineMarkerCount(text, attachments));
    return (
      <article
        data-message-id={item?.id}
        tabIndex={-1}
        data-user-message={own || undefined}
        data-pending-message={pending?.status}
        className={`group/msg relative max-w-[85%] text-sm ${enterClasses} ${
          failed
            ? "ml-auto rounded-xl rounded-br-sm border border-danger/40 bg-danger/5 px-3 py-2"
            : own
              ? "ml-auto rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2"
              : "mr-auto rounded-xl rounded-bl-sm border border-border bg-bg-raised px-3 py-2"
        } ${item && item.id === context.focusMessageId ? "outline outline-1 outline-accent/50" : ""}`}
      >
        {item && (
          <SessionAttribution
            author={item.author}
            metadata={item.metadata}
            attention={item.attention}
            onOpen={context.onLinkClick}
          />
        )}
        {strip.length > 0 && <AttachmentStrip attachments={strip} />}
        <div className="whitespace-pre-wrap break-words leading-6">
          <InlineMessage content={text} attachments={attachments} />
        </div>
        {pending && failed && (
          <div
            className="mt-1.5 flex flex-wrap items-center gap-2 border-t border-danger/20 pt-1.5 text-[11px]"
            data-failed-delivery={pending.commandId}
            aria-live="polite"
          >
            <span className="min-w-0 flex-1 text-danger">
              {pending.error?.message
                ? `Not sent: ${pending.error.message}`
                : "Not sent"}
            </span>
            {onResend && (
              <button
                type="button"
                onClick={() => onResend(pending.commandId)}
                className="cursor-pointer text-accent hover:underline"
              >
                Send again
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(pending.commandId)}
                className="cursor-pointer text-fg-muted hover:text-fg"
              >
                Dismiss
              </button>
            )}
          </div>
        )}
        {rollback && <RestoreToHere onConfirm={rollback} />}
      </article>
    );
  },
  (previous, next) =>
    previous.item === next.item &&
    previous.pending === next.pending &&
    Boolean(previous.rollback) === Boolean(next.rollback) &&
    previous.context.focusMessageId === next.context.focusMessageId,
);

/**
 * "Restore to here": undo this message's turn and everything after it,
 * files included. Confirms in place first: it cannot be redone.
 */
function RestoreToHere({
  onConfirm,
}: {
  onConfirm: () => undefined | boolean | Promise<boolean>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (confirming)
    return (
      <div
        className="mt-2 flex flex-wrap items-center gap-2 border-t border-info/20 pt-2 text-xs"
        data-testid="chat-restore-confirm"
      >
        <span className="min-w-0 flex-1 text-fg-muted">
          Undo this message and everything after it? The files it changed go
          back too.
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void Promise.resolve(onConfirm()).finally(() => {
              setBusy(false);
              setConfirming(false);
            });
          }}
          className="flex cursor-pointer items-center gap-1 rounded-md bg-accent px-2 py-1 font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          data-testid="chat-restore-confirm-button"
        >
          {busy && <LoaderCircle className="size-3 animate-spin" />}
          Restore
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => setConfirming(false)}
          className="cursor-pointer rounded-md px-2 py-1 text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          Cancel
        </button>
      </div>
    );
  return (
    // The pr-2 bridges the gap to the button so the hover never blinks.
    <span className="absolute bottom-0 right-full flex items-center pr-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/msg:opacity-100">
      <ShortcutHint label="Restore to here: undo this message and everything after it">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="grid size-6 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          aria-label="Restore to here"
          data-testid="chat-restore"
        >
          <Undo2 className="size-3" />
        </button>
      </ShortcutHint>
    </span>
  );
}

/**
 * What the agent wrote, under the steps that led to it: a note along the
 * way, or the turn's answer. Without an item it is the work after the
 * latest note, which gains its prose in place when the agent writes.
 */
interface AgentMessageProps {
  item?: AssistantMessageItem;
  steps: StepSource[];
  /** Part of the turn that is still running: its steps stay open. */
  live?: boolean;
  answer?: boolean;
  openWork?: boolean;
  context: RowContext;
}

const AgentMessage = memo(function AgentMessage({
  item,
  steps,
  live = false,
  answer = false,
  openWork = false,
  context,
}: AgentMessageProps) {
  const enterClasses = useEntered();
  const [bornLive] = useState(() => !item || item.status === "in_progress");
  const built = turnStepsOf(steps, context.requests);
  const shown = live && !item ? markRunning(built) : built;
  const text = item?.text ?? "";
  const writing = item?.status === "in_progress";
  return (
    <article
      data-message-id={item?.id}
      tabIndex={item ? -1 : undefined}
      data-live-work={!item || undefined}
      data-answer={answer || undefined}
      className={`group/msg relative mr-auto max-w-[85%] text-sm ${enterClasses} ${
        item && item.id === context.focusMessageId
          ? "rounded-md outline outline-1 outline-accent/50"
          : ""
      }`}
    >
      {/* Copy and fork from this reply. The pl-2 bridges the gap between
          the message edge and the buttons: without it the pointer leaves
          the group mid-crossing and the reveal blinks. */}
      {item && !writing && text.trim() && (
        <span className="absolute bottom-0 left-full flex items-center gap-0.5 pl-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/msg:opacity-100">
          <CopyMessageButton content={text} />
          {context.onFork && (
            <ShortcutHint label="Fork the chat from here">
              <button
                type="button"
                onClick={() => context.onFork?.(item.id)}
                className="grid size-6 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                aria-label="Fork the conversation from this message"
                data-testid="chat-fork"
              >
                <GitFork className="size-3" />
              </button>
            </ShortcutHint>
          )}
        </span>
      )}
      <TurnSteps
        steps={shown}
        live={live}
        defaultExpanded={openWork}
        resolveToolIcon={context.resolveToolIcon}
        onFileClick={context.onFileClick}
      />
      {text.trim() && (
        <div
          className={`cat-markdown min-w-0 break-words leading-6 ${bornLive ? "animate-fade-in" : ""}`}
        >
          <LinkContext.Provider
            value={{
              onLinkClick: context.onLinkClick,
              renderLink: context.renderLink,
            }}
          >
            <Markdown
              remarkPlugins={REMARK_PLUGINS}
              urlTransform={(url, key) =>
                context.onLinkClick &&
                key === "href" &&
                /^(?:file|workflow|app|artifact|chat|browser|terminal|editor|diff|mcpapp):/i.test(
                  url,
                )
                  ? url
                  : defaultUrlTransform(url)
              }
              components={context.onLinkClick ? LINK_COMPONENTS : undefined}
            >
              {text}
            </Markdown>
          </LinkContext.Provider>
        </div>
      )}
    </article>
  );
}, sameAgentMessage);

/**
 * Re-render a message only when what it shows changed: items keep their
 * identity across events unless they changed (the reducer replaces only
 * what an event names), so a streaming turn re-renders just its tail
 * instead of re-parsing every reply's Markdown. Handlers are deliberately
 * not compared: hosts recreate them every render, with the same behavior.
 */
function sameAgentMessage(
  previous: AgentMessageProps,
  next: AgentMessageProps,
): boolean {
  return (
    previous.item === next.item &&
    previous.live === next.live &&
    previous.answer === next.answer &&
    previous.openWork === next.openWork &&
    previous.context.requests === next.context.requests &&
    previous.context.focusMessageId === next.context.focusMessageId &&
    previous.steps.length === next.steps.length &&
    previous.steps.every((step, index) => step.item === next.steps[index]?.item)
  );
}

/** Answered questions: each question with what was picked. */
function AnswerCard({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: "answer" }>;
}) {
  const enterClasses = useEntered();
  if (entry.dismissed)
    return (
      <div
        className="text-center text-xs italic text-fg-faint"
        data-message-id={entry.id}
      >
        Questions dismissed
      </div>
    );
  return (
    <article
      data-user-message
      data-testid="question-answer"
      data-message-id={entry.id}
      className={`ml-auto max-w-[85%] rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2 text-sm ${enterClasses}`}
    >
      <dl className="flex flex-col gap-1.5">
        {answerRows(entry).map((row) => (
          <div key={row.question} className="min-w-0">
            {row.question && (
              <dt className="whitespace-pre-wrap break-words text-xs leading-5 text-fg-muted">
                {row.question}
              </dt>
            )}
            <dd className="whitespace-pre-wrap break-words font-medium leading-6">
              {row.answer}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  );
}

/** A line Work wrote (an agent change, a fork, a continued turn): a divider. */
function NoticeLine({
  item,
  context,
}: {
  item: NoticeItem;
  context: RowContext;
}) {
  const agentId = item.data.agentId;
  const text =
    item.code === "agent_changed"
      ? typeof agentId === "string"
        ? `Switched to ${context.resolveAgentName?.(agentId) ?? "another agent"}`
        : "Agent changed"
      : item.text;
  return (
    <div
      className="flex items-center gap-3 py-1 text-[11px] text-fg-faint"
      data-testid="chat-divider"
      data-notice-code={item.code}
      data-message-id={item.id}
    >
      <span className="h-px flex-1 bg-border" />
      <span className="max-w-[80%] text-center">{text}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/**
 * What an agent was told about turns its own conversation had not seen
 * (a switch of agent, a fork): collapsed, opens to the text it read.
 */
function HandoffLine({ item }: { item: ContextHandoffItem }) {
  const [open, setOpen] = useState(false);
  const { from, to } = item.coveredTurnOrdinals;
  const count = Math.max(0, to - from + 1);
  return (
    <div className="flex flex-col gap-1" data-testid="chat-handoff">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        className="mx-auto flex cursor-pointer items-center gap-1 text-[11px] text-fg-faint transition-colors duration-150 hover:text-fg-muted"
      >
        <ChevronRight
          className={`size-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        {count === 1
          ? "Caught up on 1 earlier turn"
          : `Caught up on ${count} earlier turns`}
      </button>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden" inert={!open}>
          <pre className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-sans text-[11px] leading-4 text-fg-muted">
            {item.text}
          </pre>
        </div>
      </div>
    </div>
  );
}

/**
 * How a turn ended, when that is worth a line: a failed turn's card with
 * what gets the person unstuck, a quiet divider for an interruption, and
 * the countdown of a turn waiting to retry.
 */
function TurnOutcome({
  turn,
  group,
  latest,
  onRetry,
  onStopRetrying,
  onReauth,
  reauthLabel,
}: {
  turn: Turn;
  group: TimelineTurn;
  latest: boolean;
  onRetry?: (turnId: string) => void;
  onStopRetrying?: () => void;
  onReauth?: () => void;
  reauthLabel?: string;
}) {
  const retrying =
    (turn.status === "queued" || turn.status === "held") &&
    turn.attemptCount > 0;
  if (turn.status === "failed" || retrying)
    return (
      <ErrorCard
        message={
          turn.error?.message ??
          (retrying ? "The last attempt did not finish." : "The turn failed.")
        }
        kind={turn.error?.kind}
        actionable={latest}
        retryAt={retrying ? turn.retryAt : null}
        onRetry={!retrying && onRetry ? () => onRetry(turn.id) : undefined}
        onStop={retrying ? onStopRetrying : undefined}
        onReauth={onReauth}
        reauthLabel={reauthLabel}
      />
    );
  if (turn.status !== "interrupted") return null;
  const stopped = interruptedStep(turn, group);
  const changed = (turn.outcome?.changedFiles ?? []).map(
    (change) => change.path,
  );
  return (
    <div
      // The running steps above become this summary in place; it fades in
      // rather than snapping over them.
      className="flex animate-fade-in flex-col items-center gap-0.5 text-center text-xs text-fg-faint"
      data-testid="chat-interrupted"
    >
      <div className="italic">Interrupted</div>
      {turn.error?.message && (
        // Not a person's stop: say what happened (the machine went away).
        <span className="italic" data-testid="chat-interrupted-reason">
          {turn.error.message}
        </span>
      )}
      {stopped && (
        <span data-testid="chat-interrupted-step">
          {`While: ${stopped.label}${stopped.ran ? ` (${stopped.ran})` : ""}`}
        </span>
      )}
      {changed.length > 0 && (
        <span data-testid="chat-interrupted-files">
          {`Left ${changed.length === 1 ? "1 changed file" : `${changed.length} changed files`}: ${changedFileNames(changed)}`}
        </span>
      )}
      {latest && onRetry && (
        <button
          type="button"
          onClick={() => onRetry(turn.id)}
          className="mt-1 flex cursor-pointer items-center gap-1 rounded-md px-2 py-0.5 not-italic text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          data-testid="chat-retry"
        >
          <RotateCcw className="size-3" />
          Retry
        </button>
      )}
    </div>
  );
}

/**
 * A failed turn: the friendly explanation plus whatever gets the person
 * unstuck: Retry (in place, no re-typing), a re-connect flow for auth
 * failures, and the countdown while a transient failure retries itself.
 */
function ErrorCard({
  message,
  kind,
  actionable,
  retryAt,
  onRetry,
  onStop,
  onReauth,
  reauthLabel,
}: {
  message: string;
  kind?: string;
  actionable: boolean;
  retryAt: string | null;
  onRetry?: () => void;
  onStop?: () => void;
  onReauth?: () => void;
  reauthLabel?: string;
}) {
  const nextAtMs = retryAt ? Date.parse(retryAt) : undefined;
  return (
    <article
      className="mr-auto max-w-[85%] animate-fade-in rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-sm"
      data-testid="chat-error-card"
    >
      <div className="whitespace-pre-wrap break-words leading-6 text-fg">
        {message}
      </div>
      {actionable && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              className="flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-bg-raised px-2.5 py-1 text-xs font-medium text-fg transition-colors duration-100 hover:border-border-strong"
              data-testid="chat-retry"
            >
              <RotateCcw className="size-3" />
              Retry
            </button>
          )}
          {kind === "auth" && onReauth && (
            <button
              type="button"
              onClick={onReauth}
              className="flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2.5 py-1 text-xs font-medium text-accent-fg transition-opacity duration-100 hover:opacity-90"
              data-testid="chat-reauth"
            >
              <KeyRound className="size-3" />
              {reauthLabel ?? "Reconnect"}
            </button>
          )}
          {nextAtMs !== undefined && Number.isFinite(nextAtMs) && (
            <AutoRetryCountdown nextAtMs={nextAtMs} />
          )}
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="cursor-pointer rounded-md px-2 py-1 text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              data-testid="stop-retrying"
            >
              Stop
            </button>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * Copies the reply as the agent wrote it (Markdown source): what pastes
 * well into a document, an issue, or another chat.
 */
function CopyMessageButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <ShortcutHint label={copied ? "Copied" : "Copy response"}>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            .writeText(content)
            .then(() => setCopied(true));
        }}
        className="grid size-6 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        aria-label="Copy response"
        data-testid="chat-copy"
      >
        {/* Both glyphs stay mounted so the swap cross-fades in place. */}
        <span className="grid place-items-center">
          <Copy
            className={`col-start-1 row-start-1 size-3 transition-opacity duration-150 ${copied ? "opacity-0" : "opacity-100"}`}
          />
          <Check
            className={`col-start-1 row-start-1 size-3 text-success transition-opacity duration-150 ${copied ? "opacity-100" : "opacity-0"}`}
          />
        </span>
      </button>
    </ShortcutHint>
  );
}

/** One row of a turn's expandable event log. */
interface TurnStep {
  /**
   * Its message and place in that message's log: stays with the step when
   * earlier work folds in above it, so its row is never relabeled.
   */
  key: string;
  kind:
    | "command"
    | "file_edit"
    | "tool"
    | "subagent"
    | "background"
    | "note"
    | "reasoning"
    | "plan"
    | "request";
  /** A folded note's message id, so focus and deep links still find it. */
  messageId?: string;
  /** Notes expand to rendered Markdown instead of a preformatted payload. */
  markdown?: boolean;
  /** Row header — the technical detail lives here, not on the live line. */
  label: string;
  /** Monospace label (commands, paths, unrecognized tool names). */
  mono?: boolean;
  /** Edited file path — makes the row a click-through to the editor. */
  filePath?: string;
  /** Tool name as the harness reported it (`server/tool` for MCP). */
  toolName?: string;
  /** Preformatted expandable body (tool input/result, full command). */
  detail?: string;
  /** Technical payloads use mono; host-tool summaries read as normal prose. */
  detailMono?: boolean;
  /** A background command's or watch's step: its key into the live states, and its words. */
  background?: {
    ref: string;
    kind: ChatBackgroundCommand["kind"];
    description: string;
  };
  /** When the step started and when its result arrived (epoch ms). */
  startedAt?: number;
  endedAt?: number;
  /** Its result has arrived, or it has none to wait for. */
  finished?: boolean;
  /** A step whose end is reported (every work item says when it ends). */
  awaitsEnd?: boolean;
  /** Still going: the turn runs and its result has not arrived. */
  running?: boolean;
}

const STEP_ICONS = {
  command: SquareTerminal,
  file_edit: Pencil,
  tool: Wrench,
  subagent: Bot,
  background: Radio,
  note: MessageSquareText,
  reasoning: Brain,
  plan: ListChecks,
  request: MessageCircleQuestionMark,
} as const;

/**
 * Friendly step labels for well-known tools, harness-neutral: Claude
 * Code's built-ins (Read, WebSearch, …), the built-in agent's lowercase
 * kin (read, websearch, …), and the desktop's workspace tools (identical
 * names on every harness). MCP tools arrive as "server/tool" and render
 * as "tool (server)"; anything else falls back to its raw name in mono.
 */
const TOOL_STEP_LABELS: Record<string, string> = {
  // Questions and plans.
  AskUserQuestion: "Asked you a question",
  ask_user: "Asked you a question",
  TodoWrite: "Updated the plan",
  read_todo_list: "Read the todo list",
  update_todo_list: "Updated the todo list",
  // Reading and searching the project.
  Read: "Read files",
  read: "Read files",
  Glob: "Searched files",
  Grep: "Searched files",
  // The web.
  WebSearch: "Searched the web",
  websearch: "Searched the web",
  WebFetch: "Fetched a page",
  webfetch: "Fetched a page",
  // Delegation, skills, and background work.
  Task: "Ran a subagent",
  Agent: "Ran a subagent",
  Skill: "Used a skill",
  SlashCommand: "Ran a slash command",
  TaskOutput: "Checked a background task",
  BashOutput: "Checked a background task",
  TaskStop: "Stopped a background task",
  KillShell: "Stopped a background task",
  // Workspace tools (the host bridge; same names on every harness).
  read_background_output: "Checked a background command",
  stop_background_command: "Stopped background work",
  write_terminal: "Typed into a terminal",
  workspace_overview: "Looked at the workspace",
  read_tab: "Read a tab",
  open_browser: "Opened a page",
  browser_snapshot: "Looked at the page",
  browser_act: "Acted on the page",
  surface_control: "Managed a surface",
  open_surface: "Showed you something",
  point_at: "Pointed at something",
  build_app: "Built an app",
  sync_project: "Synced the project",
  create_pull_request: "Opened a pull request",
  list_project_sessions: "Listed project chats",
  read_project_session: "Read a project chat",
  send_project_session_message: "Messaged a project chat",
  spawn_subsession: "Started a subsession",
  wait_for_subsessions: "Waited for subsessions",
  interrupt_subsession: "Stopped a subsession",
  request_user_attention: "Requested your attention",
  set_session_activity: "Updated activity",
  list_worktrees: "Listed worktrees",
  create_worktree: "Created a worktree",
  use_worktree: "Switched worktrees",
  request_connection: "Requested a connection",
  read_skill: "Read a skill",
};

const DESKTOP_STEP_TOOLS = new Set([
  "TodoWrite",
  "list_project_sessions",
  "read_project_session",
  "send_project_session_message",
  "spawn_subsession",
  "wait_for_subsessions",
  "interrupt_subsession",
  "request_user_attention",
  "set_session_activity",
  "read_todo_list",
  "update_todo_list",
  "list_worktrees",
  "create_worktree",
  "use_worktree",
  "build_app",
  "open_surface",
  "point_at",
  "workspace_overview",
  "read_tab",
  "open_browser",
  "browser_snapshot",
  "browser_act",
  "read_background_output",
  "stop_background_command",
  "write_terminal",
  "sync_project",
  "create_pull_request",
  "request_connection",
  "read_skill",
  "surface_control",
]);

/**
 * Bookkeeping calls, not work the reader cares about — the title/icon
 * change is already visible on the chat itself.
 */
const HIDDEN_STEP_TOOLS = new Set(["set_title", "set_chat_icon"]);

/** Human header for a tool step; mono marks an unrecognized raw name. */
function toolStepLabel(
  toolName: string,
  input?: unknown,
): { label: string; mono: boolean } {
  if (input && typeof input === "object") {
    if (toolName === "point_at" && "target" in input && input.target === null)
      return { label: "Stopped pointing", mono: false };
    if (toolName === "use_worktree" && "path" in input && input.path === null)
      return { label: "Switched to the project checkout", mono: false };
  }
  const known = TOOL_STEP_LABELS[toolName];
  if (known) return { label: known, mono: false };
  const slash = toolName.indexOf("/");
  if (slash > 0) {
    return {
      label: `${toolName.slice(slash + 1)} (${toolName.slice(0, slash)})`,
      mono: false,
    };
  }
  return { label: toolName, mono: true };
}

/** Cap for a step's expanded body; full payloads can be megabytes. */
const STEP_DETAIL_MAX = 6_000;

function stepDetailText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text || text === "{}") return undefined;
  return text.length > STEP_DETAIL_MAX
    ? `${text.slice(0, STEP_DETAIL_MAX)}\n… truncated`
    : text;
}

function friendlyFieldLabel(field: string): string {
  const spaced = field
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll("_", " ");
  return `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

function friendlyScalar(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return undefined;
}

function friendlyStatus(value: string): string {
  return value === "in_progress"
    ? "In progress"
    : `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** Plain-language field list for desktop-owned tools, never a JSON dump. */
function friendlyDetailLines(value: unknown, indent = "", depth = 0): string[] {
  const scalar = friendlyScalar(value);
  if (scalar !== undefined) return [`${indent}${scalar}`];
  if (value === null || value === undefined) return [];
  if (depth > 3) return [`${indent}More details available`];
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${indent}None`];
    return value.flatMap((item, index) => {
      const record = asRecord(item);
      if (!record) {
        return friendlyDetailLines(item, `${indent}• `, depth + 1);
      }
      const headlineEntry = ["title", "label", "name", "key", "path", "url"]
        .map((key) => [key, friendlyScalar(record[key])] as const)
        .find((entry) => entry[1] !== undefined);
      const lines = [`${indent}• ${headlineEntry?.[1] ?? `Item ${index + 1}`}`];
      for (const [key, child] of Object.entries(record)) {
        if (key === headlineEntry?.[0] || key === "id") continue;
        const childScalar = friendlyScalar(child);
        if (childScalar !== undefined) {
          lines.push(
            `${indent}  ${friendlyFieldLabel(key)}: ${key === "status" ? friendlyStatus(childScalar) : childScalar}`,
          );
          continue;
        }
        const nested = friendlyDetailLines(child, `${indent}    `, depth + 1);
        if (nested.length > 0) {
          lines.push(`${indent}  ${friendlyFieldLabel(key)}:`);
          lines.push(...nested);
        }
      }
      return lines;
    });
  }
  const record = asRecord(value);
  if (!record) return [];
  if (Object.keys(record).length === 1 && record.ok === true) return ["Done"];
  const lines: string[] = [];
  for (const [key, child] of Object.entries(record)) {
    if (key === "id") continue;
    const childScalar = friendlyScalar(child);
    if (childScalar !== undefined) {
      lines.push(
        `${indent}${friendlyFieldLabel(key)}: ${key === "status" ? friendlyStatus(childScalar) : childScalar}`,
      );
      continue;
    }
    const nested = friendlyDetailLines(child, `${indent}  `, depth + 1);
    if (nested.length > 0) {
      lines.push(`${indent}${friendlyFieldLabel(key)}:`);
      lines.push(...nested);
    }
  }
  return lines;
}

function friendlyStepDetail(value: unknown): string | undefined {
  const text = friendlyDetailLines(value).join("\n").trim();
  if (!text) return undefined;
  return text.length > STEP_DETAIL_MAX
    ? `${text.slice(0, STEP_DETAIL_MAX)}\n… truncated`
    : text;
}

function todoStepDetail(input: unknown, result: unknown): string | undefined {
  const inputRecord = asRecord(input);
  const inputItems = inputRecord?.items ?? inputRecord?.todos;
  const resultRecord = asRecord(result);
  const items = Array.isArray(inputItems)
    ? inputItems
    : Array.isArray(resultRecord?.items)
      ? resultRecord.items
      : undefined;
  if (!items) return friendlyStepDetail(result);
  if (items.length === 0) return "Cleared the todo list.";
  const lines = items.flatMap((item) => {
    const todo = asRecord(item);
    if (!todo) return [];
    const title =
      friendlyScalar(todo.title) ??
      friendlyScalar(todo.content) ??
      "Untitled task";
    const description =
      friendlyScalar(todo.description) ?? friendlyScalar(todo.activeForm);
    const status = friendlyScalar(todo.status);
    const marker =
      status === "completed" ? "✓" : status === "in_progress" ? "●" : "○";
    return [`${marker} ${title}`, ...(description ? [`  ${description}`] : [])];
  });
  const completed = friendlyScalar(resultRecord?.completed);
  const total = friendlyScalar(resultRecord?.total);
  if (completed && total) lines.push("", `${completed} of ${total} complete`);
  return lines.join("\n");
}

function toolStepDetail(
  toolName: string,
  input: unknown,
  result: unknown,
): string | undefined {
  if (
    toolName === "TodoWrite" ||
    toolName === "update_todo_list" ||
    toolName === "read_todo_list"
  ) {
    return todoStepDetail(input, result);
  }
  if (!DESKTOP_STEP_TOOLS.has(toolName)) {
    const rawInput = stepDetailText(input);
    const rawResult = stepDetailText(result);
    return stepDetailText(
      [rawInput && `Input:\n${rawInput}`, rawResult && `Result:\n${rawResult}`]
        .filter(Boolean)
        .join("\n\n"),
    );
  }
  const friendlyInput = friendlyStepDetail(input);
  const friendlyResult = friendlyStepDetail(result);
  return stepDetailText(
    [
      friendlyInput && `Input\n${friendlyInput}`,
      friendlyResult && `Result\n${friendlyResult}`,
    ]
      .filter(Boolean)
      .join("\n\n"),
  );
}

/**
 * Marks the live steps still going. A call the harness reports the end of
 * runs until that end arrives; any other step runs only while it is the
 * latest, because nothing will say when it finished.
 */
function markRunning(steps: TurnStep[]): TurnStep[] {
  return steps.map((step, index) =>
    !step.finished && (step.awaitsEnd || index === steps.length - 1)
      ? { ...step, running: true }
      : step,
  );
}

/**
 * How long the running turn has taken, and a plain word when it has gone
 * quiet: a spinner that looks the same at two seconds and at nine minutes
 * says nothing.
 */
function TurnClock({
  startedAt,
  updatedAt,
}: {
  startedAt?: string | null;
  updatedAt?: string | null;
}) {
  const started = startedAt ? Date.parse(startedAt) : Number.NaN;
  const updated = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const now = useNow(Number.isFinite(started) || Number.isFinite(updated));
  const quiet = Number.isFinite(updated) ? now - updated : 0;
  return (
    <>
      {Number.isFinite(started) && (
        // The turn's time, not the step's: the timer marks it apart from
        // the running step's own count just above.
        <span
          className="flex animate-fade-in items-center gap-1 tabular-nums text-fg-faint"
          role="timer"
          aria-label="Turn time"
        >
          <Timer className="size-3" />
          <span data-testid="chat-activity-elapsed">
            {formatElapsed(now - started)}
          </span>
        </span>
      )}
      {quiet >= STALL_AFTER_MS && (
        // Plain words, not an alarm: a long test run is quiet too.
        <span
          className="animate-fade-in text-fg-muted"
          data-testid="chat-activity-stalled"
        >
          {`No updates for ${formatElapsed(quiet)}`}
        </span>
      )}
    </>
  );
}

/** Silence long enough to say so on the activity line. */
const STALL_AFTER_MS = 30_000;

/**
 * A tool's name as the steps read it: host tools by their own name (the
 * same on every harness), a connector's as `server/tool`. Harnesses name
 * MCP tools `mcp__server__tool`.
 */
export function stepToolName(item: { tool: string; server: string | null }) {
  const mcp = /^mcp__(.+?)__(.+)$/.exec(item.tool);
  const tool = mcp?.[2] ?? item.tool;
  const server = item.server ?? mcp?.[1] ?? null;
  return server && server !== "workspace" && !DESKTOP_STEP_TOOLS.has(tool)
    ? `${server}/${tool}`
    : tool;
}

const epoch = (iso: string | null): number | undefined => {
  if (!iso) return undefined;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : undefined;
};

/** When an item started and ended, and whether it has finished. */
function itemTiming(
  item: WorkItem,
): Pick<TurnStep, "startedAt" | "endedAt" | "finished" | "awaitsEnd"> {
  return {
    startedAt: epoch(item.startedAt ?? item.createdAt),
    endedAt: epoch(item.endedAt),
    finished: item.status !== "in_progress",
    // Every item says when it ends: an unfinished one is still running.
    awaitsEnd: true,
  };
}

const firstLineOf = (text: string): string =>
  text.split("\n", 1)[0]?.trim() ?? "";

/**
 * The turn's steps, from its work items. The chat keeps its prose calm:
 * this is where the full commands, file paths and tool payloads live, on
 * demand. Work a harness's private subagent did reads under its step.
 */
function turnStepsOf(
  sources: StepSource[],
  requests: Readonly<Record<string, RuntimeRequest>>,
): TurnStep[] {
  const nested = new Map<string, WorkItem[]>();
  for (const source of sources) {
    if (source.kind !== "work" || !source.item.parentItemId) continue;
    const list = nested.get(source.item.parentItemId) ?? [];
    list.push(source.item);
    nested.set(source.item.parentItemId, list);
  }
  const steps: TurnStep[] = [];
  for (const source of sources) {
    if (source.kind === "note") {
      steps.push(noteStep(source.item));
      continue;
    }
    if (source.item.parentItemId) continue;
    const step = stepOf(source.item, {
      requests,
      nested: nested.get(source.item.id) ?? [],
    });
    if (step) steps.push(step);
  }
  return steps;
}

function stepOf(
  item: WorkItem,
  context: {
    requests: Readonly<Record<string, RuntimeRequest>>;
    nested: WorkItem[];
  },
): TurnStep | undefined {
  const timing = itemTiming(item);
  const key = item.id;
  switch (item.kind) {
    case "command": {
      const description = item.description?.trim() ?? "";
      const first = firstLineOf(item.command);
      // The agent's own words lead; the command itself is one click away.
      return {
        ...timing,
        key,
        kind: "command",
        label: description || `$ ${first || "(command)"}`,
        mono: !description,
        detail: stepDetailText(
          [
            description || item.command.includes("\n")
              ? item.command
              : undefined,
            stepDetailText(item.output || undefined),
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
        detailMono: true,
      };
    }
    case "file_change": {
      const verb =
        item.change === "created"
          ? "Created"
          : item.change === "deleted"
            ? "Deleted"
            : item.change === "renamed"
              ? "Renamed"
              : "Edited";
      return {
        ...timing,
        key,
        kind: "file_edit",
        label: `${verb} ${item.path || "a file"}`,
        mono: true,
        filePath:
          item.path && item.change !== "deleted" ? item.path : undefined,
      };
    }
    case "tool_call": {
      const toolName = stepToolName(item);
      if (HIDDEN_STEP_TOOLS.has(toolName)) return undefined;
      const started = backgroundStart(toolName, item.input);
      if (started)
        return {
          ...timing,
          key,
          finished: true,
          kind: "background",
          label: started.description,
          background: { ref: item.id, ...started },
          detail: started.command,
          detailMono: true,
        };
      const pretty = toolStepLabel(toolName, item.input);
      return {
        ...timing,
        key,
        kind: "tool",
        label: item.description?.trim() || pretty.label,
        mono: !item.description?.trim() && pretty.mono,
        toolName,
        detail: toolStepDetail(
          toolName,
          item.input,
          item.error ? { error: item.error } : item.result,
        ),
        detailMono: !DESKTOP_STEP_TOOLS.has(toolName),
      };
    }
    case "subagent":
      return {
        ...timing,
        key,
        kind: "subagent",
        label: `Subagent: ${firstLineOf(item.title) || "delegated work"}`,
        detail: stepDetailText(
          [
            context.nested
              .map((child) => nestedLine(child))
              .filter(Boolean)
              .join("\n"),
            item.result ?? undefined,
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
      };
    case "reasoning": {
      const text = item.text.trim();
      if (!text) return undefined;
      return {
        ...timing,
        key,
        kind: "reasoning",
        label: plainLine(firstLineOf(text)) || "Thinking",
        detail: text.includes("\n") ? text : undefined,
        markdown: true,
      };
    }
    case "plan":
      return {
        ...timing,
        key,
        kind: "plan",
        label: "Updated the plan",
        detail: item.steps
          .map(
            (step) =>
              `${step.status === "completed" ? "✓" : step.status === "in_progress" ? "●" : "○"} ${step.text}`,
          )
          .join("\n"),
      };
    case "request":
      return requestStep(item.id, context.requests[item.requestId], timing);
  }
}

/** A request the agent made, and how it ended. */
function requestStep(
  key: string,
  request: RuntimeRequest | undefined,
  timing: Pick<TurnStep, "startedAt" | "endedAt" | "finished" | "awaitsEnd">,
): TurnStep {
  const pending = request?.status === "pending";
  const base = {
    ...timing,
    key,
    kind: "request" as const,
    finished: !pending,
  };
  if (request?.kind === "approval") {
    const tool = request.approval?.tool;
    const what = tool
      ? stepToolName({ tool: tool.name, server: tool.server })
      : (request.approval?.action ?? request.title);
    const answer = request.response;
    const outcome =
      answer?.kind === "approval"
        ? answer.decision === "approved"
          ? answer.remember === "always"
            ? "always allowed"
            : "allowed"
          : "denied"
        : request.status === "pending"
          ? "waiting"
          : "withdrawn";
    return {
      ...base,
      label: `Asked to use ${what} (${outcome})`,
      detail: stepDetailText(
        [
          request.reason ?? undefined,
          tool ? stepDetailText(tool.input) : undefined,
        ]
          .filter(Boolean)
          .join("\n\n"),
      ),
      detailMono: true,
    };
  }
  if (request?.kind === "elicitation")
    return {
      ...base,
      label: request.elicitation?.message
        ? `Asked: ${firstLineOf(request.elicitation.message)}`
        : "Asked for your input",
    };
  return {
    ...base,
    label:
      request && request.status !== "pending" && request.status !== "resolved"
        ? "Asked you a question (closed)"
        : "Asked you a question",
    detail: request?.questions?.map((question) => question.question).join("\n"),
  };
}

/** One line of a subagent's own activity, for its step's detail. */
function nestedLine(item: WorkItem): string {
  switch (item.kind) {
    case "command":
      return `$ ${firstLineOf(item.command)}`;
    case "file_change":
      return `Edited ${item.path}`;
    case "tool_call":
      return `Used ${stepToolName(item)}`;
    default:
      return "";
  }
}

/** A note the agent wrote mid-turn, as a row of the turn's steps. */
function noteStep(item: AssistantMessageItem): TurnStep {
  const text = item.text.trim();
  const firstLine =
    text
      .split("\n")
      .map((line) => plainLine(line.replace(/^[#>*\-\s]+/, "")))
      .find(Boolean) ?? "Note";
  return {
    key: `${item.id}:note`,
    kind: "note",
    label: firstLine,
    messageId: item.id,
    // A one-line note is fully read from its row; nothing to expand.
    detail: text === firstLine ? undefined : text,
    markdown: true,
  };
}

/**
 * The step an interruption stopped, and how long it had run: the latest
 * that never finished, timed to when the turn stopped.
 */
function interruptedStep(
  turn: Turn,
  group: TimelineTurn,
): { label: string; ran?: string } | undefined {
  const work = group.entries.flatMap((entry) =>
    entry.kind === "reply" || entry.kind === "steps" ? entry.steps : [],
  );
  const stopped = [...work]
    .reverse()
    .find(
      (item) =>
        !item.parentItemId &&
        (item.status === "in_progress" || item.status === "cancelled"),
    );
  if (!stopped) return undefined;
  const step = stepOf(stopped, { requests: {}, nested: [] });
  if (!step || step.background) return undefined;
  const stoppedAt = epoch(turn.completedAt ?? turn.updatedAt);
  const ran =
    step.startedAt !== undefined && stoppedAt !== undefined
      ? stoppedAt - step.startedAt
      : undefined;
  return {
    label: step.label,
    ...(ran !== undefined && ran >= 1000 ? { ran: formatElapsed(ran) } : {}),
  };
}

/** Up to three file names, then how many more. */
function changedFileNames(paths: string[]): string {
  const names = paths
    .slice(0, 3)
    .map((path) => path.slice(path.lastIndexOf("/") + 1));
  return paths.length > 3
    ? `${names.join(", ")} and ${paths.length - 3} more`
    : names.join(", ");
}

/** A run_background_command or watch_command call's command and words. */
function backgroundStart(
  toolName: string,
  toolInput: unknown,
):
  | {
      kind: ChatBackgroundCommand["kind"];
      command: string;
      description: string;
    }
  | undefined {
  const tool = toolName.slice(toolName.lastIndexOf("/") + 1);
  const kind =
    tool === "run_background_command"
      ? "command"
      : tool === "watch_command"
        ? "watch"
        : undefined;
  if (!kind) return undefined;
  const input = asRecord(toolInput);
  // Normalized the way the host records the process, so the two pair up.
  const command =
    typeof input?.command === "string" ? input.command.trim() : "";
  if (!command) return undefined;
  const description =
    (typeof input?.description === "string"
      ? input.description.replace(/\s+/g, " ").trim()
      : "") || command.replace(/\s+/g, " ").slice(0, 80);
  return { kind, command, description };
}

/**
 * Pairs each background step with the process it started: the n-th step
 * for a command and description matches the n-th process for them.
 */
function assignBackgroundCommands(
  views: TurnView[],
  commands: ChatBackgroundCommand[],
): Map<string, ChatBackgroundCommand> {
  const assigned = new Map<string, ChatBackgroundCommand>();
  if (commands.length === 0) return assigned;
  const queues = new Map<string, ChatBackgroundCommand[]>();
  for (const command of commands) {
    const key = `${command.kind}\u0000${command.command}\u0000${command.description}`;
    queues.set(key, [...(queues.get(key) ?? []), command]);
  }
  for (const view of views)
    for (const entry of view.group.entries) {
      if (entry.kind !== "reply" && entry.kind !== "steps") continue;
      for (const item of entry.steps) {
        if (item.kind !== "tool_call") continue;
        const started = backgroundStart(stepToolName(item), item.input);
        if (!started) continue;
        const key = `${started.kind}\u0000${started.command}\u0000${started.description}`;
        const match = queues.get(key)?.shift();
        if (match) assigned.set(item.id, match);
      }
    }
  return assigned;
}

const BackgroundStates = createContext<Map<string, ChatBackgroundCommand>>(
  new Map(),
);

/** What a background step says: running pulses, then how it ended. */
function backgroundLabel(
  kind: ChatBackgroundCommand["kind"],
  state: ChatBackgroundCommand | undefined,
): string {
  if (kind === "watch") {
    if (state?.status === "running") return "Watching";
    if (state?.status === "finished") return "Watched until done";
    if (state?.status === "stopped") return "Stopped watching";
    return "Watched";
  }
  if (state?.status === "running") return "Running in background";
  if (state?.status === "stopped") return "Stopped command in background";
  if (state?.exitCode)
    return `Command failed in background (exit ${state.exitCode})`;
  return "Ran command in background";
}

/** A note's first line reads as plain text in its row: no `**`, backticks or link syntax. */
export function plainLine(line: string): string {
  return line
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|`)/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?=[^\w*]|$)/g, "$1$2")
    .trim();
}

/**
 * The expandable event log under an assistant reply: a muted "N steps"
 * line, open while the turn runs so the work reads as it happens, closed
 * once it has answered. Opening or closing it by hand sticks. Each step is
 * a row that itself stays collapsed (payloads are long and technical)
 * until clicked; a lone step is its own row, with no line to open. MCP
 * tool rows show the connector's icon when the host can resolve one.
 */
function TurnSteps({
  steps,
  live = false,
  defaultExpanded = false,
  resolveToolIcon,
  onFileClick,
}: {
  steps: TurnStep[];
  /** The turn is still running. */
  live?: boolean;
  defaultExpanded?: boolean;
  resolveToolIcon?: (toolName: string) => string | undefined;
  onFileClick?: (
    path: string,
    modifiers?: {
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    },
  ) => void;
}) {
  const [chosen, setChosen] = useState<boolean>();
  const backgroundStates = useContext(BackgroundStates);
  useEffect(() => {
    if (defaultExpanded) setChosen(true);
  }, [defaultExpanded]);
  // The rows the list first shows are already there. A row that arrives
  // later plays its own entrance while the rows already shown keep their
  // nodes: a new step at the end, earlier work folding in above, or a
  // background command that ended moving from the running rows into the
  // list.
  const shown = useRef(false);
  useEffect(() => {
    shown.current = true;
  }, []);
  const expanded = chosen ?? live;
  if (steps.length === 0) return null;
  // A lone step is its own row. It keeps the list's structure, so a second
  // step grows the line to open it in, rather than swapping the row out.
  const lone = steps.length === 1;
  const open = lone || expanded;
  // A command still running in the background stays in view, outside the
  // fold, until it ends; then it folds in with the rest.
  const running = steps.filter(
    (step) =>
      step.background &&
      backgroundStates.get(step.background.ref)?.status === "running",
  );
  const folded = steps.filter((step) => !running.includes(step));
  return (
    // Steps are chrome around the conversation, not part of its text: a
    // drag across several replies selects the prose and skips these rows.
    // An opened payload is content again, and selectable.
    <div className="mb-1.5 select-none" data-testid="chat-turn-steps">
      <div
        className={`grid transition-[grid-template-rows,opacity] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          lone ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100"
        }`}
        inert={lone}
      >
        <div className="overflow-hidden">
          <button
            type="button"
            onClick={() => setChosen(!expanded)}
            className="flex cursor-pointer items-center gap-1 text-[11px] text-fg-faint transition-colors duration-100 hover:text-fg-muted"
            aria-expanded={expanded}
            data-testid="chat-turn-steps-toggle"
          >
            <ChevronRight
              className={`size-3 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
            />
            {`${steps.length} steps`}
          </button>
        </div>
      </div>
      {running.length > 0 && (
        <div
          className={`flex flex-col gap-0.5 border-l transition-[border-color,padding,margin] duration-200 ${lone ? "border-transparent pl-0" : "mt-1 border-border pl-2.5"}`}
        >
          {running.map((step) => (
            <StepRow
              key={step.background?.ref}
              step={step}
              enter={shown.current}
              onFileClick={onFileClick}
            />
          ))}
        </div>
      )}
      {/* Grid-rows tween (the SidebarSection pattern): the list stays
          mounted, so the collapse mirrors the expansion exactly. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div
            className={`flex flex-col gap-0.5 border-l transition-[border-color,padding,margin] duration-200 ${lone ? "border-transparent pl-0" : "mt-1 border-border pl-2.5"}`}
          >
            {folded.map((step) => (
              <StepRow
                key={step.key}
                step={step}
                enter={shown.current}
                iconUrl={
                  step.toolName ? resolveToolIcon?.(step.toolName) : undefined
                }
                onFileClick={onFileClick}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepRow({
  step,
  enter = false,
  iconUrl,
  onFileClick,
}: {
  step: TurnStep;
  /** Joined a list already on screen: plays its entrance once. */
  enter?: boolean;
  iconUrl?: string;
  onFileClick?: (
    path: string,
    modifiers?: {
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    },
  ) => void;
}) {
  const [open, setOpen] = useState(false);
  // Read once: a row that was already there never gains the entrance.
  const [entering, setEntering] = useState(enter);
  const backgroundStates = useContext(BackgroundStates);
  const background = step.background
    ? backgroundStates.get(step.background.ref)
    : undefined;
  const pulsing = background?.status === "running" || step.running === true;
  const note = step.kind === "note";
  const Icon = STEP_ICONS[step.kind];
  const expandable = Boolean(step.detail);
  // Edited-file rows click through to the file in an editor surface.
  const opensFile = Boolean(step.filePath && onFileClick);
  const interactive = expandable || opensFile;
  return (
    <div
      data-testid="chat-step"
      data-step-kind={step.kind}
      data-running={pulsing || undefined}
      data-file-path={step.filePath}
      className={`${note ? "my-0.5" : ""} ${entering ? "animate-step-in" : ""}`}
      data-message-id={step.messageId}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setEntering(false);
      }}
    >
      {/* One child: the entrance grows this box from nothing. */}
      <div>
        <button
          type="button"
          onClick={
            opensFile
              ? (event) =>
                  onFileClick?.(step.filePath as string, {
                    metaKey: event.metaKey,
                    ctrlKey: event.ctrlKey,
                    shiftKey: event.shiftKey,
                    altKey: event.altKey,
                  })
              : expandable
                ? () => setOpen((value) => !value)
                : undefined
          }
          className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left ${
            // A note is the agent talking, not a tool row: it reads as prose.
            note ? "text-xs text-fg" : "text-[11px] text-fg-muted"
          } ${
            interactive
              ? "cursor-pointer transition-colors duration-100 hover:bg-bg-inset hover:text-fg"
              : "cursor-default"
          }`}
          aria-expanded={expandable ? open : undefined}
        >
          {iconUrl ? (
            <img
              src={iconUrl}
              alt=""
              className="size-3.5 shrink-0 rounded-sm"
            />
          ) : (
            <Icon
              className={`size-3.5 shrink-0 transition-colors duration-200 ${pulsing ? "animate-pulse text-accent" : "text-fg-faint"}`}
            />
          )}
          {step.background ? (
            <span className="flex min-w-0 flex-1 items-baseline gap-1.5 truncate">
              <span
                className={pulsing ? "animate-pulse text-fg" : undefined}
                data-testid="chat-background-status"
              >
                {backgroundLabel(step.background.kind, background)}
              </span>
              <span className="truncate text-fg-faint">{step.label}</span>
            </span>
          ) : (
            <span
              className={`min-w-0 flex-1 truncate transition-colors duration-200 ${step.mono ? "font-mono" : ""} ${step.running ? "text-fg" : ""}`}
            >
              {step.label}
            </span>
          )}
          <StepDuration step={step} />
          {expandable && (
            <ChevronRight
              className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
            />
          )}
        </button>
        {/* Same grid-rows tween as the step list: payloads animate open and
          closed instead of popping in and out. */}
        {step.detail && (
          <div
            className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
              open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
            }`}
          >
            <div className="overflow-hidden" inert={!open}>
              {step.markdown ? (
                <div
                  className="cat-markdown mb-1 ml-6 mt-0.5 min-w-0 select-text break-words text-xs leading-5 text-fg-muted"
                  data-testid="chat-step-detail"
                >
                  <Markdown remarkPlugins={REMARK_PLUGINS}>
                    {step.detail}
                  </Markdown>
                </div>
              ) : (
                <pre
                  className={`mb-1 ml-6 mt-0.5 max-h-56 select-text overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 text-[11px] leading-4 text-fg-muted ${step.detailMono ? "font-mono" : "font-sans"}`}
                  data-testid="chat-step-detail"
                >
                  {step.detail}
                </pre>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * How long a step took, once that is worth saying (a second or more), or
 * how long it has been running.
 */
function StepDuration({ step }: { step: TurnStep }) {
  const now = useNow(Boolean(step.running && step.startedAt !== undefined));
  if (step.startedAt === undefined) return null;
  const ms = step.running
    ? now - step.startedAt
    : step.endedAt !== undefined
      ? step.endedAt - step.startedAt
      : undefined;
  if (ms === undefined || ms < 1000) return null;
  return (
    <span
      className="shrink-0 animate-fade-in tabular-nums text-fg-faint"
      data-testid="chat-step-duration"
    >
      {formatElapsed(ms)}
    </span>
  );
}

/** How many of the attachments the prose references inline. */
function inlineMarkerCount(
  content: string,
  attachments: ChatAttachmentView[],
): number {
  return splitAttachmentMarkers(content).filter(
    (part) => part.type === "pill" && part.index < attachments.length,
  ).length;
}

/**
 * User prose with its inline pills in place: each marker becomes the
 * matching pill (same visual as the composer, read-only, hover preview);
 * markers past the attachment list vanish. Marker-less attachments are the
 * caller's to show (a strip, a count).
 */
function InlineMessage({
  content,
  attachments,
}: {
  content: string;
  attachments: ChatAttachmentView[];
}) {
  return (
    <>
      {splitAttachmentMarkers(content).map((part, index) =>
        part.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static run list per message
          <span key={index}>{part.text}</span>
        ) : attachments[part.index] ? (
          <ContextPill
            // biome-ignore lint/suspicious/noArrayIndexKey: static run list per message
            key={index}
            view={attachments[part.index] as ChatAttachmentView}
            animateIn={false}
            testId="sent-pill"
          />
        ) : null,
      )}
    </>
  );
}

/** Marker-less attachments on a (user) message: pills in a strip. */
function AttachmentStrip({
  attachments,
}: {
  attachments: ChatAttachmentView[];
}) {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {attachments.map((attachment, index) => (
        <ContextPill
          // Attachments are append-only per message; index is stable.
          // biome-ignore lint/suspicious/noArrayIndexKey: static list
          key={index}
          view={attachment}
          animateIn={false}
          testId="sent-pill"
        />
      ))}
    </div>
  );
}

/** "Retrying in Ns" that live-ticks; flips to a spinner when due. */
function AutoRetryCountdown({ nextAtMs }: { nextAtMs: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (now >= nextAtMs) return;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(1_000, nextAtMs - now),
    );
    return () => window.clearTimeout(timer);
  }, [nextAtMs, now]);
  const seconds = Math.max(0, Math.ceil((nextAtMs - now) / 1000));
  return (
    <span
      className="flex items-center gap-1.5 text-xs text-fg-muted"
      data-testid="chat-auto-retry"
    >
      <LoaderCircle className="size-3 animate-spin" />
      {seconds > 0 ? `Retrying in ${seconds}s` : "Retrying…"}
    </span>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      className="absolute bottom-4 right-4 grid size-8 place-items-center rounded-full border border-border-strong bg-bg-overlay text-fg shadow-xl"
      onClick={() => scrollToBottom()}
      aria-label="Scroll to latest message"
    >
      <ArrowDown className="size-4" />
    </button>
  );
}

/**
 * Keep following when the scroller itself resizes, as when a question or
 * approval panel below it opens or closes. A taller scroller pulls its
 * scroll position back, which use-stick-to-bottom reads as the person
 * scrolling up, and the chat would stop following new messages.
 */
function FollowScrollerResize() {
  const { scrollRef, scrollToBottom, isAtBottom } = useStickToBottomContext();
  const following = useRef(isAtBottom);
  following.current = isAtBottom;
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let height = scroller.clientHeight;
    let resized = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const follow = (delay: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        resized = false;
        void scrollToBottom("instant");
      }, delay);
    };
    const observer = new ResizeObserver(() => {
      if (scroller.clientHeight === height) return;
      height = scroller.clientHeight;
      if (!following.current) return;
      resized = true;
      // A shrink fires no scroll event; a taller scroller's does next frame.
      follow(100);
    });
    // Runs after the library's own listener, so this undoes its escape.
    const onScroll = () => {
      if (resized) follow(1);
    };
    observer.observe(scroller);
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll);
      clearTimeout(timer);
    };
  }, [scrollRef, scrollToBottom]);
  return null;
}

/** Stop following new output when opening a notification's exact message. */
function FocusMessage({
  messageId,
  ready,
}: {
  messageId?: string;
  ready: boolean;
}) {
  const { contentRef, scrollRef, stopScroll } = useStickToBottomContext();
  useEffect(() => {
    if (!messageId || !ready) return;
    const frame = requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      const scroller = scrollRef.current;
      if (!target || !scroller) return;
      stopScroll();
      scroller.scrollTo({
        top:
          scroller.scrollTop +
          target.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top -
          12,
        behavior: "instant",
      });
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [messageId, ready, contentRef, scrollRef, stopScroll]);
  return null;
}
