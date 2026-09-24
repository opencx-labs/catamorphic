import { ChatQueue } from "./chat-queue.js";

("use client");

import type { AgentMessage, PendingAgentTurn } from "@catamorphic/react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  Check,
  ChevronRight,
  Copy,
  GitFork,
  KeyRound,
  LoaderCircle,
  MessageSquareText,
  Pencil,
  Radio,
  RotateCcw,
  SquareTerminal,
  Wrench,
} from "lucide-react";
import {
  createContext,
  memo,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { splitAttachmentMarkers } from "../../lib/composer-serialize";
import {
  DEFAULT_WORK_DISPLAY,
  groupTurns,
  type WorkDisplay,
} from "../../lib/turn-groups";
import { ActivityText } from "../activity-text";
import { ContextPill } from "../context-pill";
import { ShortcutHint } from "../shortcut-hint";
import { SessionAttribution } from "./session-attribution.js";

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

export interface ChatTimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  author?: AgentMessage["author"];
  metadata?: unknown;
  attachments?: ChatAttachmentView[];
}

/**
 * Sent as the ask_user tool result when the user dismisses the question
 * panel. The timeline recognizes it by content and renders a muted note
 * instead of a user bubble.
 */
export const QUESTIONS_DISMISSED_MESSAGE =
  "The user dismissed these questions without answering them. Continue without their input, using your best judgment.";

export interface AgentQuestionOption {
  label: string;
  description: string;
}

export interface AgentQuestion {
  question: string;
  header: string;
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

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

export interface ChatTimelineProps {
  focusMessageId?: string;
  /**
   * This chat's background commands, oldest first: their steps pulse while
   * they run and say how they ended.
   */
  backgroundCommands?: ChatBackgroundCommand[];
  /** Persisted + optimistic messages, in order. */
  messages: ChatTimelineMessage[];
  /** Live activity line ("Thinking...", tool progress) shown under messages. */
  activity?: string;
  /** @deprecated superseded by `queue`; kept for simple hosts. */
  queuedCount?: number;
  /** Messages waiting behind the in-flight turn (editable until sent). */
  queue?: PendingAgentTurn[];
  onUpdateQueued?: (
    id: string,
    content: string,
  ) => undefined | boolean | Promise<undefined | boolean>;
  onRemoveQueued?: (
    id: string,
  ) => undefined | boolean | Promise<undefined | boolean>;
  /** Promote a queued message: front of the line + interrupt the turn. */
  onSendQueuedNow?: (
    id: string,
  ) => undefined | boolean | Promise<undefined | boolean>;
  /** A queued message entered/left inline editing (null = none). */
  onHoldQueued?: (
    id: string | null,
  ) => undefined | boolean | Promise<undefined | boolean>;
  /**
   * The turn at the end of the log is still running. Defaults to whether
   * an activity line is showing.
   */
  working?: boolean;
  /** How a turn's work (notes and steps) reads; see lib/turn-groups. */
  workDisplay?: WorkDisplay;
  /** Re-run the last failed turn in place. */
  onRetry?: () => void;
  /**
   * Re-connect the agent's account (auth failures). Only offered when the
   * host can actually run a login flow for the current agent.
   */
  onReauth?: () => void;
  reauthLabel?: string;
  error?: string | null;
  emptyState?: string;
  className?: string;
  /**
   * Extra classes for the scrolled content column. Lets hosts center a
   * max-width column while the scrollbar hugs the container edge.
   */
  contentClassName?: string;
  /** Names an agent id (agent-change markers); falls back to the id. */
  resolveAgentName?: (agentId: string) => string | undefined;
  /** Host-owned previews for sanitized Markdown links. */
  renderLink?: (props: {
    href: string;
    children: ReactNode;
    onOpen: NonNullable<ChatTimelineProps["onLinkClick"]>;
  }) => ReactNode;
  onLinkClick?: (
    url: string,
    modifiers: {
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    },
  ) => void;
  /**
   * A file path in the turn-step log was clicked ("Edited docs/plan.md").
   * Hosts open the file in an editor surface; without it the rows stay
   * inert text.
   */
  onFileClick?: (
    path: string,
    modifiers?: {
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    },
  ) => void;
  /**
   * Icon URL for a tool name (MCP tools are `server/tool`; the host maps
   * the server key to its connector icon). Undefined → generic glyph.
   */
  resolveToolIcon?: (toolName: string) => string | undefined;
  /**
   * Fork the conversation from an assistant message (hover action on the
   * message). The host opens the fork as its own chat surface.
   */
  onFork?: (messageId: string) => void;
  /**
   * Hands the host the "jump to my previous message" scroll action, so a
   * composer shortcut (PageUp) triggers the same move as the button.
   */
  registerJumpToPreviousUserMessage?: (jump: () => void) => void;
}

/**
 * Presentational conversation log: message bubbles (user right, agent left
 * — no name tags), media attachments, agent/effort change markers, error
 * cards with recovery actions, the editable outgoing queue, live activity,
 * stick-to-bottom scrolling. Owns no chat state — feed it from
 * `useAgentChat` (see `AgentChat`) or any other source.
 */
export function ChatTimeline({
  focusMessageId,
  backgroundCommands,
  messages,
  activity,
  queuedCount = 0,
  queue,
  onUpdateQueued,
  onRemoveQueued,
  onSendQueuedNow,
  onHoldQueued,
  working,
  workDisplay = DEFAULT_WORK_DISPLAY,
  onRetry,
  onReauth,
  reauthLabel,
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
  const lastConversationId = [...messages]
    .reverse()
    .find((message) => message.role !== "system")?.id;
  const hasUserMessages = messages.some(
    (message) =>
      message.role === "user" &&
      message.content !== QUESTIONS_DISMISSED_MESSAGE,
  );
  // Retry re-runs the conversation's last user turn; a timeline with no
  // user turn at all has nothing to re-run (the button would be dead).
  const hasRetryableTurn = messages.some((message) => message.role === "user");
  const backgroundStates = assignBackgroundCommands(
    messages,
    backgroundCommands ?? [],
  );
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
          {messages.length === 0 && !activity && (
            <div className="m-auto max-w-sm text-center text-sm leading-6 text-fg-muted">
              {emptyState}
            </div>
          )}
          {(() => {
            const keys = timelineKeys(messages);
            const keyOf = new Map(
              messages.map((message, index) => [message, keys[index]]),
            );
            const row = (
              message: ChatTimelineMessage,
              foldedWork?: ChatTimelineMessage[],
            ) => (
              <div
                key={keyOf.get(message)}
                data-message-id={message.id}
                tabIndex={-1}
                className={
                  message.id === focusMessageId
                    ? "rounded-md outline outline-1 outline-accent/50"
                    : "contents"
                }
              >
                <Message
                  message={message}
                  foldedWork={foldedWork}
                  // A focused note inside the fold has to be on screen.
                  openWork={foldedWork?.some(
                    (folded) => folded.id === focusMessageId,
                  )}
                  isLast={message.id === lastConversationId}
                  resolveAgentName={resolveAgentName}
                  onLinkClick={onLinkClick}
                  renderLink={renderLink}
                  onFileClick={onFileClick}
                  resolveToolIcon={resolveToolIcon}
                  // Retry re-runs the last user turn; without one there is
                  // nothing to re-run — hide the button, never show a dead one.
                  onRetry={hasRetryableTurn ? onRetry : undefined}
                  onReauth={onReauth}
                  reauthLabel={reauthLabel}
                  onFork={onFork}
                />
              </div>
            );
            return groupTurns(messages, {
              working: working ?? Boolean(activity),
              display: workDisplay,
            }).flatMap((item) =>
              item.kind === "message"
                ? [row(item.message)]
                : item.shown.map((message, index) =>
                    row(message, index === 0 ? item.folded : undefined),
                  ),
            );
          })()}
          {activity && (
            <div className="flex items-center gap-2 text-xs text-fg-muted">
              <LoaderCircle className="size-4 animate-spin" />
              <ActivityText text={activity} />
              {!queue && queuedCount > 0 && (
                <span className="ml-auto text-fg-faint">
                  {queuedCount} queued
                </span>
              )}
            </div>
          )}
          {queue && queue.length > 0 && (
            <ChatQueue
              queue={queue}
              onUpdate={onUpdateQueued}
              onRemove={onRemoveQueued}
              onSendNow={onSendQueuedNow}
              onHold={onHoldQueued}
              Hint={ShortcutHint}
              renderContent={(queued) => (
                <InlineMessage
                  content={queued.content}
                  attachments={queued.attachments}
                />
              )}
              renderAttachments={(queued) => (
                <AttachmentStrip
                  attachments={queued.attachments.slice(
                    inlineMarkerCount(queued.content, queued.attachments),
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
          ready={messages.some((message) => message.id === focusMessageId)}
        />
        <ScrollToLatest />
      </StickToBottom>
    </BackgroundStates.Provider>
  );
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

/**
 * Content-position identity instead of message.id: when an optimistic user
 * message is replaced by its persisted twin, the id flips (uuid → db id) but
 * the rendered content is identical. A content-based key keeps the same DOM
 * node, so the settle is invisible instead of a remount (fade-in replay).
 *
 * The content is HASHED (cached per message object): using the raw text
 * as the React key made key comparison itself scale with transcript
 * bytes, and the old per-message occurrence scan was O(n²).
 */
const contentHashCache = new WeakMap<object, string>();

function contentHash(message: ChatTimelineMessage): string {
  const cached = contentHashCache.get(message);
  if (cached !== undefined) return cached;
  let hash = 0;
  const text = message.content;
  for (let i = 0; i < text.length; i += 1) {
    hash = (hash * 31 + text.charCodeAt(i)) | 0;
  }
  const result = `${text.length.toString(36)}:${(hash >>> 0).toString(36)}`;
  contentHashCache.set(message, result);
  return result;
}

/** One pass over the list; duplicate contents get occurrence suffixes. */
function timelineKeys(messages: ChatTimelineMessage[]): string[] {
  const seen = new Map<string, number>();
  return messages.map((message) => {
    const base = `${message.role}:${contentHash(message)}`;
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return `${base}:${occurrence}`;
  });
}

/**
 * Memoized on data props only: persisted messages never change content
 * (react-query's structural sharing keeps their object identity stable),
 * so a 500ms streaming poll re-renders just the tail instead of
 * re-parsing every message's markdown. Handler props are deliberately
 * excluded from the comparison — hosts recreate those closures every
 * render, but their behavior is stable across renders.
 */
const Message = memo(
  MessageImpl,
  (previous, next) =>
    // System (marker) rows always re-render: their text derives from
    // resolveAgentName, whose roster resolves asynchronously — freezing
    // them shows "Switched to another agent" forever. They're plain
    // one-line rows; re-rendering them is free.
    next.message.role !== "system" &&
    previous.message === next.message &&
    previous.openWork === next.openWork &&
    (previous.foldedWork?.length ?? 0) === (next.foldedWork?.length ?? 0) &&
    (next.foldedWork ?? []).every(
      (folded, index) => previous.foldedWork?.[index] === folded,
    ) &&
    previous.isLast === next.isLast &&
    previous.reauthLabel === next.reauthLabel,
);

function MessageImpl({
  message,
  foldedWork,
  openWork,
  isLast,
  resolveAgentName,
  onLinkClick,
  renderLink,
  onFileClick,
  resolveToolIcon,
  onRetry,
  onReauth,
  reauthLabel,
  onFork,
}: {
  message: ChatTimelineMessage;
  /** Earlier notes of this turn, folded into this message's steps. */
  foldedWork?: ChatTimelineMessage[];
  openWork?: boolean;
  isLast: boolean;
  resolveAgentName?: (agentId: string) => string | undefined;
  renderLink?: ChatTimelineProps["renderLink"];
  onLinkClick?: ChatTimelineProps["onLinkClick"];
  onFileClick?: (
    path: string,
    modifiers?: {
      metaKey: boolean;
      ctrlKey: boolean;
      shiftKey: boolean;
      altKey: boolean;
    },
  ) => void;
  resolveToolIcon?: (toolName: string) => string | undefined;
  onRetry?: () => void;
  onReauth?: () => void;
  reauthLabel?: string;
  onFork?: (messageId: string) => void;
}) {
  const metadata = asRecord(message.metadata);
  const [entered, setEntered] = useState(false);

  // Double rAF: the first frame aligns with the commit, the second
  // guarantees the browser resolved the hidden pose before it flips —
  // a single rAF can fire before the mount frame ever paints (React
  // flushes effects pre-paint under load, e.g. the 500ms streaming
  // poll), collapsing both poses into one style recalc and skipping
  // the entrance transition entirely.
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

  // Agent/effort switches render as a centered divider, not a message.
  const marker = asRecord(metadata?.marker);
  if (message.role === "system" && marker) {
    const text =
      marker.kind === "agent_change" && typeof marker.agentId === "string"
        ? `Switched to ${resolveAgentName?.(marker.agentId) ?? "another agent"}`
        : message.content;
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] text-fg-faint">
        <span className="h-px flex-1 bg-border" />
        <span>{text}</span>
        <span className="h-px flex-1 bg-border" />
      </div>
    );
  }

  // Host notices (a background command finished) read as one quiet line;
  // the agent gets the full message and answers below it.
  const notice =
    typeof metadata?.notice === "string" ? metadata.notice : undefined;
  if (message.author?.kind === "system" && notice) {
    return (
      <div
        className="flex items-center justify-center gap-1.5 text-center text-xs text-fg-faint"
        data-testid="chat-notice"
      >
        <Radio className="size-3 shrink-0" />
        <span className="truncate">{notice}</span>
      </div>
    );
  }

  if (
    message.role === "user" &&
    message.content === QUESTIONS_DISMISSED_MESSAGE
  ) {
    return (
      <div className="text-center text-xs italic text-fg-faint">
        Questions dismissed
      </div>
    );
  }

  const attachments = message.attachments ?? attachmentsFromMetadata(metadata);
  // Pills the prose references inline (composer markers) render in place;
  // the rest — older messages, other clients — sit in a strip above.
  const stripAttachments =
    message.role === "user"
      ? attachments.slice(inlineMarkerCount(message.content, attachments))
      : attachments;
  const failed = metadata?.status === "failed";
  const humanUserMessage =
    message.role === "user" &&
    (!message.author || message.author.kind === "user");

  const enterClasses = `motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"}`;

  // Failed turns render as an error card with recovery actions (the
  // actions only on the latest message — older failures are history).
  if (message.role === "assistant" && failed) {
    if (metadata?.interrupted === true) {
      // An interrupted turn keeps whatever it had said (partial text, or
      // the orphaned-turn explanation) and closes with a quiet divider —
      // it's a user action, not a failure worth a red card.
      const partial = message.content.trim();
      const showPartial = partial && !/^interrupted\.?$/i.test(partial);
      return (
        <div className={`flex flex-col gap-2 ${enterClasses}`}>
          {showPartial && (
            <article className="mr-auto max-w-[85%] whitespace-pre-wrap break-words text-sm leading-6">
              {partial}
            </article>
          )}
          <div className="text-center text-xs italic text-fg-faint">
            Interrupted
          </div>
        </div>
      );
    }
    const partialContent =
      typeof metadata?.partialContent === "string"
        ? metadata.partialContent.trim()
        : "";
    return (
      <div className={`flex flex-col gap-2 ${enterClasses}`}>
        {partialContent && (
          <article
            className="mr-auto max-w-[85%] text-sm"
            data-testid="chat-partial-response"
          >
            <div className="cat-markdown min-w-0 break-words leading-6">
              <Markdown remarkPlugins={REMARK_PLUGINS}>
                {partialContent}
              </Markdown>
            </div>
          </article>
        )}
        <ErrorCard
          message={message}
          actionable={isLast}
          onRetry={onRetry}
          onReauth={onReauth}
          reauthLabel={reauthLabel}
        />
      </div>
    );
  }

  return (
    <article
      data-user-message={humanUserMessage || undefined}
      className={`group/msg relative max-w-[85%] text-sm ${enterClasses} ${humanUserMessage ? "ml-auto rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2" : message.role === "user" ? "mr-auto rounded-xl rounded-bl-sm border border-border bg-bg-raised px-3 py-2" : "mr-auto"}`}
    >
      <SessionAttribution
        author={message.role === "assistant" ? undefined : message.author}
        metadata={message.metadata}
        onOpen={onLinkClick}
      />
      {stripAttachments.length > 0 && (
        <AttachmentStrip attachments={stripAttachments} />
      )}
      {/* Fork the conversation from this reply: everything up to here is
          copied into a new chat that goes off on a tangent. */}
      {/* The pl-2 bridges the gap between the message edge and the
          button: without it the pointer leaves the group mid-crossing
          and the reveal fades out and back in — a visible blink. */}
      {message.role === "assistant" && (
        <span className="absolute bottom-0 left-full flex items-center gap-0.5 pl-2 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/msg:opacity-100">
          <CopyMessageButton content={message.content} />
          {onFork && (
            <ShortcutHint label="Fork the chat from here">
              <button
                type="button"
                onClick={() => onFork(message.id)}
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
      {message.role === "assistant" && (
        <TurnSteps
          steps={[
            // Work happens before the note that reports it: each folded
            // note follows its own steps, and this message's steps close.
            ...(foldedWork ?? []).flatMap((folded) => [
              ...turnSteps(folded),
              noteStep(folded),
            ]),
            ...turnSteps(message),
          ]}
          defaultExpanded={openWork}
          resolveToolIcon={resolveToolIcon}
          onFileClick={onFileClick}
        />
      )}
      {message.role === "user" ? (
        <div className="whitespace-pre-wrap break-words leading-6">
          <InlineMessage content={message.content} attachments={attachments} />
        </div>
      ) : (
        <div className="cat-markdown min-w-0 break-words leading-6">
          <LinkContext.Provider value={{ onLinkClick, renderLink }}>
            <Markdown
              remarkPlugins={REMARK_PLUGINS}
              urlTransform={(url, key) =>
                onLinkClick &&
                key === "href" &&
                /^(?:file|workflow|app|artifact|chat|browser|terminal|editor|diff|mcpapp):/i.test(
                  url,
                )
                  ? url
                  : defaultUrlTransform(url)
              }
              components={onLinkClick ? LINK_COMPONENTS : undefined}
            >
              {message.content}
            </Markdown>
          </LinkContext.Provider>
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
  kind: "command" | "file_edit" | "tool" | "subagent" | "background" | "note";
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
}

const STEP_ICONS = {
  command: SquareTerminal,
  file_edit: Pencil,
  tool: Wrench,
  subagent: Bot,
  background: Radio,
  note: MessageSquareText,
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
 * The turn's steps, from the persisted per-message event log
 * (`metadata.events`). The chat keeps its prose calm — this is where the
 * full commands, file paths, and tool payloads live, on demand.
 */
function turnSteps(message: ChatTimelineMessage): TurnStep[] {
  const events = asRecord(message.metadata)?.events;
  if (!Array.isArray(events)) return [];
  const steps: TurnStep[] = [];
  for (const [index, entry] of events.entries()) {
    const event = asRecord(entry);
    if (!event) continue;
    const content = typeof event.content === "string" ? event.content : "";
    const firstLine = content.split("\n", 1)[0]?.trim() ?? "";
    const description =
      typeof event.description === "string" ? event.description.trim() : "";
    if (event.type === "command") {
      // The agent's own words lead; the command itself is one click away.
      steps.push({
        kind: "command",
        label: description || `$ ${firstLine || "(command)"}`,
        mono: !description,
        detail: stepDetailText(
          [
            description || content.includes("\n") ? content : undefined,
            stepDetailText(event.toolResult),
          ]
            .filter(Boolean)
            .join("\n\n"),
        ),
        detailMono: true,
      });
    } else if (event.type === "file_edit") {
      const path = typeof event.filePath === "string" ? event.filePath : "";
      steps.push({
        kind: "file_edit",
        label: `Edited ${path || "a file"}`,
        mono: true,
        filePath: path || undefined,
      });
    } else if (event.type === "tool_call") {
      const toolName =
        typeof event.toolName === "string" ? event.toolName : "tool";
      if (HIDDEN_STEP_TOOLS.has(toolName)) continue;
      const started = backgroundStart(event);
      if (started) {
        steps.push({
          kind: "background",
          label: started.description,
          background: { ref: `${message.id}:${index}`, ...started },
          detail: started.command,
          detailMono: true,
        });
        continue;
      }
      const pretty = toolStepLabel(toolName, event.toolInput);
      steps.push({
        kind: "tool",
        label: pretty.label,
        mono: pretty.mono,
        toolName,
        detail: toolStepDetail(toolName, event.toolInput, event.toolResult),
        detailMono: !DESKTOP_STEP_TOOLS.has(toolName),
      });
    } else if (event.type === "subagent" && event.status !== "ended") {
      steps.push({
        kind: "subagent",
        label: `Subagent: ${firstLine || "delegated work"}`,
      });
    }
  }
  return steps;
}

/** A run_background_command or watch_command call's command and words. */
function backgroundStart(event: Record<string, unknown>):
  | {
      kind: ChatBackgroundCommand["kind"];
      command: string;
      description: string;
    }
  | undefined {
  if (event.type !== "tool_call") return undefined;
  const name = typeof event.toolName === "string" ? event.toolName : "";
  const tool = name.slice(name.lastIndexOf("/") + 1);
  const kind =
    tool === "run_background_command"
      ? "command"
      : tool === "watch_command"
        ? "watch"
        : undefined;
  if (!kind) return undefined;
  const input = asRecord(event.toolInput);
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
  messages: ChatTimelineMessage[],
  commands: ChatBackgroundCommand[],
): Map<string, ChatBackgroundCommand> {
  const assigned = new Map<string, ChatBackgroundCommand>();
  if (commands.length === 0) return assigned;
  const queues = new Map<string, ChatBackgroundCommand[]>();
  for (const command of commands) {
    const key = `${command.kind}\u0000${command.command}\u0000${command.description}`;
    queues.set(key, [...(queues.get(key) ?? []), command]);
  }
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const step of turnSteps(message)) {
      if (!step.background || !step.detail) continue;
      const key = `${step.background.kind}\u0000${step.detail}\u0000${step.background.description}`;
      const match = queues.get(key)?.shift();
      if (match) assigned.set(step.background.ref, match);
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

/** A note the agent wrote mid-turn, as a row of the turn's steps. */
function noteStep(message: ChatTimelineMessage): TurnStep {
  const text = message.content.trim();
  const firstLine =
    text
      .split("\n")
      .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
      .find(Boolean) ?? "Note";
  return {
    kind: "note",
    label: firstLine,
    messageId: message.id,
    // A one-line note is fully read from its row; nothing to expand.
    detail: text === firstLine ? undefined : text,
    markdown: true,
  };
}

/**
 * The expandable event log under an assistant reply: collapsed to a muted
 * "N steps" line; expanded, each step is a row that itself stays collapsed
 * (payloads are long and technical) until clicked. MCP tool rows show the
 * connector's icon when the host can resolve one.
 */
function TurnSteps({
  steps,
  defaultExpanded = false,
  resolveToolIcon,
  onFileClick,
}: {
  steps: TurnStep[];
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
  const [expanded, setExpanded] = useState(defaultExpanded);
  const backgroundStates = useContext(BackgroundStates);
  useEffect(() => {
    if (defaultExpanded) setExpanded(true);
  }, [defaultExpanded]);
  if (steps.length === 0) return null;
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
      <button
        type="button"
        onClick={() => setExpanded((value) => !value)}
        className="flex cursor-pointer items-center gap-1 text-[11px] text-fg-faint transition-colors duration-100 hover:text-fg-muted"
        aria-expanded={expanded}
        data-testid="chat-turn-steps-toggle"
      >
        <ChevronRight
          className={`size-3 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
        />
        {steps.length === 1 ? "1 step" : `${steps.length} steps`}
      </button>
      {running.length > 0 && (
        <div className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2.5">
          {running.map((step) => (
            <StepRow
              key={step.background?.ref}
              step={step}
              onFileClick={onFileClick}
            />
          ))}
        </div>
      )}
      {/* Grid-rows tween (the SidebarSection pattern): the list stays
          mounted, so the collapse mirrors the expansion exactly. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2.5">
            {folded.map((step, index) => (
              <StepRow
                // Steps are append-only within a message; index is stable.
                // biome-ignore lint/suspicious/noArrayIndexKey: static list
                key={index}
                step={step}
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
  iconUrl,
  onFileClick,
}: {
  step: TurnStep;
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
  const backgroundStates = useContext(BackgroundStates);
  const background = step.background
    ? backgroundStates.get(step.background.ref)
    : undefined;
  const pulsing = background?.status === "running";
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
      data-message-id={step.messageId}
    >
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
        className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-fg-muted ${
          interactive
            ? "cursor-pointer transition-colors duration-100 hover:bg-bg-inset hover:text-fg"
            : "cursor-default"
        }`}
        aria-expanded={expandable ? open : undefined}
      >
        {iconUrl ? (
          <img src={iconUrl} alt="" className="size-3.5 shrink-0 rounded-sm" />
        ) : (
          <Icon
            className={`size-3.5 shrink-0 ${pulsing ? "animate-pulse text-accent" : "text-fg-faint"}`}
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
            className={`min-w-0 flex-1 truncate ${step.mono ? "font-mono" : ""}`}
          >
            {step.label}
          </span>
        )}
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

/**
 * A failed turn: the friendly explanation plus whatever gets the user
 * unstuck — Retry (in place, no re-typing), a re-connect flow for auth
 * failures, and the auto-retry countdown for transient provider trouble.
 */
function ErrorCard({
  message,
  actionable,
  onRetry,
  onReauth,
  reauthLabel,
  className,
}: {
  message: ChatTimelineMessage;
  actionable: boolean;
  onRetry?: () => void;
  onReauth?: () => void;
  reauthLabel?: string;
  className?: string;
}) {
  const metadata = asRecord(message.metadata);
  const kind =
    typeof metadata?.errorKind === "string" ? metadata.errorKind : undefined;
  const autoRetry = asRecord(metadata?.autoRetry);
  const nextAtMs =
    typeof autoRetry?.nextAtMs === "number" ? autoRetry.nextAtMs : undefined;
  return (
    <article
      className={`mr-auto max-w-[85%] rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-sm ${className ?? ""}`}
      data-testid="chat-error-card"
    >
      <div className="whitespace-pre-wrap break-words leading-6 text-fg">
        {message.content}
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
              {nextAtMs ? "Retry now" : "Retry"}
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
          {nextAtMs !== undefined && <AutoRetryCountdown nextAtMs={nextAtMs} />}
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
 * Derive the visible timeline from raw agent-session messages: hides
 * in-progress assistant placeholders. Activity comes from execution state.
 * When the latest assistant message is awaiting user input, its parsed
 * questions are exposed so hosts can render an answer UI.
 */
export function toTimeline(
  persisted: AgentMessage[],
  optimistic: ChatTimelineMessage[],
  activity: string | undefined,
): {
  messages: ChatTimelineMessage[];
  activity: string | undefined;
  questions: AgentQuestion[] | undefined;
} {
  const messages = [...persisted, ...optimistic].filter(isConversationMessage);
  return { messages, activity, questions: pendingQuestions(persisted) };
}

/**
 * Questions from the latest assistant turn, but only while they are still
 * unanswered — i.e. the awaiting-input assistant message is the last one.
 */
function pendingQuestions(
  persisted: AgentMessage[],
): AgentQuestion[] | undefined {
  const last = persisted.at(-1);
  if (last?.role !== "assistant") return undefined;
  const metadata = asRecord(last.metadata);
  if (metadata?.status !== "awaiting_input") return undefined;
  const raw = metadata.questions;
  if (!Array.isArray(raw)) return undefined;
  const questions = raw.flatMap((entry): AgentQuestion[] => {
    const question = asRecord(entry);
    if (typeof question?.question !== "string") return [];
    const options = Array.isArray(question.options)
      ? question.options.flatMap((option): AgentQuestionOption[] => {
          const record = asRecord(option);
          return typeof record?.label === "string"
            ? [
                {
                  label: record.label,
                  description:
                    typeof record.description === "string"
                      ? record.description
                      : "",
                },
              ]
            : [];
        })
      : [];
    return [
      {
        question: question.question,
        header:
          typeof question.header === "string" && question.header.length > 0
            ? question.header
            : "Question",
        multiSelect: question.multiSelect === true,
        options,
      },
    ];
  });
  return questions.length > 0 ? questions : undefined;
}

function isConversationMessage(message: ChatTimelineMessage): boolean {
  if (message.role === "system") {
    // Markers and host notices render; other system rows are plumbing.
    const metadata = asRecord(message.metadata);
    return (
      asRecord(metadata?.marker) !== undefined ||
      typeof metadata?.notice === "string"
    );
  }
  if (message.role !== "assistant") return true;
  if (asRecord(message.metadata)?.status === "in_progress") return false;
  // Question-only turns have no prose; the question panel is the content.
  return message.content.trim().length > 0;
}

function textSourceFromMetadata(value: unknown): ChatTextSourceView | null {
  const record = asRecord(value);
  switch (record?.type) {
    case "paste":
      return { type: "paste" };
    case "selection":
      return typeof record.filePath === "string"
        ? {
            type: "selection",
            filePath: record.filePath,
            ...(typeof record.startLine === "number"
              ? { startLine: record.startLine }
              : {}),
            ...(typeof record.endLine === "number"
              ? { endLine: record.endLine }
              : {}),
          }
        : null;
    case "url":
      return typeof record.url === "string"
        ? { type: "url", url: record.url }
        : null;
    case "path":
      return typeof record.path === "string"
        ? { type: "path", path: record.path }
        : null;
    case "tab":
      return typeof record.key === "string" &&
        typeof record.kind === "string" &&
        typeof record.title === "string"
        ? {
            type: "tab",
            key: record.key,
            kind: record.kind,
            title: record.title,
            ...(typeof record.url === "string" ? { url: record.url } : {}),
            ...(typeof record.filePath === "string"
              ? { filePath: record.filePath }
              : {}),
          }
        : null;
    default:
      return null;
  }
}

/** Attachments a persisted message carries in its metadata. */
export function attachmentsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ChatAttachmentView[] {
  const raw = metadata?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry): ChatAttachmentView[] => {
    const record = asRecord(entry);
    if (record?.kind === "text" && typeof record.text === "string") {
      const source = textSourceFromMetadata(record.source);
      return source
        ? [
            {
              kind: "text",
              name: typeof record.name === "string" ? record.name : "Text",
              text: record.text,
              source,
            } satisfies ChatAttachmentView,
          ]
        : [];
    }
    return typeof record?.dataBase64 === "string" &&
      typeof record?.mediaType === "string"
      ? [
          {
            kind: record.kind === "document" ? "document" : "image",
            name: typeof record.name === "string" ? record.name : "attachment",
            mediaType: record.mediaType,
            dataBase64: record.dataBase64,
          } satisfies ChatAttachmentView,
        ]
      : [];
  });
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
