import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  FileSearchMode,
  FileSearchResult,
} from "../shared/file-search.js";
import { fileSearchScore } from "../shared/file-search-score.js";

const execute = promisify(execFile);
const MAX_RESULTS = 200;
/** A folder without Git is walked, this far at most. */
const MAX_WALKED_FILES = 20_000;

/**
 * The checkout's files: Git-visible ones (tracked and untracked, ignores
 * honored), or in a folder that is not a repository (ADR 0141) a bounded
 * walk that skips hidden entries and dependency folders. Never follows a
 * symlink.
 */
async function listFiles(root: string, signal?: AbortSignal) {
  try {
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
    return [...new Set(stdout.split("\0").filter(Boolean))];
  } catch (error) {
    signal?.throwIfAborted();
    const stderr =
      error && typeof error === "object" && "stderr" in error
        ? String(error.stderr)
        : "";
    if (!/not a git repository/i.test(stderr)) throw error;
  }
  const files: string[] = [];
  const queue = [""];
  while (queue.length > 0 && files.length < MAX_WALKED_FILES) {
    signal?.throwIfAborted();
    const folder = queue.shift() ?? "";
    const entries = await fs
      .readdir(path.join(root, folder), { withFileTypes: true })
      .catch(() => []);
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
      const relative = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  return files;
}

/**
 * Files and their folders for a mention: the top level for an empty query,
 * else the best matches, a folder before a file of the same score.
 */
function searchPaths(files: string[], needle: string): FileSearchResult {
  const folders = new Set<string>();
  for (const file of files) {
    for (let at = file.indexOf("/"); at !== -1; at = file.indexOf("/", at + 1))
      folders.add(file.slice(0, at + 1));
  }
  const entries = [
    ...[...folders].map((entry) => ({ path: entry, directory: true })),
    ...files.map((entry) => ({ path: entry, directory: false })),
  ];
  const depth = (entry: string) => entry.replace(/\/$/, "").split("/").length;
  const ranked = needle
    ? entries
        .map((entry) => ({
          ...entry,
          score: fileSearchScore(entry.path.replace(/\/$/, ""), needle),
        }))
        .filter((entry) => entry.score > 0)
        .sort(
          (a, b) =>
            b.score - a.score ||
            Number(b.directory) - Number(a.directory) ||
            depth(a.path) - depth(b.path) ||
            a.path.localeCompare(b.path),
        )
    : entries
        .filter((entry) => depth(entry.path) === 1)
        .sort(
          (a, b) =>
            Number(b.directory) - Number(a.directory) ||
            a.path.localeCompare(b.path),
        );
  return {
    matches: ranked
      .slice(0, MAX_RESULTS)
      .map((entry) =>
        entry.directory
          ? { path: entry.path, directory: true }
          : { path: entry.path },
      ),
    truncated: ranked.length > MAX_RESULTS,
  };
}

/** Search only checkout-visible regular files. Never follow symlinks out of a checkout. */
export async function searchProjectFiles({
  root,
  query,
  mode,
  signal,
}: {
  root: string;
  query: string;
  mode: FileSearchMode;
  signal?: AbortSignal;
}): Promise<FileSearchResult> {
  if (query.length > 256 || query.includes("\0"))
    throw new Error("Search must be at most 256 characters.");
  root = await fs.realpath(root);
  const needle = query.trim().toLowerCase();
  if (!needle && mode !== "paths") return { matches: [], truncated: false };
  const files = await listFiles(root, signal);
  if (mode === "paths") return searchPaths(files, needle);
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
