import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitFileDiff, gitOverview, listWorktreePaths } from "./git-view.js";

const author = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
describe("worktree Git views", () => {
  let temp: string;
  let root: string;
  const commit = async (cwd: string, message: string) => {
    await nativeGit(cwd, ["add", "-A"]);
    await nativeGit(cwd, [...author, "commit", "-m", message]);
  };
  beforeEach(async () => {
    temp = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "git-view-")),
    );
    root = path.join(temp, "primary");
    await fs.mkdir(root);
    await nativeGit(root, ["init", "-b", "trunk"]);
    await fs.writeFile(path.join(root, "notes.txt"), "original\n");
    await commit(root, "initial");
  });
  afterEach(async () => {
    await fs.rm(temp, { recursive: true, force: true });
  });

  it("separates index, working files and committed branch diffs in every checkout without altering Git state", async () => {
    const tree = path.join(temp, 'feature "quoted"\ncheckout');
    await nativeGit(root, ["worktree", "add", "-b", "feature", tree]);
    await fs.writeFile(path.join(tree, "notes.txt"), "committed\n");
    await commit(tree, "feature");
    await fs.writeFile(path.join(tree, "notes.txt"), "staged\n");
    await nativeGit(tree, ["add", "notes.txt"]);
    await fs.writeFile(path.join(tree, "notes.txt"), "working\n");
    await fs.writeFile(path.join(root, "primary.txt"), "primary only");
    const indexPath = path.resolve(
      tree,
      (await nativeGit(tree, ["rev-parse", "--git-path", "index"])).trim(),
    );
    const index = await fs.readFile(indexPath);
    const refs = await nativeGit(root, ["show-ref"]);
    const overview = await gitOverview(tree);
    expect(overview.worktrees).toHaveLength(2);
    const linked = overview.worktrees.find((item) => item.path === tree)!;
    expect(linked.isCurrent).toBe(true);
    expect(linked.baseLabel).toBe("trunk");
    expect(linked.changes.map((file) => file.mode)).toEqual([
      "staged",
      "unstaged",
    ]);
    expect(linked.branchChanges).toEqual([
      { path: "notes.txt", mode: "branch", kind: "modified" },
    ]);
    expect(await listWorktreePaths(root)).toContain(tree);
    const input = { worktreePath: tree, filePath: "notes.txt" };
    expect(await gitFileDiff({ ...input, mode: "staged" })).toMatchObject({
      before: "committed\n",
      after: "staged\n",
    });
    expect(await gitFileDiff({ ...input, mode: "unstaged" })).toMatchObject({
      before: "staged\n",
      after: "working\n",
    });
    expect(
      await gitFileDiff({ ...input, mode: "branch", baseRef: linked.baseRef }),
    ).toMatchObject({ before: "original\n", after: "committed\n" });
    expect(await fs.readFile(indexPath)).toEqual(index);
    expect(await nativeGit(root, ["show-ref"])).toBe(refs);
  });

  it("uses the remote default branch and shows branch changes in the primary checkout too", async () => {
    const head = (await nativeGit(root, ["rev-parse", "HEAD"])).trim();
    await nativeGit(root, [
      "update-ref",
      "refs/remotes/upstream/release",
      head,
    ]);
    await nativeGit(root, [
      "symbolic-ref",
      "refs/remotes/upstream/HEAD",
      "refs/remotes/upstream/release",
    ]);
    await nativeGit(root, ["config", "branch.trunk.remote", "upstream"]);
    await fs.writeFile(path.join(root, "notes.txt"), "new commit");
    await commit(root, "change");
    const tree = (await gitOverview(root)).worktrees[0]!;
    expect(tree.baseLabel).toBe("upstream/release");
    expect(tree.branchChanges).toHaveLength(1);
  });

  it("keeps rename originals, literal pathspec characters, deletions and tracked build files", async () => {
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist/tracked.js"), "tracked");
    await commit(root, "dist");
    const renamed = "renamed [x]\nnotes.txt";
    await nativeGit(root, ["mv", "notes.txt", renamed]);
    await fs.writeFile(path.join(root, "dist/tracked.js"), "changed");
    const tree = (await gitOverview(root)).worktrees[0]!;
    const rename = tree.changes.find((file) => file.kind === "renamed")!;
    expect(rename.previousPath).toBe("notes.txt");
    expect(
      await gitFileDiff({
        worktreePath: root,
        filePath: renamed,
        mode: "staged",
        previousPath: rename.previousPath,
      }),
    ).toMatchObject({
      before: "original\n",
      after: "original\n",
      notice: "Renamed from notes.txt",
    });
    expect(tree.changes.some((file) => file.path === "dist/tracked.js")).toBe(
      true,
    );
    await nativeGit(root, [...author, "commit", "-m", "rename"]);
    const refreshed = await gitFileDiff({
      worktreePath: root,
      filePath: renamed,
      mode: "staged",
      previousPath: "notes.txt",
    });
    expect(refreshed.before).toBe(refreshed.after);
    expect(refreshed.notice).toBeUndefined();

    await fs.rm(path.join(root, "dist/tracked.js"));
    expect(
      await gitFileDiff({
        worktreePath: root,
        filePath: "dist/tracked.js",
        mode: "unstaged",
      }),
    ).toMatchObject({ before: "tracked", after: "" });
  });

  it("shows detached, locked, missing and conflicted worktrees honestly", async () => {
    const detached = path.join(temp, "detached");
    const missing = path.join(temp, "missing");
    await nativeGit(root, ["worktree", "add", "--detach", detached]);
    await nativeGit(root, ["worktree", "lock", "--reason", "In use", detached]);
    await nativeGit(root, ["worktree", "add", "-b", "gone", missing]);
    await fs.rm(missing, { recursive: true });
    await nativeGit(root, ["switch", "-c", "other"]);
    await fs.writeFile(path.join(root, "notes.txt"), "theirs");
    await commit(root, "other");
    await nativeGit(root, ["switch", "trunk"]);
    await fs.writeFile(path.join(root, "notes.txt"), "ours");
    await commit(root, "ours");
    await nativeGit(root, [...author, "merge", "other"]).catch(() => {});
    const overview = await gitOverview(root);
    expect(
      overview.worktrees.find((tree) => tree.path === detached),
    ).toMatchObject({ branch: null, locked: "In use" });
    expect(
      overview.worktrees.find((tree) => tree.path === missing)?.error,
    ).toBeTruthy();
    expect(overview.worktrees[0]?.changes).toContainEqual({
      path: "notes.txt",
      kind: "conflicted",
      mode: "conflict",
    });
    expect(
      await gitFileDiff({
        worktreePath: root,
        filePath: "notes.txt",
        mode: "conflict",
      }),
    ).toMatchObject({
      before: "ours",
      after: expect.stringContaining("<<<<<<<"),
    });
  });

  it("handles unborn repositories, binary and large files, symlinks, and missing repositories", async () => {
    const fresh = path.join(temp, "new");
    await fs.mkdir(fresh);
    await nativeGit(fresh, ["init"]);
    await fs.writeFile(path.join(fresh, "new.txt"), "new");
    await nativeGit(fresh, ["add", "new.txt"]);
    expect(
      await gitFileDiff({
        worktreePath: fresh,
        filePath: "new.txt",
        mode: "staged",
      }),
    ).toMatchObject({ before: "", after: "new" });
    expect((await gitOverview(fresh)).worktrees[0]?.error).toBeUndefined();
    await fs.writeFile(path.join(root, "empty.txt"), "");
    expect(
      (
        await gitFileDiff({
          worktreePath: root,
          filePath: "empty.txt",
          mode: "untracked",
        })
      ).notice,
    ).toBe("Empty file added.");
    await nativeGit(root, ["add", "empty.txt"]);
    await fs.rm(path.join(root, "empty.txt"));
    expect(
      (
        await gitFileDiff({
          worktreePath: root,
          filePath: "empty.txt",
          mode: "unstaged",
        })
      ).notice,
    ).toBe("Empty file deleted.");
    await fs.writeFile(path.join(root, "binary"), new Uint8Array([255, 254]));
    expect(
      await gitFileDiff({
        worktreePath: root,
        filePath: "binary",
        mode: "untracked",
      }),
    ).toMatchObject({ binary: true, notice: undefined });
    await fs.writeFile(path.join(root, "large"), new Uint8Array(1_000_001));
    expect(
      (
        await gitFileDiff({
          worktreePath: root,
          filePath: "large",
          mode: "untracked",
        })
      ).notice,
    ).toContain("too large");
    await fs.writeFile(path.join(temp, "secret"), "do not disclose");
    await fs.symlink(path.join(temp, "secret"), path.join(root, "link"));
    expect(
      (
        await gitFileDiff({
          worktreePath: root,
          filePath: "link",
          mode: "untracked",
        })
      ).after,
    ).toBe(path.join(temp, "secret"));
    await fs.symlink(temp, path.join(root, "outside"));
    await expect(
      gitFileDiff({
        worktreePath: root,
        filePath: "outside/secret",
        mode: "untracked",
      }),
    ).rejects.toThrow("symbolic-link");
    await expect(
      gitFileDiff({
        worktreePath: root,
        filePath: "../secret",
        mode: "untracked",
      }),
    ).rejects.toThrow("Invalid");
    expect((await gitOverview(temp)).error).toBeTruthy();
  });
});
