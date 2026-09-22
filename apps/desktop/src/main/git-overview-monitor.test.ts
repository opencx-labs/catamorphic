import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOverview } from "../shared/git.js";
import { GitOverviewMonitor, walkedWatch } from "./git-overview-monitor.js";
import { gitOverview, readGit } from "./git-view.js";

const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
let temp: string;
let root: string;
const monitors: GitOverviewMonitor[] = [];
// A scan is followed by a cooldown of four times its duration; on a loaded
// machine (the full suite) that outlasts vi.waitFor's one-second default.
const waitFor = <T>(callback: () => T | Promise<T>) =>
  vi.waitFor(callback, { timeout: 8_000 });
const commit = async (folder: string, message: string) => {
  await readGit(folder, ["add", "-A"]);
  await readGit(folder, [...author, "commit", "-m", message]);
};
const observe = (monitor: GitOverviewMonitor, paths?: string[] | "all") => {
  const snapshots: GitOverview[] = [];
  const stop = monitor.subscribe({
    root,
    paths,
    listener: (snapshot) => snapshots.push(snapshot),
  });
  return { snapshots, stop, current: () => snapshots.at(-1) };
};
const makeMonitor = (
  options: ConstructorParameters<typeof GitOverviewMonitor>[0] = {},
) => {
  const monitor = new GitOverviewMonitor(options);
  monitors.push(monitor);
  return monitor;
};
beforeEach(async () => {
  temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "git-monitor-")),
  );
  root = path.join(temp, "primary");
  await fs.mkdir(root);
  await readGit(root, ["init", "-b", "main"]);
  await fs.writeFile(path.join(root, "notes.txt"), "initial\n");
  await fs.writeFile(path.join(root, ".gitignore"), "node_modules/\ndist/\n");
  await commit(root, "initial");
});
afterEach(async () => {
  for (const monitor of monitors.splice(0)) monitor.dispose();
  await fs.rm(temp, { recursive: true, force: true });
});

describe("walkedWatch", () => {
  it("watches only directories Git reports on and names events from the root", async () => {
    for (const dir of ["src/lib", "node_modules/pkg/dist", ".git/objects/ab"])
      await fs.mkdir(path.join(root, dir), { recursive: true });
    await fs.symlink(path.join(temp), path.join(root, "link"));
    const watched: string[] = [];
    const callbacks = new Map<
      string,
      (event: string, name: string | null) => void
    >();
    const closed: string[] = [];
    const events: Array<[string | null, string | undefined]> = [];
    const close = walkedWatch(
      root,
      (name, event) => events.push([name, event]),
      () => {},
      (relative) => relative === ".git" || relative.startsWith("node_modules"),
      ((target: string, _options: unknown, listener: unknown) => {
        const relative = path.relative(root, target) || ".";
        watched.push(relative);
        callbacks.set(
          relative,
          listener as (e: string, n: string | null) => void,
        );
        return {
          on() {},
          close: () => closed.push(relative),
        };
      }) as unknown as typeof import("node:fs").watch,
    );
    expect(watched.sort()).toEqual([".", "src", "src/lib"]);
    callbacks.get("src/lib")?.("rename", "util.ts");
    callbacks.get(".")?.("change", "notes.txt");
    expect(events).toEqual([
      ["src/lib/util.ts", "rename"],
      ["notes.txt", "change"],
    ]);
    close();
    expect(closed.sort()).toEqual([".", "src", "src/lib"]);
  });
});

describe("observed Git overviews", () => {
  it("observes external edit, atomic save, stage, rename, deletion and commit", async () => {
    const view = observe(makeMonitor());
    await waitFor(() => expect(view.current()?.worktrees).toHaveLength(1));
    await fs.writeFile(path.join(root, "notes.tmp"), "atomic edit\n");
    await fs.rename(path.join(root, "notes.tmp"), path.join(root, "notes.txt"));
    await waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes).toEqual([
        { path: "notes.txt", mode: "unstaged", kind: "modified" },
      ]),
    );
    await readGit(root, ["add", "notes.txt"]);
    await waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes[0]?.mode).toBe("staged"),
    );
    await commit(root, "edit");
    await waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes).toEqual([]),
    );
    await readGit(root, ["mv", "notes.txt", "renamed.txt"]);
    await waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes[0]).toMatchObject({
        path: "renamed.txt",
        kind: "renamed",
      }),
    );
    await fs.rm(path.join(root, "renamed.txt"));
    await waitFor(() =>
      expect(
        view
          .current()
          ?.worktrees[0]?.changes.some(
            (file) => file.mode === "unstaged" && file.kind === "deleted",
          ),
      ).toBe(true),
    );
  });

  it("watches linked worktrees and shared base refs without scanning unrelated checkouts", async () => {
    const linked = path.join(temp, "feature");
    await readGit(root, ["worktree", "add", "-b", "feature", linked]);
    await fs.writeFile(path.join(linked, "feature.txt"), "feature\n");
    await commit(linked, "feature");
    const view = observe(makeMonitor(), [linked]);
    await waitFor(() =>
      expect(
        view.current()?.worktrees.find((tree) => tree.path === linked)
          ?.branchChanges,
      ).toHaveLength(1),
    );
    expect(
      view.current()?.worktrees.find((tree) => tree.path === root)?.loaded,
    ).toBe(false);
    const head = (await readGit(linked, ["rev-parse", "HEAD"])).trim();
    await readGit(root, ["update-ref", "refs/heads/main", head]);
    await waitFor(() =>
      expect(
        view.current()?.worktrees.find((tree) => tree.path === linked)
          ?.branchChanges,
      ).toHaveLength(0),
    );
    await fs.writeFile(path.join(linked, "new.txt"), "new\n");
    await waitFor(() =>
      expect(
        view
          .current()
          ?.worktrees.find((tree) => tree.path === linked)
          ?.changes.some((file) => file.path === "new.txt"),
      ).toBe(true),
    );
  });

  it("coalesces bursts, skips ignored output, and preserves tracked files under ignored directories", async () => {
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist/tracked.js"), "tracked");
    await readGit(root, ["add", "-f", "dist/tracked.js"]);
    await readGit(root, [...author, "commit", "-m", "tracked build"]);
    const callbacks = new Map<string, (name: string | null) => void>();
    const read = vi.fn(gitOverview);
    const monitor = makeMonitor({
      read,
      watch: (dir, listener) => {
        callbacks.set(dir, listener);
        return () => callbacks.delete(dir);
      },
    });
    const view = observe(monitor);
    await waitFor(() => expect(view.current()).toBeDefined());
    read.mockClear();
    for (let i = 0; i < 100; i++) callbacks.get(root)?.("notes.txt");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    // Give the completed refresh time to settle without depending on arbitrary sleeps.
    await read.mock.results[0]?.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
    read.mockClear();
    for (let i = 0; i < 100; i++)
      callbacks.get(root)?.(`node_modules/file-${i}.js`);
    // Existing ignored directories are enumerated at watcher setup.
    await fs.writeFile(path.join(root, "dist/tracked.js"), "changed");
    callbacks.get(root)?.("dist/tracked.js");
    await waitFor(() =>
      expect(
        view
          .current()
          ?.worktrees[0]?.changes.some(
            (file) => file.path === "dist/tracked.js",
          ),
      ).toBe(true),
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("scans at most about a fifth of the time under sustained writes", async () => {
    const callbacks = new Map<
      string,
      (name: string | null, event?: string) => void
    >();
    const read = vi.fn(async (...args: Parameters<typeof gitOverview>) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return gitOverview(...args);
    });
    const monitor = makeMonitor({
      read,
      watch: (dir, listener) => {
        callbacks.set(dir, listener);
        return () => callbacks.delete(dir);
      },
    });
    const view = observe(monitor);
    await waitFor(() => expect(view.current()).toBeDefined());
    await new Promise((resolve) => setTimeout(resolve, 450));
    read.mockClear();
    // A save every 50 ms for 1.5 s: slower than any single debounce would
    // coalesce, faster than a 100 ms scan plus its 400 ms cooldown.
    const started = Date.now();
    while (Date.now() - started < 1500) {
      callbacks.get(root)?.("notes.txt", "rename");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
    const scans = read.mock.calls.filter(
      (call) => call[1] === undefined,
    ).length;
    // 30 saves: 30 scans unthrottled, about 4 with a 100 ms scan and its
    // 400 ms cooldown. A loaded machine scans slower and cools longer.
    expect(scans).toBeGreaterThanOrEqual(1);
    expect(scans).toBeLessThanOrEqual(5);
  });

  it("rebuilds watches for new directories and .gitignore, not for atomic saves", async () => {
    const callbacks = new Map<
      string,
      (name: string | null, event?: string) => void
    >();
    const read = vi.fn(gitOverview);
    const monitor = makeMonitor({
      read,
      watch: (dir, listener) => {
        callbacks.set(dir, listener);
        return () => callbacks.delete(dir);
      },
    });
    const view = observe(monitor);
    await waitFor(() => expect(view.current()).toBeDefined());
    // Wait out the scan and its cooldown so the next event starts a cycle.
    const settle = async () => {
      const started = Date.now();
      await Promise.all(read.mock.results.map((result) => result.value));
      await new Promise<void>((resolve) =>
        setTimeout(resolve, 4 * (Date.now() - started) + 50),
      );
      read.mockClear();
    };
    await settle();
    // An editor's save: temp file renamed over the original. One read, no
    // discovery pass.
    callbacks.get(root)?.("notes.txt.tmp", "rename");
    callbacks.get(root)?.("notes.txt", "rename");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    expect(read.mock.calls[0]?.[1]).not.toEqual([]);
    await settle();
    // A new directory (`npm install` starting): discovery re-reads what Git
    // ignores before the plain read.
    await fs.mkdir(path.join(root, "node_modules"));
    callbacks.get(root)?.("node_modules", "rename");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls[0]?.[1]).toEqual([]);
    await settle();
    callbacks.get(root)?.(".gitignore", "change");
    await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
    expect(read.mock.calls[0]?.[1]).toEqual([]);
  });

  it("shares watches and snapshots, releases the last consumer, and ignores late completions", async () => {
    const close = vi.fn();
    const watch = vi.fn(() => close);
    const read = vi.fn(gitOverview);
    const monitor = makeMonitor({ read, watch });
    const first = observe(monitor);
    const second = observe(monitor);
    await waitFor(() => expect(second.current()).toBeDefined());
    expect(watch).toHaveBeenCalledTimes(2); // Worktree and actual Git directory.
    expect(first.current()).toBe(second.current());
    first.stop();
    expect(close).not.toHaveBeenCalled();
    second.stop();
    expect(close).toHaveBeenCalledTimes(2);
    let finish: ((snapshot: GitOverview) => void) | undefined;
    const blocked = makeMonitor({
      read: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      watch,
    });
    const pending = observe(blocked);
    pending.stop();
    finish?.({ available: true, worktrees: [] });
    await Promise.resolve();
    expect(pending.snapshots).toEqual([]);
    expect(watch).toHaveBeenCalledTimes(2);
  });

  it("reconciles missed events and recovers a replaced working directory", async () => {
    const monitor = makeMonitor({ reconcileMs: 300, watch: () => () => {} });
    const view = observe(monitor);
    await waitFor(() => expect(view.current()?.worktrees).toHaveLength(1));
    await fs.rename(root, `${root}-old`);
    await fs.cp(`${root}-old`, root, { recursive: true });
    await fs.writeFile(path.join(root, "notes.txt"), "replaced\n");
    await waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes[0]?.path).toBe("notes.txt"),
    );
  });

  it("observes Git initialized after opening a plain folder", async () => {
    await fs.rm(path.join(root, ".git"), { recursive: true });
    const view = observe(makeMonitor());
    await waitFor(() => expect(view.current()?.worktrees).toEqual([]));
    await readGit(root, ["init", "-b", "main"]);
    await waitFor(() =>
      expect(
        view
          .current()
          ?.worktrees[0]?.changes.some((file) => file.path === "notes.txt"),
      ).toBe(true),
    );
  });
});
