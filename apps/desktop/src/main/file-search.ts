import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { FileSearchResult } from "../shared/file-search.js";
import { fileSearchScore } from "../shared/file-search-score.js";

const execute = promisify(execFile);
const MAX_RESULTS = 200;
/** Search only Git-visible regular files. Never follow symlinks out of a checkout. */
export async function searchProjectFiles({
  root,
  query,
  mode,
  signal,
}: {
  root: string;
  query: string;
  mode: "files" | "content";
  signal?: AbortSignal;
}): Promise<FileSearchResult> {
  if (query.length > 256 || query.includes("\0"))
    throw new Error("Search must be at most 256 characters.");
  root = await fs.realpath(root);
  const needle = query.trim().toLowerCase();
  if (!needle) return { matches: [], truncated: false };
  const { stdout } = await execute(
    "git",
    [
      "-C",
      root,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
    ],
    { maxBuffer: 16 * 1024 * 1024, timeout: 10_000, signal },
  );
  const files = [...new Set(stdout.split("\0").filter(Boolean))];
  if (mode === "files") {
    const matches = files
      .map((name) => ({ name, score: fileSearchScore(name, needle) }))
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .map((item) => item.name);
    return {
      matches: matches.slice(0, MAX_RESULTS).map((path) => ({ path })),
      truncated: matches.length > MAX_RESULTS,
    };
  }
  const matches: FileSearchResult["matches"] = [];
  let bytes = 0;
  let truncated = false;
  const started = Date.now();
  for (const file of files) {
    signal?.throwIfAborted();
    if (
      matches.length >= MAX_RESULTS ||
      bytes > 128 * 1024 * 1024 ||
      Date.now() - started > 5000
    ) {
      truncated = true;
      break;
    }
    const absolute = path.resolve(root, file);
    const relative = path.relative(root, absolute);
    if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
    try {
      const stat = await fs.lstat(absolute);
      if (!stat.isFile() || stat.isSymbolicLink()) continue;
      if (stat.size > 1024 * 1024) {
        truncated = true;
        continue;
      }
      const canonical = await fs.realpath(absolute);
      if (path.relative(root, canonical).startsWith("..")) continue;
      const content = await fs.readFile(absolute, "utf8");
      bytes += stat.size;
      if (content.includes("\0")) continue;
      const lines = content.split("\n");
      for (const [index, text] of lines.entries()) {
        if (!text.toLowerCase().includes(needle)) continue;
        matches.push({ path: file, line: index + 1, text: text.slice(0, 500) });
        if (matches.length >= MAX_RESULTS) {
          truncated = true;
          break;
        }
      }
    } catch (error) {
      if (signal?.aborted) throw error;
    }
  }
  return { matches, truncated };
}
