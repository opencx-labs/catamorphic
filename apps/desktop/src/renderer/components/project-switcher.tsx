import type { ProjectSummary } from "@catamorphic/react/types";
import {
  Box,
  Check,
  ChevronsUpDown,
  FolderPlus,
  Link2,
  PanelsTopLeft,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { usePopoverDismiss } from "../lib/popover-dismiss.js";
import { useWorkspace } from "../lib/workspace-context.js";
import { ProjectInspector, ProjectInspectorWarmup } from "./project-inspector";
import { ResourceInspector } from "./resource-inspector";
import { ShortcutHint } from "./shortcut-hint";

export interface ProjectSwitcherProps {
  projects: ProjectSummary[];
  activeProjectId?: string;
  onSelect: (projectId: string) => void;
  onOpenWindow?: (projectId: string) => void;
  onNewProject: () => void;
  onConnectRemote: () => void;
  onDeleteProject: (project: ProjectSummary) => void;
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
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
  // A project's card sits beside the whole list, clear of its edge and of
  // each row's window button.
  const listRef = useRef<HTMLDivElement>(null);
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
              {active?.name ?? "No projects"}
            </span>
            <ChevronsUpDown className="size-3.5 shrink-0 text-fg-faint" />
          </button>
        )}
      </ResourceInspector>

      <div
        ref={listRef}
        // As wide as the sidebar's content, however wide the button is.
        className={`absolute left-0 top-full z-50 mt-1 w-[calc(var(--left-sidebar-width,16rem)_-_1.5rem)] origin-top rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
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
                  />
                )}
              >
                {(inspectorProps) => (
                  <div className="group flex items-center">
                    <button
                      {...inspectorProps}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      onClick={(event) => {
                        if (event.metaKey || event.ctrlKey || event.shiftKey)
                          onOpenWindow?.(project.id);
                        else onSelect(project.id);
                        setOpen(false);
                      }}
                      // Shrinks beside the window button, so a long name
                      // truncates instead of scrolling the list sideways.
                      className={`flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${isActive ? "text-fg" : "text-fg-muted hover:bg-bg-raised hover:text-fg"}`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {project.name}
                      </span>
                      {isActive && (
                        <Check className="size-3.5 shrink-0 text-accent" />
                      )}
                    </button>
                    {onOpenWindow && (
                      <ShortcutHint
                        label="Open project in another window"
                        side="top"
                      >
                        <button
                          type="button"
                          aria-label={`Open ${project.name} in another window`}
                          className="row-reveal grid size-7 shrink-0 place-items-center rounded text-fg-faint hover:bg-bg-raised hover:text-fg"
                          onClick={() => {
                            onOpenWindow(project.id);
                            setOpen(false);
                          }}
                        >
                          <PanelsTopLeft className="size-3.5" />
                        </button>
                      </ShortcutHint>
                    )}
                  </div>
                )}
              </ResourceInspector>
            );
          })}
          {projects.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-fg-faint">
              No projects yet.
            </p>
          )}
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
