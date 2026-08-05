"use client";

import type { AgentMessage } from "@catamorphic/react";
import { ArrowDown, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

const REMARK_PLUGINS = [remarkGfm];

export interface ChatTimelineMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: unknown;
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
  /** Number of queued messages beyond the in-flight one. */
  queuedCount?: number;
  error?: string | null;
  emptyState?: string;
  className?: string;
  /**
   * Extra classes for the scrolled content column. Lets hosts center a
   * max-width column while the scrollbar hugs the container edge.
   */
  contentClassName?: string;
  /**
   * A link in an agent message was clicked. Hosts route it to their own
   * surface (e.g. an attached browser tab) instead of the anchor default.
   */
  onLinkClick?: (url: string) => void;
  /**
   * A changed-file chip was clicked. Hosts open the file (e.g. in an
   * editor surface). Without it the chips stay inert.
   */
  onFileClick?: (path: string) => void;
}

/**
 * Presentational conversation log: message bubbles, changed-file chips, live
 * activity, error banner, stick-to-bottom scrolling. Owns no chat state —
 * feed it from `useAgentChat` (see `AgentChat`) or any other source. Reused
 * by both the docked chat and full-surface chat hosts.
 */
export function ChatTimeline({
  messages,
  activity,
  queuedCount = 0,
  error,
  emptyState = "Ask the agent to build or change your project.",
  className = "",
  contentClassName = "",
  onLinkClick,
  onFileClick,
}: ChatTimelineProps) {
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
            onLinkClick={onLinkClick}
            onFileClick={onFileClick}
          />
        ))}
        {activity && (
          <div className="flex items-center gap-2 text-xs text-fg-muted">
            <LoaderCircle className="size-4 animate-spin" />
            <span className="animate-pulse">{activity}</span>
            {queuedCount > 0 && (
              <span className="ml-auto text-fg-faint">
                {queuedCount} queued
              </span>
            )}
          </div>
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
  onLinkClick,
  onFileClick,
}: {
  message: ChatTimelineMessage;
  onLinkClick?: (url: string) => void;
  onFileClick?: (path: string) => void;
}) {
  const files = changedFiles(message);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

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

  return (
    <article
      className={`max-w-[85%] text-sm motion-safe:transition-[opacity,translate] motion-safe:duration-200 motion-safe:ease-out ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"} ${message.role === "user" ? "ml-auto rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2" : "mr-auto"}`}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-fg-faint">
        {message.role === "user" ? "You" : "Agent"}
      </div>
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
                          if (href) onLinkClick(href);
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
