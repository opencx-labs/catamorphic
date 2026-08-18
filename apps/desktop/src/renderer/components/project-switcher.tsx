import type { ProjectSummary } from "@catamorphic/react/types";
import {
  Box,
  Check,
  ChevronsUpDown,
  FolderPlus,
  Link2,
  Trash2,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ShortcutHint } from "./shortcut-hint.js";

export interface ProjectSwitcherProps {
  projects: ProjectSummary[];
  activeProjectId?: string;
  onSelect: (projectId: string) => void;
  onNewProject: () => void;
  onConnectRemote: () => void;
  onDeleteProject: (project: ProjectSummary) => void;
}

export function ProjectSwitcher({
  projects,
  activeProjectId,
  onSelect,
  onNewProject,
  onConnectRemote,
  onDeleteProject,
}: ProjectSwitcherProps) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const active = projects.find((project) => project.id === activeProjectId);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // Claim the key so the expanded chat's window listener ignores it.
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="app-no-drag flex h-8 w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-bg-inset px-2.5 text-left transition-colors duration-150 hover:border-border-strong"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Switch project"
      >
        <Box className="size-3.5 shrink-0 text-accent" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-fg">
          {active?.name ?? "No projects"}
        </span>
        <ChevronsUpDown className="size-3.5 shrink-0 text-fg-faint" />
      </button>

      <div
        className={`absolute inset-x-0 top-full z-50 mt-1 origin-top rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
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
              <div
                key={project.id}
                className={`group flex h-8 w-full items-center rounded-md transition-colors duration-150 ${
                  isActive ? "text-fg" : "text-fg-muted hover:bg-bg-raised"
                }`}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={isActive}
                  onClick={() => {
                    onSelect(project.id);
                    setOpen(false);
                  }}
                  className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-[13px] hover:text-fg"
                >
                  <span className="min-w-0 flex-1 truncate">
                    {project.name}
                  </span>
                  {isActive && (
                    <Check className="size-3.5 shrink-0 text-accent" />
                  )}
                </button>
                <ShortcutHint label="Delete project">
                  <button
                    type="button"
                    onClick={() => {
                      onDeleteProject(project);
                      setOpen(false);
                    }}
                    className="mr-1 hidden size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-danger group-hover:grid"
                    aria-label={`Delete ${project.name}`}
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                </ShortcutHint>
              </div>
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
