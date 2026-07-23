"use client";

import { type AgentMessage, useAgentChat } from "@catamorphic/react";
import {
  ArrowDown,
  ArrowUp,
  Bot,
  LoaderCircle,
  Maximize2,
  Minimize2,
  Plus,
} from "lucide-react";
import { type FormEvent, type KeyboardEvent, useEffect, useState } from "react";
import { StickToBottom, useStickToBottomContext } from "use-stick-to-bottom";

export interface AgentChatProps {
  projectId: string;
  className?: string;
  title?: string;
  placeholder?: string;
}

export function AgentChat({
  projectId,
  className = "",
  title = "AI assistant",
  placeholder = "Describe a change...",
}: AgentChatProps) {
  const chat = useAgentChat(projectId);
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState("");
  const messages = [...chat.messages, ...chat.optimisticMessages].filter(
    isConversationMessage,
  );
  const pendingAssistant = latestPendingAssistant(chat.messages);
  const activity = pendingAssistant?.content ?? "Thinking...";
  const showActivity =
    pendingAssistant !== undefined ||
    (chat.isSending && chat.optimisticMessages.length > 0);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setExpanded(true);
    setDraft("");
    void chat.send(message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.nativeEvent.isComposing
    ) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <section
      className={`relative flex w-full max-w-3xl flex-col text-neutral-100 drop-shadow-2xl ${className}`}
      aria-label={title}
    >
      <span className="sr-only" aria-live="polite">
        {showActivity
          ? activity
          : latestConversationAssistant(chat.messages)?.content}
      </span>
      <div
        className={`origin-bottom overflow-hidden rounded-t-2xl border-neutral-700/80 bg-neutral-950/95 backdrop-blur-xl transition-[height,opacity,transform,margin,border-width] duration-200 ease-out ${
          expanded
            ? "mb-[-1px] h-[min(520px,calc(100vh-190px))] min-h-72 translate-y-0 scale-100 border-[1px] border-neutral-700/80 opacity-100"
            : "pointer-events-none invisible h-0 min-h-0 translate-y-2 scale-[0.985] border-0 opacity-0"
        }`}
        aria-hidden={!expanded}
        inert={!expanded ? true : undefined}
      >
        <header className="flex h-12 items-center justify-between border-b border-neutral-800 px-4 text-xs font-semibold">
          <span className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-full border-[1px] border-neutral-700 bg-neutral-800">
              <Bot className="size-4" />
            </span>
            {title}
          </span>
          <span className="flex items-center gap-1">
            {chat.sessionId && (
              <button
                type="button"
                className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-white disabled:opacity-40"
                onClick={chat.startNewSession}
                disabled={chat.isSending}
                aria-label="Start new agent session"
                title="New session"
              >
                <Plus className="size-4" />
              </button>
            )}
            <button
              type="button"
              className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-white"
              onClick={() => setExpanded(false)}
              aria-label="Collapse conversation"
            >
              <Minimize2 className="size-4" />
            </button>
          </span>
        </header>
        <StickToBottom
          className="relative h-[calc(100%-48px)] overflow-hidden"
          initial="smooth"
          resize="smooth"
          role="log"
        >
          <StickToBottom.Content className="flex min-h-full flex-col gap-3 p-5">
            {messages.length === 0 && !showActivity && (
              <div className="m-auto max-w-sm text-center text-sm leading-6 text-neutral-500">
                Ask the agent to build or change your project.
              </div>
            )}
            {messages.map((message) => (
              <Message key={message.id} message={message} />
            ))}
            {showActivity && (
              <div className="flex items-center gap-2 text-xs text-neutral-400">
                <LoaderCircle className="size-4 animate-spin" />
                <span className="animate-pulse">{activity}</span>
                {chat.queuedMessageCount > 1 && (
                  <span className="ml-auto text-neutral-600">
                    {chat.queuedMessageCount - 1} queued
                  </span>
                )}
              </div>
            )}
            {chat.error && (
              <div className="rounded-lg border-[1px] border-red-900 bg-red-950/40 px-3 py-2 text-xs text-red-300">
                {chat.error.message}
              </div>
            )}
          </StickToBottom.Content>
          <ScrollToLatest />
        </StickToBottom>
      </div>
      <form
        className={`flex min-h-16 items-center gap-2 border border-neutral-700/80 bg-neutral-950/95 p-2 backdrop-blur-xl ${expanded ? "rounded-b-2xl" : "rounded-2xl"}`}
        onSubmit={submit}
      >
        <textarea
          className="field-sizing-content max-h-24 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-600"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          aria-label="Message the coding agent"
        />
        <button
          type="button"
          className="grid size-8 place-items-center rounded-lg text-neutral-400 hover:bg-neutral-800 hover:text-white"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={
            expanded ? "Collapse conversation" : "Expand conversation"
          }
          title={expanded ? "Collapse conversation" : "Expand conversation"}
        >
          {expanded ? (
            <Minimize2 className="size-4" />
          ) : (
            <Maximize2 className="size-4" />
          )}
        </button>
        <button
          type="submit"
          className="grid size-8 place-items-center rounded-lg bg-neutral-100 text-neutral-950 disabled:opacity-35"
          disabled={!draft.trim()}
          aria-label="Send message"
        >
          <ArrowUp className="size-4" />
        </button>
      </form>
    </section>
  );
}

function Message({ message }: { message: ChatMessage }) {
  const files = changedFiles(message);
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <article
      className={`max-w-[85%] text-sm motion-safe:transition-[opacity,transform] motion-safe:duration-200 motion-safe:ease-out ${entered ? "motion-safe:translate-y-0 motion-safe:opacity-100" : "motion-safe:translate-y-1 motion-safe:opacity-0"} ${message.role === "user" ? "ml-auto rounded-xl rounded-br-sm border-[1px] border-blue-900 bg-blue-950/50 px-3 py-2" : "mr-auto"}`}
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-600">
        {message.role === "user" ? "You" : "Agent"}
      </div>
      <div className="whitespace-pre-wrap break-words leading-6">
        {message.content}
      </div>
      {files.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {files.map((file) => (
            <code
              key={file}
              className="rounded border-[1px] border-emerald-900 bg-emerald-950/40 px-1.5 py-0.5 text-[11px] text-emerald-300"
            >
              {file}
            </code>
          ))}
        </div>
      )}
    </article>
  );
}

type ChatMessage = {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  metadata?: unknown;
};

function latestConversationAssistant(
  messages: AgentMessage[],
): AgentMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "assistant" && isConversationMessage(message)) {
      return message;
    }
  }
  return undefined;
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

function isConversationMessage(message: ChatMessage): boolean {
  return !(
    message.role === "assistant" &&
    asRecord(message.metadata)?.status === "in_progress"
  );
}

function changedFiles(message: ChatMessage): string[] {
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
      className="absolute bottom-4 right-4 grid size-8 place-items-center rounded-full border-[1px] border-neutral-700 bg-neutral-900 text-neutral-300 shadow-xl"
      onClick={() => scrollToBottom()}
      aria-label="Scroll to latest message"
    >
      <ArrowDown className="size-4" />
    </button>
  );
}
