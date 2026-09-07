import {
  CatamorphicProvider,
  useAcknowledgeAgentSessionAttention,
  useAgentCatalog,
  useAgentChat,
  useToolPermissions,
} from "@catamorphic/react";
import {
  AgentEnvironmentControl,
  AuthenticationRequiredCard,
} from "@catamorphic/ui";
import type { QueryClient } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Bot, GitFork, ListPlus, Square, X, Zap } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
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
import { ConnectionTrouble } from "../components/connection-trouble.js";
import { Screen } from "../components/screen.js";
import { clientFor } from "../lib/api.js";
import { mirrorForkNotice } from "../lib/fork.js";
import { navigate } from "../lib/nav.js";
import { findConnection, getState, type PwaConnection } from "../lib/store.js";

export function ChatScreen({
  connection,
  projectId,
  sessionId,
  queryClient,
  animation,
}: {
  connection: PwaConnection;
  projectId: string;
  sessionId: string | null;
  queryClient: QueryClient;
  animation?: string;
}) {
  return (
    <CatamorphicProvider
      apiClient={clientFor(connection)}
      baseUrl={new URL(connection.serverUrl).origin}
      authorizationRedirectUri={`${connection.serverUrl.replace(/\/+$/, "")}/connection-authorizations/callback`}
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
  connection: PwaConnection;
  projectId: string;
  sessionId: string | null;
  animation?: string;
}) {
  const catalog = useAgentCatalog(projectId);
  const [chosenAgent, setChosenAgent] = useState<string>();
  const [chosenEnvironment, setChosenEnvironment] = useState<string>();
  const agentId = chosenAgent ?? catalog.data?.defaultAgentId;
  const agent = catalog.data?.items.find((item) => item.id === agentId);
  const environment =
    chosenEnvironment ?? agent?.environments.defaultEnvironment;
  const chat = useAgentChat(projectId, {
    source: "mobile",
    sessionId: sessionId ?? undefined,
    idleRefetchIntervalMs: 3_000,
    agentId,
    environment,
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
  const acknowledgeAttention = useAcknowledgeAgentSessionAttention(projectId);
  const relatedSessions = useQuery({
    queryKey: ["pwa", "subsessions", connection.id, projectId, chat.sessionId],
    enabled: Boolean(chat.sessionId),
    queryFn: async ({ signal }) => {
      const { data, error } = await clientFor(connection).GET(
        "/api/projects/{projectId}/agent/sessions/{sessionId}/subsessions",
        {
          signal,
          params: { path: { projectId, sessionId: chat.sessionId ?? "" } },
        },
      );
      if (error) throw new Error(error.error);
      return data ?? [];
    },
    refetchInterval: 3_000,
  });
  const children =
    relatedSessions.data
      ?.map((child) => child.session)
      .filter(
        (session) =>
          session.parentSessionId === chat.sessionId &&
          session.visibility !== "archived",
      ) ?? [];
  const openRelated = (id: string) =>
    navigate({
      kind: "chat",
      connectionId: connection.id,
      projectId,
      sessionId: id,
    });
  const acknowledgedRevisionRef = useRef(0);
  useEffect(() => {
    const session = chat.session;
    if (
      !session?.attentionRequired ||
      session.attentionRevision <= acknowledgedRevisionRef.current
    ) {
      return;
    }
    acknowledgedRevisionRef.current = session.attentionRevision;
    void acknowledgeAttention.mutateAsync(session.id).catch(() => {
      acknowledgedRevisionRef.current = session.attentionSeenRevision;
    });
  }, [chat.session, acknowledgeAttention]);
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
  const sendReady = Boolean(
    chat.sessionId || (agent?.available && environment),
  );
  const { messages, activity, questions } = toTimeline(
    chat.messages,
    chat.optimisticMessages,
    chat.activity,
  );

  const lastFailed = failedTurn(chat.messages);
  // Continued on the linked server (ADR 0062): this copy is history —
  // lock the composer and point at the live fork.
  const fork = mirrorForkNotice(chat.messages);
  const forkConnection = fork
    ? findConnection(getState(), fork.serverUrl, fork.remoteProjectId)
    : undefined;

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const message = draft.trim();
    if (!message || !sendReady) return;
    setDraft("");
    void chat.send(message);
  };

  const submitNow = () => {
    const message = draft.trim();
    if (!message || !sendReady) return;
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
        {chat.session?.parentSessionId ? (
          <button
            type="button"
            onClick={() =>
              chat.session?.parentSessionId &&
              openRelated(chat.session.parentSessionId)
            }
            className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2 text-xs text-fg-muted active:bg-bg-overlay"
            data-testid="parent-chat"
          >
            <GitFork className="size-3.5" aria-hidden="true" />
            Back to parent chat
          </button>
        ) : null}
        {children.length > 0 ? (
          <nav
            aria-label="Subsessions"
            className="flex shrink-0 gap-2 overflow-x-auto border-b border-border px-3 py-2"
          >
            {children.map((child) => (
              <button
                key={child.id}
                type="button"
                onClick={() => openRelated(child.id)}
                className="flex h-9 max-w-56 shrink-0 items-center gap-2 rounded-md border border-border bg-bg-raised px-3 text-xs text-fg-muted active:bg-bg-overlay"
              >
                <Bot className="size-3.5 shrink-0" aria-hidden="true" />
                <span className="truncate">{child.title ?? "Subsession"}</span>
                <span
                  className={
                    child.attentionRequired
                      ? "shrink-0 text-accent"
                      : "shrink-0 text-fg-faint"
                  }
                >
                  {child.attentionRequired
                    ? "Needs attention"
                    : child.running
                      ? "Working"
                      : "Idle"}
                </span>
              </button>
            ))}
          </nav>
        ) : null}
        <ChatTimeline
          className="min-h-0 flex-1"
          messages={messages.filter(
            (message) => message.content !== QUESTIONS_DISMISSED_MESSAGE,
          )}
          activity={chat.connectionLost ? undefined : activity}
          queuedCount={chat.queuedMessageCount}
          error={null}
          emptyState="Ask the agent anything about this project."
        />

        {fork ? (
          <div className="pb-safe shrink-0 border-t border-border bg-bg-raised/95 p-3 backdrop-blur-xl">
            <div
              className="flex flex-col gap-2 rounded-xl border border-border bg-bg-inset p-3"
              data-testid="fork-lock"
            >
              <p className="flex items-start gap-2 text-[13px] leading-5 text-fg-muted">
                <GitFork className="mt-0.5 size-4 shrink-0 text-fg-faint" />
                This conversation continued on {hostOf(fork.serverUrl)}. This
                copy is history.
              </p>
              {forkConnection ? (
                <button
                  type="button"
                  onClick={() =>
                    navigate({
                      kind: "chat",
                      connectionId: forkConnection.id,
                      projectId: fork.remoteProjectId,
                      sessionId: fork.sessionId,
                    })
                  }
                  className="flex h-10 cursor-pointer items-center justify-center rounded-lg bg-accent text-[14px] font-semibold text-accent-fg active:scale-[0.99]"
                  data-testid="open-fork"
                >
                  Open the live conversation
                </button>
              ) : (
                <p className="text-xs text-fg-faint">
                  Connect to {hostOf(fork.serverUrl)} to keep talking.
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="shrink-0 border-t border-border bg-bg-raised/95 backdrop-blur-xl">
            <div className="flex flex-col gap-2 px-3 pt-2">
              {!chat.sessionId && (
                <div className="flex flex-col gap-2">
                  <label className="text-sm text-fg-muted">
                    Agent
                    <select
                      aria-label="Agent"
                      value={agentId ?? ""}
                      onChange={(event) => {
                        setChosenAgent(event.target.value);
                        setChosenEnvironment(undefined);
                      }}
                      className="mt-1 h-11 w-full rounded border border-border bg-bg px-2 text-base text-fg"
                    >
                      <option value="" disabled>
                        Choose an agent
                      </option>
                      {catalog.data?.items.map((item) => (
                        <option
                          key={item.id}
                          value={item.id}
                          disabled={!item.available}
                        >
                          {item.name}
                          {item.available ? "" : " (unavailable)"}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="text-sm text-fg-muted">
                    Run in
                    <select
                      aria-label="Environment"
                      value={environment ?? ""}
                      onChange={(event) =>
                        setChosenEnvironment(event.target.value)
                      }
                      className="mt-1 h-11 w-full rounded border border-border bg-bg px-2 text-base text-fg"
                    >
                      <option value="" disabled>
                        Choose an environment
                      </option>
                      {agent?.environments.items
                        .filter((item) => item.allowed)
                        .map((item) => (
                          <option
                            key={item.name}
                            value={item.name}
                            disabled={!item.compatible || !item.available}
                          >
                            {item.label}
                            {item.reasons.length
                              ? ` (${item.reasons.join("; ")})`
                              : ""}
                          </option>
                        ))}
                    </select>
                  </label>
                  {catalog.data?.startingActions.map((action) => (
                    <button
                      key={`${action.label}:${action.prompt}`}
                      type="button"
                      className="rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-bg-overlay"
                      onClick={() => {
                        setChosenAgent(action.agentId);
                        setDraft(action.prompt);
                      }}
                    >
                      {action.label}
                    </button>
                  ))}
                  {catalog.error && (
                    <p role="alert" className="text-sm text-danger">
                      {catalog.error.message}
                    </p>
                  )}
                  {catalog.isSuccess &&
                    !catalog.data.items.some((item) => item.available) && (
                      <p className="text-sm text-fg-muted">
                        No permitted agent is ready. Ask a project manager to
                        configure an agent and environment.
                      </p>
                    )}
                </div>
              )}
              {chat.sessionId && (
                <AgentEnvironmentControl
                  projectId={projectId}
                  sessionId={chat.sessionId}
                  agentId={chat.session?.agentId ?? undefined}
                  currentEnvironment={chat.session?.environment ?? undefined}
                  busy={chat.isWorking}
                />
              )}
              {chat.authenticationRequired?.requirements.map((requirement) => (
                <AuthenticationRequiredCard
                  key={requirement.alias}
                  projectId={projectId}
                  environment={chat.authenticationRequired?.environment ?? ""}
                  requirement={requirement}
                  onAuthorized={chat.resumeAfterAuthentication}
                />
              ))}
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
                    {lastFailed.retrying
                      ? "Connection interrupted. Retrying automatically."
                      : lastFailed.interrupted
                        ? "The turn was interrupted."
                        : "The last turn failed."}
                  </span>
                  {lastFailed.retrying ? (
                    <button
                      type="button"
                      onClick={() => void chat.interrupt()}
                      className="shrink-0 rounded-md border border-border-strong px-2.5 py-1 text-fg"
                      data-testid="stop-retrying"
                    >
                      Stop
                    </button>
                  ) : null}
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
              {chat.error && !chat.authenticationRequired && (
                <ConnectionTrouble
                  connection={connection}
                  projectId={projectId}
                  message={
                    chat.connectionLost
                      ? "Connection lost. Reconnecting to check your agent's progress. It may still be running."
                      : chat.error.message
                  }
                />
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
                  placeholder={
                    chat.isWorking ? "Message (queues)…" : "Message…"
                  }
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
        )}
      </div>
    </Screen>
  );
}

function hostOf(serverUrl: string): string {
  try {
    return new URL(serverUrl).host;
  } catch {
    return serverUrl;
  }
}

function failedTurn(
  messages: ReturnType<typeof useAgentChat>["messages"],
): { interrupted: boolean; retrying: boolean } | null {
  const last = messages.at(-1);
  if (last?.role !== "assistant") return null;
  const metadata = last.metadata as Record<string, unknown> | null;
  if (metadata?.status !== "failed") return null;
  const autoRetry = metadata.autoRetry as { nextAtMs?: number } | undefined;
  return {
    interrupted: metadata.interrupted === true,
    retrying: typeof autoRetry?.nextAtMs === "number",
  };
}
