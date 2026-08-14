import { ChevronRight, GitBranch } from "lucide-react";
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
 * each with a "vs main" group for the branch's own changes). Files are
 * grouped into a collapsible directory tree (single-child directory
 * chains collapse into one "a/b/c" row, VS Code style). Clicking a file
 * opens a read-only diff tab. Data is a 15s poll plus a push refresh
 * whenever a turn checkpoint moves git state — stale rows would open
 * diffs against a HEAD that already contains them.
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
  onOpenDiff: (tab: WorkspaceTab) => void;
  /** Reports emptiness up so hide-when-empty sections can drop entirely. */
  onEmptyChange?: (empty: boolean) => void;
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
    const unsubscribe = desktopApi.onGitChanged((change) => {
      if (change.projectId === projectId) load();
    });
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      unsubscribe();
    };
  }, [projectId]);

  const hasChanges =
    overview?.available === true &&
    overview.worktrees.some(
      (tree) => tree.changes.length > 0 || (tree.vsMain?.length ?? 0) > 0,
    );
  const isEmpty = !overview || (overview.available && !hasChanges);
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);

  if (!overview) return null;
  if (!overview.available) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">
        Install git to see changes.
      </p>
    );
  }
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
          <ChangeTree
            files={tree.changes}
            onOpen={(file) => onOpenDiff(diffTab(tree, file, "uncommitted"))}
          />
          {(tree.vsMain?.length ?? 0) > 0 && (
            <>
              <p className="px-2 pt-1 text-[11px] text-fg-faint">vs main</p>
              <ChangeTree
                files={tree.vsMain ?? []}
                onOpen={(file) => onOpenDiff(diffTab(tree, file, "vs-main"))}
              />
            </>
          )}
        </div>
      ))}
    </div>
  );
}

function ChangeTree({
  files,
  onOpen,
}: {
  files: GitChangedFile[];
  onOpen: (file: GitChangedFile) => void;
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
  onOpen: (file: GitChangedFile) => void;
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
      {open && (
        <>
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
        </>
      )}
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
  onOpen: (file: GitChangedFile) => void;
}) {
  const base = file.path.split("/").at(-1) ?? file.path;
  const badge = KIND_BADGES[file.kind];
  return (
    <button
      type="button"
      onClick={() => onOpen(file)}
      title={file.path}
      style={{ paddingLeft: `${8 + depth * 12 + (depth > 0 ? 16 : 0)}px` }}
      className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md pr-2 text-left font-mono text-xs transition-colors duration-150 hover:bg-bg-overlay/60"
    >
      <span className="min-w-0 flex-1 truncate text-fg">{base}</span>
      <span className={`shrink-0 text-[11px] font-semibold ${badge.className}`}>
        {badge.letter}
      </span>
    </button>
  );
}
