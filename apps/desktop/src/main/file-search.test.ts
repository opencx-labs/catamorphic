import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nativeGit } from "@catamorphic/git";
import { afterEach, beforeEach, expect, it } from "vitest";
import { searchProjectFiles } from "./file-search.js";

let temp: string;
let root: string;
beforeEach(async () => {
  temp = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "file-search-")),
  );
  root = path.join(temp, "repo");
  await fs.mkdir(root);
  await nativeGit(root, ["init", "-b", "main"]);
});
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true });
});

it("searches tracked and untracked names without reading ignored files", async () => {
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  await fs.writeFile(path.join(root, "notes.txt"), "First\nNeedle here\n");
  await fs.writeFile(path.join(root, "ignored.txt"), "Needle ignored");
  expect(
    (await searchProjectFiles({ root, mode: "files", query: "notes" })).matches,
  ).toEqual([{ path: "notes.txt" }]);
  expect(
    (await searchProjectFiles({ root, mode: "content", query: "needle" }))
      .matches,
  ).toEqual([{ path: "notes.txt", line: 2, text: "Needle here" }]);
});

it("excludes binary data and symlinks escaping the checkout", async () => {
  await fs.writeFile(path.join(temp, "outside"), "needle secret");
  await fs.symlink(path.join(temp, "outside"), path.join(root, "link"));
  await fs.writeFile(path.join(root, "binary"), "needle\0bytes");
  expect(
    await searchProjectFiles({ root, mode: "content", query: "needle" }),
  ).toEqual({ matches: [], truncated: false });
});

it("reports bounded results and honors cancellation", async () => {
  await fs.writeFile(
    path.join(root, "many.txt"),
    Array(250).fill("needle").join("\n"),
  );
  const result = await searchProjectFiles({
    root,
    mode: "content",
    query: "needle",
  });
  expect(result.matches).toHaveLength(200);
  expect(result.truncated).toBe(true);
  const controller = new AbortController();
  controller.abort();
  await expect(
    searchProjectFiles({
      root,
      mode: "content",
      query: "needle",
      signal: controller.signal,
    }),
  ).rejects.toThrow();
});
