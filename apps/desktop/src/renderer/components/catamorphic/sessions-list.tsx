"use client";

import { useAgentSessions } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { GitBranch, MessageSquare } from "lucide-react";

export interface SessionsListProps {
  projectId: string | undefined;
  /** Highlight this session as the active one. */
  activeSessionId?: string;
  onSelect?: (session: AgentSession) => void;
  className?: string;
  /** Host-local worktree label by session id; primary sessions are absent. */
  checkoutLabels?: Record<string, string>;
}

/**
 * List of a project's agent sessions. Headers and new-chat actions are the
 * host's chrome — pair selection with a controlled `AgentChat sessionId`
 * for a Claude-Desktop-style session switcher.
 */
export function SessionsList({
  projectId,
  activeSessionId,
  onSelect,
  className = "",
  checkoutLabels = {},
}: SessionsListProps) {
  const sessionsQuery = useAgentSessions(projectId, { limit: 100 });
  const sessions = (sessionsQuery.data?.items ?? []).filter(
    (session) => session.visibility === "promoted",
  );

  if (sessionsQuery.isLoading) {
    return <p className="px-2 py-1 text-xs text-fg-muted">Loading…</p>;
  }
  if (sessionsQuery.error) {
    return (
      <p className="px-2 py-1 text-xs text-danger">
        {sessionsQuery.error.message}
      </p>
    );
  }
  if (sessions.length === 0) {
    return <p className="px-2 py-1 text-xs text-fg-faint">No chats yet.</p>;
  }

  return (
    <ul className={`flex flex-col gap-0.5 ${className}`}>
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            onClick={() => onSelect?.(session)}
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded px-2 text-left text-[13px] transition-colors duration-150 ${
              session.id === activeSessionId
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
            aria-current={session.id === activeSessionId || undefined}
          >
            <MessageSquare className="size-3.5 shrink-0" />
            <span className="truncate">{sessionLabel(session)}</span>
            {checkoutLabels[session.id] ? (
              <span className="ml-auto flex max-w-28 shrink-0 items-center gap-1 truncate rounded bg-bg-inset px-1.5 py-0.5 text-[10px] text-fg-faint">
                <GitBranch className="size-2.5 shrink-0" />
                <span className="truncate">{checkoutLabels[session.id]}</span>
              </span>
            ) : null}
          </button>
        </li>
      ))}
    </ul>
  );
}

function sessionLabel(session: AgentSession): string {
  if (session.title) return session.title;
  const created = new Date(session.createdAt);
  return `Chat ${created.toLocaleDateString()} ${created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
