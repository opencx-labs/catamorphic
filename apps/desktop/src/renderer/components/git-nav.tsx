import { ChevronRight, GitBranch } from "lucide-react";
import {
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { OpenMode } from "../../shared/open-mode.js";
import {
  desktopApi,
  type GitChangedFile,
  type GitDiffMode,
  type GitOverview,
  type GitWorktree,
  type SessionCheckoutInfo,
} from "../lib/desktop-api.js";
import { useAppPreferences } from "../lib/use-app-preferences.js";
import { Collapsible } from "./collapsible.js";
import type { PaletteItem } from "./command-palette.js";
import { OpenResourceButton } from "./open-resource-button.js";
import {
  useSidebarContent,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarTree } from "./sidebar-tree.js";
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
    const segments = file.path.split("/").filter(Boolean);
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
  searchItems,
  onOpenDiff,
  activeSessionId,
  visible = true,
}: {
  projectId: string;
  searchItems?: RefObject<() => Promise<PaletteItem[]>>;
  activeSessionId?: string;
  visible?: boolean;
  onOpenDiff: (tab: WorkspaceTab, mode?: OpenMode) => void;
}) {
  const [scope, setScope] = useState<string>(
    () => localStorage.getItem(`changes-scope:${projectId}`) ?? "follow",
  );
  const { prefs, update, error: preferencesError } = useAppPreferences();
  const flat = prefs.changesFileLayout === "flat";
  const lastSession = useRef(activeSessionId);
  if (activeSessionId) lastSession.current = activeSessionId;
  const followedSession = lastSession.current;
  const readOverview = useCallback(async () => {
    const allPaths =
      scope === "all"
        ? (await desktopApi.gitOverview(projectId, [])).worktrees.map(
            (tree) => tree.path,
          )
        : undefined;
    return desktopApi.gitOverview(
      projectId,
      scope === "follow" ? undefined : scope === "all" ? allPaths : [scope],
      scope === "follow" ? followedSession : undefined,
    );
  }, [projectId, scope, followedSession]);
  const [overview, setOverview] = useState<GitOverview | null>(null);
  const [owners, setOwners] = useState<SessionCheckoutInfo[]>([]);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    void desktopApi
      .sessionCheckouts(projectId)
      .then((items) => {
        if (active) setOwners(items);
      })
      .catch(() => {
        if (active) setOwners([]);
      });
    return () => {
      active = false;
    };
  }, [projectId, visible]);
  const [error, setError] = useState<string | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  useSidebarRefresh(() => setRefreshVersion((value) => value + 1));
  // biome-ignore lint/correctness/useExhaustiveDependencies: explicit section refresh restarts its scoped read.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let running = false;
    let queued = false;
    let timer: number | undefined;
    let delay = REFRESH_MS;
    setOverview(null);
    setError(null);
    const load = async () => {
      if (running) {
        queued = true;
        return;
      }
      running = true;
      window.clearTimeout(timer);
      const started = performance.now();
      try {
        const next = await readOverview();
        if (!cancelled) {
          setOverview(next);
          setError(null);
          delay = Math.max(
            REFRESH_MS,
            Math.min(120_000, (performance.now() - started) * 20),
          );
        }
      } catch (reason) {
        delay = Math.min(120_000, delay * 2);
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
        } else if (!cancelled) {
          timer = window.setTimeout(() => {
            if (document.visibilityState !== "hidden" && document.hasFocus())
              void load();
          }, delay);
        }
      }
    };
    void load();
    const focus = () => {
      if (document.visibilityState !== "hidden") void load();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    const unsubscribe = desktopApi.onGitChanged((change) => {
      if (
        change.projectId === projectId &&
        document.visibilityState !== "hidden"
      )
        void load();
    });
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
      unsubscribe();
    };
  }, [projectId, readOverview, visible, refreshVersion]);
  if (searchItems)
    searchItems.current = async () => {
      const snapshot = await readOverview();
      if (snapshot.error) throw new Error(snapshot.error);
      const groups = await Promise.all(
        snapshot.worktrees
          .filter((tree) => tree.loaded !== false)
          .map(async (tree): Promise<PaletteItem[]> => {
            if (tree.error || tree.comparisonError)
              throw new Error(
                tree.error ?? tree.comparisonError ?? "Could not read changes.",
              );
            const entries = await Promise.all(
              [...tree.changes, ...tree.branchChanges].map(async (file) => {
                if (file.mode !== "untracked" || !file.path.endsWith("/"))
                  return { files: [file], truncated: false };
                return desktopApi.gitUntrackedDirectory({
                  projectId,
                  worktreePath: tree.path,
                  directory: file.path,
                });
              }),
            );
            const items: PaletteItem[] = entries
              .flatMap((entry) => entry.files)
              .map((file) => ({
                id: JSON.stringify([tree.path, file.mode, file.path]),
                icon: GitBranch,
                label: file.path,
                detail: `${tree.branch ?? "Detached HEAD"} · ${file.mode}`,
                keywords: [],
                kind: "navigate",
                run: (mode) =>
                  onOpenDiff(changeTab({ projectId, tree, file }), mode),
              }));
            if (entries.some((entry) => entry.truncated))
              items.push({
                id: `truncated:${tree.path}`,
                icon: GitBranch,
                label: "Some untracked folders have more files",
                detail:
                  "Showing the first 2,000 per folder. Use Files search to find more.",
                keywords: [],
                kind: "action",
                disabled: true,
                run: () => {},
              });
            return items;
          }),
      );
      return groups.flat();
    };
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
  useSidebarContent(
    error
      ? "error"
      : overview === null
        ? "loading"
        : isEmpty
          ? "empty"
          : "ready",
  );
  if (!overview && !error) return null;
  if (overview?.available === false)
    return <p className="sidebar-empty-state">Install git to see changes.</p>;
  return (
    <div className="flex flex-col gap-1" data-testid="git-changes">
      {preferencesError && (
        <p role="alert" className="px-2 text-xs text-danger">
          {preferencesError}
        </p>
      )}
      {(error || overview?.error) && (
        <p role="alert" className="break-words px-2 py-1 text-xs text-danger">
          {error ?? overview?.error}
        </p>
      )}
      <div className="flex flex-col gap-2 px-2 py-1">
        <select
          aria-label="Changes checkout"
          className="field min-w-0 rounded-md px-2 py-1 text-xs"
          value={scope}
          onChange={(event) => {
            setScope(event.target.value);
            localStorage.setItem(
              `changes-scope:${projectId}`,
              event.target.value,
            );
          }}
        >
          <option value="follow">Follow active chat</option>
          <option value="all">All checkouts</option>
          {overview?.worktrees.map((tree) => (
            <option key={tree.path} value={tree.path}>
              {tree.branch ?? "Detached HEAD"} · {tree.path}
            </option>
          ))}
        </select>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="text-xs text-fg-muted"
            onClick={() => {
              void update({ changesFileLayout: flat ? "tree" : "flat" });
            }}
          >
            {flat ? "Flat" : "Tree"}
          </button>
        </div>
      </div>
      {overview &&
        scope !== "follow" &&
        scope !== "all" &&
        !overview.worktrees.some((tree) => tree.path === scope) && (
          <p role="status" className="px-2 py-1 text-xs text-warning">
            The selected checkout is unavailable. Choose another checkout or
            follow the active chat.
          </p>
        )}
      {overview?.worktrees
        .filter((tree) => tree.loaded !== false)
        .map((tree) => (
          <WorktreeSection
            key={`${projectId}:${tree.path}`}
            tree={tree}
            flat={flat}
            sessionIds={owners
              .filter((owner) => owner.path === tree.path)
              .map((owner) => owner.sessionId)}
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
  sessionIds,
  flat,
  tree,
  projectId,
  onOpenDiff,
}: {
  tree: GitWorktree;
  sessionIds: string[];
  flat: boolean;
  projectId: string;
  onOpenDiff: (tab: WorkspaceTab, mode?: OpenMode) => void;
}) {
  const [open, setOpen] = useState(true);
  const [directories, setDirectories] = useState<
    Record<string, GitChangedFile[]>
  >({});
  const [directoryNotice, setDirectoryNotice] = useState<string | null>(null);
  const [loadingDirectory, setLoadingDirectory] = useState<string | null>(null);
  const contentId = useId();
  const branchFiles = tree.branchChanges;
  const count = new Set(
    [...tree.changes, ...tree.branchChanges].map((file) => file.path),
  ).size;
  const openFile = (file: GitChangedFile, mode?: OpenMode) => {
    if (file.mode === "untracked" && file.path.endsWith("/")) {
      if (loadingDirectory) return;
      setLoadingDirectory(file.path);
      setDirectoryNotice(null);
      void desktopApi
        .gitUntrackedDirectory({
          projectId,
          worktreePath: tree.path,
          directory: file.path,
        })
        .then((result) => {
          setDirectories((current) => ({
            ...current,
            [file.path]: result.files,
          }));
          if (result.truncated)
            setDirectoryNotice(
              "Showing the first 2,000 untracked files. Use Files search to find more.",
            );
        })
        .catch((error: unknown) =>
          setDirectoryNotice(
            error instanceof Error
              ? error.message
              : "Could not read this folder. Try again.",
          ),
        )
        .finally(() => setLoadingDirectory(null));
      return;
    }
    onOpenDiff(changeTab({ projectId, tree, file }), mode);
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
          {sessionIds.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 py-1">
              {sessionIds.map((id) => (
                <OpenResourceButton
                  key={id}
                  className="rounded bg-bg-overlay px-1.5 py-0.5 text-[10px] text-fg-muted"
                  onOpen={(mode) =>
                    onOpenDiff({ kind: "chat", name: id }, mode)
                  }
                >
                  Chat {id.slice(0, 6)}
                </OpenResourceButton>
              ))}
            </div>
          )}
          {tree.locked && (
            <p className="px-2 text-xs text-fg-faint">Locked: {tree.locked}</p>
          )}
          {tree.error && (
            <p role="alert" className="break-words px-2 text-xs text-danger">
              {tree.error}
            </p>
          )}
          {loadingDirectory && (
            <p role="status" className="px-2 text-xs text-fg-muted">
              Loading {loadingDirectory}…
            </p>
          )}
          {directoryNotice && (
            <p role="status" className="px-2 text-xs text-warning">
              {directoryNotice}
            </p>
          )}
          {Object.keys(directories).length > 0 && (
            <button
              type="button"
              className="px-2 py-1 text-left text-xs text-fg-muted hover:text-fg"
              onClick={() => {
                setDirectories({});
                setDirectoryNotice(
                  "Open an untracked folder to reload its files.",
                );
              }}
            >
              Reload untracked folders
            </button>
          )}
          {GROUPS.map((group) => {
            const files = tree.changes
              .filter((file) => file.mode === group.mode)
              .flatMap((file) => directories[file.path] ?? [file]);
            return (
              files.length > 0 && (
                <div key={group.mode} data-change-group={group.mode}>
                  <h5 className="px-2 pt-1 text-[11px] text-fg-faint">
                    {group.label} <span>{files.length}</span>
                  </h5>
                  <ChangeTree flat={flat} files={files} onOpen={openFile} />
                </div>
              )
            );
          })}
          {branchFiles.length > 0 && (
            <div data-change-group="branch">
              <h5 className="px-2 pt-1 text-[11px] text-fg-faint">
                Committed vs {tree.baseLabel}
              </h5>
              <ChangeTree flat={flat} files={branchFiles} onOpen={openFile} />
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
  flat,
  files,
  onOpen,
}: {
  flat: boolean;
  files: GitChangedFile[];
  onOpen: (file: GitChangedFile, mode?: OpenMode) => void;
}) {
  const rows: {
    id: string;
    parentId: string | null;
    name: string;
    file?: GitChangedFile;
    hasChildren: boolean;
  }[] = [];
  const visit = (node: ChangeTreeDir, parentId: string | null) => {
    for (const dir of node.dirs) {
      const id = `${parentId ?? ""}${dir.name}/`;
      rows.push({ id, parentId, name: dir.name, hasChildren: true });
      visit(dir, id);
    }
    for (const file of node.files)
      rows.push({
        id: file.path,
        parentId,
        name: file.path.split("/").filter(Boolean).at(-1) ?? file.path,
        file,
        hasChildren: false,
      });
  };
  if (flat)
    for (const file of files)
      rows.push({
        id: file.path,
        parentId: null,
        name: file.path,
        file,
        hasChildren: false,
      });
  else visit(buildChangeTree(files), null);
  return (
    <SidebarTree
      items={rows}
      label="Changed files"
      renderItem={(row, tree) => (
        <SidebarItemRow
          itemId={row.id}
          label={row.name}
          title={row.file?.path}
          icon={row.file ? "File" : "Folder"}
          style={{ marginLeft: tree.depth * 12 }}
          badges={row.file ? [KIND_BADGES[row.file.kind].letter] : undefined}
          disclosure={
            tree.hasChildren
              ? { open: tree.expanded, onToggle: tree.toggle }
              : undefined
          }
          resource={Boolean(row.file)}
          onOpen={(mode) => (row.file ? onOpen(row.file, mode) : tree.toggle())}
          onAction={() => {}}
        />
      )}
    />
  );
}

function changeTab({
  projectId,
  tree,
  file,
}: {
  projectId: string;
  tree: GitWorktree;
  file: GitChangedFile;
}): WorkspaceTab {
  const label =
    file.mode === "branch"
      ? `vs ${tree.baseLabel}`
      : (GROUPS.find((group) => group.mode === file.mode)?.label ?? file.mode);
  const checkout = tree.branch ?? "Detached HEAD";
  return {
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
  };
}
