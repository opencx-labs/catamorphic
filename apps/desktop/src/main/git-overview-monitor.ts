import {
  type Dirent,
  type FSWatcher,
  readdirSync,
  statSync,
  watch,
} from "node:fs";
import path from "node:path";
import type { GitOverview } from "../shared/git.js";
import { type GitComparisonCache, gitOverview, readGit } from "./git-view.js";

const RECONCILE_MS = 120_000;
const DEBOUNCE_MS = 200;
const MAX_WAIT_MS = 1_000;
/** After a scan, wait this many times its duration before the next. */
const COOLDOWN_FACTOR = 4;
const COOLDOWN_MAX_MS = 5_000;

type Listener = (snapshot: GitOverview) => void;
/** Names reach the listener relative to `directory`, `/`-separated. */
type Watch = (
  directory: string,
  listener: (name: string | null, event?: string) => void,
  failed: () => void,
  /** Subtrees not worth watching, relative to `directory`. */
  skip: (relative: string) => boolean,
) => () => void;

function nativeWatch(
  directory: string,
  listener: (name: string | null, event?: string) => void,
  failed: () => void,
  skip: (relative: string) => boolean,
) {
  // Linux has no recursive watch primitive: Node walks the tree and takes
  // one inotify watch per directory, ignored trees included. A monorepo
  // has tens of thousands of those (node_modules) against a per-user budget
  // that can be 8192, and the walk itself takes seconds. macOS (FSEvents)
  // and Windows watch a tree with one handle, so they keep the native path.
  if (process.platform === "linux")
    return walkedWatch(directory, listener, failed, skip);
  let watcher: FSWatcher;
  try {
    watcher = watch(
      directory,
      { recursive: true, persistent: false },
      (event, name) => listener(name?.split(path.sep).join("/") ?? null, event),
    );
    watcher.on("error", () => {
      watcher.close();
      failed();
    });
    return () => watcher.close();
  } catch {
    failed();
    return () => {};
  }
}

/**
 * Recursive watch built from single-directory watches, visiting only the
 * directories Git would report on. A directory appearing later reaches the
 * listener as a rename in its parent; the monitor rebuilds the watches then.
 */
export function walkedWatch(
  directory: string,
  listener: (name: string | null, event?: string) => void,
  failed: () => void,
  skip: (relative: string) => boolean,
  watchOne: typeof watch = watch,
): () => void {
  const watchers: FSWatcher[] = [];
  let closed = false;
  const close = () => {
    closed = true;
    for (const watcher of watchers.splice(0)) watcher.close();
  };
  const fail = () => {
    if (closed) return;
    close();
    failed();
  };
  const visit = (relative: string) => {
    const absolute = relative ? path.join(directory, relative) : directory;
    let watcher: FSWatcher;
    try {
      watcher = watchOne(absolute, { persistent: false }, (event, name) =>
        listener(
          name === null
            ? relative || null
            : `${relative ? `${relative}/` : ""}${String(name)}`,
          event,
        ),
      );
    } catch {
      if (!relative) fail(); // The root itself: give up, the fallback retries.
      return;
    }
    watcher.on("error", fail);
    watchers.push(watcher);
    let entries: Dirent[];
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue; // Symlinked trees stay unwatched.
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      if (!skip(child)) visit(child);
    }
  };
  visit("");
  return close;
}

function isDirectory(target: string): boolean {
  try {
    return statSync(target).isDirectory();
  } catch {
    return false; // Gone: nothing new to ignore.
  }
}

/** Watcher events are hints. Only Git defines status, ignored files and committed diffs. */
export class GitOverviewMonitor {
  private readonly entries = new Map<string, Entry>();
  private readonly watchers = new Map<
    string,
    {
      listeners: Set<(name: string | null, event?: string) => void>;
      close: () => void;
    }
  >();
  constructor(
    private readonly options: {
      watch?: Watch;
      reconcileMs?: number;
      read?: typeof gitOverview;
    } = {},
  ) {}

  subscribe({
    root,
    paths,
    listener,
  }: {
    root: string;
    paths?: string[] | "all";
    listener: Listener;
  }): () => void {
    const key = JSON.stringify([
      root,
      paths === "all" ? paths : paths && [...new Set(paths)].sort(),
    ]);
    let entry = this.entries.get(key);
    const created = !entry;
    if (!entry) {
      entry = new Entry({
        root,
        paths,
        read: this.options.read ?? gitOverview,
        watch: (directory, listener, skip) =>
          this.watch(directory, listener, skip),
        reconcileMs: this.options.reconcileMs ?? RECONCILE_MS,
      });
      this.entries.set(key, entry);
    }
    entry.listeners.add(listener);
    if (entry.snapshot) listener(entry.snapshot);
    else if (created) entry.refresh();
    const retained = entry;
    return () => {
      retained.listeners.delete(listener);
      if (!retained.listeners.size) {
        retained.dispose();
        if (this.entries.get(key) === retained) this.entries.delete(key);
      }
    };
  }

  private watch(
    directory: string,
    listener: (name: string | null, event?: string) => void,
    skip: (relative: string) => boolean,
  ): () => void {
    // Replacing a directory changes its inode; never reuse a watch on the old tree.
    let identity = directory;
    try {
      const stat = statSync(directory);
      identity += `:${stat.dev}:${stat.ino}`;
    } catch {
      /* Fallback retries missing paths. */
    }
    let entry = this.watchers.get(identity);
    if (!entry) {
      const listeners = new Set<
        (name: string | null, event?: string) => void
      >();
      const emit = (name: string | null, event?: string) => {
        for (const callback of listeners) callback(name, event);
      };
      entry = { listeners, close: () => {} };
      this.watchers.set(identity, entry);
      entry.close = (this.options.watch ?? nativeWatch)(
        directory,
        emit,
        () => {
          this.watchers.delete(identity);
          emit(null);
        },
        skip,
      );
    }
    entry.listeners.add(listener);
    const retained = entry;
    return () => {
      retained.listeners.delete(listener);
      if (!retained.listeners.size) {
        retained.close();
        if (this.watchers.get(identity) === retained)
          this.watchers.delete(identity);
      }
    };
  }

  dispose(): void {
    for (const entry of this.entries.values()) entry.dispose();
    this.entries.clear();
  }
}

class Entry {
  readonly listeners = new Set<Listener>();
  snapshot?: GitOverview;
  private readonly comparisons: GitComparisonCache = new Map();
  private release: Array<() => void> = [];
  private timer?: ReturnType<typeof setTimeout>;
  private debounce?: ReturnType<typeof setTimeout>;
  private deadline?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private running = false;
  private dirty = false;
  private fingerprint = "";
  // Sustained writes (an agent editing) arrive slower than the debounce and
  // would scan once per save. Scanning stays under ~1/5 of wall time.
  private cooldownUntil = 0;
  private rebuildWatches = true;
  private topology = "";

  constructor(
    private readonly options: {
      root: string;
      paths?: string[] | "all";
      watch: (
        directory: string,
        listener: (name: string | null, event?: string) => void,
        skip: (relative: string) => boolean,
      ) => () => void;
      read: typeof gitOverview;
      reconcileMs: number;
    },
  ) {}

  refresh = (): void => {
    if (this.disposed) return;
    clearTimeout(this.debounce);
    clearTimeout(this.deadline);
    this.debounce = undefined;
    this.deadline = undefined;
    if (this.running) {
      this.dirty = true;
      return;
    }
    const cooldown = this.cooldownUntil - Date.now();
    if (cooldown > 0) {
      this.debounce = setTimeout(this.refresh, cooldown);
      return;
    }
    void this.load();
  };

  private invalidate = (): void => {
    if (this.disposed) return;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(this.refresh, DEBOUNCE_MS);
    this.deadline ??= setTimeout(this.refresh, MAX_WAIT_MS);
  };

  private async load(): Promise<void> {
    this.running = true;
    clearTimeout(this.timer);
    const started = Date.now();
    try {
      // Retain the old watches until replacements are installed: no gap during a scan.
      const discovery =
        this.rebuildWatches || this.options.paths === "all"
          ? await this.options.read(this.options.root, [])
          : undefined;
      const requested =
        this.options.paths === "all"
          ? (discovery?.worktrees.map((tree) => tree.path) ?? [])
          : this.options.paths;
      if (discovery) {
        await this.rewatch({
          ...discovery,
          worktrees: discovery.worktrees.map((tree) => ({
            ...tree,
            loaded: requested ? requested.includes(tree.path) : tree.isCurrent,
          })),
        });
      }
      if (this.disposed) return;
      const next = await this.options.read(
        this.options.root,
        requested,
        this.comparisons,
      );
      if (this.disposed) return;
      await this.rewatch(next);
      if (this.disposed) return;
      const fingerprint = JSON.stringify(next);
      this.snapshot = next;
      if (fingerprint !== this.fingerprint) {
        this.fingerprint = fingerprint;
        for (const listener of this.listeners) listener(next);
      }
    } catch (error) {
      if (!this.disposed) {
        const snapshot = {
          ...this.snapshot,
          available: this.snapshot?.available ?? true,
          worktrees: this.snapshot?.worktrees ?? [],
          error: error instanceof Error ? error.message : String(error),
        };
        this.snapshot = snapshot;
        this.fingerprint = "";
        for (const listener of this.listeners) listener(snapshot);
      }
    } finally {
      this.running = false;
      this.cooldownUntil =
        Date.now() +
        Math.min(COOLDOWN_MAX_MS, COOLDOWN_FACTOR * (Date.now() - started));
      if (!this.disposed) {
        if (this.dirty) {
          this.dirty = false;
          this.invalidate();
        }
        this.timer = setTimeout(() => {
          this.rebuildWatches = true;
          this.refresh();
        }, this.options.reconcileMs);
        this.timer.unref?.();
      }
    }
  }

  private async rewatch(snapshot: GitOverview): Promise<void> {
    const releases: Array<() => void> = [];
    const roots = snapshot.worktrees
      .filter((tree) => tree.loaded && !tree.prunable)
      .map((tree) => tree.path);
    if (!roots.length) roots.push(this.options.root); // Plain folder: notice later git init.
    const topology = JSON.stringify(roots);
    if (!this.rebuildWatches && topology === this.topology) return;
    this.topology = topology;
    this.rebuildWatches = false;
    const metadata = new Set<string>();
    for (const root of roots) {
      let ignored: string[] = [];
      try {
        const directories = (
          await readGit(root, [
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
          ])
        )
          .trim()
          .split("\n");
        for (const directory of directories) metadata.add(directory);
        // Ask Git, rather than guessing that dist/ or node_modules/ cannot be tracked.
        ignored = (
          await readGit(root, [
            "ls-files",
            "--others",
            "--ignored",
            "--exclude-standard",
            "--directory",
            "-z",
          ])
        )
          .split("\0")
          .filter(Boolean);
      } catch {
        /* A removed/plain checkout is retried by reconciliation. */
      }
      if (this.disposed) break;
      const isIgnored = (relative: string) =>
        ignored.some((item) =>
          item.endsWith("/")
            ? relative === item.slice(0, -1) || relative.startsWith(item)
            : relative === item,
        );
      releases.push(
        this.options.watch(
          root,
          (name, event) => {
            if (name === null) {
              this.rebuildWatches = true;
              this.invalidate();
              return;
            }
            const relative = name;
            if (relative === ".git") {
              this.rebuildWatches = true;
              this.invalidate();
              return;
            }
            if (relative.startsWith(".git/")) return;
            if (relative === ".gitignore" || relative.endsWith("/.gitignore"))
              this.rebuildWatches = true;
            if (isIgnored(relative)) return;
            // Editors save atomically (write a temp file, rename it over the
            // original), so file renames are the common case and never change
            // what is ignored. Directories can: a fresh node_modules/ must be
            // filtered before its contents flood the queue.
            if (event === "rename" && isDirectory(path.join(root, name)))
              this.rebuildWatches = true;
            this.invalidate();
          },
          (relative) => relative === ".git" || isIgnored(relative),
        ),
      );
    }
    if (!this.disposed)
      for (const directory of metadata) {
        releases.push(
          this.options.watch(
            directory,
            (name) => {
              const relative = name ?? undefined;
              if (
                relative?.endsWith(".lock") ||
                relative?.startsWith("objects/") ||
                relative?.startsWith("logs/")
              )
                return;
              if (
                relative === "config" ||
                relative?.startsWith("info/") ||
                relative?.startsWith("worktrees/")
              )
                this.rebuildWatches = true;
              this.invalidate();
            },
            // Object and reflog churn is filtered above; not worth watches.
            (relative) => relative === "objects" || relative === "logs",
          ),
        );
      }
    for (const release of this.release) release();
    this.release = releases;
    if (this.disposed) {
      for (const release of this.release) release();
      this.release = [];
    }
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    clearTimeout(this.debounce);
    clearTimeout(this.deadline);
    for (const release of this.release) release();
    this.release = [];
    this.comparisons.clear();
  }
}
