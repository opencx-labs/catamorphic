import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  pruneTurboCache,
  TURBO_CACHE_MAX_AGE_MS,
  turboCacheDirectory,
} from "./turbo-cache.js";

describe("pruneTurboCache", () => {
  let directory: string;
  const now = Date.now();
  const day = 24 * 60 * 60 * 1000;

  beforeEach(async () => {
    directory = await mkdtemp(path.join(tmpdir(), "turbo-cache-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  /** One cache entry: archive, manifest and metadata, written `age` ago. */
  const entry = async (hash: string, age: number, archiveBytes = 10) => {
    const written = new Date(now - age);
    for (const [suffix, bytes] of [
      [".tar.zst", archiveBytes],
      ["-manifest.json", 2],
      ["-meta.json", 2],
    ] as const) {
      const file = path.join(directory, `${hash}${suffix}`);
      await writeFile(file, "x".repeat(bytes));
      await utimes(file, written, written);
    }
  };

  it("removes whole entries past the age, and leaves everything else", async () => {
    await entry("aaaaaaaaaaaaaaaa", TURBO_CACHE_MAX_AGE_MS + day);
    await entry("bbbbbbbbbbbbbbbb", day);
    await writeFile(path.join(directory, "cookies"), "");

    expect(await pruneTurboCache({ directory, now })).toEqual({
      removedEntries: 1,
      removedBytes: 14,
    });
    expect((await readdir(directory)).sort()).toEqual([
      "bbbbbbbbbbbbbbbb-manifest.json",
      "bbbbbbbbbbbbbbbb-meta.json",
      "bbbbbbbbbbbbbbbb.tar.zst",
      "cookies",
    ]);
  });

  it("removes the oldest recent entries until the cache fits", async () => {
    await entry("1111111111111111", 3 * day, 100);
    await entry("2222222222222222", 2 * day, 100);
    await entry("3333333333333333", day, 100);

    const result = await pruneTurboCache({ directory, now, maxBytes: 150 });

    expect(result).toEqual({ removedEntries: 2, removedBytes: 208 });
    expect(
      (await readdir(directory)).every((name) => name.startsWith("3")),
    ).toBe(true);
  });

  it("does nothing when there is no cache", async () => {
    expect(
      await pruneTurboCache({
        directory: path.join(directory, "missing"),
        now,
      }),
    ).toEqual({ removedEntries: 0, removedBytes: 0 });
  });
});

describe("turboCacheDirectory", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "turbo-root-")));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("is the main worktree's, from any worktree, unless configured", async () => {
    const main = path.join(root, "main");
    await mkdir(main);
    const git = (cwd: string, ...args: string[]) =>
      execFileSync("git", args, { cwd, stdio: "ignore" });
    git(main, "init", "-q", "-b", "main");
    git(
      main,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    const worktree = path.join(root, "feature");
    git(main, "worktree", "add", "-q", "-b", "feature", worktree);

    expect(turboCacheDirectory({ rootPath: worktree, env: {} })).toBe(
      path.join(main, ".turbo", "cache"),
    );
    expect(
      turboCacheDirectory({
        rootPath: worktree,
        env: { TURBO_CACHE_DIR: "custom/cache" },
      }),
    ).toBe(path.join(worktree, "custom", "cache"));
  });
});
