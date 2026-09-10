import { useProjects } from "@catamorphic/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { App } from "./app.js";
import { DockHost } from "./components/dock-host.js";
import { desktopApi } from "./lib/desktop-api.js";
import { ProjectTheme } from "./lib/theme.js";
import { WorkspaceContext } from "./lib/workspace-context.js";

/** Hiding a project never unmounts its resources or agent tool handlers. */
export function WorkspaceRoot() {
  const queryClient = useQueryClient();
  const projectList = useProjects();
  const [projects, setProjects] = useState<
    Array<{ key: string; projectId?: string }>
  >([{ key: "initial" }]);
  const [ready, setReady] = useState(false);
  const [active, setActive] = useState("initial");
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
    const first = projects[0];
    if (first && !projects.some((project) => project.key === active))
      setActive(first.key);
  }, [projects, active]);
  const [transition, setTransition] = useState(0);
  const root = useRef<HTMLDivElement>(null);
  const current = useRef(projects);
  current.current = projects;
  useEffect(() => {
    void desktopApi.workspaceInitial().then((projectId) => {
      const initialProjectId =
        projectId ??
        new URLSearchParams(location.search).get("project") ??
        undefined;
      if (initialProjectId)
        setProjects([{ key: "initial", projectId: initialProjectId }]);
      setReady(true);
    });
  }, []);
  useEffect(() => {
    const reset = () => {
      setProjects([{ key: "initial" }]);
      setActive("initial");
    };
    window.addEventListener("catamorphic:profile-refetch", reset);
    return () =>
      window.removeEventListener("catamorphic:profile-refetch", reset);
  }, []);
  const resolve = useCallback((key: string, projectId: string) => {
    void desktopApi.workspaceClaim(projectId).then((claimed) => {
      if (!claimed) return;
      setProjects((items) =>
        items.find((item) => item.key === key)?.projectId === projectId
          ? items
          : items.map((item) =>
              item.key === key ? { ...item, projectId } : item,
            ),
      );
    });
  }, []);
  useEffect(
    () =>
      desktopApi.onWorkspaceEvent((event) => {
        if (event.kind !== "navigate") return;
        const { projectId } = event;
        void desktopApi.workspaceClaim(projectId).then(async (claimed) => {
          if (!claimed) return;
          await queryClient.invalidateQueries({
            queryKey: ["cat", "projects"],
          });
          const known =
            current.current.find((item) => item.projectId === projectId) ??
            current.current.find((item) => !item.projectId);
          const key = known?.key ?? projectId;
          if (known && !known.projectId)
            setProjects((items) =>
              items.map((item) =>
                item.key === known.key ? { ...item, projectId } : item,
              ),
            );
          if (!known)
            setProjects((items) =>
              items.some((item) => item.projectId === projectId)
                ? items
                : [...items, { key, projectId }],
            );
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
  if (!ready) return <div className="size-full bg-bg" />;
  return (
    <div ref={root} className="relative isolate size-full" data-workspace-root>
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
              projectId: project.projectId,
            }}
          >
            <ProjectTheme projectId={project.projectId}>
              <App
                runtimeProjectId={project.projectId}
                onProjectResolved={(id) => resolve(project.key, id)}
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
    </div>
  );
}
