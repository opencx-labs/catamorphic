"use client";

import {
  type AgentTurnUsage,
  answerRows,
  type ContextHandoffItem,
  messageWithAttachmentNames,
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
  Bot,
  Brain,
  Check,
  ChevronRight,
  Copy,
  GitFork,
  ListChecks,
  LoaderCircle,
  MessageCircleQuestion,
  Pencil,
  Radio,
  RotateCcw,
  SquareTerminal,
  Undo2,
  Wrench,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ChatQueue } from "./chat-queue.js";
import { SessionAttribution } from "./session-attribution.js";

const REMARK_PLUGINS = [remarkGfm];

/** What a host action resolves to: false keeps the control actionable. */
type ActionResult = undefined | boolean | Promise<undefined | boolean>;

interface LinkModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

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

export interface ChatTimelineProps {
  /** The conversation as turns: `useAgentChat().timeline`. */
  timeline: TimelineTurn[];
  /** Sent messages the session does not show yet, and failed sends. */
  pending?: PendingAgentMessage[];
  /** Turns waiting to run, shown as editable queued bubbles. */
  queue?: QueuedMessage[];
  /** Live activity line ("Thinking...", tool progress) shown under the turns. */
  activity?: string;
  /** An item to scroll to and outline (a notification's message). */
  focusMessageId?: string;
  onEditQueued?: (turnId: string, text: string) => ActionResult;
  onCancelQueued?: (turnId: string) => ActionResult;
  onSendQueuedNow?: (turnId: string) => ActionResult;
  onHoldQueued?: (turnId: string | null) => ActionResult;
  /** Run a failed turn again. */
  onRetry?: (turnId: string) => void;
  /** Stop the agent; also cancels a turn waiting to retry. */
  onInterrupt?: () => void;
  /** Undo a turn and every later one: files and conversation. */
  onRollback?: (turnId: string) => ActionResult;
  /** Fork the conversation through a message (the item id). */
  onFork?: (itemId: string) => void;
  onResendFailed?: (commandId: string) => void;
  onDismissFailed?: (commandId: string) => void;
  /** Older transcript exists before what is loaded. */
  hasOlder?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  /** A request a `request` step points at, to label it. */
  resolveRequest?: (requestId: string) => RuntimeRequest | undefined;
  /** An agent's display name, for agent-change notices. */
  resolveAgentName?: (agentId: string) => string | undefined;
  /**
   * Render a person's message body. Defaults to the text with attachment
   * names inline; hosts with attachment pills render their own.
   */
  renderUserContent?: (item: UserMessageItem) => ReactNode;
  error?: string | null;
  emptyState?: string;
  className?: string;
  /**
   * Extra classes for the scrolled content column. Lets hosts center a
   * max-width column while the scrollbar hugs the container edge.
   */
  contentClassName?: string;
  /** Optional host preview/pill rendering. The URL has passed Markdown sanitization. */
  renderLink?: (props: {
    href: string;
    children: ReactNode;
    onOpen: NonNullable<ChatTimelineProps["onLinkClick"]>;
  }) => ReactNode;
  /**
   * A link in an agent message was clicked. Hosts route it to their own
   * surface (e.g. an attached browser tab) instead of the anchor default.
   * Modifier state rides along so hosts can offer alternate flavors
   * (background tab, minimize-and-open, ...).
   */
  onLinkClick?: (url: string, modifiers: LinkModifiers) => void;
  /**
   * A changed-file chip was clicked. Hosts open the file (e.g. in an
   * editor surface). Without it the chips stay inert.
   */
  onFileClick?: (path: string, modifiers?: LinkModifiers) => void;
  /**
   * Icon URL for a tool name (MCP tools are `server/tool`; the host maps
   * the server key to its connector icon). Undefined: generic glyph.
   */
  resolveToolIcon?: (toolName: string) => string | undefined;
}

/**
 * Presentational conversation log over the session's turns (ADR 0196):
 * each turn reads as its message, the work that led to the answer behind
 * a "N steps" disclosure, and the answer, with notices, handoffs, answered
 * questions, failures and rollbacks in place. Owns no chat state: feed it
 * from `useAgentChat` (see `AgentChat`).
 */
export function ChatTimeline({
  timeline,
  pending = [],
  queue,
  activity,
  focusMessageId,
  onEditQueued,
  onCancelQueued,
  onSendQueuedNow,
  onHoldQueued,
  onRetry,
  onInterrupt,
  onRollback,
  onFork,
  onResendFailed,
  onDismissFailed,
  hasOlder = false,
  isLoadingOlder = false,
  onLoadOlder,
  resolveRequest,
  resolveAgentName,
  renderUserContent,
  error,
  emptyState = "Ask the agent to build or change your project.",
  className = "",
  contentClassName = "",
  onLinkClick,
  renderLink,
  onFileClick,
  resolveToolIcon,
}: ChatTimelineProps) {
  const lastTurnId = timeline.filter((entry) => entry.turn).at(-1)?.turn?.id;
  const empty =
    timeline.length === 0 &&
    pending.length === 0 &&
    !activity &&
    !queue?.length;
  const context: TurnContext = {
    onLinkClick,
    renderLink,
    onFileClick,
    resolveToolIcon,
    resolveRequest,
    resolveAgentName,
    renderUserContent,
    onRetry,
    onInterrupt,
    onRollback,
    onFork,
    focusMessageId,
  };
  return (
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
          <button
            type="button"
            onClick={onLoadOlder}
            disabled={isLoadingOlder}
            className="mx-auto flex cursor-pointer items-center gap-1.5 rounded-full border border-border px-3 py-1 text-[11px] text-fg-muted transition-colors duration-150 hover:text-fg disabled:cursor-default"
            data-testid="chat-load-older"
          >
            {isLoadingOlder && <LoaderCircle className="size-3 animate-spin" />}
            {isLoadingOlder
              ? "Loading earlier messages"
              : "Load earlier messages"}
          </button>
        )}
        {empty && (
          <div className="m-auto max-w-sm text-center text-sm leading-6 text-fg-muted">
            {emptyState}
          </div>
        )}
        <LinkContext.Provider value={{ onLinkClick, renderLink }}>
          {timeline.map((entry) => (
            <TurnView
              key={entry.key}
              entry={entry}
              latest={entry.turn !== null && entry.turn.id === lastTurnId}
              context={context}
            />
          ))}
        </LinkContext.Provider>
        {pending.map((message) => (
          <PendingBubble
            key={message.commandId}
            message={message}
            onResend={onResendFailed}
            onDismiss={onDismissFailed}
          />
        ))}
        {activity && (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <LoaderCircle className="size-4 animate-spin" />
            <span className="animate-pulse">{activity}</span>
          </div>
        )}
        {queue && queue.length > 0 && (
          <ChatQueue
            queue={queue}
            onEdit={onEditQueued}
            onCancel={onCancelQueued}
            onSendNow={onSendQueuedNow}
            onHold={onHoldQueued}
          />
        )}
        {error && (
          <div className="rounded-lg border border-danger/50 bg-danger/10 px-3 py-2 text-xs text-danger">
            {error}
          </div>
        )}
      </StickToBottom.Content>
      <FocusMessage
        messageId={focusMessageId}
        ready={timeline.some((turn) =>
          turn.entries.some((entry) => entryId(entry) === focusMessageId),
        )}
      />
      <ScrollToLatest />
    </StickToBottom>
  );
}

interface TurnContext
  extends Pick<
    ChatTimelineProps,
    | "onLinkClick"
    | "renderLink"
    | "onFileClick"
    | "resolveToolIcon"
    | "resolveRequest"
    | "resolveAgentName"
    | "renderUserContent"
    | "onRetry"
    | "onInterrupt"
    | "onRollback"
    | "onFork"
    | "focusMessageId"
  > {}

function entryId(entry: TimelineEntry): string | undefined {
  switch (entry.kind) {
    case "answer":
      return entry.id;
    case "steps":
      return undefined;
    default:
      return entry.item.id;
  }
}

/** One turn: its entries, then how it ended (failure, interruption, undo). */
function TurnView({
  entry,
  latest,
  context,
}: {
  entry: TimelineTurn;
  latest: boolean;
  context: TurnContext;
}) {
  const { turn } = entry;
  const rolledBack = turn?.status === "rolled_back";
  const settled = turn ? isSettled(turn) : true;
  const lastReplyIndex = entry.entries.reduce(
    (last, candidate, index) => (candidate.kind === "reply" ? index : last),
    -1,
  );
  return (
    <div
      className={`group/turn flex flex-col gap-3 transition-opacity duration-200 ${rolledBack ? "opacity-50" : ""}`}
      data-turn-id={turn?.id}
      data-turn-status={turn?.status}
    >
      {entry.entries.map((item, index) => {
        const id = entryId(item);
        return (
          <div
            key={id ?? `steps:${index}`}
            data-message-id={id}
            tabIndex={id ? -1 : undefined}
            className={
              id && id === context.focusMessageId
                ? "rounded-md outline outline-1 outline-accent/50"
                : "contents"
            }
          >
            <Entry
              entry={item}
              live={!settled}
              context={context}
              footer={
                turn && index === lastReplyIndex && settled && !rolledBack ? (
                  <TurnFooter
                    turn={turn}
                    replyId={item.kind === "reply" ? item.item.id : undefined}
                    replyText={item.kind === "reply" ? item.item.text : ""}
                    context={context}
                  />
                ) : undefined
              }
            />
          </div>
        );
      })}
      {turn && lastReplyIndex === -1 && settled && !rolledBack && (
        <ChangedFiles
          files={turn.outcome?.changedFiles.map((file) => file.path) ?? []}
          onFileClick={context.onFileClick}
        />
      )}
      {turn && <TurnEnding turn={turn} latest={latest} context={context} />}
    </div>
  );
}

function isSettled(turn: Turn): boolean {
  return (
    turn.status === "completed" ||
    turn.status === "failed" ||
    turn.status === "interrupted" ||
    turn.status === "cancelled" ||
    turn.status === "rolled_back"
  );
}

/** How a turn ended, when it did not simply answer. */
function TurnEnding({
  turn,
  latest,
  context,
}: {
  turn: Turn;
  latest: boolean;
  context: TurnContext;
}) {
  if (turn.status === "rolled_back")
    return (
      <div
        className="flex items-center gap-1.5 text-[11px] text-fg-faint"
        data-testid="chat-turn-undone"
      >
        <Undo2 className="size-3" /> Undone
      </div>
    );
  if (turn.status === "failed")
    return (
      <article
        className="mr-auto max-w-[85%] rounded-xl border border-danger/40 bg-danger/5 px-3 py-2.5 text-sm"
        data-testid="chat-error-card"
      >
        <div className="whitespace-pre-wrap break-words leading-6 text-fg">
          {turn.error?.message ?? "The agent stopped with an error."}
        </div>
        {latest && context.onRetry && (
          <button
            type="button"
            onClick={() => context.onRetry?.(turn.id)}
            className="mt-2 flex cursor-pointer items-center gap-1.5 rounded-md border border-border bg-bg-raised px-2.5 py-1 text-xs font-medium text-fg"
            data-testid="chat-retry"
          >
            <RotateCcw className="size-3" /> Retry
          </button>
        )}
      </article>
    );
  if (turn.status === "interrupted")
    return <Divider testId="chat-interrupted">Interrupted</Divider>;
  if (
    (turn.status === "queued" || turn.status === "held") &&
    turn.attemptCount > 0
  )
    return (
      <RetryCountdown
        retryAt={turn.retryAt}
        error={turn.error?.message}
        onStop={context.onInterrupt}
      />
    );
  return null;
}

/** A turn that ran and waits to run again on its own. */
function RetryCountdown({
  retryAt,
  error,
  onStop,
}: {
  retryAt: string | null;
  error?: string;
  onStop?: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!retryAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [retryAt]);
  const seconds = retryAt
    ? Math.max(0, Math.ceil((Date.parse(retryAt) - now) / 1000))
    : 0;
  return (
    <div
      className="mr-auto flex max-w-[85%] items-center gap-2 rounded-lg border border-border bg-bg-raised px-3 py-2 text-xs text-fg-muted"
      data-testid="chat-retrying"
    >
      <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
      <span className="min-w-0 flex-1">
        {seconds > 0 ? `Retrying in ${seconds}s` : "Retrying"}
        {error ? `. ${error}` : ""}
      </span>
      {onStop && (
        <button
          type="button"
          onClick={onStop}
          className="shrink-0 cursor-pointer rounded-md border border-border-strong px-2 py-0.5 text-fg"
          data-testid="chat-stop-retrying"
        >
          Stop
        </button>
      )}
    </div>
  );
}

function Entry({
  entry,
  live,
  context,
  footer,
}: {
  entry: TimelineEntry;
  live: boolean;
  context: TurnContext;
  footer?: ReactNode;
}) {
  switch (entry.kind) {
    case "input":
      return <InputMessage item={entry.item} context={context} />;
    case "reply":
      return (
        <article className="mr-auto max-w-[85%] text-sm">
          <TurnSteps steps={entry.steps} live={false} context={context} />
          <AssistantMarkdown text={entry.item.text} context={context} />
          {footer}
        </article>
      );
    case "steps":
      return (
        <div className="mr-auto max-w-[85%] text-sm">
          <TurnSteps steps={entry.steps} live={live} context={context} />
        </div>
      );
    case "answer":
      return <AnswerMessage entry={entry} />;
    case "notice":
      return <NoticeLine item={entry.item} context={context} />;
    case "handoff":
      return <HandoffLine item={entry.item} />;
  }
}

function AssistantMarkdown({
  text,
  context,
}: {
  text: string;
  context: TurnContext;
}) {
  const { onLinkClick } = context;
  return (
    <div className="cat-markdown min-w-0 break-words leading-6">
      <Markdown
        remarkPlugins={REMARK_PLUGINS}
        urlTransform={(url, key) =>
          onLinkClick &&
          key === "href" &&
          /^(?:file|workflow|app|artifact|chat|browser|terminal|editor|diff|mcpapp|session|run):/i.test(
            url,
          )
            ? url
            : defaultUrlTransform(url)
        }
        components={onLinkClick ? LINK_COMPONENTS : undefined}
      >
        {text}
      </Markdown>
    </div>
  );
}

/** Fade and rise once on mount. */
function useEntered(): boolean {
  const [entered, setEntered] = useState(false);
  // Double rAF: the first frame aligns with the commit, the second
  // guarantees the browser resolved the hidden pose before it flips. A
  // single rAF can fire before the mount frame ever paints, collapsing
  // both poses into one style recalc and skipping the entrance.
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
  return entered;
}

// transition-[opacity,translate], not transform: Tailwind v4's
// translate-y-* sets the individual `translate` property, which a
// `transform` transition does not cover.
const ENTER =
  "motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)]";
const enterPose = (entered: boolean) =>
  entered
    ? "motion-safe:translate-y-0 motion-safe:opacity-100"
    : "motion-safe:translate-y-1 motion-safe:opacity-0";

const USER_BUBBLE =
  "ml-auto rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2";

function InputMessage({
  item,
  context,
}: {
  item: UserMessageItem;
  context: TurnContext;
}) {
  const entered = useEntered();
  // Host notices (a background command finished) read as one quiet line;
  // the agent gets the full message and answers below it.
  const notice =
    typeof item.metadata.notice === "string" ? item.metadata.notice : undefined;
  if (item.author.kind === "system" && notice)
    return (
      <div
        className="flex items-center justify-center gap-1.5 text-center text-xs text-fg-faint"
        data-testid="chat-notice"
      >
        <Radio className="size-3 shrink-0" />
        <span className="truncate">{notice}</span>
      </div>
    );
  const person = item.author.kind === "user";
  return (
    <article
      className={`max-w-[85%] text-sm ${ENTER} ${enterPose(entered)} ${person ? USER_BUBBLE : "mr-auto"}`}
      data-testid="chat-user-message"
    >
      <SessionAttribution
        author={item.author}
        metadata={item.metadata}
        attention={item.attention}
        onOpen={context.onLinkClick}
      />
      <div className="whitespace-pre-wrap break-words leading-6">
        {context.renderUserContent
          ? context.renderUserContent(item)
          : messageWithAttachmentNames(item.text, item.attachments)}
      </div>
    </article>
  );
}

/** A message this client sent that the session does not show yet. */
function PendingBubble({
  message,
  onResend,
  onDismiss,
}: {
  message: PendingAgentMessage;
  onResend?: (commandId: string) => void;
  onDismiss?: (commandId: string) => void;
}) {
  const entered = useEntered();
  const failed = message.status === "failed";
  return (
    <article
      className={`ml-auto max-w-[85%] rounded-xl rounded-br-sm border px-3 py-2 text-sm ${ENTER} ${enterPose(entered)} ${failed ? "border-danger/40 bg-danger/5" : "border-info/30 bg-info/10"}`}
      data-testid={failed ? "chat-failed-message" : "chat-sending-message"}
      data-command-id={message.commandId}
    >
      <div className="whitespace-pre-wrap break-words leading-6">
        {messageWithAttachmentNames(message.text, message.attachments) ||
          "Attachment"}
      </div>
      <div className="mt-1 flex items-center justify-end gap-3 text-[11px] text-fg-faint">
        {failed ? (
          <>
            <span className="mr-auto min-w-0 truncate text-danger">
              {message.error?.message ?? "Not delivered"}
            </span>
            {onResend && (
              <button
                type="button"
                onClick={() => onResend(message.commandId)}
                className="cursor-pointer text-accent"
                data-testid="chat-resend"
              >
                Resend
              </button>
            )}
            {onDismiss && (
              <button
                type="button"
                onClick={() => onDismiss(message.commandId)}
                className="cursor-pointer text-fg-muted hover:text-fg"
              >
                Dismiss
              </button>
            )}
          </>
        ) : (
          <span>Sending</span>
        )}
      </div>
    </article>
  );
}

/** An answer from the question panel: the questions and what was picked. */
function AnswerMessage({
  entry,
}: {
  entry: Extract<TimelineEntry, { kind: "answer" }>;
}) {
  if (entry.dismissed)
    return (
      <div className="text-center text-xs italic text-fg-faint">
        Questions dismissed
      </div>
    );
  return (
    <article
      data-testid="question-answer"
      className="ml-auto max-w-[85%] rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2 text-sm"
    >
      <dl className="flex flex-col gap-1.5">
        {answerRows(entry).map((row, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are fixed per answer
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

function Divider({
  children,
  testId,
}: {
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      className="flex items-center gap-3 text-center text-[11px] text-fg-faint"
      data-testid={testId}
    >
      <span className="h-px flex-1 bg-border" />
      <span className="min-w-0 max-w-[70%]">{children}</span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

/** A line Work wrote: an agent or model change, a fork, a continued turn. */
function NoticeLine({
  item,
  context,
}: {
  item: NoticeItem;
  context: TurnContext;
}) {
  const agentId = item.data.agentId;
  const agentName =
    item.code === "agent_changed" && typeof agentId === "string"
      ? context.resolveAgentName?.(agentId)
      : undefined;
  return (
    <div data-notice-code={item.code} className="contents">
      <Divider testId="chat-session-notice">
        {agentName ? `Switched to ${agentName}` : item.text}
      </Divider>
    </div>
  );
}

/** What an agent was told about turns its thread had not seen. */
function HandoffLine({ item }: { item: ContextHandoffItem }) {
  const [open, setOpen] = useState(false);
  const { from, to } = item.coveredTurnOrdinals;
  const count = Math.max(1, to - from + 1);
  return (
    <div className="flex flex-col gap-1" data-testid="chat-handoff">
      <Divider>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
          className="inline-flex cursor-pointer items-center gap-1 transition-colors duration-100 hover:text-fg-muted"
        >
          <ChevronRight
            className={`size-3 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          />
          Caught up on {count} earlier {count === 1 ? "turn" : "turns"}
        </button>
      </Divider>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
      >
        <div className="overflow-hidden">
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 font-sans text-[11px] leading-4 text-fg-muted">
            {item.text}
          </pre>
        </div>
      </div>
    </div>
  );
}

/** Under a settled turn's answer: changed files, usage, and hover actions. */
function TurnFooter({
  turn,
  replyId,
  replyText,
  context,
}: {
  turn: Turn;
  replyId?: string;
  replyText: string;
  context: TurnContext;
}) {
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [rollbackFailed, setRollbackFailed] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);
  const usage = usageLabel(turn.outcome?.usage);
  const { onFork, onRollback } = context;
  const canRollback = Boolean(onRollback) && turn.status !== "cancelled";
  const rollback = async () => {
    if (!onRollback || rolling) return;
    setRolling(true);
    setRollbackFailed(false);
    try {
      const result = await onRollback(turn.id);
      if (result === false) setRollbackFailed(true);
      else setConfirming(false);
    } catch {
      setRollbackFailed(true);
    } finally {
      setRolling(false);
    }
  };
  const action =
    "grid size-6 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-100 hover:bg-bg-overlay hover:text-fg";
  return (
    <>
      <ChangedFiles
        files={turn.outcome?.changedFiles.map((file) => file.path) ?? []}
        onFileClick={context.onFileClick}
      />
      {confirming ? (
        <div
          className="mt-2 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-bg-raised px-2.5 py-1.5 text-xs"
          data-testid="chat-rollback-confirm"
        >
          <span className="min-w-0 flex-1 text-fg-muted">
            {rollbackFailed
              ? "That did not work. Try again."
              : "Undo this turn and every later one? Files and the conversation go back to before it."}
          </span>
          <button
            type="button"
            onClick={() => void rollback()}
            disabled={rolling}
            className="cursor-pointer rounded-md bg-accent px-2.5 py-1 font-medium text-accent-fg disabled:opacity-50"
            data-testid="chat-rollback-confirm-button"
          >
            Undo
          </button>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            disabled={rolling}
            className="cursor-pointer rounded-md px-2 py-1 text-fg-muted hover:text-fg"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/turn:opacity-100 group-focus-within/turn:opacity-100">
          {replyText && (
            <button
              type="button"
              className={action}
              onClick={() =>
                void navigator.clipboard
                  ?.writeText(replyText)
                  .then(() => setCopied(true))
              }
              aria-label="Copy answer"
              title="Copy"
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
            </button>
          )}
          {onFork && replyId && (
            <button
              type="button"
              className={action}
              onClick={() => onFork(replyId)}
              aria-label="Fork from here"
              title="Fork from here"
              data-testid="chat-fork"
            >
              <GitFork className="size-3.5" />
            </button>
          )}
          {canRollback && (
            <button
              type="button"
              className={action}
              onClick={() => setConfirming(true)}
              aria-label="Undo from here"
              title="Undo from here"
              data-testid="chat-rollback"
            >
              <Undo2 className="size-3.5" />
            </button>
          )}
          {usage && (
            <span className="ml-1.5 font-mono text-[10px] text-fg-faint">
              {usage}
            </span>
          )}
        </div>
      )}
    </>
  );
}

function ChangedFiles({
  files,
  onFileClick,
}: {
  files: string[];
  onFileClick?: ChatTimelineProps["onFileClick"];
}) {
  if (files.length === 0) return null;
  return (
    <div className="mt-2 flex flex-wrap gap-1">
      {files.map((file) =>
        onFileClick ? (
          <button
            key={file}
            type="button"
            data-file-path={file}
            onClick={(event) =>
              onFileClick(file, {
                metaKey: event.metaKey,
                ctrlKey: event.ctrlKey,
                shiftKey: event.shiftKey,
                altKey: event.altKey,
              })
            }
            className="cursor-pointer rounded border border-success/50 bg-success/10 px-1.5 py-0.5 font-mono text-[11px] text-success transition-colors duration-100 hover:bg-success/20"
          >
            {file}
          </button>
        ) : (
          <code
            key={file}
            className="rounded border border-success/50 bg-success/10 px-1.5 py-0.5 text-[11px] text-success"
          >
            {file}
          </code>
        ),
      )}
    </div>
  );
}

/** "12.4k tokens · $0.03", from what the harness reported. */
function usageLabel(usage: AgentTurnUsage | undefined): string | undefined {
  if (!usage) return undefined;
  const tokens =
    (usage.inputTokens ?? 0) +
    (usage.cachedInputTokens ?? 0) +
    (usage.cacheCreationTokens ?? 0) +
    (usage.outputTokens ?? 0);
  const parts: string[] = [];
  if (tokens > 0)
    parts.push(
      `${tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : tokens} tokens`,
    );
  if (usage.costUsd !== undefined && usage.costUsd > 0)
    parts.push(`$${usage.costUsd.toFixed(2)}`);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

// ---------------------------------------------------------------------------
// Steps

/** One row of a turn's expandable work log. */
interface TurnStep {
  id: string;
  kind:
    | "command"
    | "file_edit"
    | "tool"
    | "subagent"
    | "reasoning"
    | "plan"
    | "request";
  /** Row header: the technical detail lives here, not on the live line. */
  label: string;
  /** Monospace label (commands, paths, unrecognized tool names). */
  mono?: boolean;
  /** Tool name for the icon lookup (`server/tool` for MCP). */
  toolName?: string;
  /** Preformatted expandable body (tool input/result, full command). */
  detail?: string;
  /** Technical payloads use mono; host-tool summaries read as normal prose. */
  detailMono?: boolean;
  status: WorkItem["status"];
  /** Milliseconds the step took, when it reported both ends. */
  durationMs?: number;
}

const STEP_ICONS = {
  command: SquareTerminal,
  file_edit: Pencil,
  tool: Wrench,
  subagent: Bot,
  reasoning: Brain,
  plan: ListChecks,
  request: MessageCircleQuestion,
} as const;

/**
 * Friendly step labels for well-known tools, harness-neutral: Claude
 * Code's built-ins (Read, WebSearch, ...), the built-in agent's lowercase
 * kin (read, websearch, ...), and the desktop's workspace tools (identical
 * names on every harness). MCP tools render as "tool (server)"; anything
 * else falls back to its raw name in mono.
 */
const TOOL_STEP_LABELS: Record<string, string> = {
  // Questions and plans.
  AskUserQuestion: "Asked you a question",
  ask_user: "Asked you a question",
  close_questions: "Closed its questions",
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
  run_background_command: "Ran command in background",
  read_background_output: "Checked a background command",
  stop_background_command: "Stopped background work",
  watch_command: "Watched for a change",
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
  "run_background_command",
  "read_background_output",
  "stop_background_command",
  "watch_command",
  "write_terminal",
  "sync_project",
  "create_pull_request",
  "request_connection",
  "read_skill",
  "surface_control",
]);

/**
 * Bookkeeping calls, not work the reader cares about: the title/icon
 * change is already visible on the chat itself.
 */
const HIDDEN_STEP_TOOLS = new Set(["set_title", "set_chat_icon"]);

/** The tool as people read it: `server/tool` for MCP, else its own name. */
function toolDisplayName(item: Extract<WorkItem, { kind: "tool_call" }>) {
  if (!item.server) return item.tool;
  const prefix = `mcp__${item.server}__`;
  const name = item.tool.startsWith(prefix)
    ? item.tool.slice(prefix.length)
    : item.tool;
  return `${item.server}/${name}`;
}

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
    return [
      `${statusMarker(friendlyScalar(todo.status))} ${title}`,
      ...(description ? [`  ${description}`] : []),
    ];
  });
  const completed = friendlyScalar(resultRecord?.completed);
  const total = friendlyScalar(resultRecord?.total);
  if (completed && total) lines.push("", `${completed} of ${total} complete`);
  return lines.join("\n");
}

function statusMarker(status: string | undefined): string {
  return status === "completed" ? "✓" : status === "in_progress" ? "●" : "○";
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

function durationOf(item: WorkItem): number | undefined {
  if (!item.startedAt || !item.endedAt) return undefined;
  const ms = Date.parse(item.endedAt) - Date.parse(item.startedAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** "850ms", "12s", "2m 5s". */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest > 0 ? `${minutes}m ${rest}s` : `${minutes}m`;
}

function requestStepLabel(request: RuntimeRequest | undefined): string {
  if (!request) return "Asked for your input";
  if (request.kind === "question") return "Asked you a question";
  if (request.kind === "elicitation") return "Asked for input";
  const tool = request.approval?.tool?.name ?? request.title;
  const response = request.response;
  const outcome =
    response?.kind === "approval"
      ? response.decision === "approved"
        ? ". Allowed"
        : ". Denied"
      : request.status === "expired" || request.status === "cancelled"
        ? ". No answer"
        : "";
  return `Asked to use ${tool}${outcome}`;
}

/** A turn's work items as rows of its steps disclosure. */
function turnSteps(
  items: readonly WorkItem[],
  resolveRequest: ChatTimelineProps["resolveRequest"],
): TurnStep[] {
  const steps: TurnStep[] = [];
  for (const item of items) {
    const base = {
      id: item.id,
      status: item.status,
      durationMs: durationOf(item),
    };
    switch (item.kind) {
      case "command": {
        const description = item.description?.trim() ?? "";
        const firstLine = item.command.split("\n", 1)[0]?.trim() ?? "";
        // The agent's own words lead; the command itself is one click away.
        steps.push({
          ...base,
          kind: "command",
          label: description || `$ ${firstLine || "(command)"}`,
          mono: !description,
          detail: stepDetailText(
            [
              description || item.command.includes("\n")
                ? item.command
                : undefined,
              stepDetailText(item.output),
              item.exitCode !== null && item.exitCode !== 0
                ? `Exit code ${item.exitCode}`
                : undefined,
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
          detailMono: true,
        });
        break;
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
        steps.push({
          ...base,
          kind: "file_edit",
          label:
            item.change === "renamed" && item.previousPath
              ? `${verb} ${item.previousPath} to ${item.path}`
              : `${verb} ${item.path || "a file"}`,
          mono: true,
        });
        break;
      }
      case "tool_call": {
        const toolName = toolDisplayName(item);
        if (HIDDEN_STEP_TOOLS.has(toolName)) break;
        const pretty = toolStepLabel(toolName, item.input);
        const known = !pretty.mono;
        const description = item.description?.trim();
        steps.push({
          ...base,
          kind: "tool",
          label: !known && description ? description : pretty.label,
          mono: !known && !description,
          toolName,
          detail: stepDetailText(
            [
              toolStepDetail(toolName, item.input, item.result),
              item.error ? `Error:\n${item.error}` : undefined,
            ]
              .filter(Boolean)
              .join("\n\n"),
          ),
          detailMono: !DESKTOP_STEP_TOOLS.has(toolName),
        });
        break;
      }
      case "reasoning":
        if (!item.text.trim()) break;
        steps.push({
          ...base,
          kind: "reasoning",
          label: "Thought",
          detail: stepDetailText(item.text),
        });
        break;
      case "plan":
        steps.push({
          ...base,
          kind: "plan",
          label: "Updated the plan",
          detail: item.steps
            .map((step) => `${statusMarker(step.status)} ${step.text}`)
            .join("\n"),
        });
        break;
      case "request":
        steps.push({
          ...base,
          kind: "request",
          label: requestStepLabel(resolveRequest?.(item.requestId)),
        });
        break;
      case "subagent":
        steps.push({
          ...base,
          kind: "subagent",
          label: `Subagent: ${item.title || "delegated work"}`,
          detail: stepDetailText(item.result),
        });
        break;
    }
  }
  return steps;
}

/**
 * The expandable work log of a turn: collapsed to a muted "N steps" line;
 * expanded, each step is a row that itself stays collapsed (payloads are
 * long and technical) until clicked. MCP tool rows show the connector's
 * icon when the host can resolve one.
 */
function TurnSteps({
  steps: items,
  live,
  context,
}: {
  steps: readonly WorkItem[];
  /** The turn is still working: rows may still be running. */
  live: boolean;
  context: TurnContext;
}) {
  const [expanded, setExpanded] = useState(false);
  const steps = turnSteps(items, context.resolveRequest);
  if (steps.length === 0) return null;
  const starts = items.flatMap((item) =>
    item.startedAt ? [Date.parse(item.startedAt)] : [],
  );
  const ends = items.flatMap((item) =>
    item.endedAt ? [Date.parse(item.endedAt)] : [],
  );
  const span =
    !live && starts.length > 0 && ends.length > 0
      ? Math.max(...ends) - Math.min(...starts)
      : undefined;
  return (
    <div className="mb-1.5" data-testid="chat-turn-steps">
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
        {span !== undefined && span >= 1000 && ` · ${formatDuration(span)}`}
      </button>
      {/* Grid-rows tween: the list stays mounted, so the collapse mirrors
          the expansion exactly. */}
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          expanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div className="mt-1 flex flex-col gap-0.5 border-l border-border pl-2.5">
            {steps.map((step) => (
              <StepRow
                key={step.id}
                step={step}
                iconUrl={
                  step.toolName
                    ? context.resolveToolIcon?.(step.toolName)
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StepRow({ step, iconUrl }: { step: TurnStep; iconUrl?: string }) {
  const [open, setOpen] = useState(false);
  const Icon = STEP_ICONS[step.kind];
  const expandable = Boolean(step.detail);
  return (
    <div data-testid="chat-step" data-step-status={step.status}>
      <button
        type="button"
        onClick={expandable ? () => setOpen((value) => !value) : undefined}
        className={`flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-fg-muted ${
          expandable
            ? "cursor-pointer transition-colors duration-100 hover:bg-bg-inset hover:text-fg"
            : "cursor-default"
        }`}
        aria-expanded={expandable ? open : undefined}
      >
        {step.status === "in_progress" ? (
          <LoaderCircle className="size-3.5 shrink-0 animate-spin text-fg-faint" />
        ) : iconUrl ? (
          <img src={iconUrl} alt="" className="size-3.5 shrink-0 rounded-sm" />
        ) : (
          <Icon className="size-3.5 shrink-0 text-fg-faint" />
        )}
        <span
          className={`min-w-0 flex-1 truncate ${step.mono ? "font-mono" : ""}`}
        >
          {step.label}
        </span>
        {step.status === "failed" && (
          <span className="shrink-0 text-danger">Failed</span>
        )}
        {step.durationMs !== undefined && step.durationMs >= 1000 && (
          <span className="shrink-0 font-mono text-[10px] text-fg-faint">
            {formatDuration(step.durationMs)}
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
          <div className="overflow-hidden">
            <pre
              className={`mb-1 ml-6 mt-0.5 max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-bg-inset p-2 text-[11px] leading-4 text-fg-muted ${step.detailMono ? "font-mono" : "font-sans"}`}
              data-testid="chat-step-detail"
            >
              {step.detail}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
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
