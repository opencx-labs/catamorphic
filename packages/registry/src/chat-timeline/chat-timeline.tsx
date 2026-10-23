"use client";

import {
  type AgentAttachment,
  type AssistantMessageItem,
  answerRows,
  type ContextHandoffItem,
  isActiveTurnStatus,
  isUnreadSteer,
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
  Square,
  TextQuote,
  Undo2,
  Volume2,
  Zap,
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
import {
  ChatQueue,
  forgetHandover,
  glideFrom,
  type HintComponent,
  handoverFrom,
  recordHandover,
  sentWith,
  TitleHint,
} from "../chat-queue/chat-queue.js";
import { edgeFadeLength, fadeEdges } from "../edge-fade/edge-fade.js";
import {
  ActivityText,
  afterMotion,
  finishTransitions,
  SwapText,
  transitionPlaying,
  useLinger,
} from "./activity-text.js";
import {
  assignBackgroundCommands,
  BackgroundStates,
  type ChatBackgroundCommand,
  hasSteps,
  interruptedStep,
  markRunning,
  OnScreen,
  type OnScreenSource,
  onScreenSource,
  sameBackgroundStates,
  TurnClockContext,
  TurnLine,
  TurnSteps,
  turnStepsOf,
} from "./chat-steps.js";
import {
  endsOwnChat,
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
  /**
   * Have the agent read a message sent while it works now, not at its next
   * step: offered on the message until it is read (ADR 0240).
   */
  onSteerNow?: (itemId: string) => ActionResult;
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
  /**
   * Read one of the agent's replies aloud, as written, in its agent's
   * voice; with it, replies offer a read aloud button beside Copy.
   */
  onReadAloud?: (input: {
    itemId: string;
    text: string;
    agentId: string | null;
  }) => void;
  /**
   * The reply being read aloud, if any, and whether it is still on its
   * way: its button shows so, stays in view, and stops it.
   */
  readingAloud?: { itemId: string; preparing: boolean } | null;
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
   * A Markdown image in an agent message. An address in a reply is not the
   * person's choice to contact it, so without a host the image is named,
   * never loaded; hosts decide what may show (ADR 0277).
   */
  renderImage?: (props: { src: string; alt: string }) => ReactNode;
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
   * The person's own message as the host shows it: an element of its own
   * leading the words (a skill chip before what a skill launcher sent) and
   * the words after it, attachment markers kept. Undefined: as sent.
   */
  presentUserMessage?: (
    text: string,
  ) => { lead: ReactNode; text: string } | undefined;
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
  presentUserMessage?: ChatTimelineProps["presentUserMessage"];
  sourceHref?: SourceHref;
  /** Which callbacks the host gave: their controls show only then. */
  opensLinks: boolean;
  opensFiles: boolean;
  forks: boolean;
  readsAloud: boolean;
  readingAloud: { itemId: string; preparing: boolean } | null;
}

/**
 * The host's callbacks, stable for the timeline's life: each calls the
 * latest prop, so a memoized row never holds one from an older render.
 */
interface TimelineActions {
  openLink: (url: string, modifiers: LinkModifiers) => void;
  openFile: (path: string, modifiers?: LinkModifiers) => void;
  fork: (itemId: string) => void;
  readAloud: (input: {
    itemId: string;
    text: string;
    agentId: string | null;
  }) => void;
  rollback: (turnId: string, item: UserMessageItem) => ActionResult;
  /** Has the agent read the message now; its turn says it is stopping. */
  steerNow: (item: UserMessageItem) => ActionResult;
  resend: (commandId: string) => void;
  dismiss: (commandId: string) => void;
}

const HostContext = createContext<TimelineHost>({
  renderAttachment: defaultAttachment,
  Hint: TitleHint,
  opensLinks: false,
  opensFiles: false,
  forks: false,
  readsAloud: false,
  readingAloud: null,
});

const ActionsContext = createContext<TimelineActions>({
  openLink: () => undefined,
  openFile: () => undefined,
  fork: () => undefined,
  readAloud: () => undefined,
  rollback: () => undefined,
  steerNow: () => undefined,
  resend: () => undefined,
  dismiss: () => undefined,
});

// Stable component identity keeps focused links and host preview state
// alive; the context hands each link the latest callbacks, so it is
// provided once at the root and updates without re-rendering any message.
const LinkContext = createContext<
  Pick<ChatTimelineProps, "onLinkClick" | "renderLink" | "renderImage">
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
function TimelineImage({ src, alt }: { src?: string; alt?: string }) {
  const { renderImage } = useContext(LinkContext);
  if (src && renderImage) return renderImage({ src, alt: alt ?? "" });
  return <span className="text-fg-muted">{alt || "Image"}</span>;
}
const IMAGE_COMPONENTS = { img: TimelineImage };
const LINK_COMPONENTS = { a: TimelineLink, img: TimelineImage };

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
      components={opensLinks ? LINK_COMPONENTS : IMAGE_COMPONENTS}
    >
      {text}
    </Markdown>
  );
});

/**
 * HTML blocks that run on past blank lines (CommonMark's kinds 1 to 5):
 * how each opens, and what ends it, on its first line or a later one.
 */
const HTML_BLOCKS: ReadonlyArray<readonly [opens: RegExp, ends: RegExp]> = [
  [
    /^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i,
    /<\/(?:script|pre|style|textarea)>/i,
  ],
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<![A-Za-z]/, />/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
];

/**
 * A reply's Markdown as its top-level blocks, so a streaming reply parses
 * only its last block again as words arrive, and earlier blocks keep their
 * nodes. It splits only where a new paragraph, heading, fence or rule
 * starts after a blank line outside a fence or an HTML block that runs past
 * blank lines (`<pre>`, a comment; one not closed yet runs to the end),
 * never inside a list, quote or table, and not at all when the text
 * defines references another block could use; each block then reads
 * exactly as it would in the whole.
 */
export function markdownBlocks(text: string): string[] {
  if (/^ {0,3}\[[^\]\n]+\]:/m.test(text)) return [text];
  const blocks: string[] = [];
  let current: string[] = [];
  let fence: string | undefined;
  let html: RegExp | undefined;
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
    if (html) {
      if (html.test(line)) html = undefined;
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
    else html = htmlBlockEnd(line);
    blank = line.trim() === "";
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

/** What ends the HTML block this line opens, unless it ends on it too. */
function htmlBlockEnd(line: string): RegExp | undefined {
  for (const [opens, ends] of HTML_BLOCKS) {
    const open = opens.exec(line);
    if (open) return ends.test(line.slice(open[0].length)) ? undefined : ends;
  }
  return undefined;
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
 * A person's message's row is a container, so what sits beside the
 * message measures the room there, and it lets the sent time paint past
 * its edge where a settled row would clip it (see NARROW). Hovered or
 * focused, while its time shows, it rises over the row after it, which
 * would otherwise paint over the time hanging below it and take the
 * pointer from it (rows are flex items, so the raise needs no position).
 */
const USER_ROW =
  "@container [overflow-clip-margin:1.5rem] hover:z-[1] focus-within:z-[1]";

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
    onSteerNow,
    onHoldQueued,
    onRetry,
    onInterrupt,
    onReauth,
    reauthLabel,
    onRollback,
    onFork,
    onReadAloud,
    readingAloud = null,
    onResendFailed,
    onDismissFailed,
    resolveAgentName,
    sourceHref,
    onLinkClick,
    renderLink,
    renderImage,
    onFileClick,
    resolveToolIcon,
    backgroundCommands,
    renderAttachment = defaultAttachment,
    Hint = TitleHint,
    presentUserMessage,
    registerJumpToPreviousUserMessage,
    jumpShortcut,
  } = props;
  const latest = useRef(props);
  latest.current = props;
  // Messages the agent stops to read: the one the person interrupted for
  // and every other its turn had not read then. They say so, and offer
  // Interrupt no more, until they are read.
  const [stopping, setStopping] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [actions] = useState<TimelineActions>(() => ({
    openLink: (url, modifiers) => latest.current.onLinkClick?.(url, modifiers),
    openFile: (path, modifiers) =>
      latest.current.onFileClick?.(path, modifiers),
    fork: (itemId) => latest.current.onFork?.(itemId),
    readAloud: (input) => latest.current.onReadAloud?.(input),
    rollback: (turnId, item) => latest.current.onRollback?.(turnId, item),
    steerNow: async (item) => {
      const unread = [
        item.id,
        ...(latest.current.timeline
          .find((group) => group.turn?.id === item.turnId)
          ?.entries.flatMap((entry) =>
            entry.kind === "input" && isUnreadSteer(entry.item)
              ? [entry.item.id]
              : [],
          ) ?? []),
      ];
      setStopping((ids) => new Set([...ids, ...unread]));
      const result = await latest.current.onSteerNow?.(item.id);
      if (result === false)
        setStopping(
          (ids) => new Set([...ids].filter((id) => !unread.includes(id))),
        );
      return result;
    },
    resend: (commandId) => latest.current.onResendFailed?.(commandId),
    dismiss: (commandId) => latest.current.onDismissFailed?.(commandId),
  }));
  const opensLinks = Boolean(onLinkClick);
  const opensFiles = Boolean(onFileClick);
  const forks = Boolean(onFork);
  const readsAloud = Boolean(onReadAloud);
  const host = useMemo<TimelineHost>(
    () => ({
      renderAttachment,
      Hint,
      resolveToolIcon,
      resolveAgentName,
      presentUserMessage,
      sourceHref,
      opensLinks,
      opensFiles,
      forks,
      readsAloud,
      readingAloud,
    }),
    [
      renderAttachment,
      Hint,
      resolveToolIcon,
      resolveAgentName,
      presentUserMessage,
      sourceHref,
      opensLinks,
      opensFiles,
      forks,
      readsAloud,
      readingAloud,
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
  // Before the running turn has a steps line, the turn line keeps the
  // first one's place above the activity line, and that line takes it in
  // the same frame: it is simply there, and nothing moves (ActivityLine).
  const keepsLine = Boolean(activity) && clockRow === undefined;
  const lineKept = useRef(false);
  const lineTaker = useRef<string | undefined>(undefined);
  if (lineKept.current && activity && clockRow !== undefined)
    lineTaker.current = clockRow;
  useLayoutEffect(() => {
    lineKept.current = keepsLine;
  }, [keepsLine]);
  const latestTurnId = [...timeline].reverse().find((group) => group.turn)
    ?.turn?.id;
  const working = Boolean(activeId);
  const hasUserMessages =
    pending.length > 0 ||
    timeline.some((group) =>
      group.entries.some((entry) => entry.kind === "input"),
    );
  // Paired again as the timeline changes, and handed down only when a
  // pairing differs: every step reads it, and most events change none.
  const pairedBackground = useRef(NO_BACKGROUND);
  const backgroundStates = useMemo(() => {
    const next = backgroundCommands?.length
      ? assignBackgroundCommands(timeline, backgroundCommands)
      : NO_BACKGROUND;
    if (!sameBackgroundStates(pairedBackground.current, next))
      pairedBackground.current = next;
    return pairedBackground.current;
  }, [timeline, backgroundCommands]);
  // Waiting on work it started in the background (a test run, a watch),
  // the turn is quiet by design, as while it waits on the person: its
  // silence says nothing, so the clock does not count it.
  const waitsOnBackground = useMemo(
    () =>
      timeline.some(
        (group) =>
          group.turn?.id === activeId &&
          group.entries.some(
            (entry) =>
              (entry.kind === "reply" || entry.kind === "steps") &&
              entry.steps.some(
                (item) => backgroundStates.get(item.id)?.status === "running",
              ),
          ),
      ),
    [timeline, activeId, backgroundStates],
  );
  const clockTimes = useMemo(
    () => ({
      startedAt,
      updatedAt: waitsOnBackground ? undefined : updatedAt,
    }),
    [startedAt, updatedAt, waitsOnBackground],
  );
  // Links re-render with their message, unless the host's handlers change.
  const links = useMemo(
    () => ({ onLinkClick, renderLink, renderImage }),
    [onLinkClick, renderLink, renderImage],
  );
  const { folding, folded } = useFoldingNotes(views);
  // Work that joins the timeline on screen opens its own height, while
  // what a chat opens with, or gains while hidden, is simply there.
  const [onScreen] = useState(onScreenSource);
  // The day sent times read from: "Yesterday" once midnight passes.
  const today = useToday();
  // The message about to start reads in the conversation, still withdrawable.
  const starting = timeline.find(
    (group) => group.turn && waitsToRun(group.turn),
  )?.turn;
  const foldSteps = foldsSteps(workDisplay);
  const endedByTheirAgent = useMemo(
    () => turnsEndedOwnChat(timeline),
    [timeline],
  );
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
      const className = undone
        ? "cat-row cat-settled flex flex-col gap-3 opacity-50"
        : view.live || foldingIn(row, folding)
          ? "cat-row flex flex-col gap-3"
          : // A settled turn out of view is skipped by style and layout.
            "cat-row cat-settled flex flex-col gap-3";
      conversation.push(
        row.kind === "entry" && row.entry.kind === "input" ? (
          // Rendered here, not through the row view, so a pending
          // message's node and its item's are the same element.
          <div
            key={key}
            className={`${className} ${USER_ROW}`}
            data-turn-id={turn?.id}
            data-turn-undone={undone || undefined}
          >
            <UserMessage
              item={row.entry.item}
              focused={row.entry.item.id === focusMessageId}
              unread={view.live && isUnreadSteer(row.entry.item)}
              stopping={stopping.has(row.entry.item.id)}
              steerable={
                Boolean(onSteerNow) &&
                view.live &&
                isUnreadSteer(row.entry.item) &&
                (turn?.status === "running" || turn?.status === "waiting") &&
                !turn.cancellationRequested
              }
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
          </div>
        ) : (
          <TurnRowView
            key={key}
            className={className}
            turnId={turn?.id}
            undone={undone}
            row={row}
            view={view}
            requests={requests}
            focusMessageId={focusMessageId}
            foldSteps={foldSteps}
            folding={folding}
            clock={key === clockRow}
            placed={key === lineTaker.current}
          />
        ),
      );
    }
    if (turn)
      conversation.push(
        <TurnOutcome
          key={`outcome:${turn.id}`}
          turn={turn}
          group={view.group}
          latest={turn.id === latestTurnId}
          endedByTheirAgent={endedByTheirAgent.has(turn.id)}
          onRetry={onRetry}
          onInterrupt={onInterrupt}
          onReauth={onReauth}
          reauthLabel={reauthLabel}
        />,
      );
  });
  // Sends the queue holds (an interrupting one waits there while the agent
  // stops), by the key their items were sent with.
  const queuedSends = (queue ?? []).flatMap((queued) =>
    queued.item?.kind === "user_message" && queued.item.idempotencyKey
      ? [queued.item.idempotencyKey]
      : [],
  );
  for (const message of pending) {
    const key = `send:${message.commandId}`;
    // Its item is already on screen: the item's row is this message now.
    if (shownSends.has(key)) continue;
    // Its queued bubble is this message now, and takes over from here in
    // the same commit (handoverFrom).
    if (queuedSends.some((sent) => sent.endsWith(`:${message.commandId}`)))
      continue;
    conversation.push(
      <div key={key} className={`cat-row flex flex-col gap-3 ${USER_ROW}`}>
        <UserMessage
          pending={message}
          // Sent into the working turn: unread from the start, so the
          // message keeps its look as the session's item takes over.
          unread={
            working &&
            message.dispatch === "steer" &&
            message.status !== "failed"
          }
          resendable={Boolean(onResendFailed)}
          dismissable={Boolean(onDismissFailed)}
        />
      </div>,
    );
  }
  return (
    <HostContext.Provider value={host}>
      <ActionsContext.Provider value={actions}>
        <FoldedContext.Provider value={folded}>
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
                      // The conversation fades out where it continues, above
                      // the composer and under the header, instead of being
                      // cut at their edges (FadeEdges).
                      scrollClassName="cat-edge-fade"
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
                      <TodayContext.Provider value={today}>
                        {conversation}
                      </TodayContext.Provider>
                      <ActivityLine
                        activity={activity}
                        turnLine={clockRow === undefined}
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
                    <FadeEdges />
                    <TrackOnScreen state={onScreen} />
                  </StickToBottom>
                </OnScreen.Provider>
              </TurnClockContext.Provider>
            </BackgroundStates.Provider>
          </LinkContext.Provider>
        </FoldedContext.Provider>
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

interface TurnRowProps {
  /** The row's place in the conversation's column. */
  className: string;
  turnId?: string;
  undone: boolean;
  row: TurnRow;
  view: TurnView;
  requests: Readonly<Record<string, RuntimeRequest>>;
  focusMessageId?: string;
  foldSteps: boolean;
  folding: ReadonlyMap<string, InPlace>;
  /** Its steps line carries the running turn's clock. */
  clock: boolean;
  /** Its steps line takes the turn line's place (see ActivityLine). */
  placed: boolean;
}

/**
 * One of a turn's rows, in its place in the conversation's column. Its
 * inputs keep their identity while the turn is unchanged (`TurnView`), so
 * an update elsewhere in the chat skips it. Writing and work that join a
 * running turn on screen open their own height (see AgentMessage), and
 * the row opens the column's gap above them in the same beat, so what is
 * below slides down rather than jumping by the gap first.
 */
const TurnRowView = memo(function TurnRowView({
  className,
  turnId,
  undone,
  ...props
}: TurnRowProps) {
  const onScreen = useContext(OnScreen);
  // Read once, as AgentMessage reads its own entrance; dropped once played.
  const [opening, setOpening] = useState(
    () =>
      props.row.kind !== "entry" &&
      props.view.live &&
      !props.placed &&
      onScreen.current,
  );
  return (
    <div
      className={opening ? `${className} cat-gap-in` : className}
      data-turn-id={turnId}
      data-turn-undone={undone || undefined}
      onAnimationEnd={(event) => {
        if (event.target === event.currentTarget) setOpening(false);
      }}
    >
      <TurnRowBody {...props} />
    </div>
  );
});

function TurnRowBody({
  row,
  view,
  requests,
  focusMessageId,
  foldSteps,
  folding,
  clock,
  placed,
}: Omit<TurnRowProps, "className" | "turnId" | "undone">) {
  const host = useContext(HostContext);
  const actions = useContext(ActionsContext);
  const folded = useContext(FoldedContext);
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
              onAnimationEnd={(event) => {
                if (event.target === event.currentTarget) folded(note.id);
              }}
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
          placed={placed}
        />
      </>
    );
  }
  const entry = row.entry;
  const onOpen = host.opensLinks ? actions.openLink : undefined;
  switch (entry.kind) {
    case "input":
      // The timeline renders a person's message itself (see ChatTimeline).
      return null;
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
}

/** How long a folding note stays on screen: its fold-away animation. */
const FOLD_AWAY_MS = 220;

/**
 * How long past its fold-away a stand-in may wait for the animation's end:
 * a host without the keyframes (or a hidden chat) never sends one.
 */
const FOLD_GRACE_MS = 250;

/** A stand-in's fold-away has played: it goes. */
const FoldedContext = createContext<(noteId: string) => void>(() => undefined);

/**
 * Whether notes are still folding away in this row. It waits to settle
 * (`cat-settled`) until they have gone: the frame a row starts skipping,
 * before the browser finds it on screen, it keeps its last laid-out size,
 * which stand-ins that arrived in that same commit would make short by
 * their height, so the conversation below jumped up and back for a frame.
 */
function foldingIn(
  row: TurnRow,
  folding: ReadonlyMap<string, InPlace>,
): boolean {
  return (
    row.kind === "reply" && row.folded.some((note) => folding.has(note.id))
  );
}

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
function useFoldingNotes(views: TurnView[]): {
  folding: ReadonlyMap<string, InPlace>;
  folded: (noteId: string) => void;
} {
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
  // Each stand-in goes once its fold-away has played, at its end: on a
  // slow renderer the animation starts late, and a stand-in taken away
  // mid-fold would snap the conversation shorter by what was left of it.
  // The timer stands in where no animation plays.
  const folded = useCallback((noteId: string) => {
    setFolding((current) => {
      if (!current.has(noteId)) return current;
      const kept = new Map(current);
      kept.delete(noteId);
      return kept;
    });
  }, []);
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
      Math.max(0, due + FOLD_GRACE_MS - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [folding]);
  return { folding, folded };
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
  const { scrollRef, contentRef, isAtBottom, stopScroll } =
    useStickToBottomContext();
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
  const settling = useRef<(() => void) | undefined>(undefined);
  useEffect(() => () => settling.current?.(), []);
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
    settling.current?.();
    // Moving up lets go of the latest message, streaming or not.
    stopScroll();
    // Clear of the top edge's fade.
    const off = () =>
      target.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top -
      12 -
      edgeFadeLength(scroller);
    scroller.scrollTo({ top: scroller.scrollTop + off(), behavior: "smooth" });
    // Turns skipped while out of view take their real height as the
    // scroll brings them in, which moves the message after its place was
    // read: once the scroll ends, finish the way there. A reader's own
    // scroll, or the next jump, has the last word.
    const interrupts = ["wheel", "touchstart", "pointerdown", "keydown"];
    const stop = () => {
      settling.current = undefined;
      window.clearTimeout(fallback);
      scroller.removeEventListener("scrollend", settle);
      for (const name of interrupts)
        scroller.removeEventListener(name, stop, true);
    };
    const settle = () => {
      stop();
      const rest = off();
      if (Math.abs(rest) > 2)
        scroller.scrollTo({
          top: scroller.scrollTop + rest,
          behavior: "smooth",
        });
    };
    // Where scrollend is missing, about as long as a long smooth scroll.
    const fallback = window.setTimeout(settle, 1_000);
    settling.current = stop;
    scroller.addEventListener("scrollend", settle);
    for (const name of interrupts)
      scroller.addEventListener(name, stop, { capture: true, passive: true });
  }, [scrollRef, contentRef, stopScroll]);

  useEffect(() => {
    register?.(jump);
  }, [register, jump]);

  // One arrow at a time, in one place: away from the end, Scroll to latest
  // takes it. The shortcut jumps either way.
  if (!scrollable || !isAtBottom) return null;
  return (
    <Hint label="Jump to your previous message" shortcut={shortcut}>
      <button
        type="button"
        className={CHAT_ARROW}
        onClick={jump}
        aria-label="Jump to your previous message"
        data-testid="chat-jump-previous"
      >
        <ArrowUp className="size-4" />
      </button>
    </Hint>
  );
}

/**
 * The entrance every message plays once: a short rise and fade. A message
 * taking a place already kept for it (`rise: false`) only fades in where
 * it is, so nothing in it moves.
 */
function useEntered(already = false, { rise = true } = {}): string {
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
  if (!rise)
    return `motion-safe:transition-opacity motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${entered ? "motion-safe:opacity-100" : "motion-safe:opacity-0"}`;
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

/**
 * When the person sent a message: shown on hover or keyboard focus, and
 * on a touch screen while the message has focus (after a tap), never all
 * the time: a time beside every message would be noise. On touch a tap
 * passes through it to whatever it covers.
 */
const SENT_TIME =
  "opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 group-focus-visible/msg:opacity-100 group-has-[:focus-visible]/msg:opacity-100 pointer-coarse:group-focus-within/msg:opacity-100 pointer-coarse:pointer-events-none";

/**
 * A narrow row (a phone, a slim pane) leaves no room beside a long
 * message for "Yesterday 2:14 PM": under 26rem, the room beside a message
 * at its widest is under 62px. There the side row lets go of its
 * children: Restore to here keeps its place beside the message, and the
 * time hangs under the message's corner as a hint would, over the top of
 * what follows. The row lets it paint there (overflow-clip-margin).
 */
const NARROW = {
  side: "@max-[26rem]:contents",
  restore:
    "@max-[26rem]:absolute @max-[26rem]:bottom-0 @max-[26rem]:right-full @max-[26rem]:pr-2",
  time: "@max-[26rem]:absolute @max-[26rem]:top-full @max-[26rem]:right-0 @max-[26rem]:min-h-0 @max-[26rem]:pt-1",
  label:
    "@max-[26rem]:whitespace-nowrap @max-[26rem]:rounded-md @max-[26rem]:bg-bg-overlay @max-[26rem]:px-1.5 @max-[26rem]:py-0.5 @max-[26rem]:leading-3 @max-[26rem]:text-fg-muted @max-[26rem]:shadow-lg @max-[26rem]:ring-1 @max-[26rem]:ring-border",
};

/** When a message was sent, as the timeline says it. */
export interface SentTime {
  /**
   * Beside the message: the time today ("2:14 PM"), "Yesterday" and the
   * time, the date and time earlier this year ("Oct 12, 2:14 PM"), and the
   * date in another year ("Oct 12, 2025").
   */
  label: string;
  /** The whole date and time, for the hint. */
  full: string;
}

const SENT_FORMATS = {
  time: { hour: "numeric", minute: "2-digit" },
  thisYear: {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  },
  otherYear: { year: "numeric", month: "short", day: "numeric" },
  full: { dateStyle: "full", timeStyle: "short" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;

const sentFormatters = new Map<string, Intl.DateTimeFormat>();
const yesterdayWords = new Map<string, string>();

/** One formatter per locale and form: building them is not cheap. */
function sentFormatter(
  form: keyof typeof SENT_FORMATS,
  locale: string | undefined,
): Intl.DateTimeFormat {
  const key = `${locale ?? ""}:${form}`;
  const known = sentFormatters.get(key);
  if (known) return known;
  const made = new Intl.DateTimeFormat(locale, SENT_FORMATS[form]);
  sentFormatters.set(key, made);
  return made;
}

/** "Yesterday" in the person's language, as a label starts with it. */
function yesterdayWord(locale: string | undefined): string {
  const key = locale ?? "";
  const known = yesterdayWords.get(key);
  if (known) return known;
  const word = new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    -1,
    "day",
  );
  const made = `${word.charAt(0).toLocaleUpperCase(locale)}${word.slice(1)}`;
  yesterdayWords.set(key, made);
  return made;
}

/** The same day on the local calendar. */
function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * When a message was sent (`createdAt`, ISO), relative to `now` on the
 * local calendar and in the person's locale unless `locale` names one.
 * Undefined for a time that is not one.
 */
export function sentTime(
  iso: string,
  { now = Date.now(), locale }: { now?: number | Date; locale?: string } = {},
): SentTime | undefined {
  const sent = new Date(iso);
  if (Number.isNaN(sent.getTime())) return undefined;
  const today = new Date(now);
  const yesterday = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - 1,
  );
  const time = () => sentFormatter("time", locale).format(sent);
  const label = sameDay(sent, today)
    ? time()
    : sameDay(sent, yesterday)
      ? `${yesterdayWord(locale)} ${time()}`
      : sentFormatter(
          sent.getFullYear() === today.getFullYear() ? "thisYear" : "otherYear",
          locale,
        ).format(sent);
  return { label, full: sentFormatter("full", locale).format(sent) };
}

/** The local day the timeline reads sent times from (its midnight). */
const TodayContext = createContext<number | undefined>(undefined);

function startOfToday(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}

/**
 * Today's midnight, which turns over at the next one: a chat left open
 * overnight says "Yesterday" by morning. One timer a day; a machine that
 * slept through midnight fires it late, so coming back looks again.
 * Undefined until mounted: a host rendering on a server would otherwise
 * write times in the server's zone and locale, not the person's.
 */
function useToday(): number | undefined {
  const [today, setToday] = useState<number | undefined>(undefined);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = () => {
      clearTimeout(timer);
      setToday(startOfToday());
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      // A second past it, so the day has surely turned.
      timer = setTimeout(check, midnight.getTime() - Date.now() + 1_000);
    };
    check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
    };
  }, []);
  return today;
}

interface UserMessageProps {
  /** The message as the session holds it. */
  item?: UserMessageItem;
  /** Sent from here and not in the session yet: shown at once. */
  pending?: PendingAgentMessage;
  focused?: boolean;
  /** The turn "Restore to here" undoes, when it is offered. */
  restoreTurnId?: string;
  /** Sent while the agent works, and not read yet (ADR 0240). */
  unread?: boolean;
  /** The agent can stop its step to read it now. */
  steerable?: boolean;
  /** Its turn stops for the agent to read what it had not. */
  stopping?: boolean;
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
  unread = false,
  steerable = false,
  stopping = false,
  resendable = false,
  dismissable = false,
}: UserMessageProps) {
  const actions = useContext(ActionsContext);
  const { presentUserMessage } = useContext(HostContext);
  // A queued message whose turn just started takes over from its bubble:
  // it arrives from where the bubble was, already shown, instead of rising
  // in anew below it. Read in the commit, once the bubble has left the
  // queue and said where it was.
  const [takeover, setTakeover] = useState<DOMRect | null>(null);
  const articleRef = useRef<HTMLElement>(null);
  // Mount only: where it came from is read once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount only
  useLayoutEffect(() => {
    const from = item ? handoverFrom(`item:${item.id}`) : undefined;
    if (!item || !from) return;
    forgetHandover(`item:${item.id}`);
    // Before paint: it never shows the entrance's hidden pose.
    setTakeover(from);
  }, []);
  // Measured without the entrance's pose, which the takeover drops.
  useLayoutEffect(() => {
    if (takeover && articleRef.current) glideFrom(articleRef.current, takeover);
  }, [takeover]);
  // A send waiting in the queue (an interrupting one, ⌘↵) leaves this
  // pending bubble for its queued one, which arrives from here; so does a
  // message its turn ended without reading, queued as a turn of its own.
  const command = pending?.commandId ?? (item ? sentWith(item) : undefined);
  useLayoutEffect(
    () => () => {
      const article = articleRef.current;
      if (command && article)
        recordHandover(`send:${command}`, article.getBoundingClientRect());
    },
    [command],
  );
  const entering = useEntered();
  const enterClasses = takeover ? "" : entering;
  const text = item?.text ?? pending?.text ?? "";
  const attachments = item?.attachments ?? pending?.attachments ?? [];
  const shown = presentUserMessage?.(text);
  const failed = pending?.status === "failed";
  return (
    <article
      ref={articleRef}
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
        {shown?.lead}
        <InlineMessage
          content={shown ? shown.text : text}
          attachments={attachments}
        />
      </div>
      <UnreadLine
        unread={unread}
        stopping={stopping}
        // Not yet held by the session, a send has nothing to stop for; one
        // the chat opens with is simply there.
        already={Boolean(item) && unread}
        onSteerNow={
          item && steerable ? () => actions.steerNow(item) : undefined
        }
      />
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
      {/* A send the session does not hold yet has no time of its own. */}
      <MessageSide
        sentAt={item?.createdAt}
        onRestore={
          item && restoreTurnId
            ? () => actions.rollback(restoreTurnId, item)
            : undefined
        }
      />
    </article>
  );
}, sameUserMessage);

/**
 * Handlers are not compared: they reach the host through the actions. The
 * sent time reads the item and the timeline's day, a context, so a new day
 * re-renders the message without a prop.
 */
function sameUserMessage(
  previous: UserMessageProps,
  next: UserMessageProps,
): boolean {
  return (
    previous.item === next.item &&
    previous.pending === next.pending &&
    previous.focused === next.focused &&
    previous.restoreTurnId === next.restoreTurnId &&
    previous.unread === next.unread &&
    previous.steerable === next.steerable &&
    previous.stopping === next.stopping &&
    previous.resendable === next.resendable &&
    previous.dismissable === next.dismissable
  );
}

/**
 * Under a message sent while the agent works (ADR 0240): it is not read
 * yet, and the agent reads it at its next step. Interrupt has it stop that
 * step and read it now; every message its turn had not read then says it
 * is stopping. The line opens a moment after the message is sent, so one
 * the agent reads at once never shows it, and closes once it is read.
 */
function UnreadLine({
  unread,
  stopping,
  already,
  onSteerNow,
}: {
  unread: boolean;
  stopping: boolean;
  /** Unread as it first showed: open at once, nothing to wait for. */
  already: boolean;
  onSteerNow?: () => ActionResult;
}) {
  const { Hint } = useContext(HostContext);
  const [asking, setAsking] = useState(false);
  const [failed, setFailed] = useState(false);
  const open = useHeld(unread, UNREAD_LINE_DELAY_MS, already);
  const lineRef = useRef<HTMLDivElement>(null);
  // Its words are there while it shows and closes, never otherwise: the
  // message's text (a copy of it) is the message's alone.
  const shown = useLinger(open ? true : undefined, REVEAL_MS + 80, () =>
    transitionPlaying(
      lineRef.current?.closest(".cat-reveal"),
      "grid-template-rows",
    ),
  );
  const waiting = stopping || asking;
  const offered = Boolean(onSteerNow) && !waiting;
  // Focus inside a line that closes, or on a button that goes, rests on
  // the message rather than falling to the page.
  useLayoutEffect(() => {
    const line = lineRef.current;
    if ((!open || !offered) && line?.contains(document.activeElement))
      line.closest<HTMLElement>("article")?.focus();
  }, [open, offered]);
  const interrupt = async () => {
    if (!onSteerNow || waiting) return;
    setAsking(true);
    setFailed(false);
    try {
      if ((await onSteerNow()) === false) setFailed(true);
    } catch {
      setFailed(true);
    } finally {
      setAsking(false);
    }
  };
  return (
    <div data-testid="chat-unread-line" data-unread={unread || undefined}>
      <Reveal closed={!open} inert={!open}>
        <div ref={lineRef} className="select-none">
          {shown.value && (
            <div className="mt-1 flex min-h-5 items-center justify-end gap-1.5 text-[11px] leading-4 text-fg-faint">
              <span
                className={`transition-opacity duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${offered ? "" : "pointer-events-none opacity-0"}`}
                inert={!offered}
              >
                <span className={MESSAGE_ACTIONS}>
                  <Hint label="Interrupt: the agent stops its current step and reads this now">
                    <button
                      type="button"
                      onClick={() => void interrupt()}
                      className="flex h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 text-fg-muted transition-colors duration-150 hover:bg-accent/10 hover:text-accent"
                      aria-label="Interrupt so the agent reads this now"
                      data-testid="chat-steer-now"
                    >
                      <Zap className="size-3" />
                      Interrupt
                    </button>
                  </Hint>
                </span>
              </span>
              <SwapText
                value={waiting ? "Stopping to read it" : "Not read yet"}
                data-testid="chat-unread-state"
              />
            </div>
          )}
          {failed && (
            <p role="alert" className="mt-1 text-right text-[11px] text-danger">
              Could not interrupt. Try again.
            </p>
          )}
        </div>
      </Reveal>
    </div>
  );
}

/** How long a message stays unread before its line opens. */
const UNREAD_LINE_DELAY_MS = 400;

/**
 * `value` once it has held for `ms`; false as soon as it does not. With
 * `initial`, already held at first render.
 */
function useHeld(value: boolean, ms: number, initial = false): boolean {
  const [held, setHeld] = useState(initial);
  useEffect(() => {
    if (!value) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return value && held;
}

/**
 * Beside the person's message: when it was sent, and "Restore to here"
 * when that is offered.
 */
function MessageSide({
  sentAt,
  onRestore,
}: {
  /** The item's `createdAt` (ISO); none for a send not held yet. */
  sentAt?: string;
  onRestore?: () => ActionResult;
}) {
  const { Hint } = useContext(HostContext);
  const today = useContext(TodayContext);
  const sent =
    sentAt && today !== undefined
      ? sentTime(sentAt, { now: today })
      : undefined;
  // The hint sits inside the time, so only the time is placed: a host's
  // hint wrapper never lands in the message's own flow.
  const time = sent && (
    <time
      dateTime={sentAt}
      data-testid="chat-sent-time"
      // Not part of what a copy of the conversation takes.
      className={`flex min-h-6 min-w-0 select-none items-center justify-end text-right text-[11px] leading-4 tabular-nums text-fg-faint [overflow-wrap:anywhere] ${SENT_TIME} ${NARROW.time}`}
    >
      <Hint label={sent.full}>
        <span className={NARROW.label}>{sent.label}</span>
      </Hint>
    </time>
  );
  if (onRestore)
    return <RestoreToHere onConfirm={onRestore}>{time}</RestoreToHere>;
  return time ? <SideRow>{time}</SideRow> : null;
}

/**
 * The row outside the message on its left, level with its last line. It
 * takes at most the room beside the message (the message's row is a
 * container), so nothing in it covers the message or leaves the
 * conversation: its first child stays against the message, what does not
 * fit beside it goes above, and a long time wraps. The pr-2 bridges the
 * gap to the message so the hover never blinks. A narrow row places its
 * children itself (see NARROW).
 */
function SideRow({ children }: { children: ReactNode }) {
  return (
    <span
      className={`absolute bottom-0 right-full flex w-max max-w-[calc(100cqw-100%)] flex-row-reverse flex-wrap-reverse items-center gap-x-1.5 pr-2 ${NARROW.side}`}
    >
      {children}
    </span>
  );
}

/**
 * "Restore to here": undo this message's turn and everything after it,
 * files included. Confirms in place first: it cannot be redone. Its
 * button sits against the message, the sent time (`children`) before it.
 */
function RestoreToHere({
  onConfirm,
  children,
}: {
  onConfirm: () => ActionResult;
  children?: ReactNode;
}) {
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
      <>
        {children && <SideRow>{children}</SideRow>}
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
      </>
    );
  return (
    <SideRow>
      <span className={`flex ${MESSAGE_ACTIONS} ${NARROW.restore}`}>
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
      {children}
    </SideRow>
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
  /** Its steps line takes the turn line's place: it is there at once. */
  placed?: boolean;
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
  placed = false,
  still = false,
}: AgentMessageProps) {
  const host = useContext(HostContext);
  const actions = useContext(ActionsContext);
  const onScreen = useContext(OnScreen);
  // Taking the turn line's place on screen: it fades in where it is, and
  // neither rises nor opens.
  const [inPlace] = useState(() => !still && placed && onScreen.current);
  const enterClasses = useEntered(still, { rise: !inPlace });
  const [bornLive] = useState(
    () => !still && (!item || item.status === "in_progress"),
  );
  // Work that joins a running turn on screen opens its own height (and its
  // row the gap above it, see TurnRowView).
  const [joined] = useState(
    () => !still && !placed && live && onScreen.current,
  );
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
      {/* Copy, read aloud and fork from this reply. The pl-2 bridges the
          gap between the message edge and the buttons: without it the
          pointer leaves the group mid-crossing and the reveal blinks.
          Being read aloud, they stay in view, so it can be stopped. */}
      {item && !writing && text.trim() && (
        <span
          className={`absolute bottom-0 left-full flex items-center gap-0.5 pl-2 ${
            host.readingAloud?.itemId === item.id
              ? "opacity-100 transition-opacity duration-150"
              : MESSAGE_ACTIONS
          }`}
        >
          <CopyMessageButton content={text} />
          {host.readsAloud && (
            <ReadAloudButton
              itemId={item.id}
              text={text}
              agentId={item.agentId}
            />
          )}
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
        placed={inPlace}
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
 * not. Once written, the box lets go of its height. A hidden chat lays out
 * nothing: the box keeps its height meanwhile and, shown again, takes the
 * text's at once, so what was written while away never opens again.
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
  // Its height lets go once the last line it opened has played out,
  // however late the renderer started it: released mid-way, the box would
  // snap to the text's height.
  const lineOpening = useCallback(
    () => transitionPlaying(box.current, "height"),
    [],
  );
  useEffect(() => {
    if (!opening) return;
    return afterMotion(GROW_SETTLE_MS, lineOpening, () => setOpening(false));
  }, [opening, lineOpening]);
  // It keeps growing a moment past the last words, so the line they
  // opened plays out rather than snapping when the reply completes.
  const writing = useLinger(
    active ? true : undefined,
    GROW_SETTLE_MS,
    lineOpening,
  );
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
    let away = false;
    const follow = () => {
      // Not laid out: its height reads 0, which is not the text's.
      if (inner.getClientRects().length === 0) {
        away = true;
        return;
      }
      const height = `${inner.getBoundingClientRect().height}px`;
      if (!away) {
        outer.style.height = height;
        return;
      }
      away = false;
      outer.style.transition = "none";
      outer.style.height = height;
      // Read back, so the height applies before the transition returns.
      outer.getBoundingClientRect();
      outer.style.transition = "";
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
    previous.placed === next.placed &&
    previous.still === next.still &&
    previous.steps.length === next.steps.length &&
    previous.steps.every((step, index) => step.item === next.steps[index]?.item)
  );
}

/**
 * Requests whose answer has shown. An answer shows the moment it is sent
 * (where its question stood) and may then move to the message the session
 * records for it: that card is the same answer, and does not enter again.
 */
const shownAnswers = new Set<string>();

/**
 * An answer its person is sending from this window: it takes its
 * question's place in the conversation as it is, without rising in, while
 * the panel it was given in closes. Call it before responding.
 */
export function answerSentHere(requestId: string): void {
  shownAnswers.add(requestId);
}

/** Answered questions: each question with what was picked. */
function AnswerCard({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: "answer" }>;
}) {
  const enterClasses = useEntered(shownAnswers.has(entry.requestId));
  useEffect(() => {
    shownAnswers.add(entry.requestId);
  }, [entry.requestId]);
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
              {/* An answer in the person's own words keeps its pills in place. */}
              <InlineMessage
                content={row.answer}
                attachments={row.attachments}
              />
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
 * (a new agent, a fork, turns it never began): one quiet line, as a
 * coding agent's "conversation compacted", that opens to the text it read.
 */
function HandoffLine({ item }: { item: ContextHandoffItem }) {
  const [open, setOpen] = useState(false);
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
        {item.strategy === "delta"
          ? "Told the agent what it missed"
          : "Told the agent the conversation so far"}
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
 * Turns stopped because their own agent archived or closed the chat from
 * within them: stopping was the agent's last act, so the turn shows no
 * interruption and offers no Retry.
 */
function turnsEndedOwnChat(timeline: readonly TimelineTurn[]): Set<string> {
  const ended = new Set<string>();
  let last: Turn | null = null;
  for (const group of timeline) {
    last = group.turn ?? last;
    for (const entry of group.entries)
      if (
        entry.kind === "notice" &&
        last?.status === "interrupted" &&
        endsOwnChat(entry.item)
      )
        ended.add(last.id);
  }
  return ended;
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
  endedByTheirAgent,
  onRetry,
  onInterrupt,
  onReauth,
  reauthLabel,
}: {
  turn: Turn;
  group: TimelineTurn;
  latest: boolean;
  /** Its own agent archived or closed the chat: the notice after it says why it ended. */
  endedByTheirAgent: boolean;
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
  const left = changed.length > 0 && (
    <span data-testid="chat-interrupted-files">
      {`Left ${changed.length === 1 ? "1 changed file" : `${changed.length} changed files`}: ${changedFileNames(changed)}`}
    </span>
  );
  // Nothing interrupted it, so nothing to retry: only what it left changed.
  if (endedByTheirAgent)
    return left ? (
      <div className="cat-fade-in text-center text-xs text-fg-faint">
        {left}
      </div>
    ) : null;
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
      {left}
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

/**
 * Reads the reply aloud in its agent's voice; pressed again, it stops. A
 * spinner while it is on its way, a stop square while it plays.
 */
function ReadAloudButton({
  itemId,
  text,
  agentId,
}: {
  itemId: string;
  text: string;
  agentId: string | null;
}) {
  const { Hint, readingAloud } = useContext(HostContext);
  const actions = useContext(ActionsContext);
  const reading = readingAloud?.itemId === itemId ? readingAloud : null;
  const label = reading ? "Stop reading aloud" : "Read aloud";
  return (
    <Hint label={label}>
      <button
        type="button"
        onClick={() => actions.readAloud({ itemId, text, agentId })}
        className={ICON_BUTTON}
        aria-label={label}
        aria-pressed={Boolean(reading)}
        data-testid="chat-read-aloud"
        data-reading={
          reading ? (reading.preparing ? "preparing" : "speaking") : undefined
        }
      >
        {/* Every glyph stays mounted so each swap cross-fades in place. */}
        <span className="grid place-items-center">
          <Volume2
            className={`col-start-1 row-start-1 size-3 transition-opacity duration-150 ${reading ? "opacity-0" : "opacity-100"}`}
          />
          <LoaderCircle
            className={`col-start-1 row-start-1 size-3 transition-opacity duration-150 ${reading?.preparing ? "animate-spin opacity-100" : "opacity-0"}`}
          />
          <Square
            className={`col-start-1 row-start-1 size-2.5 fill-current transition-opacity duration-150 ${reading && !reading.preparing ? "opacity-100" : "opacity-0"}`}
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
 * A line that opens its own height in the timeline's column and closes it
 * again (`cat-reveal`, its one child the line). It opens from nothing only
 * when it appears in a timeline on screen (`data-entering`, dropped once
 * it has opened): a chat opened, or shown again, mid-turn has it open
 * already, as it was. Its line is clipped only while it opens or closes
 * (`data-moving`), so a focus ring in it shows whole at rest.
 */
function Reveal({
  closed,
  appear = true,
  className = "",
  inert,
  children,
}: {
  closed: boolean;
  /** Opens from nothing as it appears on screen; otherwise it is simply there. */
  appear?: boolean;
  className?: string;
  /** Closing: out of reach and hidden from assistive technology. */
  inert?: boolean;
  children: ReactNode;
}) {
  const onScreen = useContext(OnScreen);
  const [entering, setEntering] = useState(() => appear && onScreen.current);
  const [moving, setMoving] = useState(entering);
  const [was, setWas] = useState(closed);
  if (was !== closed) {
    setWas(closed);
    setMoving(true);
  }
  const rest = useRef(() => {
    setMoving(false);
    setEntering(false);
  });
  const box = useRef<HTMLDivElement>(null);
  // Its transition's end settles it; the timer stands in where none plays,
  // and waits on while it does (on a slow renderer it starts late).
  // Closed, it stays clipped until it goes.
  useEffect(() => {
    if (!moving || closed) return;
    return afterMotion(
      REVEAL_MS + 80,
      () => transitionPlaying(box.current, "grid-template-rows"),
      () => rest.current(),
    );
  }, [moving, closed]);
  return (
    <div
      ref={box}
      className={`cat-reveal ${className}`}
      data-entering={entering || undefined}
      data-moving={moving || undefined}
      data-closed={closed || undefined}
      inert={inert}
      aria-hidden={inert || undefined}
      onTransitionEnd={(event) => {
        if (
          event.target === event.currentTarget &&
          event.propertyName === "grid-template-rows"
        )
          rest.current();
      }}
    >
      {children}
    </div>
  );
}

/**
 * The agent's live line under the conversation: the spinner and what the
 * agent is doing, and nothing beside the words (the turn's clock sits on
 * its steps line). One fixed height, so neither the spinner nor anything
 * below it moves as the words change. It opens its own height when work
 * starts and closes it when the work is done, so the conversation never
 * jumps by a line. Withdrawing a message about to start sits at the far
 * end, clear of the words.
 *
 * Until the running turn has a steps line (a message still on its way
 * included), the turn line above it keeps that line's place, with the
 * turn's clock: the two open as one, and the first steps line takes the
 * turn line's place in the same frame, so the activity line never moves
 * for it, however late the frames come.
 */
function ActivityLine({
  activity,
  turnLine,
  startingId,
  onCancel,
}: {
  activity?: string;
  /** No steps line in the running turn yet: the turn line keeps its place. */
  turnLine: boolean;
  /** The message about to start, withdrawable until the agent takes it. */
  startingId?: string;
  onCancel?: (turnId: string) => ActionResult;
}) {
  const line = useRef<HTMLDivElement>(null);
  // It stays for its exit once the work it named is done, with the words
  // it last said, until its closing has played (however late the renderer
  // starts it: gone before, the conversation would jump by its height);
  // the timeline itself never renders again for that.
  const shown = useLinger(activity ? true : undefined, REVEAL_MS, () =>
    transitionPlaying(
      line.current?.closest(".cat-reveal"),
      "grid-template-rows",
    ),
  );
  const said = useRef(activity);
  if (activity) said.current = activity;
  const cancel = useLinger(startingId, REVEAL_MS);
  const present = Boolean(shown.value && said.current);
  const leaving = shown.leaving;
  // Closing, it keeps the turn line as it was: the two close as one.
  const lined = useRef(turnLine);
  if (!leaving) lined.current = turnLine;
  // The first steps line takes the turn line's place in this commit: an
  // opening still under way ends in it, so the frame that shows the steps
  // line shows the activity line where it stays. A renderer that stalls
  // as the turn starts begins the opening only after the stall, and the
  // first step, arrived meanwhile, would show above a line still opening.
  const handing = useRef(lined.current);
  useLayoutEffect(() => {
    if (handing.current && !lined.current)
      finishTransitions(line.current?.closest(".cat-reveal"));
    handing.current = lined.current;
  });
  // A turn line there as the activity line opens is part of its opening;
  // one that comes later (a next turn under a line still open) opens its
  // own place.
  const opened = useRef(false);
  useEffect(() => {
    opened.current = present;
  }, [present]);
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
  if (!present || !said.current) return null;
  return (
    <Reveal
      closed={leaving}
      className="[--cat-reveal-gap:-0.75rem]"
      inert={leaving}
    >
      <div>
        {lined.current && (
          // Gone at once when the first steps line takes its place. Its
          // place opens from nothing (no column gap to give back).
          <Reveal
            closed={false}
            appear={opened.current}
            className="[--cat-reveal-gap:0px]"
          >
            <TurnLine leaving={leaving} />
          </Reveal>
        )}
        <div
          ref={line}
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
    </Reveal>
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

/** The conversation's one scroll arrow, centered over it. */
const CHAT_ARROW =
  "absolute bottom-4 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full border border-border-strong bg-bg-overlay text-fg shadow-xl";

function ScrollToLatest() {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  if (isAtBottom) return null;
  return (
    <button
      type="button"
      className={CHAT_ARROW}
      onClick={() => scrollToBottom()}
      aria-label="Scroll to latest message"
    >
      <ArrowDown className="size-4" />
    </button>
  );
}

/**
 * Keep following when the scroller itself resizes, as when the composer
 * grows or a question or approval panel below it opens or closes. A
 * shorter scroller keeps its scroll position, which leaves the latest
 * message below its new edge: it is held at the end in the same frame,
 * before paint, so the conversation rides the composer's glide instead of
 * catching up once it stops.
 *
 * A taller scroller pulls its scroll position back to its new end, which
 * use-stick-to-bottom would read as the person scrolling up and stop
 * following. That scroll is told apart where it lands: it moved up, yet the
 * view is still at its end, so the end moved and not the person. It is
 * marked as the library's own before the library's listener reads it,
 * whenever the layout that pulled it back ran (a script reading layout
 * between frames runs it before this observer sees the resize).
 */
function FollowScrollerResize() {
  const { scrollRef, state } = useStickToBottomContext();
  useEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    let height = scroller.clientHeight;
    let last = scroller.scrollTop;
    const observer = new ResizeObserver(() => {
      if (scroller.clientHeight === height) return;
      height = scroller.clientHeight;
      // Only a chat that follows (see PinToBottom), not one a reader let go
      // of a few pixels short of the end. Through the library's own setter,
      // so the scroll this makes reads as its own.
      if (state.isAtBottom)
        state.scrollTop = scroller.scrollHeight - scroller.clientHeight;
    });
    // Capturing, it runs before the library's listener on the scroller.
    const onScroll = () => {
      const top = scroller.scrollTop;
      const atEnd = top >= scroller.scrollHeight - scroller.clientHeight - 1;
      if (state.isAtBottom && top < last && atEnd)
        state.ignoreScrollToTop = top;
      last = top;
    };
    observer.observe(scroller);
    scroller.addEventListener("scroll", onScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      observer.disconnect();
      scroller.removeEventListener("scroll", onScroll, { capture: true });
    };
  }, [scrollRef, state]);
  return null;
}

/** The conversation fades out where it continues past an edge (edge-fade). */
function FadeEdges() {
  const { scrollRef } = useStickToBottomContext();
  useEffect(() => {
    const scroller = scrollRef.current;
    return scroller ? fadeEdges(scroller) : undefined;
  }, [scrollRef]);
  return null;
}

/**
 * While the chat follows its latest message, the browser keeps it there:
 * everything in the conversation but the anchor at its end opts out of
 * scroll anchoring (`data-pinned`), so content growing or shrinking above
 * the anchor moves the scroll with it in the same frame, with no script
 * per frame. Scrolled up, anchoring keeps what the person reads in place
 * instead.
 *
 * It pins only while use-stick-to-bottom itself follows: its own
 * `state.isAtBottom`, which every let-go clears. The context's `isAtBottom`
 * also counts "near the end", which would go on following a reader who
 * let go a few pixels short of it, and `escapedFromLock` stays set after
 * "Scroll to latest" until the person scrolls down, which would leave a
 * followed chat to script. A press in the conversation unpins until it is
 * released, and so does text selected in it, so what the person presses
 * or selects holds still under the pointer; a drag that selects text lets
 * go, as the library means it to.
 *
 * The library reads scrolls from scroll events, which it ignores while
 * the content resizes, as it does nearly every frame of a streaming
 * answer, and hears the wheel only when the first box under the pointer
 * that may scroll is the log (not over a code block, which scrolls
 * sideways). So a wheel or a touch drag that scrolls the log up, a key
 * that scrolls up and a press on the scrollbar let go here, before the
 * next growth pulls the view back down.
 */
function PinToBottom() {
  const { contentRef, scrollRef, state, stopScroll } =
    useStickToBottomContext();
  const update = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    const content = contentRef.current;
    if (!scroller || !content) return;
    let pressed = false;
    // Where the last press was: keys scroll the log after a press in it
    // left nothing focused.
    let pressedIn = false;
    let selected = false;
    let touchY: number | undefined;
    let recheck: ReturnType<typeof setTimeout> | undefined;
    const pin = () => {
      const pinned = state.isAtBottom && !pressed && !selected;
      if (pinned === "pinned" in content.dataset) return;
      if (pinned) content.dataset.pinned = "";
      else delete content.dataset.pinned;
    };
    update.current = pin;
    pin();
    const letGo = () => {
      if (!state.isAtBottom) return;
      // Nothing above to scroll to: following goes on.
      if (scroller.scrollTop <= 0) return;
      stopScroll();
      pin();
    };
    const inLog = (node: EventTarget | Node | null) =>
      node instanceof Node && scroller.contains(node);
    const onPointerDown = (event: PointerEvent) => {
      pressedIn = inLog(event.target);
      if (!pressedIn) return;
      // The scroller itself, outside the conversation's column: its
      // scrollbar (or the gutter beside it).
      if (event.target === scroller) {
        letGo();
        return;
      }
      pressed = true;
      pin();
    };
    const onPointerUp = () => {
      if (!pressed) return;
      pressed = false;
      pin();
    };
    const onSelectionChange = () => {
      const selection = document.getSelection();
      const now = Boolean(
        selection &&
          !selection.isCollapsed &&
          (inLog(selection.anchorNode) || inLog(selection.focusNode)),
      );
      if (now && pressed) letGo();
      if (now === selected) return;
      selected = now;
      pin();
    };
    const onWheel = (event: WheelEvent) => {
      // A pinch zooms; it scrolls nothing.
      if (event.deltaY < 0 && !event.ctrlKey && !scrollsWithin(event, scroller))
        letGo();
      pin();
    };
    const onTouchStart = (event: TouchEvent) => {
      touchY = event.touches[0]?.clientY;
    };
    const onTouchMove = (event: TouchEvent) => {
      const y = event.touches[0]?.clientY;
      if (y === undefined || touchY === undefined) return;
      // A finger moving down from the highest it reached scrolls the
      // conversation up; a tap's jitter does not.
      if (y > touchY + 8) letGo();
      touchY = Math.min(touchY, y);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !scrollsUp(event) || editable(event.target))
        return;
      const focused = document.activeElement;
      const here =
        focused && focused !== document.body ? inLog(focused) : pressedIn;
      if (here) letGo();
    };
    // The library may follow again, or let go, without a change it renders
    // (its "near the end" already showed): read it once its own handler
    // has run, after the scroll's, or at once after the wheel's.
    const onScroll = () => {
      clearTimeout(recheck);
      recheck = setTimeout(pin, 2);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("keydown", onKeyDown);
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("touchmove", onTouchMove, { passive: true });
    scroller.addEventListener("scroll", onScroll, { passive: true });
    scroller.addEventListener("wheel", onWheel, { passive: true });
    return () => {
      update.current = () => undefined;
      clearTimeout(recheck);
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("keydown", onKeyDown);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("touchmove", onTouchMove);
      scroller.removeEventListener("scroll", onScroll);
      scroller.removeEventListener("wheel", onWheel);
    };
  }, [contentRef, scrollRef, state, stopScroll]);
  // It renders again as the library lets go or returns to the end, which
  // pins anew.
  useLayoutEffect(() => update.current());
  return null;
}

/**
 * Whether a wheel going up scrolls a box inside the log rather than the
 * log: one between the pointer and the log that scrolls vertically and is
 * not at its top yet (an opened step's long output).
 */
function scrollsWithin(event: WheelEvent, scroller: HTMLElement): boolean {
  for (
    let node = event.target instanceof Element ? event.target : null;
    node && node !== scroller;
    node = node.parentElement
  ) {
    if (node.scrollTop <= 0 || node.scrollHeight <= node.clientHeight) continue;
    const { overflowY } = getComputedStyle(node);
    if (overflowY === "auto" || overflowY === "scroll") return true;
  }
  return false;
}

/** A key that scrolls the focused scroller up. */
function scrollsUp(event: KeyboardEvent): boolean {
  return (
    event.key === "PageUp" ||
    event.key === "Home" ||
    event.key === "ArrowUp" ||
    (event.key === " " && event.shiftKey)
  );
}

/** Where keys edit text instead of scrolling. */
function editable(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.isContentEditable ||
      target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement)
  );
}

/** One-shot keyframes a chat shown again would otherwise play again. */
const ENTRANCES = new Set([
  "catamorphic-fade-in",
  "catamorphic-fold-away",
  "catamorphic-step-in",
  "catamorphic-gap-in",
  "catamorphic-swap-out",
  "catamorphic-swap-in",
]);

/**
 * Keeps the timeline's on-screen state (see `OnScreenState`): laid out (a
 * lurking chat, or one in a tab behind, is not) in a window that shows.
 * The browser drops the animations of what is not laid out and starts them
 * again as it shows: those finish here, before the first frame shown, so
 * nothing the chat already held, or gained while hidden, enters again.
 */
function TrackOnScreen({ state }: { state: OnScreenSource }) {
  const { scrollRef, contentRef } = useStickToBottomContext();
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (!scroller) return;
    const laidOut = () =>
      typeof scroller.checkVisibility === "function"
        ? scroller.checkVisibility()
        : true;
    let shown = laidOut();
    const update = () =>
      state.set(shown && document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    // Shown or hidden, the scroller's size changes; observed before paint.
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(() => {
            const now = laidOut();
            if (now && !shown) finishEntrances(contentRef.current);
            shown = now;
            update();
          });
    observer?.observe(scroller);
    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", update);
    };
  }, [scrollRef, contentRef, state]);
  return null;
}

function finishEntrances(content: HTMLElement | null) {
  if (!content || typeof content.getAnimations !== "function") return;
  for (const animation of content.getAnimations({ subtree: true })) {
    const name =
      "animationName" in animation ? animation.animationName : undefined;
    if (typeof name === "string" && ENTRANCES.has(name)) animation.finish();
  }
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
            12 -
            edgeFadeLength(scroller),
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
