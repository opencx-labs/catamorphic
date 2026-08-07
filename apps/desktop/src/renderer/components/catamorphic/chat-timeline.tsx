"use client";

import type { AgentMessage, QueuedAgentMessage } from "@catamorphic/react";
import {
  ArrowDown,
  ChevronUp,
  FileText,
  KeyRound,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";
import { ShortcutHint } from "../shortcut-hint";

const REMARK_PLUGINS = [remarkGfm];

export interface ChatAttachmentView {
  kind: "image" | "document";
  name: string;
  mediaType: string;
  dataBase64: string;
}

export interface ChatTimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
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

export interface ChatTimelineProps {
  /** Persisted + optimistic messages, in order. */
  messages: ChatTimelineMessage[];
  /** Live activity line ("Thinking...", tool progress) shown under messages. */
  activity?: string;
  /** @deprecated superseded by `queue`; kept for simple hosts. */
  queuedCount?: number;
  /** Messages waiting behind the in-flight turn (editable until sent). */
  queue?: QueuedAgentMessage[];
  onUpdateQueued?: (id: string, content: string) => void;
  onRemoveQueued?: (id: string) => void;
  /** Promote a queued message: front of the line + interrupt the turn. */
  onSendQueuedNow?: (id: string) => void;
  /** A queued message entered/left inline editing (null = none). */
  onHoldQueued?: (id: string | null) => void;
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
  onLinkClick?: (
    url: string,
    modifiers: { metaKey: boolean; shiftKey: boolean },
  ) => void;
  onFileClick?: (path: string) => void;
}

/**
 * Presentational conversation log: message bubbles (user right, agent left
 * — no name tags), media attachments, agent/effort change markers, error
 * cards with recovery actions, the editable outgoing queue, live activity,
 * stick-to-bottom scrolling. Owns no chat state — feed it from
 * `useAgentChat` (see `AgentChat`) or any other source.
 */
export function ChatTimeline({
  messages,
  activity,
  queuedCount = 0,
  queue,
  onUpdateQueued,
  onRemoveQueued,
  onSendQueuedNow,
  onHoldQueued,
  onRetry,
  onReauth,
  reauthLabel,
  error,
  emptyState = "Ask the agent to build or change your project.",
  className = "",
  contentClassName = "",
  resolveAgentName,
  onLinkClick,
  onFileClick,
}: ChatTimelineProps) {
  const lastConversationId = [...messages]
    .reverse()
    .find((message) => message.role !== "system")?.id;
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
        {messages.length === 0 && !activity && (
          <div className="m-auto max-w-sm text-center text-sm leading-6 text-fg-muted">
            {emptyState}
          </div>
        )}
        {messages.map((message, index) => (
          <Message
            key={timelineKey(message, index, messages)}
            message={message}
            isLast={message.id === lastConversationId}
            resolveAgentName={resolveAgentName}
            onLinkClick={onLinkClick}
            onFileClick={onFileClick}
            onRetry={onRetry}
            onReauth={onReauth}
            reauthLabel={reauthLabel}
          />
        ))}
        {activity && (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <LoaderCircle className="size-4 animate-spin" />
            <span className="animate-pulse">{activity}</span>
            {!queue && queuedCount > 0 && (
              <span className="ml-auto text-fg-faint">
                {queuedCount} queued
              </span>
            )}
          </div>
        )}
        {queue && queue.length > 0 && (
          <QueueList
            queue={queue}
            onUpdate={onUpdateQueued}
            onRemove={onRemoveQueued}
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
      <ScrollToLatest />
    </StickToBottom>
  );
}

/**
 * Content-position identity instead of message.id: when an optimistic user
 * message is replaced by its persisted twin, the id flips (uuid → db id) but
 * the rendered content is identical. A content-based key keeps the same DOM
 * node, so the settle is invisible instead of a remount (fade-in replay).
 */
function timelineKey(
  message: ChatTimelineMessage,
  index: number,
  messages: ChatTimelineMessage[],
): string {
  let occurrence = 0;
  for (let i = 0; i < index; i += 1) {
    const other = messages[i];
    if (other?.role === message.role && other?.content === message.content) {
      occurrence += 1;
    }
  }
  return `${message.role}:${occurrence}:${message.content}`;
}

function Message({
  message,
  isLast,
  resolveAgentName,
  onLinkClick,
  onFileClick,
  onRetry,
  onReauth,
  reauthLabel,
}: {
  message: ChatTimelineMessage;
  isLast: boolean;
  resolveAgentName?: (agentId: string) => string | undefined;
  onLinkClick?: ChatTimelineProps["onLinkClick"];
  onFileClick?: (path: string) => void;
  onRetry?: () => void;
  onReauth?: () => void;
  reauthLabel?: string;
}) {
  const files = changedFiles(message);
  const metadata = asRecord(message.metadata);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
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
  const failed = metadata?.status === "failed";
  const enterClasses = `motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"}`;

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
    return (
      <ErrorCard
        message={message}
        actionable={isLast}
        onRetry={onRetry}
        onReauth={onReauth}
        reauthLabel={reauthLabel}
        className={enterClasses}
      />
    );
  }

  return (
    <article
      className={`max-w-[85%] text-sm ${enterClasses} ${message.role === "user" ? "ml-auto rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2" : "mr-auto"}`}
    >
      {attachments.length > 0 && <AttachmentStrip attachments={attachments} />}
      {message.role === "user" ? (
        <div className="whitespace-pre-wrap break-words leading-6">
          {message.content}
        </div>
      ) : (
        <div className="cat-markdown min-w-0 break-words leading-6">
          <Markdown
            remarkPlugins={REMARK_PLUGINS}
            components={
              onLinkClick
                ? {
                    a: ({ href, children }) => (
                      <a
                        href={href}
                        onClick={(event) => {
                          event.preventDefault();
                          if (href) {
                            onLinkClick(href, {
                              metaKey: event.metaKey,
                              shiftKey: event.shiftKey,
                            });
                          }
                        }}
                      >
                        {children}
                      </a>
                    ),
                  }
                : undefined
            }
          >
            {message.content}
          </Markdown>
        </div>
      )}
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {files.map((file) =>
            onFileClick ? (
              <button
                key={file}
                type="button"
                onClick={() => onFileClick(file)}
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
      )}
    </article>
  );
}

/** Image thumbnails and document chips on a (user) message. */
function AttachmentStrip({
  attachments,
}: {
  attachments: ChatAttachmentView[];
}) {
  return (
    <div className="mb-1.5 flex flex-wrap justify-end gap-1.5">
      {attachments.map((attachment) =>
        attachment.kind === "image" ? (
          <img
            key={`${attachment.name}:${attachment.dataBase64.length}:${attachment.dataBase64.slice(-24)}`}
            src={`data:${attachment.mediaType};base64,${attachment.dataBase64}`}
            alt={attachment.name}
            className="max-h-40 max-w-56 rounded-lg border border-border object-cover"
          />
        ) : (
          <span
            key={`${attachment.name}:${attachment.dataBase64.length}:${attachment.dataBase64.slice(-24)}`}
            className="flex items-center gap-1.5 rounded-md border border-border bg-bg-inset px-2 py-1 text-[11px] text-fg-muted"
          >
            <FileText className="size-3" />
            <span className="max-w-40 truncate">{attachment.name}</span>
          </span>
        ),
      )}
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
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
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

/** How many queued messages stay visible while collapsed. */
const QUEUE_COLLAPSE_THRESHOLD = 2;

/**
 * The outgoing queue, rendered at the end of the chat as ghost bubbles:
 * dashed, right-aligned, each editable (which pauses its dispatch),
 * deletable, or promotable ("send now" interrupts the running turn). Long
 * queues collapse behind a "N queued" toggle.
 */
function QueueList({
  queue,
  onUpdate,
  onRemove,
  onSendNow,
  onHold,
}: {
  queue: QueuedAgentMessage[];
  onUpdate?: (id: string, content: string) => void;
  onRemove?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onHold?: (id: string | null) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const collapsed = !expanded && queue.length > QUEUE_COLLAPSE_THRESHOLD;
  const visible = collapsed ? queue.slice(0, 1) : queue;
  const hidden = queue.length - visible.length;
  return (
    <div className="flex flex-col items-end gap-1.5" data-testid="chat-queue">
      {visible.map((queued) => (
        <QueuedBubble
          key={queued.id}
          queued={queued}
          onUpdate={onUpdate}
          onRemove={onRemove}
          onSendNow={onSendNow}
          onHold={onHold}
        />
      ))}
      {queue.length > QUEUE_COLLAPSE_THRESHOLD && (
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex cursor-pointer items-center gap-1 rounded-full border border-border bg-bg-inset px-2.5 py-1 text-[11px] text-fg-muted transition-colors duration-150 hover:text-fg"
          aria-expanded={!collapsed}
          data-testid="chat-queue-toggle"
        >
          {collapsed ? `+${hidden} more queued` : "Collapse queue"}
          <ChevronUp
            className={`size-3 transition-transform duration-150 ${collapsed ? "" : "rotate-180"}`}
          />
        </button>
      )}
    </div>
  );
}

function QueuedBubble({
  queued,
  onUpdate,
  onRemove,
  onSendNow,
  onHold,
}: {
  queued: QueuedAgentMessage;
  onUpdate?: (id: string, content: string) => void;
  onRemove?: (id: string) => void;
  onSendNow?: (id: string) => void;
  onHold?: (id: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(queued.content);
  const [entered, setEntered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const editRef = useRef<HTMLTextAreaElement>(null);
  // Refs, not deps: the callbacks are re-created every host render, and an
  // effect keyed on them would run its cleanup constantly — releasing the
  // hold the moment it was taken.
  const onHoldRef = useRef(onHold);
  onHoldRef.current = onHold;
  const editingRef = useRef(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);
  // True unmount only: if this bubble disappears mid-edit, never leave the
  // queue paused — but don't touch holds owned by other bubbles.
  useEffect(
    () => () => {
      if (editingRef.current) onHoldRef.current?.(null);
    },
    [],
  );

  const beginEdit = () => {
    setDraft(queued.content);
    setEditing(true);
    editingRef.current = true;
    onHold?.(queued.id);
  };
  const commitEdit = () => {
    setEditing(false);
    editingRef.current = false;
    const content = draft.trim();
    if (content && content !== queued.content) {
      onUpdate?.(queued.id, content);
    }
    onHold?.(null);
  };
  const remove = () => {
    // Animate out, then actually delete.
    setLeaving(true);
    if (editingRef.current) {
      editingRef.current = false;
      onHold?.(null);
    }
    window.setTimeout(() => onRemove?.(queued.id), 160);
  };

  const shown = entered && !leaving;
  return (
    <div
      className={`group/queued relative max-w-[85%] motion-safe:transition-[opacity,translate,scale] motion-safe:duration-200 motion-safe:ease-[cubic-bezier(0.2,0,0,1)] ${shown ? "translate-y-0 scale-100 opacity-100" : "translate-y-1 scale-[0.98] opacity-0"}`}
      data-testid="chat-queued-message"
    >
      <div className="rounded-xl rounded-br-sm border border-dashed border-info/40 bg-info/5 px-3 py-2 text-sm text-fg-muted">
        {editing ? (
          <textarea
            ref={editRef}
            className="field-sizing-content w-full min-w-48 resize-none bg-transparent leading-6 text-fg outline-none"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commitEdit}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                commitEdit();
              }
              if (event.key === "Escape") {
                event.stopPropagation();
                setDraft(queued.content);
                setEditing(false);
                editingRef.current = false;
                onHold?.(null);
              }
            }}
            aria-label="Edit queued message"
            data-testid="chat-queued-edit"
          />
        ) : (
          <div className="whitespace-pre-wrap break-words leading-6">
            {queued.content}
          </div>
        )}
        {queued.attachments.length > 0 && (
          <div className="mt-1 text-[11px] text-fg-faint">
            {queued.attachments.length} attachment
            {queued.attachments.length > 1 ? "s" : ""}
          </div>
        )}
        <div className="mt-1 flex items-center justify-end gap-0.5 text-[10px] uppercase tracking-wider text-fg-faint">
          Queued
          <span className="ml-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/queued:opacity-100 group-focus-within/queued:opacity-100">
            {!editing && (
              <ShortcutHint label="Edit before it sends">
                <button
                  type="button"
                  onClick={beginEdit}
                  className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-fg"
                  aria-label="Edit queued message"
                >
                  <Pencil className="size-3" />
                </button>
              </ShortcutHint>
            )}
            <ShortcutHint label="Delete from queue">
              <button
                type="button"
                onClick={remove}
                className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-danger"
                aria-label="Delete queued message"
                data-testid="chat-queued-delete"
              >
                <Trash2 className="size-3" />
              </button>
            </ShortcutHint>
            <ShortcutHint label="Send now — interrupts the agent">
              <button
                type="button"
                onClick={() => onSendNow?.(queued.id)}
                className="grid size-5 cursor-pointer place-items-center rounded text-fg-faint hover:text-accent"
                aria-label="Send queued message now"
                data-testid="chat-queued-send-now"
              >
                <Zap className="size-3" />
              </button>
            </ShortcutHint>
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * Derive the visible timeline from raw agent-session messages: hides
 * in-progress assistant placeholders and surfaces them as an activity line.
 * When the latest assistant message is awaiting user input, its parsed
 * questions are exposed so hosts can render an answer UI.
 */
export function toTimeline(
  persisted: AgentMessage[],
  optimistic: ChatTimelineMessage[],
  isSending: boolean,
): {
  messages: ChatTimelineMessage[];
  activity: string | undefined;
  questions: AgentQuestion[] | undefined;
} {
  const messages = [...persisted, ...optimistic].filter(isConversationMessage);
  const pending = latestPendingAssistant(persisted);
  const activity =
    pending !== undefined
      ? (pending.content ?? "Thinking...")
      : isSending && optimistic.length > 0
        ? "Thinking..."
        : undefined;
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

function latestPendingAssistant(
  messages: AgentMessage[],
): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return asRecord(message.metadata)?.status === "in_progress"
        ? message
        : undefined;
    }
  }
  return undefined;
}

function isConversationMessage(message: ChatTimelineMessage): boolean {
  if (message.role === "system") {
    // Only marker rows render; other system rows are plumbing.
    return asRecord(asRecord(message.metadata)?.marker) !== undefined;
  }
  if (message.role !== "assistant") return true;
  if (asRecord(message.metadata)?.status === "in_progress") return false;
  // Question-only turns have no prose; the question panel is the content.
  return message.content.trim().length > 0;
}

function changedFiles(message: ChatTimelineMessage): string[] {
  const metadata = asRecord(message.metadata);
  const changes = metadata?.changedFiles;
  if (!Array.isArray(changes)) return [];
  return changes.flatMap((change) => {
    const entry = asRecord(change);
    return typeof entry?.path === "string" ? [entry.path] : [];
  });
}

function attachmentsFromMetadata(
  metadata: Record<string, unknown> | undefined,
): ChatAttachmentView[] {
  const raw = metadata?.attachments;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    const record = asRecord(entry);
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
