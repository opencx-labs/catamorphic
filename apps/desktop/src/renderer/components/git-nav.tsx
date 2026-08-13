import { GitBranch } from "lucide-react";
import { useEffect, useState } from "react";
import {
  desktopApi,
  type GitChangedFile,
  type GitDiffMode,
  type GitOverview,
  type GitWorktree,
} from "../lib/desktop-api.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

/**
 * The sidebar's Changes section: uncommitted files per git worktree
 * (main worktree first, extra worktrees under a small branch header,
 * each with a "vs main" group for the branch's own changes). Clicking a
 * file opens a read-only diff tab. Data is a 15s poll — git state
 * changes outside the app all the time (terminals, agents, editors).
 */

const REFRESH_MS = 15_000;

/** A/M/D/R in the status colors — the classic dev-tool shorthand. */
const KIND_BADGES: Record<
  GitChangedFile["kind"],
  { letter: string; className: string }
> = {
  added: { letter: "A", className: "text-success" },
  modified: { letter: "M", className: "text-info" },
  deleted: { letter: "D", className: "text-danger" },
  renamed: { letter: "R", className: "text-warning" },
};

export function GitNav({
  projectId,
  onOpenDiff,
}: {
  projectId: string;
  onOpenDiff: (tab: WorkspaceTab) => void;
}) {
  const [overview, setOverview] = useState<GitOverview | null>(null);

  useEffect(() => {
    let cancelled = false;
    setOverview(null);
    const load = () =>
      void desktopApi
        .gitOverview(projectId)
        .then((next) => {
          if (!cancelled) setOverview(next);
        })
        .catch(() => {});
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [projectId]);

  if (!overview) return null;
  if (!overview.available) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">
        Install git to see changes.
      </p>
    );
  }
  const hasChanges = overview.worktrees.some(
    (tree) => tree.changes.length > 0 || (tree.vsMain?.length ?? 0) > 0,
  );
  if (!hasChanges) {
    return <p className="px-2 py-1 text-xs text-fg-faint">No changes.</p>;
  }

  const diffTab = (
    tree: GitWorktree,
    file: GitChangedFile,
    mode: GitDiffMode,
  ): WorkspaceTab => {
    const modeLabel = mode === "uncommitted" ? "uncommitted" : "vs main";
    const treeName = tree.path.split("/").at(-1) ?? tree.path;
    return {
      kind: "diff",
      // Unique per worktree + file + mode, so reopening focuses the
      // existing tab; the label stays the short basename.
      name: tree.isMain
        ? `${file.path} (${modeLabel})`
        : `${treeName} · ${file.path} (${modeLabel})`,
      label: file.path.split("/").at(-1) ?? file.path,
      detail: `${file.path} (${modeLabel})`,
      projectId,
      source: {
        type: "local",
        worktreePath: tree.path,
        filePath: file.path,
        mode,
      },
    };
  };

  const onlyMain = overview.worktrees.length === 1;
  return (
    <div className="flex flex-col gap-0.5">
      {overview.worktrees.map((tree) => (
        <div key={tree.path} className="flex flex-col gap-0.5">
          {/* The lone main worktree needs no header — it IS the project. */}
          {!(tree.isMain && onlyMain) && (
            <div className="flex h-7 min-w-0 items-center gap-2 px-2 text-[13px] text-fg-muted">
              <GitBranch className="size-3.5 shrink-0 text-fg-faint" />
              <span className="truncate">{tree.branch ?? "detached"}</span>
              <span className="ml-auto shrink-0 text-[11px] text-fg-faint">
                {tree.path.split("/").at(-1)}
              </span>
            </div>
          )}
          {tree.changes.map((file) => (
            <FileRow
              key={`${tree.path}:${file.path}`}
              file={file}
              onOpen={() => onOpenDiff(diffTab(tree, file, "uncommitted"))}
            />
          ))}
          {(tree.vsMain?.length ?? 0) > 0 && (
            <>
              <p className="px-2 pt-1 text-[11px] text-fg-faint">vs main</p>
              {tree.vsMain?.map((file) => (
                <FileRow
                  key={`${tree.path}:vs-main:${file.path}`}
                  file={file}
                  onOpen={() => onOpenDiff(diffTab(tree, file, "vs-main"))}
                />
              ))}
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/** 28px row: dimmed directory + filename, kind letter on the right. */
function FileRow({
  file,
  onOpen,
}: {
  file: GitChangedFile;
  onOpen: () => void;
}) {
  const separator = file.path.lastIndexOf("/");
  const dir = separator >= 0 ? file.path.slice(0, separator + 1) : "";
  const base = separator >= 0 ? file.path.slice(separator + 1) : file.path;
  const badge = KIND_BADGES[file.kind];
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left font-mono text-xs transition-colors duration-150 hover:bg-bg-overlay/60"
    >
      <span className="min-w-0 flex-1 truncate">
        {dir && <span className="text-fg-faint">{dir}</span>}
        <span className="text-fg">{base}</span>
      </span>
      <span className={`shrink-0 text-[11px] font-semibold ${badge.className}`}>
        {badge.letter}
      </span>
    </button>
  );
}
