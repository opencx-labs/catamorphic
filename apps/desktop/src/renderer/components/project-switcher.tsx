import type { ProjectSummary } from "@catamorphic/react/types";
import { Box, Check, ChevronsUpDown, FolderPlus, Link2 } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePopoverDismiss } from "../lib/popover-dismiss.js";
import { useWorkspace } from "../lib/workspace-context.js";
import { ProjectInspector, ProjectInspectorWarmup } from "./project-inspector";
import { ResourceInspector } from "./resource-inspector";

export interface ProjectSwitcherProps {
  projects: ProjectSummary[];
  activeProjectId?: string;
  loading?: boolean;
  loadError?: boolean;
  onRetry?: () => void;
  onSelect: (projectId: string) => void;
  onOpenWindow?: (projectId: string) => void;
  onNewProject: () => void;
  onConnectRemote: () => void;
  onDeleteProject: (project: ProjectSummary) => void;
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  loading = false,
  loadError = false,
  onRetry,
  onSelect,
  onOpenWindow,
  onNewProject,
  onConnectRemote,
  onDeleteProject,
}: ProjectSwitcherProps) {
  const { visible } = useWorkspace();
  useEffect(() => {
    if (!visible) setOpen(false);
  }, [visible]);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // A project's card sits beside the whole list, clear of its edge.
  const listRef = useRef<HTMLDivElement>(null);
  // The current project's own card sits beside the sidebar, not beside the
  // button: across the sidebar's top row the button reaches its toggle,
  // and a card at the button's edge would cover it.
  const sidebarRef = useRef<Element | null>(null);
  useLayoutEffect(() => {
    sidebarRef.current =
      rootRef.current?.closest(".sidebar-inner") ?? rootRef.current;
  }, []);
  const active = projects.find((project) => project.id === activeProjectId);
  // A press anywhere else, a web page or an app's frame included, closes
  // the list; a press on a project's card or its menu does not.
  usePopoverDismiss({
    open,
    within: [rootRef],
    onDismiss: () => setOpen(false),
    returnFocus: triggerRef,
  });

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <ResourceInspector
        label={`${active?.name ?? "Project"} details`}
        anchorRef={sidebarRef}
        warmup={
          active ? (
            <ProjectInspectorWarmup projectId={active.id} current />
          ) : null
        }
        content={(dismiss) =>
          active ? (
            <ProjectInspector
              project={active}
              current
              onDelete={() => {
                dismiss();
                onDeleteProject(active);
              }}
            />
          ) : null
        }
      >
        {(inspectorProps) => (
          <button
            {...inspectorProps}
            ref={(node) => {
              inspectorProps.ref.current = node;
              triggerRef.current = node;
            }}
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="app-no-drag flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2.5 text-left transition-colors duration-150 hover:bg-bg-overlay/60"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-label="Switch project"
          >
            <Box className="size-3.5 shrink-0 text-fg-muted" />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
              {active?.name ??
                (loadError
                  ? "Projects unavailable"
                  : loading
                    ? "Loading projects…"
                    : "Choose project")}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-fg-faint" />
          </button>
        )}
      </ResourceInspector>

      <div
        ref={listRef}
        // As wide as the sidebar's content, however wide the button is.
        className={`absolute left-0 top-full z-50 mt-1 w-[calc(var(--left-sidebar-width,16rem)_-_1.5rem)] origin-top rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl transition-[opacity,scale] duration-150 ease-standard ${
          open
            ? "scale-100 opacity-100"
            : "pointer-events-none scale-95 opacity-0"
        }`}
        role="listbox"
        aria-hidden={!open}
        inert={!open ? true : undefined}
      >
        <div className="max-h-64 overflow-y-auto">
          {projects.map((project) => {
            const isActive = project.id === activeProjectId;
            return (
              <ResourceInspector
                key={project.id}
                label={`${project.name} details`}
                anchorRef={listRef}
                warmup={
                  <ProjectInspectorWarmup
                    projectId={project.id}
                    current={isActive}
                  />
                }
                content={(dismiss) => (
                  <ProjectInspector
                    project={project}
                    current={isActive}
                    onDelete={() => {
                      dismiss();
                      onDeleteProject(project);
                      setOpen(false);
                    }}
                    onOpenWindow={
                      onOpenWindow && !isActive
                        ? () => {
                            dismiss();
                            onOpenWindow(project.id);
                            setOpen(false);
                          }
                        : undefined
                    }
                  />
                )}
              >
                {(inspectorProps) => (
                  <button
                    {...inspectorProps}
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    onClick={(event) => {
                      if (
                        !isActive &&
                        (event.metaKey || event.ctrlKey || event.shiftKey)
                      )
                        onOpenWindow?.(project.id);
                      else onSelect(project.id);
                      setOpen(false);
                    }}
                    // A long name truncates instead of scrolling the list
                    // sideways.
                    className={`flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${isActive ? "text-fg" : "text-fg-muted hover:bg-bg-raised hover:text-fg"}`}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {project.name}
                    </span>
                    {isActive && (
                      <Check className="size-3.5 shrink-0 text-accent" />
                    )}
                  </button>
                )}
              </ResourceInspector>
            );
          })}
          {loadError ? (
            <div role="alert" className="px-2 py-1.5 text-xs text-fg-muted">
              Could not load your projects.
              <button
                type="button"
                onClick={onRetry}
                className="button-ghost button-sm mt-1"
              >
                Try again
              </button>
            </div>
          ) : projects.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-fg-faint">
              {loading ? "Loading projects…" : "Add your first project."}
            </p>
          ) : null}
        </div>
        <div className="mt-1 border-t border-border pt-1">
          <button
            type="button"
            onClick={() => {
              onNewProject();
              setOpen(false);
            }}
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-raised hover:text-fg"
          >
            <FolderPlus className="size-3.5 shrink-0" />
            New project
          </button>
          <button
            type="button"
            onClick={() => {
              onConnectRemote();
              setOpen(false);
            }}
            data-testid="switcher-connect-remote"
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-raised hover:text-fg"
          >
            <Link2 className="size-3.5 shrink-0" />
            Connect to a server…
          </button>
        </div>
      </div>
    </div>
  );
}
