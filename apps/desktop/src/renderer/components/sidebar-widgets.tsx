import { useAgentSessions, useRuns, useWorkflows } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import type { OpenMode } from "../../shared/open-mode.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  localEditorPath,
  useLocalProjectFiles,
} from "../lib/local-project-files.js";
import { OpenResourceButton } from "./open-resource-button.js";
import {
  useSidebarContent,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarTree } from "./sidebar-tree.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

export function SidebarActivity({
  projectId,
  visible,
  onOpenSession,
  onOpenTab,
}: {
  projectId: string;
  visible: boolean;
  onOpenSession: (session: AgentSession, mode?: OpenMode) => void;
  onOpenTab: (tab: WorkspaceTab, mode?: OpenMode) => void;
}) {
  const sessions = useAgentSessions(projectId, {
    limit: 100,
    refetchInterval: visible ? 2000 : false,
  });
  const workflows = useWorkflows(projectId);
  useSidebarRefresh(sessions.refetch);
  useSidebarRefresh(workflows.refetch);
  const active = (sessions.data?.items ?? []).filter(
    (session) => session.running || session.attentionRequired,
  );
  const [workflowStates, setWorkflowStates] = useState<
    ReadonlyMap<string, { count: number; loading: boolean; error: boolean }>
  >(new Map());
  const reportWorkflow = useCallback(
    (
      name: string,
      state: { count: number; loading: boolean; error: boolean },
    ) => {
      setWorkflowStates((current) => {
        const before = current.get(name);
        return before?.count === state.count &&
          before.loading === state.loading &&
          before.error === state.error
          ? current
          : new Map(current).set(name, state);
      });
    },
    [],
  );
  const states = (workflows.data ?? []).map((workflow) =>
    workflowStates.get(workflow.name),
  );
  useSidebarContent(
    sessions.isError ||
      workflows.isError ||
      states.some((state) => state?.error)
      ? "error"
      : sessions.isLoading ||
          workflows.isLoading ||
          states.some((state) => !state || state.loading)
        ? "loading"
        : active.length || states.some((state) => state?.count)
          ? "ready"
          : "empty",
  );
  return (
    <div className="text-xs">
      {sessions.isError && (
        <p role="alert" className="sidebar-empty-state">
          Could not load activity.{" "}
          <button type="button" onClick={() => void sessions.refetch()}>
            Retry
          </button>
        </p>
      )}
      <SidebarTree
        items={active}
        label="Agent activity"
        renderItem={(session) => (
          <SidebarItemRow
            itemId={session.id}
            label={session.title ?? "Untitled chat"}
            icon="MessageSquare"
            resource
            description={session.activity ?? undefined}
            badges={[session.attentionRequired ? "Needs you" : "Working"]}
            onOpen={(mode) => onOpenSession(session, mode)}
            onAction={() => {}}
          />
        )}
      />
      {!sessions.isLoading && !sessions.isError && !active.length && (
        <p className="sidebar-empty-state">No agents need attention.</p>
      )}
      {(workflows.data ?? []).map((workflow) => (
        <WorkflowActivity
          key={workflow.name}
          projectId={projectId}
          name={workflow.name}
          visible={visible}
          onOpenTab={onOpenTab}
          report={reportWorkflow}
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
  report,
}: {
  projectId: string;
  name: string;
  visible: boolean;
  onOpenTab: (tab: WorkspaceTab, mode?: OpenMode) => void;
  report: (
    name: string,
    state: { count: number; loading: boolean; error: boolean },
  ) => void;
}) {
  const runs = useRuns({
    projectId,
    workflowName: name,
    limit: 10,
    pollInterval: visible ? 2000 : false,
  });
  useSidebarRefresh(runs.refetch);
  const active = (runs.data?.items ?? []).filter((run) =>
    ["pending", "running", "waiting", "paused", "failed"].includes(run.status),
  );
  useEffect(
    () =>
      report(name, {
        count: active.length,
        loading: runs.isLoading,
        error: runs.isError,
      }),
    [name, active.length, runs.isLoading, runs.isError, report],
  );
  return (
    <>
      {runs.isError && (
        <p role="alert" className="sidebar-empty-state">
          Could not load {name} activity.{" "}
          <button type="button" onClick={() => void runs.refetch()}>
            Retry
          </button>
        </p>
      )}
      <SidebarTree
        items={active}
        label={`${name} activity`}
        renderItem={(run) => (
          <SidebarItemRow
            itemId={run.id}
            label={name}
            icon="Workflow"
            resource
            badges={[run.status]}
            onOpen={(mode) => onOpenTab({ kind: "workflow", name }, mode)}
            onAction={() => {}}
          />
        )}
      />
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
  onOpenFile: (path: string, mode?: OpenMode) => void;
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
  useSidebarContent(
    note.isError || files.isError
      ? "error"
      : file && note.isPending
        ? "loading"
        : file
          ? "ready"
          : "empty",
  );
  useSidebarRefresh(note.refetch);
  const refetch = note.refetch;
  const refetchFiles = files.refetch;
  useEffect(() => {
    // Hidden tabs skip git events. Catch up when their note picker is shown.
    if (visible) void refetchFiles();
  }, [visible, refetchFiles]);
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
        <>
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
          {files.isError && (
            <p role="alert" className="mb-2 text-warning">
              Could not load project notes.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                aria-label="Retry loading project notes"
                onClick={() => void refetchFiles()}
              >
                Retry
              </button>
            </p>
          )}
        </>
      )}
      {file && (
        <>
          <OpenResourceButton
            type="button"
            className="mb-2 max-w-full truncate text-fg-muted hover:text-accent"
            onOpen={(mode) => onOpenFile(file, mode)}
          >
            Open {file}
          </OpenResourceButton>
          {note.isError ? (
            <p role="alert" className="text-warning">
              This note could not be read.{" "}
              <button
                type="button"
                className="underline underline-offset-2"
                aria-label="Retry reading note"
                onClick={() => void refetch()}
              >
                Retry
              </button>
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
