import {
  CatamorphicProvider,
  useAcknowledgeAgentSessionAttention,
  useAgentSessions,
  useProject,
} from "@catamorphic/react";
import type { QueryClient } from "@tanstack/react-query";
import { CirclePause, MessageSquarePlus } from "lucide-react";
import { useState } from "react";
import { ChatGlyph } from "../components/chat-glyph.js";
import { ConnectionTrouble } from "../components/connection-trouble.js";
import { Screen } from "../components/screen.js";
import { authenticatedFetch, clientFor } from "../lib/api.js";
import { navigate } from "../lib/nav.js";
import type { PwaConnection } from "../lib/store.js";

export function SessionsScreen({
  connection,
  projectId,
  projectName,
  queryClient,
  animation,
}: {
  connection: PwaConnection;
  projectId: string;
  projectName: string;
  queryClient: QueryClient;
  animation?: string;
}) {
  return (
    <CatamorphicProvider
      apiClient={clientFor(connection)}
      queryClient={queryClient}
    >
      <SessionsList
        connection={connection}
        projectId={projectId}
        projectName={projectName}
        animation={animation}
      />
    </CatamorphicProvider>
  );
}

function SessionsList({
  connection,
  projectId,
  projectName,
  animation,
}: {
  connection: PwaConnection;
  projectId: string;
  projectName: string;
  animation?: string;
}) {
  const sessions = useAgentSessions(projectId, { limit: 100 });
  const acknowledgeAttention = useAcknowledgeAgentSessionAttention(projectId);
  const project = useProject(projectId);
  const [resumingId, setResumingId] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<{
    sessionId: string;
    message: string;
  } | null>(null);
  const title = project.data?.name ?? projectName;
  const items = [...(sessions.data?.items ?? [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );

  const openChat = (sessionId: string | null) =>
    navigate({
      kind: "chat",
      connectionId: connection.id,
      projectId,
      sessionId,
    });

  const openOrResume = async (session: (typeof items)[number]) => {
    if (!session.resumable) {
      if (session.attentionRequired) {
        void acknowledgeAttention.mutateAsync(session.id).catch(() => {});
      }
      openChat(session.id);
      return;
    }
    if (resumingId) return;
    setResumeError(null);
    setResumingId(session.id);
    try {
      const base = connection.serverUrl.replace(/\/+$/, "");
      const response = await authenticatedFetch({
        connectionId: connection.id,
      })(`${base}/projects/${projectId}/agent/sessions/${session.id}/resume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          expectedAuthorityRevision: session.authorityRevision,
        }),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 409
            ? "This session changed on another machine. Refresh and try again."
            : `The server said ${response.status}.`,
        );
      }
      await sessions.refetch();
      if (session.attentionRequired) {
        await acknowledgeAttention.mutateAsync(session.id).catch(() => {});
      }
      openChat(session.id);
    } catch (error) {
      setResumeError({
        sessionId: session.id,
        message:
          error instanceof Error
            ? error.message
            : "This session could not be resumed.",
      });
    } finally {
      setResumingId(null);
    }
  };

  return (
    <Screen
      title={title}
      subtitle={new URL(connection.serverUrl).host}
      back
      animation={animation}
    >
      <div className="relative h-full">
        <div className="h-full overflow-y-auto overscroll-contain">
          {sessions.isLoading && (
            <p className="p-4 text-sm text-fg-faint">Loading sessions…</p>
          )}
          {sessions.isError && (
            <div className="p-4">
              <ConnectionTrouble
                connection={connection}
                projectId={projectId}
                message={sessions.error.message}
              />
            </div>
          )}
          {items.length === 0 && sessions.isSuccess && (
            <div className="flex h-full flex-col items-center justify-center gap-2 p-8 text-center">
              <p className="text-sm leading-6 text-fg-muted">
                No conversations yet. Start one below.
              </p>
            </div>
          )}
          <ul className="flex flex-col py-1 pb-24">
            {items.map((session) => (
              <li key={session.id}>
                <button
                  type="button"
                  onClick={() => void openOrResume(session)}
                  aria-busy={resumingId === session.id}
                  className="row-press flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
                  data-testid="session-row"
                >
                  <span className="relative grid size-10 shrink-0 place-items-center rounded-full border border-border bg-bg-raised">
                    <ChatGlyph
                      icon={session.icon}
                      fork={session.parentSessionId !== null}
                      className="size-4.5"
                    />
                    {session.attentionRequired && (
                      <span
                        className="absolute right-0 top-0 size-2 animate-pulse rounded-full bg-accent"
                        aria-hidden="true"
                        data-testid="session-attention"
                      />
                    )}
                  </span>
                  {session.attentionRequired && (
                    <span className="sr-only">Ready for you</span>
                  )}
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate text-[15px] leading-6 ${session.status === "closed" ? "text-fg-muted" : "font-medium"}`}
                    >
                      {session.title ?? fallbackTitle(session.createdAt)}
                    </span>
                    <span className="flex items-center gap-1 truncate text-xs leading-4 text-fg-faint">
                      {session.resumable ? (
                        <span className="inline-flex items-center gap-1 font-medium text-accent">
                          <CirclePause className="size-3" aria-hidden="true" />
                          {resumingId === session.id
                            ? "Resuming…"
                            : "Paused · Tap to resume"}
                        </span>
                      ) : (
                        <>
                          {relativeTime(session.updatedAt)}
                          {session.status === "closed" ? " · closed" : ""}
                        </>
                      )}
                    </span>
                    {resumeError?.sessionId === session.id && (
                      <span
                        className="mt-1 block text-xs leading-4 text-danger"
                        role="alert"
                      >
                        {resumeError.message}
                      </span>
                    )}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        <button
          type="button"
          onClick={() => openChat(null)}
          className="pb-safe absolute bottom-4 right-4 box-content grid size-14 cursor-pointer place-items-center rounded-full bg-accent text-accent-fg shadow-xl transition-transform duration-150 active:scale-95"
          aria-label="New chat"
          data-testid="new-chat"
        >
          <MessageSquarePlus className="size-6" />
        </button>
      </div>
    </Screen>
  );
}

function fallbackTitle(createdAt: string): string {
  const date = new Date(createdAt);
  return `Chat ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

function relativeTime(iso: string): string {
  const delta = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}
