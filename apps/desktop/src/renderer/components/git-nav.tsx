import { ChevronRight, GitBranch } from "lucide-react";
import { useEffect, useId, useState } from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import {
  desktopApi,
  type GitChangedFile,
  type GitDiffMode,
  type GitOverview,
  type GitWorktree,
} from "../lib/desktop-api.js";
import { Collapsible } from "./collapsible.js";
import { OpenResourceButton } from "./open-resource-button.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

/** Per-checkout changes, with separate index, working-file and committed comparisons.
 * Refresh on focus, Git mutations and a bounded poll; preserve each disclosure's state.
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
  conflicted: { letter: "!", className: "text-danger" },
};

interface ChangeTreeDir {
  /** Display name; single-child chains collapse into "a/b/c". */
  name: string;
  dirs: ChangeTreeDir[];
  files: GitChangedFile[];
}

/** Nest flat change paths into a tree, collapsing single-child chains. */
function buildChangeTree(files: GitChangedFile[]): ChangeTreeDir {
  const root: ChangeTreeDir = { name: "", dirs: [], files: [] };
  for (const file of files) {
    const segments = file.path.split("/");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.find((dir) => dir.name === segment);
      if (!next) {
        next = { name: segment, dirs: [], files: [] };
        node.dirs.push(next);
      }
      node = next;
    }
    node.files.push(file);
  }
  const collapse = (dir: ChangeTreeDir): ChangeTreeDir => {
    let current = dir;
    while (current.dirs.length === 1 && current.files.length === 0) {
      const only = current.dirs[0];
      if (!only) break;
      current = { ...only, name: `${current.name}/${only.name}` };
    }
    return { ...current, dirs: current.dirs.map(collapse) };
  };
  return { ...root, dirs: root.dirs.map(collapse) };
}

export function GitNav({
  projectId,
  onOpenDiff,
  onEmptyChange,
}: {
  projectId: string;
  onOpenDiff: (tab: WorkspaceTab, mode?: OpenMode) => void;
  onEmptyChange?: (empty: boolean) => void;
}) {
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    let running = false;
    let queued = false;
    setOverview(null);
    setError(null);
    const load = async () => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      try {
        const next = await desktopApi.gitOverview(projectId);
        if (!cancelled) {
          setOverview(next);
          setError(null);
        }
      } catch (reason) {
        if (!cancelled)
          setError(
            reason instanceof Error
              ? reason.message
              : "Could not read Git changes.",
          );
      } finally {
        running = false;
        if (queued && !cancelled) {
          queued = false;
          void load();
        }
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), REFRESH_MS);
    const focus = () => void load();
    window.addEventListener("focus", focus);
    const unsubscribe = desktopApi.onGitChanged((change) => {
      if (change.projectId === projectId) void load();
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", focus);
      unsubscribe();
    };
  }, [projectId]);
  const hasContent = overview?.worktrees.some(
    (tree) =>
      tree.changes.length ||
      tree.branchChanges.length ||
      tree.error ||
      tree.comparisonError,
  );
  const isEmpty =
    !error &&
    !overview?.error &&
    overview?.available !== false &&
    !hasContent &&
    (overview?.worktrees.length ?? 0) <= 1;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);
  if (!overview && !error) return null;
  if (overview?.available === false)
    return <p className="sidebar-empty-state">Install git to see changes.</p>;
  return (
    <div className="flex flex-col gap-1" data-testid="git-changes">
      {(error || overview?.error) && (
        <p role="alert" className="break-words px-2 py-1 text-xs text-danger">
          {error ?? overview?.error}
        </p>
      )}
      {overview?.worktrees.map((tree) => (
        <WorktreeSection
          key={`${projectId}:${tree.path}`}
          tree={tree}
          projectId={projectId}
          onOpenDiff={onOpenDiff}
        />
      ))}
    </div>
  );
}

const GROUPS: Array<{ mode: GitDiffMode; label: string }> = [
  { mode: "conflict", label: "Conflicts" },
  { mode: "staged", label: "Staged" },
  { mode: "unstaged", label: "Unstaged" },
  { mode: "untracked", label: "Untracked" },
];
function WorktreeSection({
  tree,
  projectId,
  onOpenDiff,
}: {
  tree: GitWorktree;
  projectId: string;
  onOpenDiff: (tab: WorkspaceTab, mode?: OpenMode) => void;
}) {
  const [open, setOpen] = useState(true);
  const contentId = useId();
  const count = new Set(
    [...tree.changes, ...tree.branchChanges].map((file) => file.path),
  ).size;
  const openFile = (file: GitChangedFile, mode?: OpenMode) => {
    const label =
      file.mode === "branch"
        ? `vs ${tree.baseLabel}`
        : (GROUPS.find((group) => group.mode === file.mode)?.label ??
          file.mode);
    const checkout = tree.branch ?? "Detached HEAD";
    onOpenDiff(
      {
        kind: "diff",
        name: JSON.stringify([tree.path, file.mode, file.path]),
        label: file.path.split("/").at(-1) ?? file.path,
        detail: `${checkout} · ${file.path} (${label})`,
        projectId,
        source: {
          type: "local",
          worktreePath: tree.path,
          filePath: file.path,
          mode: file.mode,
          previousPath: file.previousPath,
          baseRef: tree.baseRef,
        },
      },
      mode,
    );
  };
  return (
    <div className="flex flex-col gap-0.5" data-worktree-path={tree.path}>
      <h4>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
          title={tree.path}
          className="flex h-7 w-full min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-2 text-left text-[13px] text-fg-muted hover:bg-bg-overlay/60"
        >
          <ChevronRight
            className={`size-3 shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${open ? "rotate-90" : ""}`}
          />
          <GitBranch className="size-3.5 shrink-0 text-fg-faint" />
          <span className="min-w-0 truncate">
            {tree.branch ?? "Detached HEAD"}
          </span>
          {tree.isCurrent && (
            <span className="text-[10px] text-fg-faint">Current</span>
          )}
          <span className="ml-auto text-[11px] text-fg-faint">{count}</span>
        </button>
      </h4>
      <div id={contentId} className="pl-3">
        <Collapsible open={open}>
          <p
            className="truncate px-2 text-[10px] text-fg-faint"
            title={tree.path}
          >
            {tree.path.split("/").at(-1) ?? tree.path}
          </p>
          {tree.locked && (
            <p className="px-2 text-xs text-fg-faint">Locked: {tree.locked}</p>
          )}
          {tree.error && (
            <p role="alert" className="break-words px-2 text-xs text-danger">
              {tree.error}
            </p>
          )}
          {GROUPS.map((group) => {
            const files = tree.changes.filter(
              (file) => file.mode === group.mode,
            );
            return (
              files.length > 0 && (
                <div key={group.mode} data-change-group={group.mode}>
                  <h5 className="px-2 pt-1 text-[11px] text-fg-faint">
                    {group.label} <span>{files.length}</span>
                  </h5>
                  <ChangeTree files={files} onOpen={openFile} />
                </div>
              )
            );
          })}
          {tree.branchChanges.length > 0 && (
            <div data-change-group="branch">
              <h5 className="px-2 pt-1 text-[11px] text-fg-faint">
                Committed vs {tree.baseLabel}
              </h5>
              <ChangeTree files={tree.branchChanges} onOpen={openFile} />
            </div>
          )}
          {tree.comparisonError && (
            <p role="alert" className="break-words px-2 text-xs text-danger">
              Could not compare branch: {tree.comparisonError}
            </p>
          )}
          {!count && !tree.error && !tree.comparisonError && (
            <p className="sidebar-empty-state">No changes.</p>
          )}
        </Collapsible>
      </div>
    </div>
  );
}

function ChangeTree({
  files,
  onOpen,
}: {
  files: GitChangedFile[];
  onOpen: (file: GitChangedFile, mode?: OpenMode) => void;
}) {
  const root = buildChangeTree(files);
  return (
    <div className="flex flex-col gap-px">
      {root.dirs.map((dir) => (
        <DirNode key={dir.name} dir={dir} depth={0} onOpen={onOpen} />
      ))}
      {root.files.map((file) => (
        <FileRow key={file.path} file={file} depth={0} onOpen={onOpen} />
      ))}
    </div>
  );
}

function DirNode({
  dir,
  depth,
  onOpen,
}: {
  dir: ChangeTreeDir;
  depth: number;
  onOpen: (file: GitChangedFile, mode?: OpenMode) => void;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex flex-col gap-px">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        className="flex h-6 w-full cursor-pointer items-center gap-1 rounded-md pr-2 text-left font-mono text-xs text-fg-faint transition-colors duration-150 hover:bg-bg-overlay/60 hover:text-fg-muted"
      >
        <ChevronRight
          className={`size-3 shrink-0 transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
            open ? "rotate-90" : ""
          }`}
        />
        <span className="truncate">{dir.name}/</span>
      </button>
      <Collapsible open={open}>
        {dir.dirs.map((child) => (
          <DirNode
            key={child.name}
            dir={child}
            depth={depth + 1}
            onOpen={onOpen}
          />
        ))}
        {dir.files.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            depth={depth + 1}
            onOpen={onOpen}
          />
        ))}
      </Collapsible>
    </div>
  );
}

/** 28px leaf row: basename + kind letter (the tree shows the directory). */
function FileRow({
  file,
  depth,
  onOpen,
}: {
  file: GitChangedFile;
  depth: number;
  onOpen: (file: GitChangedFile, mode?: OpenMode) => void;
}) {
  const base = file.path.split("/").at(-1) ?? file.path;
  const badge = KIND_BADGES[file.kind];
  return (
    <OpenResourceButton
      type="button"
      onOpen={(mode) => onOpen(file, mode)}
      title={
        file.previousPath ? `${file.previousPath} → ${file.path}` : file.path
      }
      style={{ paddingLeft: `${8 + depth * 12 + (depth > 0 ? 16 : 0)}px` }}
      className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md pr-2 text-left font-mono text-xs transition-colors duration-150 hover:bg-bg-overlay/60"
    >
      <span className="min-w-0 flex-1 truncate text-fg">{base}</span>
      <span className={`shrink-0 text-[11px] font-semibold ${badge.className}`}>
        {badge.letter}
      </span>
    </OpenResourceButton>
  );
}
