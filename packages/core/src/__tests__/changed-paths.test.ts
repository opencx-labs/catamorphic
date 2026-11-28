import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CHANGED_PATHS_LIMIT,
  changedPaths,
} from "../services/sessions/changed-paths.js";

/*
 * The paths that differ between two commits of a chat (ADR 0346), read with
 * Git from a real repository: what a setup workflow asks before it decides
 * whether a lockfile moved.
 */

/** A well-formed id no repository here holds. */
const ABSENT = "0123456789abcdef0123456789abcdef01234567";
const SPACED = "docs/my notes é.md";

let root: string;

/** Git in a repository, without the machine's own configuration. */
function git(repoPath: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Tester",
      GIT_AUTHOR_EMAIL: "tester@work.example",
      GIT_COMMITTER_NAME: "Tester",
      GIT_COMMITTER_EMAIL: "tester@work.example",
    },
  }).trim();
}

function repository(name: string, extra: readonly string[] = []): string {
  const repoPath = path.join(root, name);
  fs.mkdirSync(repoPath);
  git(repoPath, ["init", "--quiet", "--initial-branch=main", ...extra]);
  return repoPath;
}

function write(repoPath: string, file: string, text: string): void {
  fs.mkdirSync(path.dirname(path.join(repoPath, file)), { recursive: true });
  fs.writeFileSync(path.join(repoPath, file), text);
}

/** Commit the working tree as it stands, and answer the commit's id. */
function commit(repoPath: string, message: string): string {
  git(repoPath, ["add", "--all"]);
  git(repoPath, ["commit", "--quiet", "--allow-empty", "-m", message]);
  return git(repoPath, ["rev-parse", "HEAD"]);
}

describe("the paths that differ between two commits", () => {
  let repoPath: string;
  let first: string;
  let second: string;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "changed-paths-"));
    repoPath = repository("project");
    write(repoPath, "bun.lock", "lock 1\n");
    write(repoPath, "keep.txt", "kept\n");
    write(repoPath, "old.txt", "going away\n");
    write(repoPath, "before.txt", "the same words in both places\n");
    write(repoPath, "src/app/main.ts", "export const version = 1;\n");
    first = commit(repoPath, "First");
    write(repoPath, "bun.lock", "lock 2\n");
    fs.rmSync(path.join(repoPath, "old.txt"));
    fs.renameSync(
      path.join(repoPath, "before.txt"),
      path.join(repoPath, "after.txt"),
    );
    write(repoPath, "src/app/main.ts", "export const version = 2;\n");
    write(repoPath, "src/app/deep/new.ts", "export const added = true;\n");
    write(repoPath, SPACED, "a space and an accent\n");
    second = commit(repoPath, "Second");
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("names what was added, modified, deleted and moved, at any depth", async () => {
    const answer = await changedPaths({ repoPath, from: first, to: second });
    expect(answer).toEqual({
      // Git's order; a moved file is its old path and its new one.
      paths: [
        "after.txt",
        "before.txt",
        "bun.lock",
        SPACED,
        "old.txt",
        "src/app/deep/new.ts",
        "src/app/main.ts",
      ],
      truncated: false,
      complete: true,
    });
    // The same paths differ whichever commit is asked first.
    expect(
      (await changedPaths({ repoPath, from: second, to: first })).paths,
    ).toEqual(answer.paths);
  });

  it("answers no paths for a commit compared with itself", async () => {
    expect(await changedPaths({ repoPath, from: first, to: first })).toEqual({
      paths: [],
      truncated: false,
      complete: true,
    });
    // Two commits with the same files differ in nothing either.
    const again = commit(repoPath, "Nothing changed");
    expect(await changedPaths({ repoPath, from: second, to: again })).toEqual({
      paths: [],
      truncated: false,
      complete: true,
    });
  });

  it("names the first paths in Git's order and says when more differ", async () => {
    const many = repository("many");
    const empty = commit(many, "Empty");
    const names = Array.from(
      { length: CHANGED_PATHS_LIMIT + 5 },
      (_, index) => `files/file-${String(index).padStart(5, "0")}.txt`,
    );
    for (const name of names) write(many, name, `${name}\n`);
    const full = commit(many, "Many files");

    const capped = await changedPaths({
      repoPath: many,
      from: empty,
      to: full,
    });
    expect(capped.paths).toHaveLength(CHANGED_PATHS_LIMIT);
    expect(capped.paths).toEqual(names.slice(0, CHANGED_PATHS_LIMIT));
    expect(capped).toMatchObject({ truncated: true, complete: true });

    // Exactly as many as the answer may name is the whole answer.
    expect(
      await changedPaths({
        repoPath: many,
        from: empty,
        to: full,
        limit: names.length,
      }),
    ).toEqual({ paths: names, truncated: false, complete: true });
    expect(
      await changedPaths({
        repoPath: many,
        from: empty,
        to: full,
        limit: names.length - 1,
      }),
    ).toEqual({ paths: names.slice(0, -1), truncated: true, complete: true });
  });

  it("answers incomplete, with no paths, for a commit the repository does not hold", async () => {
    const unknown = { paths: [], truncated: false, complete: false };
    expect(await changedPaths({ repoPath, from: ABSENT, to: second })).toEqual(
      unknown,
    );
    expect(await changedPaths({ repoPath, from: first, to: ABSENT })).toEqual(
      unknown,
    );
    // An id the repository holds that is no commit is not one either.
    const tree = git(repoPath, ["rev-parse", `${second}^{tree}`]);
    expect(await changedPaths({ repoPath, from: first, to: tree })).toEqual(
      unknown,
    );
  });

  it("takes only full commit ids, never a ref or an option", async () => {
    const leaked = path.join(root, "leaked.txt");
    for (const from of [
      "main",
      "HEAD~1",
      first.slice(0, 12),
      first.toUpperCase(),
      `--output=${leaked}`,
    ])
      await expect(
        changedPaths({ repoPath, from, to: second }),
      ).rejects.toThrow("A commit is named by its full id");
    await expect(
      changedPaths({ repoPath, from: first, to: `--output=${leaked}` }),
    ).rejects.toThrow("A commit is named by its full id");
    expect(fs.existsSync(leaked)).toBe(false);
  });

  it("compares the commits of a SHA-256 repository", async () => {
    const hashed = repository("sha256", ["--object-format=sha256"]);
    write(hashed, "bun.lock", "lock 1\n");
    const from = commit(hashed, "First");
    write(hashed, "bun.lock", "lock 2\n");
    write(hashed, "package.json", "{}\n");
    const to = commit(hashed, "Second");
    expect(from).toHaveLength(64);
    expect(await changedPaths({ repoPath: hashed, from, to })).toEqual({
      paths: ["bun.lock", "package.json"],
      truncated: false,
      complete: true,
    });
  });
});
