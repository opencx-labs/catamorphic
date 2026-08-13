import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Read-side git data for the dev surfaces (sidebar Git section, diff tabs):
 * worktree discovery, changed files, and per-file before/after content.
 * Uses the system git binary — worktrees and three-dot diffs are exactly the
 * territory where reimplementing git goes wrong, and the audience for these
 * surfaces (engineers) has git. When git is absent the overview reports
 * `available: false` and the UI shows a quiet empty state; the write side
 * (checkpoints, sync) is isomorphic-git and unaffected.
 */

const execFileAsync = promisify(execFile);

/** Diff/overview payloads stay renderer-friendly: plain JSON, no classes. */
export interface GitChangedFile {
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed";
  /** Set when kind is "renamed". */
  previousPath?: string;
}

export interface GitWorktree {
  path: string;
  branch: string | null;
  isMain: boolean;
  /** Uncommitted changes in this worktree (staged + unstaged + untracked). */
  changes: GitChangedFile[];
  /** For non-main worktrees: files changed on this branch vs main (3-dot). */
  vsMain?: GitChangedFile[];
}

export interface GitOverview {
  available: boolean;
  worktrees: GitWorktree[];
}

export type GitDiffMode = "uncommitted" | "vs-main";

export interface GitFileDiff {
  path: string;
  before: string;
  after: string;
  binary: boolean;
}

const MAX_DIFF_BYTES = 1_000_000;

let gitChecked: Promise<boolean> | undefined;
function gitAvailable(): Promise<boolean> {
  gitChecked ??= execFileAsync("git", ["--version"]).then(
    () => true,
    () => false,
  );
  return gitChecked;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout;
}

export async function gitOverview(rootPath: string): Promise<GitOverview> {
  if (!(await gitAvailable())) return { available: false, worktrees: [] };
  let worktrees: Array<{ path: string; branch: string | null }>;
  try {
    worktrees = parseWorktreeList(
      await git(rootPath, ["worktree", "list", "--porcelain"]),
    );
  } catch {
    // Not a git repo (or git failed) — nothing to show.
    return { available: true, worktrees: [] };
  }

  const result: GitWorktree[] = [];
  for (const [index, tree] of worktrees.entries()) {
    const isMain = index === 0; // git lists the main worktree first
    const entry: GitWorktree = {
      path: tree.path,
      branch: tree.branch,
      isMain,
      changes: await uncommittedChanges(tree.path).catch(() => []),
    };
    if (!isMain && tree.branch && tree.branch !== "main") {
      entry.vsMain = await vsMainChanges(tree.path).catch(() => []);
    }
    result.push(entry);
  }
  return { available: true, worktrees: result };
}

export async function gitFileDiff(
  worktreePath: string,
  filePath: string,
  mode: GitDiffMode,
): Promise<GitFileDiff> {
  const abs = path.join(worktreePath, filePath);
  if (path.relative(worktreePath, abs).startsWith("..")) {
    throw new Error("Path escapes the worktree");
  }

  const baseRef =
    mode === "vs-main"
      ? (await git(worktreePath, ["merge-base", "main", "HEAD"])).trim()
      : "HEAD";
  const before = await git(worktreePath, [
    "show",
    `${baseRef}:${filePath}`,
  ]).catch(() => "");
  const after = await fs.readFile(abs, "utf8").catch(() => "");

  const binary = before.includes("\0") || after.includes("\0");
  return {
    path: filePath,
    before: binary ? "" : before.slice(0, MAX_DIFF_BYTES),
    after: binary ? "" : after.slice(0, MAX_DIFF_BYTES),
    binary,
  };
}

function parseWorktreeList(
  porcelain: string,
): Array<{ path: string; branch: string | null }> {
  const trees: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length), branch: null };
      trees.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line
        .slice("branch ".length)
        .replace(/^refs\/heads\//, "");
    }
  }
  return trees;
}

/** `git status --porcelain=v1 -z`: robust against spaces/renames. */
async function uncommittedChanges(cwd: string): Promise<GitChangedFile[]> {
  const out = await git(cwd, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  const parts = out.split("\0");
  const files: GitChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry || entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const filePath = entry.slice(3);
    if (xy.includes("R") || xy.includes("C")) {
      // Rename/copy: the NEXT -z record is the original path.
      const previousPath = parts[++i];
      files.push({
        path: filePath,
        kind: "renamed",
        ...(previousPath ? { previousPath } : {}),
      });
    } else if (xy === "??" || xy.includes("A")) {
      files.push({ path: filePath, kind: "added" });
    } else if (xy.includes("D")) {
      files.push({ path: filePath, kind: "deleted" });
    } else {
      files.push({ path: filePath, kind: "modified" });
    }
  }
  return files;
}

/** `git diff --name-status -z main...HEAD` — the branch's own changes. */
async function vsMainChanges(cwd: string): Promise<GitChangedFile[]> {
  const out = await git(cwd, ["diff", "--name-status", "-z", "main...HEAD"]);
  const parts = out.split("\0");
  const files: GitChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    if (status.startsWith("R") || status.startsWith("C")) {
      const previousPath = parts[++i] ?? "";
      const newPath = parts[++i] ?? "";
      files.push({
        path: newPath,
        kind: "renamed",
        ...(previousPath ? { previousPath } : {}),
      });
    } else {
      const filePath = parts[++i] ?? "";
      if (!filePath) continue;
      files.push({
        path: filePath,
        kind:
          status === "A" ? "added" : status === "D" ? "deleted" : "modified",
      });
    }
  }
  return files;
}
