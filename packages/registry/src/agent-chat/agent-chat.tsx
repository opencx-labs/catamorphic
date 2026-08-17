"use client";

import { useAgentChat, useToolPermissions } from "@catamorphic/react";
import { ArrowUp, Bot, Maximize2, Minimize2, Plus } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { ChatTimeline, toTimeline } from "../chat-timeline/chat-timeline.js";
import { ToolPermissionCard } from "../tool-permission-card/tool-permission-card.js";

export interface AgentChatProps {
  projectId: string;
  className?: string;
  title?: string;
  placeholder?: string;
  /**
   * Open a specific session instead of lazily creating one on first send.
   * Pair with `onSessionCreated` to track lazily created sessions.
   */
  sessionId?: string;
  onSessionCreated?: (sessionId: string) => void;
  /**
   * `dock` (default) renders the collapsible bottom-docked bar. `full` fills
   * the parent and keeps the conversation always visible — for hosts where
   * chat is the primary surface.
   */
  variant?: "dock" | "full";
}

export function AgentChat({
  projectId,
  className = "",
  title = "AI assistant",
  placeholder = "Describe a change...",
  sessionId,
  onSessionCreated,
  variant = "dock",
}: AgentChatProps) {
  const chat = useAgentChat(projectId, { sessionId, onSessionCreated });
  // Tool-permission asks (ADR 0054) park on the host and surface here as
  // consent cards while a turn runs; the tool call resumes on the answer.
  const permissions = useToolPermissions(
    projectId,
    chat.sessionId ?? undefined,
    {
      enabled: chat.isWorking,
    },
  );
  const isFull = variant === "full";
  const [dockExpanded, setDockExpanded] = useState(false);
  const expanded = isFull || dockExpanded;
  const setExpanded = (value: boolean | ((previous: boolean) => boolean)) => {
    if (!isFull) setDockExpanded(value);
  };
  const [draft, setDraft] = useState("");
  const { messages, activity } = toTimeline(
    chat.messages,
    chat.optimisticMessages,
    chat.isSending,
  );

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
      className={`relative flex w-full flex-col text-fg ${
        isFull ? "h-full min-h-0" : "max-w-3xl drop-shadow-2xl"
      } ${className}`}
      aria-label={title}
    >
      <span className="sr-only" aria-live="polite">
        {activity ?? messages.at(-1)?.content}
      </span>
      <div
        className={`relative origin-bottom overflow-hidden rounded-t-2xl border-border bg-bg-raised/95 backdrop-blur-xl transition-[height,opacity,transform,margin,border-width] duration-200 ease-out ${
          isFull
            ? "mb-[-1px] min-h-0 flex-1 border"
            : expanded
              ? "mb-[-1px] h-[min(520px,calc(100vh-190px))] min-h-72 translate-y-0 scale-100 border opacity-100"
              : "pointer-events-none invisible h-0 min-h-0 translate-y-2 scale-[0.985] border-0 opacity-0"
        }`}
        aria-hidden={!expanded}
        inert={!expanded ? true : undefined}
      >
        <header className="flex h-12 items-center justify-between border-b border-border px-4 text-xs font-semibold">
          <span className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-full border border-border-strong bg-bg-overlay">
              <Bot className="size-4" />
            </span>
            {title}
          </span>
          <span className="flex items-center gap-1">
            {chat.sessionId && (
              <button
                type="button"
                className="grid size-8 place-items-center rounded-lg text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:opacity-40"
                onClick={chat.startNewSession}
                disabled={chat.isSending}
                aria-label="Start new agent session"
                title="New session"
              >
                <Plus className="size-4" />
              </button>
            )}
            {!isFull && (
              <button
                type="button"
                className="grid size-8 place-items-center rounded-lg text-fg-muted hover:bg-bg-overlay hover:text-fg"
                onClick={() => setExpanded(false)}
                aria-label="Collapse conversation"
              >
                <Minimize2 className="size-4" />
              </button>
            )}
          </span>
        </header>
        <ChatTimeline
          className={
            permissions.permissions.length > 0
              ? "h-[calc(100%-48px)] pb-2"
              : "h-[calc(100%-48px)]"
          }
          messages={messages}
          activity={activity}
          queuedCount={Math.max(0, chat.queuedMessageCount - 1)}
          error={chat.error?.message ?? null}
        />
        {permissions.permissions.length > 0 && (
          <div className="absolute inset-x-3 bottom-3 flex flex-col gap-2">
            {permissions.permissions.map((permission) => (
              <ToolPermissionCard
                key={permission.id}
                permission={permission}
                busy={permissions.isAnswering}
                onAnswer={(answer) =>
                  void permissions.answer(permission.id, answer)
                }
              />
            ))}
          </div>
        )}
      </div>
      <form
        className={`flex min-h-16 items-center gap-2 border border-border bg-bg-raised/95 p-2 backdrop-blur-xl ${expanded ? "rounded-b-2xl" : "rounded-2xl"}`}
        onSubmit={submit}
      >
        <textarea
          className="field-sizing-content max-h-24 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-fg-faint"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          rows={1}
          aria-label="Message the coding agent"
        />
        {!isFull && (
          <button
            type="button"
            className="grid size-8 place-items-center rounded-lg text-fg-muted hover:bg-bg-overlay hover:text-fg"
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
        )}
        <button
          type="submit"
          className="grid size-8 place-items-center rounded-lg bg-accent text-accent-fg disabled:opacity-35"
          disabled={!draft.trim()}
          aria-label="Send message"
        >
          <ArrowUp className="size-4" />
        </button>
      </form>
    </section>
  );
}
