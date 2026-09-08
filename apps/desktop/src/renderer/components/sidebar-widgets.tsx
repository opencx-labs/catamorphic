import { useAgentSessions, useRuns, useWorkflows } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import { desktopApi } from "../lib/desktop-api.js";
import {
  localEditorPath,
  useLocalProjectFiles,
} from "../lib/local-project-files.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

export function SidebarActivity({
  projectId,
  visible,
  onOpenSession,
  onOpenTab,
}: {
  projectId: string;
  visible: boolean;
  onOpenSession: (session: AgentSession) => void;
  onOpenTab: (tab: WorkspaceTab) => void;
}) {
  const sessions = useAgentSessions(projectId, {
    limit: 100,
    refetchInterval: visible ? 2000 : false,
  });
  const workflows = useWorkflows(projectId);
  const active = (sessions.data?.items ?? []).filter(
    (session) => session.running || session.attentionRequired,
  );
  return (
    <div className="text-xs">
      {sessions.isError && (
        <p className="px-2 py-1 text-warning">Could not load activity.</p>
      )}
      {active.map((session) => (
        <button
          key={session.id}
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-overlay"
          onClick={() => onOpenSession(session)}
        >
          <span
            className={`size-1.5 shrink-0 rounded-full ${session.attentionRequired ? "bg-accent" : "bg-success"}`}
          />
          <span className="min-w-0 flex-1 truncate">
            {session.title ?? "Untitled chat"}
          </span>
          <span className="shrink-0 text-fg-faint">
            {session.attentionRequired ? "Needs you" : "Working"}
          </span>
        </button>
      ))}
      {!sessions.isLoading && !sessions.isError && active.length === 0 && (
        <p className="px-2 py-1 text-fg-faint">No agents need attention.</p>
      )}
      {(workflows.data ?? []).map((workflow) => (
        <WorkflowActivity
          key={workflow.name}
          projectId={projectId}
          name={workflow.name}
          visible={visible}
          onOpenTab={onOpenTab}
        />
      ))}
    </div>
  );
}
function WorkflowActivity({
  projectId,
  name,
  visible,
  onOpenTab,
}: {
  projectId: string;
  name: string;
  visible: boolean;
  onOpenTab: (tab: WorkspaceTab) => void;
}) {
  const runs = useRuns({
    projectId,
    workflowName: name,
    limit: 10,
    pollInterval: visible ? 2000 : false,
  });
  const refetch = runs.refetch;
  useEffect(() => {
    if (!visible) return;
    const timer = window.setInterval(() => {
      if (!document.hidden) void refetch();
    }, 10000);
    return () => window.clearInterval(timer);
  }, [visible, refetch]);
  const active = (runs.data?.items ?? []).filter((run) =>
    ["pending", "running", "waiting", "paused", "failed"].includes(run.status),
  );
  return (
    <>
      {active.map((run) => (
        <button
          key={run.id}
          type="button"
          className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-bg-overlay"
          onClick={() => onOpenTab({ kind: "workflow", name })}
        >
          <span className="min-w-0 flex-1 truncate">{name}</span>
          <span
            className={
              run.status === "failed" ? "text-warning" : "text-fg-faint"
            }
          >
            {run.status}
          </span>
        </button>
      ))}
    </>
  );
}

/** The note is an existing project file. Personal pinning creates no new document model. */
export function SidebarNote({
  projectId,
  scope,
  path,
  visible,
  onOpenFile,
}: {
  projectId: string;
  scope: string;
  path?: string;
  visible: boolean;
  onOpenFile: (path: string) => void;
}) {
  const key = `catamorphic:sidebar-note:${scope}`;
  const [pinned, setPinned] = useState(() => localStorage.getItem(key) ?? "");
  const file = path ?? pinned;
  const files = useLocalProjectFiles(projectId);
  const note = useQuery({
    queryKey: ["desktop", "sidebar-note", projectId, file],
    queryFn: async () =>
      desktopApi.editorFileRead({
        filePath: await localEditorPath(projectId, file),
      }),
    enabled: Boolean(file) && visible,
  });
  const refetch = note.refetch;
  const refetchFiles = files.refetch;
  useEffect(
    () =>
      desktopApi.onGitChanged((event) => {
        if (!visible || event.projectId !== projectId) return;
        void refetchFiles();
        if (file) void refetch();
      }),
    [projectId, file, visible, refetch, refetchFiles],
  );
  return (
    <div className="px-2 text-xs">
      {!path && (
        <select
          aria-label="Pin a project note"
          className="mb-2 w-full rounded border border-border bg-bg-raised px-1 py-1 text-fg-muted"
          value={pinned}
          onChange={(event) => {
            setPinned(event.target.value);
            localStorage.setItem(key, event.target.value);
          }}
        >
          <option value="">Pin a note</option>
          {(files.data ?? [])
            .filter((entry) => /\.(md|txt)$/i.test(entry.path))
            .map((entry) => (
              <option key={entry.path} value={entry.path}>
                {entry.path}
              </option>
            ))}
        </select>
      )}
      {file && (
        <>
          <button
            type="button"
            className="mb-2 max-w-full truncate text-fg-muted hover:text-accent"
            onClick={() => onOpenFile(file)}
          >
            Open {file}
          </button>
          {note.isError ? (
            <p className="text-warning">
              This note could not be read. Choose another file.
            </p>
          ) : note.isLoading ? (
            <p className="text-fg-faint">Loading note…</p>
          ) : (
            <div className="sidebar-note max-h-96 overflow-y-auto break-words">
              <ReactMarkdown
                components={{
                  a: ({ children }) => <span>{children}</span>,
                  img: ({ alt }) => <span>{alt}</span>,
                }}
              >
                {note.data?.content ?? ""}
              </ReactMarkdown>
            </div>
          )}
        </>
      )}
    </div>
  );
}
