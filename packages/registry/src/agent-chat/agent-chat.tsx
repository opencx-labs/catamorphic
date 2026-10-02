"use client";

import {
  QUESTIONS_DISMISSED_MESSAGE,
  type RuntimeRequest,
  type RuntimeRequestResponse,
  useAgentChat,
} from "@catamorphic/react";
import { ArrowUp, Bot, Maximize2, Minimize2, Plus, Square } from "lucide-react";
import { type FormEvent, type KeyboardEvent, useState } from "react";
import { AgentQuestionPanel } from "../agent-question-panel/agent-question-panel.js";
import { ChatTimeline } from "../chat-timeline/chat-timeline.js";
import { TodoProgress } from "../todo-progress/todo-progress.js";
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
   * the parent and keeps the conversation always visible, for hosts where
   * chat is the primary surface.
   */
  variant?: "dock" | "full";
  /**
   * Fork the conversation through a message (the item id). Wire it to
   * `useForkAgentSession` with `{ sessionId, messageId: itemId }`; without
   * it the Fork action is hidden.
   */
  onFork?: (input: { sessionId: string; itemId: string }) => void;
  /** The viewer's external user id, so requests naming approvers wait honestly. */
  viewerId?: string;
  /** An agent's display name, for agent-change notices. */
  resolveAgentName?: (agentId: string) => string | undefined;
}

export function AgentChat({
  projectId,
  className = "",
  title = "AI assistant",
  placeholder = "Describe a change...",
  sessionId,
  onSessionCreated,
  variant = "dock",
  onFork,
  viewerId,
  resolveAgentName,
}: AgentChatProps) {
  const chat = useAgentChat(projectId, { sessionId, onSessionCreated });
  const isFull = variant === "full";
  const [dockExpanded, setDockExpanded] = useState(false);
  const expanded = isFull || dockExpanded;
  const setExpanded = (value: boolean | ((previous: boolean) => boolean)) => {
    if (!isFull) setDockExpanded(value);
  };
  const [draft, setDraft] = useState("");
  const [responding, setResponding] = useState<string | null>(null);

  // Questions answer in the panel or in the person's own words through the
  // composer (ADR 0195); approvals and elicitations answer on their cards.
  const questions = chat.requests.filter(
    (request) =>
      request.kind === "question" && request.answerable && request.questions,
  );
  const cards = chat.requests.filter((request) => !questions.includes(request));
  const respond = async (
    request: RuntimeRequest,
    response: RuntimeRequestResponse,
  ) => {
    setResponding(request.id);
    try {
      await chat.respond(request.id, response);
    } finally {
      setResponding(null);
    }
  };

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

  const lastReply = chat.timeline
    .at(-1)
    ?.entries.filter((entry) => entry.kind === "reply")
    .at(-1);

  return (
    <section
      className={`relative flex w-full flex-col text-fg ${
        isFull ? "h-full min-h-0" : "max-w-3xl drop-shadow-2xl"
      } ${className}`}
      aria-label={title}
    >
      <span className="sr-only" aria-live="polite">
        {chat.activity ??
          (lastReply?.kind === "reply" ? lastReply.item.text : undefined)}
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
            {chat.session?.title ?? title}
          </span>
          <span className="flex items-center gap-1">
            {chat.isWorking && (
              <button
                type="button"
                className="flex h-8 items-center gap-1.5 rounded-lg px-2 text-fg-muted hover:bg-bg-overlay hover:text-fg"
                onClick={() => void chat.interrupt()}
                aria-label="Stop the agent"
                title="Stop"
                data-testid="chat-interrupt"
              >
                <Square className="size-3 fill-current" />
                Stop
              </button>
            )}
            {chat.sessionId && (
              <button
                type="button"
                className="grid size-8 place-items-center rounded-lg text-fg-muted hover:bg-bg-overlay hover:text-fg disabled:opacity-40"
                onClick={chat.startNewSession}
                disabled={chat.isSending}
                data-disabled-reason="Wait for the message to send"
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
            cards.length > 0
              ? "h-[calc(100%-48px)] pb-2"
              : "h-[calc(100%-48px)]"
          }
          timeline={chat.timeline}
          pending={chat.pending}
          queue={chat.queue}
          activity={chat.activity}
          onEditQueued={chat.editQueued}
          onCancelQueued={chat.cancelQueued}
          onSendQueuedNow={chat.sendQueuedNow}
          onHoldQueued={chat.holdQueued}
          onRetry={(turnId) => void chat.retry(turnId)}
          onInterrupt={(turnId) => void chat.interrupt(turnId)}
          onRollback={chat.rollback}
          onFork={
            onFork && chat.sessionId
              ? (itemId) =>
                  chat.sessionId &&
                  onFork({ sessionId: chat.sessionId, itemId })
              : undefined
          }
          onResendFailed={(commandId) => void chat.resendFailed(commandId)}
          onDismissFailed={chat.dismissFailed}
          hasOlder={chat.hasOlder}
          isLoadingOlder={chat.isLoadingOlder}
          onLoadOlder={() => void chat.loadOlder()}
          resolveRequest={(requestId) => chat.state?.requests[requestId]}
          resolveAgentName={resolveAgentName}
          error={
            chat.connectionLost
              ? "Connection lost. Reconnecting; the agent may still be working."
              : (chat.error?.message ?? null)
          }
        />
        {cards.length > 0 && (
          <div className="absolute inset-x-3 bottom-3 flex flex-col gap-2">
            {cards.map((request) => (
              <ToolPermissionCard
                key={request.id}
                request={request}
                viewerId={viewerId}
                busy={responding === request.id}
                onRespond={(response) => void respond(request, response)}
              />
            ))}
          </div>
        )}
      </div>
      {expanded && questions.length > 0 && (
        <div className="max-h-[50vh] overflow-y-auto">
          {questions.map((request) => (
            <AgentQuestionPanel
              key={request.id}
              questions={request.questions ?? []}
              blocking={request.blocking}
              disabled={responding === request.id}
              onSubmit={(answers) =>
                void respond(request, { kind: "question", answers })
              }
              onDismiss={() =>
                void respond(request, {
                  kind: "question",
                  answers: [QUESTIONS_DISMISSED_MESSAGE],
                })
              }
            />
          ))}
        </div>
      )}
      <form
        className={`flex min-h-16 items-center gap-2 border border-border bg-bg-raised/95 p-2 backdrop-blur-xl ${expanded ? "rounded-b-2xl" : "rounded-2xl"}`}
        onSubmit={submit}
      >
        <TodoProgress todos={chat.session?.todos ?? []} />
        <textarea
          className="field-sizing-content max-h-24 min-h-10 min-w-0 flex-1 resize-none bg-transparent px-3 py-2 text-sm outline-none placeholder:text-fg-faint"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={
            questions.length > 0
              ? "Or reply in your own words..."
              : chat.isWorking
                ? "Message (queues until the agent is done)..."
                : placeholder
          }
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
          data-disabled-reason="Write a message first"
          aria-label="Send message"
        >
          <ArrowUp className="size-4" />
        </button>
      </form>
    </section>
  );
}
