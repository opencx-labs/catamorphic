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
}: ChatTimelineProps) {
  return (
    <StickToBottom
      className={`relative overflow-hidden ${className}`}
      initial="smooth"
      resize="smooth"
      role="log"
    >
      <StickToBottom.Content className="flex min-h-full flex-col gap-3 p-5">
        {messages.length === 0 && !activity && (
          <div className="m-auto max-w-sm text-center text-sm leading-6 text-fg-muted">
            {emptyState}
          </div>
        )}
        {messages.map((message) => (
          <Message key={message.id} message={message} />
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

function Message({ message }: { message: ChatTimelineMessage }) {
  const files = changedFiles(message);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <article
      className={`max-w-[85%] text-sm motion-safe:transition-[opacity,transform] motion-safe:duration-200 motion-safe:ease-out ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"} ${message.role === "user" ? "ml-auto rounded-xl rounded-br-sm border border-info/30 bg-info/10 px-3 py-2" : "mr-auto"}`}
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
          <Markdown remarkPlugins={REMARK_PLUGINS}>{message.content}</Markdown>
        </div>
      )}
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {files.map((file) => (
            <code
              key={file}
              className="rounded border border-success/50 bg-success/10 px-1.5 py-0.5 text-[11px] text-success"
            >
              {file}
            </code>
          ))}
        </div>
      )}
    </article>
  );
}

/**
 * Derive the visible timeline from raw agent-session messages: hides
 * in-progress assistant placeholders and surfaces them as an activity line.
 */
export function toTimeline(
  persisted: AgentMessage[],
  optimistic: ChatTimelineMessage[],
  isSending: boolean,
): { messages: ChatTimelineMessage[]; activity: string | undefined } {
  const messages = [...persisted, ...optimistic].filter(isConversationMessage);
  const pending = latestPendingAssistant(persisted);
  const activity =
    pending !== undefined
      ? (pending.content ?? "Thinking...")
      : isSending && optimistic.length > 0
        ? "Thinking..."
        : undefined;
  return { messages, activity };
}

function latestPendingAssistant(
  messages: AgentMessage[],
): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant") {
      return isConversationMessage(message) ? undefined : message;
    }
  }
  return undefined;
}

function isConversationMessage(message: ChatTimelineMessage): boolean {
  return !(
    message.role === "assistant" &&
    asRecord(message.metadata)?.status === "in_progress"
  );
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
