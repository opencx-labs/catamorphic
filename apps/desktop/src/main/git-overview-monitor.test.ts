import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitOverview } from "../shared/git.js";
import { GitOverviewMonitor } from "./git-overview-monitor.js";
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

describe("observed Git overviews", () => {
  it("observes external edit, atomic save, stage, rename, deletion and commit", async () => {
    const view = observe(makeMonitor());
    await vi.waitFor(() => expect(view.current()?.worktrees).toHaveLength(1));
    await fs.writeFile(path.join(root, "notes.tmp"), "atomic edit\n");
    await fs.rename(path.join(root, "notes.tmp"), path.join(root, "notes.txt"));
    await vi.waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes).toEqual([
        { path: "notes.txt", mode: "unstaged", kind: "modified" },
      ]),
    );
    await readGit(root, ["add", "notes.txt"]);
    await vi.waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes[0]?.mode).toBe("staged"),
    );
    await commit(root, "edit");
    await vi.waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes).toEqual([]),
    );
    await readGit(root, ["mv", "notes.txt", "renamed.txt"]);
    await vi.waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes[0]).toMatchObject({
        path: "renamed.txt",
        kind: "renamed",
      }),
    );
    await fs.rm(path.join(root, "renamed.txt"));
    await vi.waitFor(() =>
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
    await vi.waitFor(() =>
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
    await vi.waitFor(() =>
      expect(
        view.current()?.worktrees.find((tree) => tree.path === linked)
          ?.branchChanges,
      ).toHaveLength(0),
    );
    await fs.writeFile(path.join(linked, "new.txt"), "new\n");
    await vi.waitFor(() =>
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
    await vi.waitFor(() => expect(view.current()).toBeDefined());
    read.mockClear();
    for (let i = 0; i < 100; i++) callbacks.get(root)?.("notes.txt");
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
    // Give the completed refresh time to settle without depending on arbitrary sleeps.
    await read.mock.results[0]?.value;
    await new Promise<void>((resolve) => setImmediate(resolve));
    read.mockClear();
    for (let i = 0; i < 100; i++)
      callbacks.get(root)?.(`node_modules/file-${i}.js`);
    // Existing ignored directories are enumerated at watcher setup.
    await fs.writeFile(path.join(root, "dist/tracked.js"), "changed");
    callbacks.get(root)?.("dist/tracked.js");
    await vi.waitFor(() =>
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

  it("shares watches and snapshots, releases the last consumer, and ignores late completions", async () => {
    const close = vi.fn();
    const watch = vi.fn(() => close);
    const read = vi.fn(gitOverview);
    const monitor = makeMonitor({ read, watch });
    const first = observe(monitor);
    const second = observe(monitor);
    await vi.waitFor(() => expect(second.current()).toBeDefined());
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
    await vi.waitFor(() => expect(view.current()?.worktrees).toHaveLength(1));
    await fs.rename(root, `${root}-old`);
    await fs.cp(`${root}-old`, root, { recursive: true });
    await fs.writeFile(path.join(root, "notes.txt"), "replaced\n");
    await vi.waitFor(() =>
      expect(view.current()?.worktrees[0]?.changes[0]?.path).toBe("notes.txt"),
    );
  });

  it("observes Git initialized after opening a plain folder", async () => {
    await fs.rm(path.join(root, ".git"), { recursive: true });
    const view = observe(makeMonitor());
    await vi.waitFor(() => expect(view.current()?.worktrees).toEqual([]));
    await readGit(root, ["init", "-b", "main"]);
    await vi.waitFor(() =>
      expect(
        view
          .current()
          ?.worktrees[0]?.changes.some((file) => file.path === "notes.txt"),
      ).toBe(true),
    );
  });
});
