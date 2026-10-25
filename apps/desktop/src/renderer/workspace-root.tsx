import {
  type AgentSession,
  useAgentAttention,
  useProjects,
} from "@catamorphic/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { WorkspaceNavigation } from "../shared/desktop-workspace.js";
import { App } from "./app.js";
import { DockHost } from "./components/dock-host.js";
import { Modal } from "./components/modal.js";
import {
  ProjectAuthorityProvider,
  useRemoteAuthority,
} from "./components/project-authority-provider.js";
import { desktopApi } from "./lib/desktop-api.js";
import {
  endMove,
  isMoving,
  startMove,
  unsavedBeforeMove,
} from "./lib/project-move.js";
import { LOCAL_CHATS_POLL_MS } from "./lib/session-change-hints.js";
import { ProjectTheme } from "./lib/theme.js";
import { WorkspaceContext } from "./lib/workspace-context.js";
import { flushWorkspaceSaves } from "./lib/workspace-persistence.js";

/** Hiding a project never unmounts its resources or agent tool handlers. */
export function WorkspaceRoot() {
  const queryClient = useQueryClient();
  const projectList = useProjects();
  const [attentionByProject, setAttentionByProject] = useState<
    Record<string, AgentSession[]>
  >({});
  const onAttention = useCallback(
    (projectId: string, sessions: AgentSession[]) => {
      setAttentionByProject((current) => ({
        ...current,
        [projectId]: sessions,
      }));
    },
    [],
  );
  const [projects, setProjects] = useState<
    Array<{
      key: string;
      projectId?: string;
      navigation?: WorkspaceNavigation["surface"];
    }>
  >([{ key: "initial" }]);
  const [ready, setReady] = useState(false);
  const readyRef = useRef(ready);
  readyRef.current = ready;
  const [active, setActive] = useState("initial");
  const current = useRef(projects);
  current.current = projects;
  useEffect(() => {
    if (!projectList.data || projectList.isFetching) return;
    const ids = new Set(projectList.data.items.map((project) => project.id));
    setProjects((current) => {
      const retained = current.filter(
        (project) => !project.projectId || ids.has(project.projectId),
      );
      return retained.length === current.length
        ? current
        : retained.length
          ? retained
          : [{ key: crypto.randomUUID() }];
    });
  }, [projectList.data, projectList.isFetching]);
  useEffect(() => {
    if (!ready) return;
    const ids = Object.entries(attentionByProject)
      .filter(([, sessions]) => sessions.length > 0)
      .map(([id]) => id)
      .filter(
        (id) =>
          !isMoving(id) &&
          !current.current.some((item) => item.projectId === id),
      );
    // A project another window owns is that window's to keep alive. A
    // claim made is a project to mount, whatever arrives meanwhile.
    for (const projectId of ids)
      void desktopApi.workspaceClaim(projectId).then((claimed) => {
        if (!claimed) return;
        setProjects((items) =>
          items.some((item) => item.projectId === projectId)
            ? items
            : [...items, { key: projectId, projectId }],
        );
      });
  }, [ready, attentionByProject]);
  useEffect(() => {
    const first = projects[0];
    if (first && !projects.some((project) => project.key === active))
      setActive(first.key);
  }, [projects, active]);
  const [transition, setTransition] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const activeKey = useRef(active);
  activeKey.current = active;
  // Projects let go to a window of their own (lib/project-move.ts),
  // answered once unmounted: their workspaces saved as they were, their
  // shells left running for the new window, their chats off the dock.
  const [released, setReleased] = useState<string[]>([]);
  useEffect(() => {
    if (released.length === 0) return;
    for (const projectId of released) {
      void desktopApi.workspaceRelease(projectId, true);
      endMove(projectId);
    }
    setReleased([]);
  }, [released]);
  // A project kept here by unsaved edits says which, and where to see them.
  const [heldBack, setHeldBack] = useState<{
    projectId: string;
    files: string[];
  } | null>(null);
  useEffect(
    () =>
      desktopApi.onWorkspaceEvent((event) => {
        if (event.kind !== "release") return;
        const { projectId } = event;
        // Still opening what it shows: nothing is let go yet.
        if (!readyRef.current) {
          void desktopApi.workspaceRelease(projectId, false);
          return;
        }
        const item = current.current.find(
          (project) => project.projectId === projectId,
        );
        if (!item) {
          void desktopApi.workspaceRelease(projectId, true);
          return;
        }
        // The project in front stays: this window is the one showing it.
        if (item.key === activeKey.current) {
          void desktopApi.workspaceRelease(projectId, false);
          return;
        }
        const files = unsavedBeforeMove(projectId);
        if (files.length > 0) {
          void desktopApi.workspaceRelease(projectId, false);
          setHeldBack({ projectId, files });
          return;
        }
        startMove(projectId);
        setProjects((items) =>
          items.filter((project) => project.projectId !== projectId),
        );
        setReleased((ids) => [...ids, projectId]);
      }),
    [],
  );
  useEffect(
    () =>
      desktopApi.onWorkspaceEvent((event) => {
        if (event.kind === "forget") {
          void queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
          setProjects((items) => {
            const retained = items.filter(
              (item) => item.projectId !== event.projectId,
            );
            return retained.length > 0 ? retained : [{ key: "initial" }];
          });
          setAttentionByProject((items) => {
            const { [event.projectId]: _removed, ...rest } = items;
            return rest;
          });
          return;
        }
        if (event.kind !== "flush") return;
        // Commit any already queued input/layout update before reading the savers.
        flushSync(() => {});
        void flushWorkspaceSaves().then(
          () => desktopApi.workspaceFlushed(event.requestId),
          (error: unknown) =>
            desktopApi.workspaceFlushed(
              event.requestId,
              error instanceof Error
                ? error.message
                : "Could not save the workspace",
            ),
        );
      }),
    [queryClient],
  );
  useEffect(() => {
    void desktopApi
      .workspaceInitial()
      .then(({ projectIds, activeProjectId }) => {
        if (projectIds.length > 0) {
          setProjects(
            projectIds.map((projectId) => ({ key: projectId, projectId })),
          );
          setActive(activeProjectId ?? projectIds[0] ?? "initial");
        }
        setReady(true);
      });
  }, []);
  useEffect(() => {
    const reset = () => {
      setProjects([{ key: "initial" }]);
      setAttentionByProject({});
      setActive("initial");
    };
    window.addEventListener("catamorphic:profile-refetch", reset);
    return () =>
      window.removeEventListener("catamorphic:profile-refetch", reset);
  }, []);
  const resolve = useCallback(
    async (key: string, projectId: string): Promise<boolean> => {
      if (!(await desktopApi.workspaceClaim(projectId))) return false;
      setProjects((items) => {
        if (items.some((item) => item.projectId === projectId)) return items;
        // A successful claim is retained even if a navigation filled the
        // initial slot while it was pending; it never replaces that navigation.
        const initial = items.find((item) => item.key === key);
        return initial && !initial.projectId
          ? items.map((item) =>
              item.key === key ? { ...item, projectId } : item,
            )
          : [...items, { key: projectId, projectId }];
      });
      return true;
    },
    [],
  );
  useEffect(
    () =>
      desktopApi.onWorkspaceEvent((event) => {
        if (event.kind !== "navigate") return;
        const { projectId } = event;
        // On its way to a window of its own: it opens there.
        if (isMoving(projectId)) return;
        void desktopApi.workspaceClaim(projectId).then(async (claimed) => {
          if (!claimed) return;
          await queryClient.invalidateQueries({
            queryKey: ["cat", "projects"],
          });
          const known =
            current.current.find((item) => item.projectId === projectId) ??
            current.current.find((item) => !item.projectId);
          const key = known?.key ?? projectId;
          setProjects((items) => {
            const existing = items.find((item) => item.key === key);
            return existing
              ? items.map((item) =>
                  item.key === key
                    ? {
                        ...item,
                        projectId,
                        // Revealing the project does not cancel a surface
                        // that another request is still opening there.
                        navigation: event.surface ?? item.navigation,
                      }
                    : item,
                )
              : [...items, { key, projectId, navigation: event.surface }];
          });
          setActive((old) => {
            if (old !== key) setTransition((value) => value + 1);
            return key;
          });
          void desktopApi.setPrefs({ lastProjectId: projectId });
        });
      }),
    [queryClient],
  );
  const projectId = projects.find(
    (project) => project.key === active,
  )?.projectId;
  useEffect(() => {
    if (projectId) void desktopApi.workspaceActive(projectId);
  }, [projectId]);
  // The window is named for its project wherever macOS lists windows: the
  // Window menu, Mission Control, and Cmd+` going between them.
  const projectName = projectList.data?.items.find(
    (project) => project.id === projectId,
  )?.name;
  useEffect(() => {
    document.title = projectName ?? "Work";
  }, [projectName]);
  if (!ready) return <div className="size-full bg-bg" />;
  return (
    <div ref={root} className="relative isolate size-full" data-workspace-root>
      <div hidden>
        {(projectList.data?.items ?? []).map((project) => (
          <ProjectAuthorityProvider key={project.id} projectId={project.id}>
            <AttentionMonitor
              projectId={project.id}
              onAttention={onAttention}
            />
          </ProjectAuthorityProvider>
        ))}
      </div>
      {projects.map((project) => (
        <div
          key={project.key}
          data-project-runtime={project.projectId ?? "initial"}
          data-workspace-visible={project.key === active}
          className="absolute inset-0"
          style={{
            // Keep native guest surfaces paintable for agents working in the background.
            opacity: project.key === active ? 1 : 0,
            pointerEvents: project.key === active ? "auto" : "none",
          }}
          inert={project.key !== active}
        >
          <WorkspaceContext.Provider
            value={{
              visible: project.key === active,
              navigation: project.navigation,
              projectId: project.projectId,
              attention: project.projectId
                ? attentionByProject[project.projectId]
                : undefined,
            }}
          >
            <ProjectTheme projectId={project.projectId}>
              <App
                runtimeProjectId={project.projectId}
                onRequestProject={(id) => resolve(project.key, id)}
              />
              {project.key === active && transition > 0 && (
                <div
                  key={transition}
                  className="project-switch-tint"
                  aria-hidden="true"
                />
              )}
            </ProjectTheme>
          </WorkspaceContext.Provider>
        </div>
      ))}
      <DockHost activeProjectId={projectId} />
      <UnsavedMoveDialog
        name={
          projectList.data?.items.find(
            (project) => project.id === heldBack?.projectId,
          )?.name ?? "This project"
        }
        files={heldBack?.files ?? null}
        onShow={() => {
          if (heldBack)
            void desktopApi.workspaceNavigate({
              projectId: heldBack.projectId,
            });
          setHeldBack(null);
        }}
        onClose={() => setHeldBack(null)}
      />
    </div>
  );
}

/**
 * A project asked to open in a window of its own while files of it hold
 * unsaved edits: those live only in their editors here, so it stays until
 * they are saved or discarded.
 */
function UnsavedMoveDialog({
  name,
  files,
  onShow,
  onClose,
}: {
  name: string;
  files: string[] | null;
  onShow: () => void;
  onClose: () => void;
}) {
  const listed =
    files === null
      ? ""
      : files.length <= 2
        ? files.join(" and ")
        : `${files.slice(0, 2).join(", ")} and ${files.length - 2} more`;
  return (
    <Modal open={files !== null} onClose={onClose} width={420}>
      <div className="px-5 pt-5">
        <h2 className="text-sm font-semibold text-fg">
          {name} has unsaved changes
        </h2>
        <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
          Save or discard the changes in {listed}, then open {name} in a new
          window. Its tabs, chats and terminals go with it.
        </p>
      </div>
      <footer className="mt-4 flex items-center justify-end gap-2 border-t border-border px-5 py-3.5">
        <button type="button" onClick={onClose} className="button-ghost">
          Cancel
        </button>
        <button type="button" onClick={onShow} className="button-primary">
          Show changes
        </button>
      </footer>
    </Modal>
  );
}

/** One cached attention query per authority, independent of open project tabs. */
function AttentionMonitor({
  projectId,
  onAttention,
}: {
  projectId: string;
  onAttention: (projectId: string, sessions: AgentSession[]) => void;
}) {
  const authority = useRemoteAuthority();
  const attention = useAgentAttention({
    // This computer's attention follows its hints (ADR 0229).
    refetchInterval: authority ? 5_000 : LOCAL_CHATS_POLL_MS,
  });
  const remoteProjectId = authority?.remoteProjectId ?? projectId;
  useEffect(() => {
    if (!attention.data) return;
    onAttention(
      projectId,
      attention.data
        .filter((session) => session.projectId === remoteProjectId)
        .map((session) => ({ ...session, projectId })),
    );
  }, [attention.data, projectId, remoteProjectId, onAttention]);
  return null;
}
