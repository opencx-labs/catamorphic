import {
  CatamorphicProvider,
  useAgentChat,
  useToolPermissions,
} from "@catamorphic/react";
import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, ListPlus, Square, X, Zap } from "lucide-react";
import { type FormEvent, useState } from "react";
import {
  AgentQuestionPanel,
  QUESTIONS_DISMISSED_MESSAGE,
} from "../components/agent-question-panel.js";
import {
  ChatTimeline,
  toTimeline,
} from "../components/catamorphic/chat-timeline.js";
import { ToolPermissionCard } from "../components/catamorphic/tool-permission-card.js";
import { ChatGlyph } from "../components/chat-glyph.js";
import { Screen } from "../components/screen.js";
import { clientFor, fetchMe } from "../lib/api.js";
import { navigate } from "../lib/nav.js";
import type { CompanionConnection } from "../lib/store.js";

export function ChatScreen({
  connection,
  projectId,
  sessionId,
  queryClient,
  animation,
}: {
  connection: CompanionConnection;
  projectId: string;
  sessionId: string | null;
  queryClient: QueryClient;
  animation?: string;
}) {
  return (
    <CatamorphicProvider
      apiClient={clientFor(connection)}
      queryClient={queryClient}
    >
      <Chat
        connection={connection}
        projectId={projectId}
        sessionId={sessionId}
        animation={animation}
      />
    </CatamorphicProvider>
  );
}

function Chat({
  connection,
  projectId,
  sessionId,
  animation,
}: {
  connection: CompanionConnection;
  projectId: string;
  sessionId: string | null;
  animation?: string;
}) {
  // A scoped member must address the project agent explicitly
  // (`project:<id>:<slug>`, ADR 0055) — a bare create is builder-only.
  // Root tokens (the desktop's embedded server) use the host default.
  const me = useQuery({
    queryKey: ["companion", "me", connection.id],
    queryFn: () => fetchMe(connection),
    staleTime: 60_000,
  });
  const scopedAgent = me.data?.identity.root
    ? undefined
    : me.data?.projects.find((p) => p.projectId === projectId)?.agents[0];
  const chat = useAgentChat(projectId, {
    sessionId: sessionId ?? undefined,
    ...(scopedAgent ? { agentId: `project:${projectId}:${scopedAgent}` } : {}),
    onSessionCreated: (created) =>
      // Adopt the lazily created session into the URL without growing the
      // back stack — Back should return to the sessions list, not to the
      // transient "new chat" entry.
      navigate(
        {
          kind: "chat",
          connectionId: connection.id,
          projectId,
          sessionId: created,
        },
        { replace: true },
      ),
  });
  const permissions = useToolPermissions(
    projectId,
    chat.sessionId ?? undefined,
    {
      enabled: chat.isWorking,
    },
  );
  const [draft, setDraft] = useState("");
  // Until /me answers we don't know whether a fresh chat must carry the
  // project agent id; hold the first send rather than 403 a scoped user.
  const sendReady = sessionId !== null || me.isFetched;
  const { messages, activity, questions } = toTimeline(
    chat.messages,
    chat.optimisticMessages,
    chat.isSending,
  );

  const lastFailed = failedTurn(chat.messages);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    void chat.send(message);
  };

  const submitNow = () => {
    const message = draft.trim();
    if (!message) return;
    setDraft("");
    void chat.sendNow(message);
  };

  return (
    <Screen
      title={
        <span className="flex items-center gap-2">
          <ChatGlyph icon={chat.session?.icon} className="size-4 shrink-0" />
          <span className="truncate">
            {chat.session?.title ?? (sessionId === null ? "New chat" : "Chat")}
          </span>
        </span>
      }
      back
      animation={animation}
      trailing={
        chat.isWorking ? (
          <button
            type="button"
            onClick={() => void chat.interrupt()}
            className="flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-border px-3 text-[13px] text-fg-muted active:bg-bg-overlay"
            data-testid="chat-interrupt"
          >
            <Square className="size-3 fill-current" />
            Stop
          </button>
        ) : undefined
      }
    >
      <div className="flex h-full min-h-0 flex-col">
        <ChatTimeline
          className="min-h-0 flex-1"
          messages={messages.filter(
            (message) => message.content !== QUESTIONS_DISMISSED_MESSAGE,
          )}
          activity={activity}
          queuedCount={chat.queuedMessageCount}
          error={null}
          emptyState="Ask the agent anything about this project."
        />

        <div className="shrink-0 border-t border-border bg-bg-raised/95 backdrop-blur-xl">
          <div className="flex flex-col gap-2 px-3 pt-2">
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
            {questions && !chat.isSending && (
              <AgentQuestionPanel
                questions={questions}
                onSubmit={(answer) => void chat.send(answer)}
                onDismiss={() => void chat.send(QUESTIONS_DISMISSED_MESSAGE)}
              />
            )}
            {lastFailed && !chat.isWorking && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-[13px]">
                <span className="min-w-0 truncate text-danger">
                  {lastFailed.interrupted
                    ? "The turn was interrupted."
                    : "The last turn failed."}
                </span>
                <button
                  type="button"
                  onClick={() => void chat.retry()}
                  className="shrink-0 cursor-pointer rounded-md border border-border-strong px-2.5 py-1 text-fg active:bg-bg-overlay"
                  data-testid="chat-retry"
                >
                  Retry
                </button>
              </div>
            )}
            {chat.error && (
              <p className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                {chat.error.message}
              </p>
            )}
            {chat.queue.length > 0 && (
              <ul className="flex flex-col gap-1">
                {chat.queue.map((queued) => (
                  <li
                    key={queued.id}
                    className="flex items-center gap-2 rounded-lg border border-border bg-bg-inset px-3 py-1.5 text-[13px] text-fg-muted"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {queued.content}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-fg-faint">
                      queued
                    </span>
                    <button
                      type="button"
                      onClick={() => chat.sendQueuedNow(queued.id)}
                      className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint active:text-fg"
                      aria-label="Send now"
                    >
                      <Zap className="size-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => chat.removeQueued(queued.id)}
                      className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint active:text-fg"
                      aria-label="Remove queued message"
                    >
                      <X className="size-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
          <form
            className="pb-safe flex items-end gap-2 p-3 pt-2"
            onSubmit={submit}
          >
            <div className="field flex min-w-0 flex-1 items-end">
              <textarea
                className="max-h-32 min-h-11 w-full resize-none bg-transparent px-3 py-2.5 leading-6 outline-none [field-sizing:content] placeholder:text-fg-faint"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={chat.isWorking ? "Message (queues)…" : "Message…"}
                rows={1}
                enterKeyHint="send"
                aria-label="Message the agent"
                data-testid="chat-input"
              />
            </div>
            {chat.isWorking && draft.trim() && (
              <button
                type="button"
                onClick={submitNow}
                className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl border border-border-strong bg-bg-overlay text-fg transition-transform duration-150 active:scale-95"
                aria-label="Interrupt and send now"
                data-testid="chat-send-now"
              >
                <Zap className="size-4.5" />
              </button>
            )}
            <button
              type="submit"
              className="grid size-11 shrink-0 cursor-pointer place-items-center rounded-xl bg-accent text-accent-fg transition-transform duration-150 active:scale-95 disabled:opacity-35"
              disabled={!draft.trim() || !sendReady}
              aria-label={chat.isWorking ? "Queue message" : "Send message"}
              data-testid="chat-send"
            >
              {chat.isWorking ? (
                <ListPlus className="size-4.5" />
              ) : (
                <ArrowUp className="size-4.5" />
              )}
            </button>
          </form>
        </div>
      </div>
    </Screen>
  );
}

function failedTurn(
  messages: ReturnType<typeof useAgentChat>["messages"],
): { interrupted: boolean } | null {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  const metadata = last.metadata as Record<string, unknown> | null;
  if (metadata?.status !== "failed") return null;
  // A scheduled auto-retry runs by itself; no manual affordance needed.
  const autoRetry = metadata.autoRetry as { nextAtMs?: number } | undefined;
  if (
    typeof autoRetry?.nextAtMs === "number" &&
    Date.now() < autoRetry.nextAtMs + 30_000
  ) {
    return null;
  }
  return { interrupted: metadata.interrupted === true };
}
