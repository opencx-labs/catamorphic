import { type FSWatcher, statSync, watch } from "node:fs";
import path from "node:path";
import type { GitOverview } from "../shared/git.js";
import { type GitComparisonCache, gitOverview, readGit } from "./git-view.js";

const RECONCILE_MS = 120_000;
const DEBOUNCE_MS = 200;
const MAX_WAIT_MS = 1_000;

type Listener = (snapshot: GitOverview) => void;
type Watch = (
  directory: string,
  listener: (name: string | null, event?: string) => void,
  failed: () => void,
) => () => void;

function nativeWatch(
  directory: string,
  listener: (name: string | null, event?: string) => void,
  failed: () => void,
) {
  let watcher: FSWatcher;
  try {
    watcher = watch(
      directory,
      { recursive: true, persistent: false },
      (event, name) => listener(name, event),
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
        watch: (directory, listener) => this.watch(directory, listener),
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
      entry.close = (this.options.watch ?? nativeWatch)(directory, emit, () => {
        this.watchers.delete(identity);
        emit(null);
      });
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
  private rebuildWatches = true;
  private topology = "";

  constructor(
    private readonly options: {
      root: string;
      paths?: string[] | "all";
      watch: (
        directory: string,
        listener: (name: string | null, event?: string) => void,
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
      releases.push(
        this.options.watch(root, (name, event) => {
          if (name === null) {
            this.rebuildWatches = true;
            this.invalidate();
            return;
          }
          const relative = name.split(path.sep).join("/");
          if (relative === ".git") {
            this.rebuildWatches = true;
            this.invalidate();
            return;
          }
          if (relative.startsWith(".git/")) return;
          if (relative === ".gitignore" || relative.endsWith("/.gitignore"))
            this.rebuildWatches = true;
          if (
            ignored.some((item) =>
              item.endsWith("/")
                ? relative === item.slice(0, -1) || relative.startsWith(item)
                : relative === item,
            )
          )
            return;
          if (event === "rename") this.rebuildWatches = true;
          this.invalidate();
        }),
      );
    }
    if (!this.disposed)
      for (const directory of metadata) {
        releases.push(
          this.options.watch(directory, (name) => {
            const relative = name?.split(path.sep).join("/");
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
          }),
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
