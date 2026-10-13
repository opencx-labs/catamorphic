"use client";

import {
  type AgentAttachment,
  type AssistantMessageItem,
  answerRows,
  type ContextHandoffItem,
  isActiveTurnStatus,
  type NoticeItem,
  type PendingAgentMessage,
  type QueuedMessage,
  type RuntimeRequest,
  splitAttachmentMarkers,
  type TimelineEntry,
  type TimelineTurn,
  type Turn,
  type UserMessageItem,
  waitsToRun,
} from "@catamorphic/react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronRight,
  ClipboardType,
  Copy,
  FileText,
  GitFork,
  Globe,
  KeyRound,
  Link2,
  LoaderCircle,
  type LucideIcon,
  RotateCcw,
  TextQuote,
  Undo2,
} from "lucide-react";
import {
  createContext,
  Fragment,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ActivityText, useLinger } from "./activity-text.js";
import { ChatQueue, type HintComponent, TitleHint } from "./chat-queue.js";
import {
  assignBackgroundCommands,
  BackgroundStates,
  type ChatBackgroundCommand,
  hasSteps,
  interruptedStep,
  markRunning,
  STALL_AFTER_MS,
  TurnClock,
  TurnClockContext,
  TurnSteps,
  turnStepsOf,
  useNow,
} from "./chat-steps.js";
import {
  InboundMessageRow,
  type InputLinkModifiers,
  noticeText,
  QueuedInputLine,
  type SourceHref,
  TaskNotificationRows,
} from "./session-input.js";
import {
  DEFAULT_WORK_DISPLAY,
  foldsSteps,
  type StepSource,
  type TurnRow,
  turnRows,
  type WorkDisplay,
} from "./turn-rows.js";

export type { ChatBackgroundCommand } from "./chat-steps.js";
export type { WorkDisplay } from "./turn-rows.js";

const REMARK_PLUGINS = [remarkGfm];

/** What a host action resolves to: false keeps the control actionable. */
type ActionResult = undefined | boolean | Promise<undefined | boolean>;

type LinkModifiers = InputLinkModifiers;

/** Where a sent attachment shows: in place in the words, or in a strip. */
export type AttachmentPlace = "inline" | "strip";

export interface ChatTimelineProps {
  /** The conversation as turns, oldest first: `useAgentChat().timeline`. */
  timeline: TimelineTurn[];
  /** Messages this client sent that the session does not show yet. */
  pending?: PendingAgentMessage[];
  /** Turns waiting to run, editable until they start. */
  queue?: QueuedMessage[];
  /**
   * The session's runtime requests by id (`chat.state?.requests`): request
   * steps say how they ended. Pass the same object until one changes.
   */
  requests?: Readonly<Record<string, RuntimeRequest>>;
  /**
   * The turn the agent works on now; its work reads as live. Defaults to
   * the timeline's active turn, the same one as `chat.activeTurn`.
   */
  activeTurnId?: string | null;
  /** Live activity line ("Thinking...", tool progress) shown under the turns. */
  activity?: string;
  /**
   * When the running turn started (ISO); the activity line counts from it.
   * Defaults to the active turn's start.
   */
  activityStartedAt?: string | null;
  /**
   * When the running turn last reported progress (ISO): a long silence is
   * said on the activity line. Defaults to the active turn's last activity
   * while it runs, not while it waits on someone.
   */
  activityUpdatedAt?: string | null;
  /** Older history exists before the loaded turns. */
  hasOlder?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  error?: string | null;
  /** An item to scroll to and outline (a notification's message). */
  focusMessageId?: string;
  /** How a turn's work (notes and steps) reads; see `turnRows`. */
  workDisplay?: WorkDisplay;
  emptyState?: string;
  className?: string;
  /**
   * Extra classes for the scrolled content column. Lets hosts center a
   * max-width column while the scrollbar hugs the container edge.
   */
  contentClassName?: string;
  // Actions: each control shows only when its callback is given.
  onEditQueued?: (turnId: string, text: string) => ActionResult;
  onCancelQueued?: (turnId: string) => ActionResult;
  /** Run a queued turn now: it goes next and stops the active one. */
  onSendQueuedNow?: (turnId: string) => ActionResult;
  /** A queued message entered or left inline editing (null = none). */
  onHoldQueued?: (turnId: string | null) => ActionResult;
  /** Run a failed or interrupted turn again. */
  onRetry?: (turnId: string) => void;
  /**
   * Stop the agent. A turn waiting to retry names itself, so its Stop
   * never stops another turn.
   */
  onInterrupt?: (turnId?: string) => void;
  /**
   * Connect the agent's account again, offered on a turn that failed on
   * authentication. Only pass it when the host can run that flow.
   */
  onReauth?: (turnId: string) => void;
  reauthLabel?: string;
  /**
   * "Restore to here": undo a turn and every later one, files included,
   * from the person's message. Offered on a settled turn once nothing
   * runs; resolving false (or throwing) says it did not work.
   */
  onRollback?: (turnId: string, item: UserMessageItem) => ActionResult;
  /** Fork the conversation through one of the agent's replies (the item id). */
  onFork?: (itemId: string) => void;
  onResendFailed?: (commandId: string) => void;
  onDismissFailed?: (commandId: string) => void;
  // The host's own surface.
  /** Names an agent id (agent-change notices, senders). */
  resolveAgentName?: (agentId: string) => string | undefined;
  /**
   * The host's address for where an input came from (ADR 0217): a chat in
   * another project, a terminal. Defaults to `session:`, `run:` and keys.
   */
  sourceHref?: SourceHref;
  /**
   * A link in an agent message was clicked. Hosts route it to their own
   * surface instead of the anchor default; modifier state rides along.
   * Without it, links stay plain sanitized anchors.
   */
  onLinkClick?: (url: string, modifiers: LinkModifiers) => void;
  /** Host-owned previews for sanitized Markdown links. */
  renderLink?: (props: {
    href: string;
    children: ReactNode;
    onOpen: NonNullable<ChatTimelineProps["onLinkClick"]>;
  }) => ReactNode;
  /**
   * A file path in the steps was clicked ("Edited docs/plan.md"). Hosts
   * open the file; without it the rows stay text.
   */
  onFileClick?: (path: string, modifiers?: LinkModifiers) => void;
  /**
   * Icon URL for a tool name (MCP tools are `server/tool`; the host maps
   * the server key to its connector icon). Undefined: the generic glyph.
   */
  resolveToolIcon?: (toolName: string) => string | undefined;
  /**
   * This chat's background commands, oldest first: their steps pulse while
   * they run and say how they ended.
   */
  backgroundCommands?: ChatBackgroundCommand[];
  /**
   * A sent attachment, in the words where it was placed or in the strip
   * above them. Defaults to a pill with its glyph and name.
   */
  renderAttachment?: (
    attachment: AgentAttachment,
    place: AttachmentPlace,
  ) => ReactNode;
  /** Names each control on hover; defaults to the browser's tooltip. */
  Hint?: HintComponent;
  /**
   * Hands the host the "jump to my previous message" scroll action, so a
   * composer shortcut triggers the same move as the button.
   */
  registerJumpToPreviousUserMessage?: (jump: () => void) => void;
  /** That shortcut's display form (e.g. "⇞"), shown in the button's hint. */
  jumpShortcut?: string;
}

/**
 * Render-affecting host inputs, read by rows deep in the list. A change
 * re-renders the rows that read it, memoized or not: hosts keep these
 * stable (memoized callbacks, module-level components) to keep a long
 * conversation cheap.
 */
interface TimelineHost {
  renderAttachment: NonNullable<ChatTimelineProps["renderAttachment"]>;
  Hint: HintComponent;
  resolveToolIcon?: ChatTimelineProps["resolveToolIcon"];
  resolveAgentName?: ChatTimelineProps["resolveAgentName"];
  sourceHref?: SourceHref;
  /** Which callbacks the host gave: their controls show only then. */
  opensLinks: boolean;
  opensFiles: boolean;
  forks: boolean;
}

/**
 * The host's callbacks, stable for the timeline's life: each calls the
 * latest prop, so a memoized row never holds one from an older render.
 */
interface TimelineActions {
  openLink: (url: string, modifiers: LinkModifiers) => void;
  openFile: (path: string, modifiers?: LinkModifiers) => void;
  fork: (itemId: string) => void;
  rollback: (turnId: string, item: UserMessageItem) => ActionResult;
  resend: (commandId: string) => void;
  dismiss: (commandId: string) => void;
}

const HostContext = createContext<TimelineHost>({
  renderAttachment: defaultAttachment,
  Hint: TitleHint,
  opensLinks: false,
  opensFiles: false,
  forks: false,
});

const ActionsContext = createContext<TimelineActions>({
  openLink: () => undefined,
  openFile: () => undefined,
  fork: () => undefined,
  rollback: () => undefined,
  resend: () => undefined,
  dismiss: () => undefined,
});

// Stable component identity keeps focused links and host preview state
// alive; the context hands each link the latest callbacks, so it is
// provided once at the root and updates without re-rendering any message.
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

/** Links the host opens itself keep their scheme through sanitizing. */
const HOST_LINK =
  /^(?:file|workflow|app|artifact|chat|browser|terminal|editor|diff|mcpapp|session|run):/i;
function hostUrlTransform(url: string, key: string): string {
  return key === "href" && HOST_LINK.test(url) ? url : defaultUrlTransform(url);
}

/** The agent's Markdown; parsed again only when its text changes. */
const TimelineMarkdown = memo(function TimelineMarkdown({
  text,
  opensLinks,
}: {
  text: string;
  opensLinks: boolean;
}) {
  return (
    <Markdown
      remarkPlugins={REMARK_PLUGINS}
      urlTransform={opensLinks ? hostUrlTransform : defaultUrlTransform}
      components={opensLinks ? LINK_COMPONENTS : undefined}
    >
      {text}
    </Markdown>
  );
});

/**
 * A reply's Markdown as its top-level blocks, so a streaming reply parses
 * only its last block again as words arrive, and earlier blocks keep their
 * nodes. It splits only where a new paragraph, heading, fence or rule
 * starts after a blank line outside a fence, never inside a list, quote or
 * table, and not at all when the text defines references another block
 * could use; each block then reads exactly as it would in the whole.
 */
export function markdownBlocks(text: string): string[] {
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(text)) return [text];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  let blank = false;
  for (const line of text.split("\n")) {
    const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      // A fence closes on a bare run of its own mark, at least as long.
      const closer = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line)?.[1];
      if (closer && closer[0] === fence[0] && closer.length >= fence.length)
        fence = undefined;
      current.push(line);
      continue;
    }
    const startsBlock =
      blank && /^\S/.test(line) && !/^([-*+]\s|\d+[.)]\s|>|\|)/.test(line);
    if (startsBlock && current.length > 0) {
      blocks.push(current.join("\n"));
      current = [];
    }
    if (opener) fence = opener;
    blank = line.trim() === "";
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

/** A reply's prose, block by block (see `markdownBlocks`). */
function ReplyMarkdown({
  text,
  opensLinks,
}: {
  text: string;
  opensLinks: boolean;
}) {
  return (
    <>
      {markdownBlocks(text).map((block, index) => (
        // Blocks only grow at the end: a block keeps its place. The line
        // break between blocks is the one the whole would have.
        // biome-ignore lint/suspicious/noArrayIndexKey: blocks are append-only
        <Fragment key={index}>
          {index > 0 && "\n"}
          <TimelineMarkdown text={block} opensLinks={opensLinks} />
        </Fragment>
      ))}
    </>
  );
}

const linkedMarkdown = (text: string) => (
  <TimelineMarkdown text={text} opensLinks />
);
const plainMarkdown = (text: string) => (
  <TimelineMarkdown text={text} opensLinks={false} />
);

/**
 * Whether the timeline is already on screen: work that joins it later
 * opens its own height, while what a chat opens with is simply there.
 */
const OnScreen = createContext<{ readonly current: boolean }>({
  current: false,
});

const NO_REQUESTS: Readonly<Record<string, RuntimeRequest>> = {};
const NO_BACKGROUND: ReadonlyMap<string, ChatBackgroundCommand> = new Map();

/**
 * A turn's rows, worked out once per turn: a turn the timeline hands back
 * unchanged (the same object) keeps its rows, so its row views skip.
 */
interface TurnView {
  group: TimelineTurn;
  rows: TurnRow[];
  /** The work display its rows were worked out for. */
  display: WorkDisplay;
  /** The turn is still running: its work reads live. */
  live: boolean;
}

/**
 * Presentational conversation log (ADR 0197): each turn reads as its
 * input, its work, then its answer; notices as quiet dividers; failed and
 * interrupted turns close with their outcome; the editable outgoing queue,
 * live activity and stick-to-bottom scrolling. Owns no chat state: feed
 * it from `useAgentChat`.
 */
export function ChatTimeline(props: ChatTimelineProps) {
  const {
    timeline,
    pending = [],
    queue,
    requests = NO_REQUESTS,
    activeTurnId,
    activity,
    activityStartedAt,
    activityUpdatedAt,
    hasOlder = false,
    isLoadingOlder = false,
    onLoadOlder,
    error,
    focusMessageId,
    workDisplay = DEFAULT_WORK_DISPLAY,
    emptyState = "Ask the agent to build or change your project.",
    className = "",
    contentClassName = "",
    onEditQueued,
    onCancelQueued,
    onSendQueuedNow,
    onHoldQueued,
    onRetry,
    onInterrupt,
    onReauth,
    reauthLabel,
    onRollback,
    onFork,
    onResendFailed,
    onDismissFailed,
    resolveAgentName,
    sourceHref,
    onLinkClick,
    renderLink,
    onFileClick,
    resolveToolIcon,
    backgroundCommands,
    renderAttachment = defaultAttachment,
    Hint = TitleHint,
    registerJumpToPreviousUserMessage,
    jumpShortcut,
  } = props;
  const latest = useRef(props);
  latest.current = props;
  const [actions] = useState<TimelineActions>(() => ({
    openLink: (url, modifiers) => latest.current.onLinkClick?.(url, modifiers),
    openFile: (path, modifiers) =>
      latest.current.onFileClick?.(path, modifiers),
    fork: (itemId) => latest.current.onFork?.(itemId),
    rollback: (turnId, item) => latest.current.onRollback?.(turnId, item),
    resend: (commandId) => latest.current.onResendFailed?.(commandId),
    dismiss: (commandId) => latest.current.onDismissFailed?.(commandId),
  }));
  const opensLinks = Boolean(onLinkClick);
  const opensFiles = Boolean(onFileClick);
  const forks = Boolean(onFork);
  const host = useMemo<TimelineHost>(
    () => ({
      renderAttachment,
      Hint,
      resolveToolIcon,
      resolveAgentName,
      sourceHref,
      opensLinks,
      opensFiles,
      forks,
    }),
    [
      renderAttachment,
      Hint,
      resolveToolIcon,
      resolveAgentName,
      sourceHref,
      opensLinks,
      opensFiles,
      forks,
    ],
  );

  const activeTurn =
    activeTurnId === undefined
      ? timeline.find(
          (group) => group.turn && isActiveTurnStatus(group.turn.status),
        )?.turn
      : timeline.find((group) => group.turn && group.turn.id === activeTurnId)
          ?.turn;
  const activeId =
    activeTurnId === undefined ? (activeTurn?.id ?? null) : activeTurnId;
  const startedAt =
    activityStartedAt === undefined ? activeTurn?.startedAt : activityStartedAt;
  const updatedAt =
    activityUpdatedAt !== undefined
      ? activityUpdatedAt
      : activeTurn?.status === "running" && !activeTurn.cancellationRequested
        ? (activeTurn.activityAt ?? activeTurn.startedAt)
        : undefined;
  const viewCache = useRef(new WeakMap<TimelineTurn, TurnView>());
  const views: TurnView[] = timeline.map((group) => {
    const live = Boolean(group.turn && group.turn.id === activeId);
    const cached = viewCache.current.get(group);
    if (
      cached &&
      cached.live === live &&
      cached.display.live === workDisplay.live &&
      cached.display.settled === workDisplay.settled
    )
      return cached;
    const view: TurnView = {
      group,
      live,
      display: workDisplay,
      rows: turnRows(group, { live, display: workDisplay }),
    };
    viewCache.current.set(group, view);
    return view;
  });
  // The running turn's clock rides its latest steps line: the work in
  // progress, or the latest note's steps until more work follows it.
  let clockRow: string | undefined;
  for (const view of views) {
    if (!view.live) continue;
    for (const row of view.rows)
      if (row.kind !== "entry" && hasSteps(row.steps))
        clockRow = rowKey(view.group, row);
  }
  const clockTimes = useMemo(
    () => ({ startedAt, updatedAt }),
    [startedAt, updatedAt],
  );
  const latestTurnId = [...timeline].reverse().find((group) => group.turn)
    ?.turn?.id;
  const working = Boolean(activeId);
  const hasUserMessages =
    pending.length > 0 ||
    timeline.some((group) =>
      group.entries.some((entry) => entry.kind === "input"),
    );
  const backgroundStates = useMemo(
    () =>
      backgroundCommands?.length
        ? assignBackgroundCommands(timeline, backgroundCommands)
        : NO_BACKGROUND,
    [timeline, backgroundCommands],
  );
  // Links re-render with their message, unless the host's handlers change.
  const links = useMemo(
    () => ({ onLinkClick, renderLink }),
    [onLinkClick, renderLink],
  );
  const folding = useFoldingNotes(views);
  const onScreen = useRef(false);
  useEffect(() => {
    onScreen.current = true;
  }, []);
  // The message about to start reads in the conversation, still withdrawable.
  const starting = timeline.find(
    (group) => group.turn && waitsToRun(group.turn),
  )?.turn;
  const foldSteps = foldsSteps(workDisplay);
  const empty =
    timeline.length === 0 &&
    pending.length === 0 &&
    !activity &&
    !queue?.length;
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
          className={
            undone
              ? "cat-settled flex flex-col gap-3 opacity-50"
              : view.live
                ? "contents"
                : // A settled turn out of view is skipped by style and layout.
                  "cat-settled flex flex-col gap-3"
          }
          data-turn-id={turn?.id}
          data-turn-undone={undone || undefined}
        >
          {row.kind === "entry" && row.entry.kind === "input" ? (
            // Rendered here, not through the row view, so a pending
            // message's node and its item's are the same element.
            <UserMessage
              item={row.entry.item}
              focused={row.entry.item.id === focusMessageId}
              restoreTurnId={
                onRollback &&
                turn &&
                !working &&
                !undone &&
                turn.status !== "cancelled" &&
                row.entry.item.id === turn.inputItemId
                  ? turn.id
                  : undefined
              }
            />
          ) : (
            <TurnRowView
              row={row}
              view={view}
              requests={requests}
              focusMessageId={focusMessageId}
              foldSteps={foldSteps}
              folding={folding}
              clock={key === clockRow}
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
          onInterrupt={onInterrupt}
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
          resendable={Boolean(onResendFailed)}
          dismissable={Boolean(onDismissFailed)}
        />
      </div>,
    );
  }
  return (
    <HostContext.Provider value={host}>
      <ActionsContext.Provider value={actions}>
        <LinkContext.Provider value={links}>
          <BackgroundStates.Provider value={backgroundStates}>
            <TurnClockContext.Provider value={clockTimes}>
              <OnScreen.Provider value={onScreen}>
                <StickToBottom
                  className={`cat-timeline relative overflow-hidden ${className}`}
                  initial="smooth"
                  // The browser holds the latest message in place as the
                  // conversation grows (see PinToBottom); script only
                  // catches up where it cannot, at once, never by a
                  // spring that lays the page out every frame.
                  resize="instant"
                  role="log"
                >
                  <StickToBottom.Content
                    className={`flex min-h-full flex-col gap-3 p-5 ${contentClassName}`}
                  >
                    {hasOlder && onLoadOlder && (
                      <LoadOlder
                        loading={isLoadingOlder}
                        onLoad={onLoadOlder}
                      />
                    )}
                    {empty && (
                      <div className="m-auto max-w-sm text-center text-sm leading-6 text-fg-muted">
                        {emptyState}
                      </div>
                    )}
                    {conversation}
                    <ActivityLine
                      activity={activity}
                      // With no steps line yet, a silence reads above it.
                      turnLine={Boolean(activeId) && clockRow === undefined}
                      startingId={
                        starting && !activeId && onCancelQueued
                          ? starting.id
                          : undefined
                      }
                      onCancel={onCancelQueued}
                    />
                    {queue && queue.length > 0 && (
                      <ChatQueue
                        queue={queue}
                        onEdit={onEditQueued}
                        onCancel={onCancelQueued}
                        onSendNow={onSendQueuedNow}
                        onHold={onHoldQueued}
                        Hint={Hint}
                        renderContent={queuedContent}
                        renderAttachments={queuedAttachments}
                        renderInput={(queued) => (
                          <QueuedInputLine
                            queued={queued}
                            resolveAgentName={resolveAgentName}
                          />
                        )}
                      />
                    )}
                    {error && (
                      <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
                        {error}
                      </div>
                    )}
                    <div aria-hidden className="cat-scroll-anchor" />
                  </StickToBottom.Content>
                  {hasUserMessages && (
                    <JumpToPreviousUserMessage
                      register={registerJumpToPreviousUserMessage}
                      shortcut={jumpShortcut}
                    />
                  )}
                  <FocusMessage
                    messageId={focusMessageId}
                    ready={Boolean(
                      focusMessageId &&
                        timeline.some((group) =>
                          group.entries.some((entry) =>
                            entry.kind === "notifications"
                              ? entry.items.some(
                                  (item) => item.id === focusMessageId,
                                )
                              : entryId(entry) === focusMessageId,
                          ),
                        ),
                    )}
                  />
                  <ScrollToLatest />
                  <FollowScrollerResize />
                  <PinToBottom />
                </StickToBottom>
              </OnScreen.Provider>
            </TurnClockContext.Provider>
          </BackgroundStates.Provider>
        </LinkContext.Provider>
      </ActionsContext.Provider>
    </HostContext.Provider>
  );
}

/** The item id an entry reads at, for focus and deep links. */
function entryId(entry: TimelineEntry): string {
  switch (entry.kind) {
    case "answer":
      return entry.id;
    case "steps":
      return entry.steps[0]?.id ?? "";
    case "notifications":
      return entry.items[0]?.id ?? "";
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

/**
 * One of a turn's rows. Its inputs keep their identity while the turn is
 * unchanged (`TurnView`), so an update elsewhere in the chat skips it.
 */
const TurnRowView = memo(function TurnRowView({
  row,
  view,
  requests,
  focusMessageId,
  foldSteps,
  folding,
  clock,
}: {
  row: TurnRow;
  view: TurnView;
  requests: Readonly<Record<string, RuntimeRequest>>;
  focusMessageId?: string;
  foldSteps: boolean;
  folding: ReadonlyMap<string, InPlace>;
  /** Its steps line carries the running turn's clock. */
  clock: boolean;
}) {
  const host = useContext(HostContext);
  const actions = useContext(ActionsContext);
  // Live work and the reply it becomes render alike, so the node that
  // showed the steps gains the prose in place instead of remounting.
  if (row.kind === "steps" || row.kind === "reply") {
    const reply = row.kind === "reply" ? row : undefined;
    return (
      <>
        {(reply?.folded ?? []).map((note) => {
          const was = folding.get(note.id);
          if (!was) return null;
          return (
            <div
              key={`folding:${note.id}`}
              aria-hidden
              inert
              className="cat-fold-away"
            >
              {/* The note as it read in place, steps and all, so the
                  whole of it closes up rather than its steps first. */}
              <AgentMessage
                item={note}
                steps={was.steps}
                live={was.live}
                requests={requests}
                foldSteps={foldSteps}
                still
              />
            </div>
          );
        })}
        <AgentMessage
          item={reply?.item}
          steps={row.steps}
          live={view.live}
          answer={reply?.answer ?? false}
          openWork={
            reply?.folded.some((note) => note.id === focusMessageId) ?? false
          }
          focused={reply !== undefined && reply.item.id === focusMessageId}
          requests={requests}
          foldSteps={foldSteps}
          clock={clock}
        />
      </>
    );
  }
  const entry = row.entry;
  const onOpen = host.opensLinks ? actions.openLink : undefined;
  switch (entry.kind) {
    case "input":
      return (
        <UserMessage
          item={entry.item}
          focused={entry.item.id === focusMessageId}
        />
      );
    case "inbound":
      return (
        <InboundMessageRow
          item={entry.item}
          onOpen={onOpen}
          resolveAgentName={host.resolveAgentName}
          sourceHref={host.sourceHref}
          focused={entry.item.id === focusMessageId}
        />
      );
    case "notifications":
      return (
        <TaskNotificationRows
          items={entry.items}
          onOpen={onOpen}
          sourceHref={host.sourceHref}
          focusMessageId={focusMessageId}
        />
      );
    case "answer":
      return <AnswerCard entry={entry} />;
    case "notice":
      return <NoticeLine item={entry.item} />;
    case "handoff":
      return <HandoffLine item={entry.item} />;
  }
});

/** How long a folding note stays on screen: its fold-away animation. */
const FOLD_AWAY_MS = 220;

/** How a note read in place: its steps, and whether its turn was running. */
interface InPlace {
  steps: StepSource[];
  live: boolean;
}

/**
 * Notes that were in place a moment ago and have just folded into their
 * answer's steps (the turn settled, or the setting changed). They stay on
 * screen for the fold-away animation, as they read in place (their steps
 * included), so settling closes them up instead of snapping the
 * conversation shorter.
 */
function useFoldingNotes(views: TurnView[]): ReadonlyMap<string, InPlace> {
  const inPlace = useRef<Map<string, InPlace>>(new Map());
  const [folding, setFolding] = useState<
    ReadonlyMap<string, InPlace & { until: number }>
  >(() => new Map());
  const shown = new Map<string, InPlace>();
  const foldedIds: string[] = [];
  for (const view of views)
    for (const row of view.rows) {
      if (row.kind !== "reply") continue;
      shown.set(row.item.id, { steps: row.steps, live: view.live });
      for (const note of row.folded) foldedIds.push(note.id);
    }
  // Notes in place at the last commit that fold now. Their stand-ins
  // render in this same commit: the conversation is never laid out without
  // them, even for a layout read between two commits, which would pull the
  // scroll back by their height.
  const arrived = foldedIds.filter(
    (id) => !folding.has(id) && inPlace.current.has(id),
  );
  if (arrived.length > 0) {
    const next = new Map(folding);
    const until = Date.now() + FOLD_AWAY_MS;
    for (const id of arrived) {
      const was = inPlace.current.get(id);
      if (was) next.set(id, { ...was, until });
    }
    setFolding(next);
  }
  // How each note reads now, for the next render to fold from.
  useLayoutEffect(() => {
    inPlace.current = shown;
  });
  // Each stand-in goes once its fold-away has played.
  useEffect(() => {
    if (folding.size === 0) return;
    const due = Math.min(...[...folding.values()].map((note) => note.until));
    const timer = window.setTimeout(
      () => {
        const now = Date.now() + 16;
        setFolding((current) => {
          const kept = new Map(
            [...current].filter(([, note]) => note.until > now),
          );
          return kept.size === current.size ? current : kept;
        });
      },
      Math.max(0, due - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [folding]);
  return folding;
}

/**
 * Walks the conversation upward one user message per click: each press
 * scrolls the nearest user message above the current view to the top,
 * where its answer starts. The everyday use: "what did I even ask?"
 * while multitasking. A host's composer shortcut can do the same move.
 */
function JumpToPreviousUserMessage({
  register,
  shortcut,
}: {
  register?: (jump: () => void) => void;
  shortcut?: string;
}) {
  const { Hint } = useContext(HostContext);
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
    <Hint label="Jump to your previous message" shortcut={shortcut}>
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
    </Hint>
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
  // transition-[opacity,translate], not transform: Tailwind v4's
  // translate-y-* sets the individual `translate` property.
  return `motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"}`;
}

/**
 * A message's actions beside it: shown on hover or focus, and always on a
 * touch screen, where nothing hovers.
 */
const MESSAGE_ACTIONS =
  "opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/msg:opacity-100 pointer-coarse:opacity-100";

const ICON_BUTTON =
  "grid size-6 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg";

interface UserMessageProps {
  /** The message as the session holds it. */
  item?: UserMessageItem;
  /** Sent from here and not in the session yet: shown at once. */
  pending?: PendingAgentMessage;
  focused?: boolean;
  /** The turn "Restore to here" undoes, when it is offered. */
  restoreTurnId?: string;
  resendable?: boolean;
  dismissable?: boolean;
}

/**
 * The person's own message (right). What an agent, a workflow or Work
 * delivered is not this: it reads as a row of its own (ADR 0217).
 */
const UserMessage = memo(function UserMessage({
  item,
  pending,
  focused = false,
  restoreTurnId,
  resendable = false,
  dismissable = false,
}: UserMessageProps) {
  const actions = useContext(ActionsContext);
  const enterClasses = useEntered();
  const text = item?.text ?? pending?.text ?? "";
  const attachments = item?.attachments ?? pending?.attachments ?? [];
  const failed = pending?.status === "failed";
  return (
    <article
      data-message-id={item?.id}
      tabIndex={-1}
      data-user-message
      data-testid="chat-user-message"
      data-pending-message={pending?.status}
      className={`group/msg relative ml-auto max-w-[85%] rounded-xl rounded-br-sm border px-3 py-2 text-sm ${enterClasses} ${
        failed ? "border-danger/40 bg-danger/5" : "border-info/30 bg-info/10"
      } ${focused ? "outline outline-1 outline-accent/50" : ""}`}
    >
      <AttachmentStrip text={text} attachments={attachments} />
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
          {resendable && (
            <button
              type="button"
              onClick={() => actions.resend(pending.commandId)}
              className="cursor-pointer text-accent hover:underline"
              data-testid="chat-resend"
            >
              Send again
            </button>
          )}
          {dismissable && (
            <button
              type="button"
              onClick={() => actions.dismiss(pending.commandId)}
              className="cursor-pointer text-fg-muted hover:text-fg"
            >
              Dismiss
            </button>
          )}
        </div>
      )}
      {item && restoreTurnId && (
        <RestoreToHere
          onConfirm={() => actions.rollback(restoreTurnId, item)}
        />
      )}
    </article>
  );
}, sameUserMessage);

/** Handlers are not compared: they reach the host through the actions. */
function sameUserMessage(
  previous: UserMessageProps,
  next: UserMessageProps,
): boolean {
  return (
    previous.item === next.item &&
    previous.pending === next.pending &&
    previous.focused === next.focused &&
    previous.restoreTurnId === next.restoreTurnId &&
    previous.resendable === next.resendable &&
    previous.dismissable === next.dismissable
  );
}

/**
 * "Restore to here": undo this message's turn and everything after it,
 * files included. Confirms in place first: it cannot be redone.
 */
function RestoreToHere({ onConfirm }: { onConfirm: () => ActionResult }) {
  const { Hint } = useContext(HostContext);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const confirm = async () => {
    setBusy(true);
    setFailed(false);
    try {
      if ((await onConfirm()) === false) setFailed(true);
      else setConfirming(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };
  if (confirming)
    return (
      <div
        className="mt-2 flex flex-wrap items-center gap-2 border-t border-info/20 pt-2 text-xs"
        data-testid="chat-restore-confirm"
      >
        <span
          className={`min-w-0 flex-1 ${failed ? "text-danger" : "text-fg-muted"}`}
          aria-live="polite"
        >
          {failed
            ? "That did not work. Try again."
            : "Undo this message and everything after it? The files it changed go back too."}
        </span>
        <button
          type="button"
          disabled={busy}
          onClick={() => void confirm()}
          className="flex cursor-pointer items-center gap-1 rounded-md bg-accent px-2 py-1 font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          data-testid="chat-restore-confirm-button"
        >
          {busy && <LoaderCircle className="size-3 animate-spin" />}
          Restore
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setConfirming(false);
            setFailed(false);
          }}
          className="cursor-pointer rounded-md px-2 py-1 text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
        >
          Cancel
        </button>
      </div>
    );
  return (
    // The pr-2 bridges the gap to the button so the hover never blinks.
    <span
      className={`absolute bottom-0 right-full flex items-center pr-2 ${MESSAGE_ACTIONS}`}
    >
      <Hint label="Restore to here: undo this message and everything after it">
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className={ICON_BUTTON}
          aria-label="Restore to here"
          data-testid="chat-restore"
        >
          <Undo2 className="size-3" />
        </button>
      </Hint>
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
  /** Part of the turn that is still running: its steps read open, unless folded. */
  live?: boolean;
  answer?: boolean;
  openWork?: boolean;
  focused?: boolean;
  requests: Readonly<Record<string, RuntimeRequest>>;
  /** Steps stay behind their line until opened (see `foldsSteps`). */
  foldSteps: boolean;
  /** Its steps line carries the running turn's clock. */
  clock?: boolean;
  /** A stand-in for a note on its way out: shown as it was, nothing enters. */
  still?: boolean;
}

const AgentMessage = memo(function AgentMessage({
  item,
  steps,
  live = false,
  answer = false,
  openWork = false,
  focused = false,
  requests,
  foldSteps,
  clock = false,
  still = false,
}: AgentMessageProps) {
  const host = useContext(HostContext);
  const actions = useContext(ActionsContext);
  const enterClasses = useEntered(still);
  const onScreen = useContext(OnScreen);
  const [bornLive] = useState(
    () => !still && (!item || item.status === "in_progress"),
  );
  // Work that joins a running turn on screen opens its own height.
  const [joined] = useState(() => !still && live && onScreen.current);
  const built = turnStepsOf(steps, { requests, sourceHref: host.sourceHref });
  const shown = live && !item ? markRunning(built) : built;
  const text = item?.text ?? "";
  const writing = item?.status === "in_progress";
  const { Hint } = host;
  return (
    <article
      data-message-id={item?.id}
      tabIndex={item ? -1 : undefined}
      data-live-work={!item || undefined}
      data-answer={answer || undefined}
      className={`group/msg relative mr-auto max-w-[85%] text-sm ${enterClasses} ${
        focused ? "rounded-md outline outline-1 outline-accent/50" : ""
      }`}
    >
      {/* Copy and fork from this reply. The pl-2 bridges the gap between
          the message edge and the buttons: without it the pointer leaves
          the group mid-crossing and the reveal blinks. */}
      {item && !writing && text.trim() && (
        <span
          className={`absolute bottom-0 left-full flex items-center gap-0.5 pl-2 ${MESSAGE_ACTIONS}`}
        >
          <CopyMessageButton content={text} />
          {host.forks && (
            <Hint label="Fork the chat from here">
              <button
                type="button"
                onClick={() => actions.fork(item.id)}
                className={ICON_BUTTON}
                aria-label="Fork the conversation from this message"
                data-testid="chat-fork"
              >
                <GitFork className="size-3" />
              </button>
            </Hint>
          )}
        </span>
      )}
      <TurnSteps
        steps={shown}
        live={live}
        fold={foldSteps}
        clock={clock}
        enter={joined}
        defaultExpanded={openWork}
        resolveToolIcon={host.resolveToolIcon}
        onFileClick={host.opensFiles ? actions.openFile : undefined}
        onLinkClick={host.opensLinks ? actions.openLink : undefined}
        renderMarkdown={host.opensLinks ? linkedMarkdown : plainMarkdown}
      />
      {text.trim() && (
        <Growing active={writing} enter={joined || (live && !still)}>
          <div
            className={`cat-markdown min-w-0 break-words leading-6 ${bornLive ? "cat-fade-in" : ""}`}
          >
            <ReplyMarkdown text={text} opensLinks={host.opensLinks} />
          </div>
        </Growing>
      )}
    </article>
  );
}, sameAgentMessage);

/** How long a growing reply takes to open each new line's place. */
const GROW_MS = 180;
/** How long past its last growth a reply's box holds its height. */
const GROW_SETTLE_MS = GROW_MS + 60;

/**
 * Prose being written: while `active`, its box follows the text's height
 * on a short transition, so each new line opens its place instead of
 * pushing everything below it down at once. Prose that appears in a chat
 * on screen while its turn runs (`enter`) opens from nothing, written or
 * not. Once written, the box lets go of its height.
 */
function Growing({
  active,
  enter,
  children,
}: {
  active: boolean;
  enter: boolean;
  children: ReactNode;
}) {
  const box = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const onScreen = useContext(OnScreen);
  const [fromNothing] = useState(() => (active || enter) && onScreen.current);
  const [opening, setOpening] = useState(fromNothing);
  useEffect(() => {
    if (!opening) return;
    const timer = window.setTimeout(() => setOpening(false), GROW_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [opening]);
  // It keeps growing a moment past the last words, so the line they
  // opened plays out rather than snapping when the reply completes.
  const writing = useLinger(active ? true : undefined, GROW_SETTLE_MS);
  const growing = Boolean(writing.value) || opening;
  useLayoutEffect(() => {
    const outer = box.current;
    const inner = content.current;
    if (!outer || !inner) return;
    if (!growing) {
      outer.style.height = "";
      return;
    }
    if (typeof ResizeObserver === "undefined") return;
    if (fromNothing && !outer.style.height) {
      outer.style.height = "0px";
      // Read back, so the empty start is styled before the text's height.
      outer.getBoundingClientRect();
    }
    const follow = () => {
      outer.style.height = `${inner.getBoundingClientRect().height}px`;
    };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(inner);
    return () => observer.disconnect();
  }, [growing, fromNothing]);
  return (
    <div ref={box} className="cat-grow" data-growing={growing || undefined}>
      <div ref={content}>{children}</div>
    </div>
  );
}

/**
 * Re-render a message only when what it shows changed: items keep their
 * identity across events unless they changed (the reducer replaces only
 * what an event names), so a streaming turn re-renders just its tail
 * instead of re-parsing every reply's Markdown. Handlers and host inputs
 * are not props: they arrive through the timeline's contexts.
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
    previous.focused === next.focused &&
    previous.requests === next.requests &&
    previous.foldSteps === next.foldSteps &&
    previous.clock === next.clock &&
    previous.still === next.still &&
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
        {answerRows(entry).map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are fixed per answer, and questions may repeat
          <div key={index} className="min-w-0">
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
function NoticeLine({ item }: { item: NoticeItem }) {
  const { resolveAgentName } = useContext(HostContext);
  const agentId = item.data.agentId;
  const text =
    item.code === "agent_changed"
      ? typeof agentId === "string"
        ? `Switched to ${resolveAgentName?.(agentId) ?? "another agent"}`
        : "Agent changed"
      : noticeText(item, resolveAgentName);
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
  const count = Math.max(1, to - from + 1);
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
 * what gets the person unstuck, a quiet summary for an interruption, and
 * the countdown of a turn waiting to retry.
 */
function TurnOutcome({
  turn,
  group,
  latest,
  onRetry,
  onInterrupt,
  onReauth,
  reauthLabel,
}: {
  turn: Turn;
  group: TimelineTurn;
  latest: boolean;
  onRetry?: (turnId: string) => void;
  onInterrupt?: (turnId?: string) => void;
  onReauth?: (turnId: string) => void;
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
        // A turn waiting to retry counts down, and stops, wherever it is.
        retryAt={retrying ? (turn.retryAt ?? "") : null}
        onRetry={
          latest && !retrying && onRetry ? () => onRetry(turn.id) : undefined
        }
        onStop={
          retrying && onInterrupt ? () => onInterrupt(turn.id) : undefined
        }
        onReauth={
          latest && turn.error?.kind === "auth" && onReauth
            ? () => onReauth(turn.id)
            : undefined
        }
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
      className="cat-fade-in flex flex-col items-center gap-0.5 text-center text-xs text-fg-faint"
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

/** Up to three file names, then how many more. */
function changedFileNames(paths: string[]): string {
  const names = paths
    .slice(0, 3)
    .map((path) => path.slice(path.lastIndexOf("/") + 1));
  return paths.length > 3
    ? `${names.join(", ")} and ${paths.length - 3} more`
    : names.join(", ");
}

/**
 * A failed turn: the friendly explanation plus whatever gets the person
 * unstuck: Retry (in place, no re-typing), a re-connect flow for auth
 * failures, and the countdown while a transient failure retries itself.
 */
function ErrorCard({
  message,
  retryAt,
  onRetry,
  onStop,
  onReauth,
  reauthLabel,
}: {
  message: string;
  /** Waiting to retry: when it runs again ("" when it is due now). */
  retryAt: string | null;
  onRetry?: () => void;
  onStop?: () => void;
  onReauth?: () => void;
  reauthLabel?: string;
}) {
  const nextAtMs =
    retryAt === null ? undefined : retryAt ? Date.parse(retryAt) : 0;
  const counting = nextAtMs !== undefined && Number.isFinite(nextAtMs);
  return (
    <article
      className="cat-fade-in mr-auto max-w-[85%] rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-sm"
      data-testid="chat-error-card"
    >
      <div className="whitespace-pre-wrap break-words leading-6 text-fg">
        {message}
      </div>
      {(onRetry || onReauth || counting || onStop) && (
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
          {onReauth && (
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
          {counting && <AutoRetryCountdown nextAtMs={nextAtMs} />}
          {onStop && (
            <button
              type="button"
              onClick={onStop}
              className="cursor-pointer rounded-md px-2 py-1 text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              data-testid="chat-stop-retrying"
            >
              Stop
            </button>
          )}
        </div>
      )}
    </article>
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

/**
 * Copies the reply as the agent wrote it (Markdown source): what pastes
 * well into a document, an issue, or another chat.
 */
function CopyMessageButton({ content }: { content: string }) {
  const { Hint } = useContext(HostContext);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  return (
    <Hint label={copied ? "Copied" : "Copy response"}>
      <button
        type="button"
        onClick={() => {
          // No clipboard outside a secure context (a phone on the LAN).
          void navigator.clipboard
            ?.writeText(content)
            .then(() => setCopied(true));
        }}
        className={ICON_BUTTON}
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
    </Hint>
  );
}

/** Withdraw the message about to start, before the agent picks it up. */
function CancelStarting({
  turnId,
  onCancel,
  leaving,
}: {
  turnId: string;
  onCancel: (turnId: string) => ActionResult;
  leaving: boolean;
}) {
  const [cancelling, setCancelling] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        setCancelling(true);
        try {
          await onCancel(turnId);
        } finally {
          setCancelling(false);
        }
      }}
      disabled={cancelling || leaving}
      className={`ml-auto shrink-0 cursor-pointer rounded-md px-2 py-0.5 text-xs text-fg-muted transition-[color,background-color,opacity] duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-default ${
        leaving ? "opacity-0" : "cat-fade-in disabled:opacity-50"
      }`}
      data-testid="chat-cancel-starting"
    >
      Cancel
    </button>
  );
}

/** How long the activity line and the turn line take to open or close. */
const REVEAL_MS = 220;

/**
 * The agent's live line under the conversation: the spinner and what the
 * agent is doing, and nothing beside the words (the turn's clock sits on
 * its steps line). One fixed height, so neither the spinner nor anything
 * below it moves as the words change. It opens its own height when work
 * starts and closes it when the work is done, so the conversation never
 * jumps by a line. Withdrawing a message about to start sits at the far
 * end, clear of the words.
 */
function ActivityLine({
  activity,
  turnLine,
  startingId,
  onCancel,
}: {
  activity?: string;
  /** The running turn has no steps line: its silence reads here instead. */
  turnLine: boolean;
  /** The message about to start, withdrawable until the agent takes it. */
  startingId?: string;
  onCancel?: (turnId: string) => ActionResult;
}) {
  // It stays for its exit once the work it named is done, with the words
  // it last said; the timeline itself never renders again for that.
  const shown = useLinger(activity ? true : undefined, REVEAL_MS);
  const said = useRef(activity);
  if (activity) said.current = activity;
  const cancel = useLinger(startingId, REVEAL_MS);
  const line = useRef<HTMLDivElement>(null);
  const present = Boolean(shown.value && said.current);
  // Its spinner and breathing stop while it is scrolled out of view.
  useEffect(() => {
    const element = line.current;
    if (!present || !element || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting) delete element.dataset.offscreen;
      else element.dataset.offscreen = "";
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [present]);
  if (!shown.value || !said.current) return null;
  const leaving = shown.leaving;
  return (
    <div
      ref={line}
      className="cat-reveal [--cat-reveal-gap:-0.75rem]"
      data-closed={leaving || undefined}
      inert={leaving}
      aria-hidden={leaving || undefined}
    >
      <div>
        <TurnLine shown={turnLine && !leaving} />
        <div
          className="flex h-5 items-center gap-2 text-xs text-fg-muted"
          data-testid="chat-activity"
        >
          <LoaderCircle className="size-4 shrink-0 animate-spin" />
          <ActivityText text={said.current} />
          {cancel.value && onCancel && (
            <CancelStarting
              turnId={cancel.value}
              onCancel={onCancel}
              leaving={cancel.leaving}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * A running turn's clock before it has a steps line to sit on: a line of
 * its own above the activity, shown only once the turn has gone quiet, so
 * a long silence before the first step still says so. The first steps line
 * takes the clock from it.
 */
function TurnLine({ shown }: { shown: boolean }) {
  const { updatedAt } = useContext(TurnClockContext);
  const updated = updatedAt ? Date.parse(updatedAt) : Number.NaN;
  const now = useNow(shown && Number.isFinite(updated));
  const quiet = Number.isFinite(updated) ? now - updated : 0;
  const line = useLinger(
    shown && quiet >= STALL_AFTER_MS ? true : undefined,
    REVEAL_MS,
  );
  if (!line.value) return null;
  return (
    <div className="cat-reveal" data-closed={line.leaving || undefined}>
      <div>
        <div className="pb-1.5" data-testid="chat-turn-line">
          <TurnClock leaving={line.leaving} />
        </div>
      </div>
    </div>
  );
}

/** How many of the attachments the prose references inline. */
function inlineMarkerCount(
  content: string,
  attachments: readonly AgentAttachment[],
): number {
  return splitAttachmentMarkers(content).filter(
    (part) => part.type === "pill" && part.index < attachments.length,
  ).length;
}

/**
 * The person's prose with its attachments in place: each marker becomes
 * the matching attachment's pill; markers past the attachment list
 * vanish. Attachments without a marker are the strip's to show.
 */
function InlineMessage({
  content,
  attachments,
}: {
  content: string;
  attachments: readonly AgentAttachment[];
}) {
  const { renderAttachment } = useContext(HostContext);
  return (
    <>
      {splitAttachmentMarkers(content).map((part, index) => {
        const attachment =
          part.type === "pill" ? attachments[part.index] : undefined;
        return part.type === "text" ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static run list per message
          <span key={index}>{part.text}</span>
        ) : attachment ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: static run list per message
          <Fragment key={index}>
            {renderAttachment(attachment, "inline")}
          </Fragment>
        ) : null;
      })}
    </>
  );
}

/** The attachments a message has no marker for: pills in a strip. */
function AttachmentStrip({
  text,
  attachments,
  className = "mb-1.5",
}: {
  text: string;
  attachments: readonly AgentAttachment[];
  className?: string;
}) {
  const { renderAttachment } = useContext(HostContext);
  const strip = attachments.slice(inlineMarkerCount(text, attachments));
  if (strip.length === 0) return null;
  return (
    <div className={`flex flex-wrap justify-end gap-1.5 ${className}`}>
      {strip.map((attachment, index) => (
        // Attachments are append-only per message; index is stable.
        // biome-ignore lint/suspicious/noArrayIndexKey: static list
        <Fragment key={index}>{renderAttachment(attachment, "strip")}</Fragment>
      ))}
    </div>
  );
}

const queuedContent = (queued: QueuedMessage) =>
  queued.item?.kind === "user_message" ? (
    <InlineMessage
      content={queued.item.text}
      attachments={queued.item.attachments}
    />
  ) : null;

const queuedAttachments = (queued: QueuedMessage) =>
  queued.item?.kind === "user_message" ? (
    <AttachmentStrip
      text={queued.item.text}
      attachments={queued.item.attachments}
      className="mt-1.5"
    />
  ) : null;

const TEXT_SOURCE_ICONS: Record<string, LucideIcon> = {
  paste: ClipboardType,
  selection: TextQuote,
  url: Link2,
  path: FileText,
  tab: Globe,
};

/**
 * The built-in pill for a sent attachment: an image's thumbnail or the
 * kind's glyph, and its name. Hosts with previews pass `renderAttachment`.
 */
function DefaultAttachment({ attachment }: { attachment: AgentAttachment }) {
  const label =
    attachment.kind === "text" && attachment.source.type === "tab"
      ? attachment.source.title
      : attachment.name;
  const Icon =
    attachment.kind === "text"
      ? (TEXT_SOURCE_ICONS[attachment.source.type] ?? FileText)
      : FileText;
  return (
    <span
      data-testid="sent-pill"
      data-pill-kind={
        attachment.kind === "text" ? attachment.source.type : attachment.kind
      }
      title={attachment.name}
      className="inline-flex h-5 max-w-full items-center gap-1 overflow-hidden whitespace-nowrap rounded-md bg-accent/15 px-1.5 align-[-4px] text-[12px] font-medium text-accent"
    >
      {attachment.kind === "image" ? (
        <img
          src={`data:${attachment.mediaType};base64,${attachment.dataBase64}`}
          alt=""
          className="size-4 shrink-0 rounded-[3px] object-cover"
          draggable={false}
        />
      ) : (
        <Icon className="size-3.5 shrink-0" />
      )}
      <span className="max-w-52 truncate">{label}</span>
    </span>
  );
}

function defaultAttachment(attachment: AgentAttachment): ReactNode {
  return <DefaultAttachment attachment={attachment} />;
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

/**
 * While the chat follows its latest message, the browser keeps it there:
 * everything in the conversation but the anchor at its end opts out of
 * scroll anchoring, so content growing or shrinking above the anchor moves
 * the scroll with it in the same frame, with no script per frame. Scrolled
 * up, anchoring keeps what the person reads in place instead.
 */
function PinToBottom() {
  const { contentRef, isAtBottom } = useStickToBottomContext();
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    if (isAtBottom) content.dataset.pinned = "";
    else delete content.dataset.pinned;
  }, [contentRef, isAtBottom]);
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
    let correction: number | undefined;
    const frame = requestAnimationFrame(() => {
      const target = contentRef.current?.querySelector<HTMLElement>(
        `[data-message-id="${CSS.escape(messageId)}"]`,
      );
      const scroller = scrollRef.current;
      if (!target || !scroller) return;
      stopScroll();
      const place = () =>
        scroller.scrollTo({
          top:
            scroller.scrollTop +
            target.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top -
            12,
          behavior: "instant",
        });
      place();
      target.focus({ preventScroll: true });
      // Turns skipped while out of view take their real height as they
      // come into view: place the message again once they have.
      correction = requestAnimationFrame(place);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (correction !== undefined) cancelAnimationFrame(correction);
    };
  }, [messageId, ready, contentRef, scrollRef, stopScroll]);
  return null;
}
