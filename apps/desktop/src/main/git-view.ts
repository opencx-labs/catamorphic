import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type {
  GitChangedFile,
  GitDiffInput,
  GitFileDiff,
  GitOverview,
  GitWorktree,
} from "../shared/git.js";

export type { GitDiffMode } from "../shared/git.js";

const execute = promisify(execFile);
const MAX_DIFF_BYTES = 1_000_000;
async function git(cwd: string, args: string[]): Promise<string> {
  return (
    await execute("git", ["--literal-pathspecs", "-C", cwd, ...args], {
      maxBuffer: 16 * 1024 * 1024,
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
      },
    })
  ).stdout;
}
const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
const optionalGit = async (
  cwd: string,
  args: string[],
): Promise<string | undefined> => {
  try {
    return (await git(cwd, args)).trim() || undefined;
  } catch (error) {
    // Git uses 1/128 for absent refs/config. Process, permissions and timeout failures remain errors.
    if (
      error instanceof Error &&
      "code" in error &&
      (error.code === 1 || error.code === 128)
    )
      return undefined;
    throw error;
  }
};

type ListedWorktree = Pick<
  GitWorktree,
  "path" | "branch" | "locked" | "prunable"
> & { bare?: boolean };
async function worktreeList(root: string): Promise<ListedWorktree[]> {
  const output = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const trees: ListedWorktree[] = [];
  let current: ListedWorktree | undefined;
  for (const record of output.split("\0")) {
    if (record.startsWith("worktree ")) {
      current = { path: record.slice(9), branch: null };
      trees.push(current);
    } else if (current && record.startsWith("branch "))
      current.branch = record.slice(7).replace(/^refs\/heads\//, "");
    else if (current && record === "bare") current.bare = true;
    else if (current && (record === "locked" || record.startsWith("locked ")))
      current.locked = record.slice(7) || "Locked";
    else if (
      current &&
      (record === "prunable" || record.startsWith("prunable "))
    )
      current.prunable = record.slice(9) || "Folder is missing";
  }
  return trees.filter((tree) => !tree.bare);
}

async function comparisonBase(
  cwd: string,
  fallbackBranch: string | null,
): Promise<string | undefined> {
  const branch = await optionalGit(cwd, ["symbolic-ref", "--short", "HEAD"]);
  const remote = branch
    ? await optionalGit(cwd, ["config", "--get", `branch.${branch}.remote`])
    : undefined;
  for (const name of [
    ...new Set(
      [remote, "origin"].filter(
        (value): value is string => !!value && value !== ".",
      ),
    ),
  ]) {
    const ref = await optionalGit(cwd, [
      "symbolic-ref",
      "--quiet",
      `refs/remotes/${name}/HEAD`,
    ]);
    if (ref && (await optionalGit(cwd, ["rev-parse", "--verify", ref])))
      return ref;
  }
  for (const candidate of [
    "refs/heads/main",
    "refs/heads/master",
    ...(fallbackBranch ? [`refs/heads/${fallbackBranch}`] : []),
  ]) {
    if (await optionalGit(cwd, ["rev-parse", "--verify", candidate]))
      return candidate;
  }
  return optionalGit(cwd, ["rev-parse", "--symbolic-full-name", "@{upstream}"]);
}
const shortRef = (ref: string) => ref.replace(/^refs\/(heads|remotes)\//, "");
const overviewRequests = new Map<string, Promise<GitOverview>>();
export async function gitOverview(rootPath: string): Promise<GitOverview> {
  const key = await fs.realpath(rootPath).catch(() => path.resolve(rootPath));
  const pending = overviewRequests.get(key);
  if (pending) return pending;
  const request = readGitOverview(key);
  overviewRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (overviewRequests.get(key) === request) overviewRequests.delete(key);
  }
}
async function readGitOverview(rootPath: string): Promise<GitOverview> {
  let trees: ListedWorktree[];
  try {
    trees = await worktreeList(rootPath);
  } catch (error) {
    return {
      available: !(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ),
      worktrees: [],
      error: message(error),
    };
  }
  const selected = await optionalGit(rootPath, [
    "rev-parse",
    "--show-toplevel",
  ]);
  const result: GitWorktree[] = [];
  // Bound concurrent status work so one slow/missing worktree does not serialize every other checkout.
  for (let offset = 0; offset < trees.length; offset += 4) {
    result.push(
      ...(await Promise.all(
        trees
          .slice(offset, offset + 4)
          .map(async (tree, index): Promise<GitWorktree> => {
            const entry: GitWorktree = {
              ...tree,
              isMain: offset + index === 0,
              isCurrent: tree.path === selected,
              changes: [],
              branchChanges: [],
            };
            if (tree.prunable) {
              entry.error = `Worktree unavailable: ${tree.prunable}`;
              return entry;
            }
            try {
              entry.changes = await uncommittedChanges(tree.path);
            } catch (error) {
              entry.error = message(error);
              return entry;
            }
            try {
              const head = await optionalGit(tree.path, [
                "rev-parse",
                "--verify",
                "HEAD",
              ]);
              if (!head) return entry; // A repository before its first commit still has changes.
              const base = await comparisonBase(
                tree.path,
                trees[0]?.branch ?? null,
              );
              if (base) {
                entry.baseRef = base;
                entry.baseLabel = shortRef(base);
                entry.branchChanges = parseNameStatus(
                  await git(tree.path, [
                    "diff",
                    "--no-ext-diff",
                    "--no-textconv",
                    "--name-status",
                    "-M",
                    "-z",
                    `${base}...HEAD`,
                    "--",
                  ]),
                );
              }
            } catch (error) {
              entry.comparisonError = message(error);
            }
            return entry;
          }),
      )),
    );
  }
  return { available: true, worktrees: result };
}
export async function listWorktreePaths(rootPath: string): Promise<string[]> {
  return (await worktreeList(rootPath))
    .filter((tree) => !tree.prunable)
    .map((tree) => tree.path);
}

function changeKind(status: string): GitChangedFile["kind"] {
  return status === "A" || status === "?"
    ? "added"
    : status === "D"
      ? "deleted"
      : status === "R" || status === "C"
        ? "renamed"
        : "modified";
}
async function uncommittedChanges(cwd: string): Promise<GitChangedFile[]> {
  const parts = (
    await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])
  ).split("\0");
  const files: GitChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const record = parts[i];
    if (!record || record.length < 4) continue;
    const xy = record.slice(0, 2);
    const filePath = record.slice(3);
    const previousPath = /[RC]/.test(xy) ? parts[++i] : undefined;
    if (xy.includes("U") || xy === "AA" || xy === "DD") {
      files.push({ path: filePath, mode: "conflict", kind: "conflicted" });
      continue;
    }
    if (xy === "??") {
      files.push({ path: filePath, mode: "untracked", kind: "added" });
      continue;
    }
    for (const [position, mode] of [
      [0, "staged"],
      [1, "unstaged"],
    ] as const) {
      const status = xy[position];
      if (!status || status === " ") continue;
      files.push({
        path: filePath,
        mode,
        kind: changeKind(status),
        ...(/[RC]/.test(status) && previousPath ? { previousPath } : {}),
      });
    }
  }
  return files;
}
function parseNameStatus(output: string): GitChangedFile[] {
  const parts = output.split("\0");
  const files: GitChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (!status) continue;
    const oldPath = parts[++i];
    if (!oldPath) continue;
    const renamed = /^[RC]/.test(status);
    const filePath = renamed ? parts[++i] : oldPath;
    if (!filePath) continue;
    files.push({
      path: filePath,
      mode: "branch",
      kind: changeKind(status[0] ?? "M"),
      ...(renamed ? { previousPath: oldPath } : {}),
    });
  }
  return files;
}
function validateFile(filePath: string): void {
  if (
    !filePath ||
    path.isAbsolute(filePath) ||
    filePath.includes("\0") ||
    filePath
      .split(/[\\/]/)
      .some((part) => part === ".." || part === ".git" || part === "." || !part)
  )
    throw new Error("Invalid worktree file path");
}
type Content = {
  text: string;
  binary?: boolean;
  notice?: string;
  mode?: string;
};
const decode = (bytes: Uint8Array, mode?: string): Content => {
  if (bytes.includes(0)) return { text: "", binary: true, mode };
  try {
    return {
      text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      mode,
    };
  } catch {
    return { text: "", binary: true, mode };
  }
};
async function objectContent(
  cwd: string,
  ref: string,
  file: string,
): Promise<Content> {
  const index = ref === ":" || ref === ":2";
  const output = await git(
    cwd,
    index
      ? ["ls-files", "--stage", "-z", "--", file]
      : ["ls-tree", "-z", ref, "--", file],
  );
  const row = output
    .split("\0")
    .find(
      (record) =>
        record.slice(record.indexOf("\t") + 1) === file &&
        (!index || record.split("\t")[0]?.endsWith(ref === ":2" ? " 2" : " 0")),
    );
  if (!row) return { text: "" };
  const [mode, kindOrSha, shaOrStage] = row.split("\t")[0]!.split(" ");
  const sha = index ? kindOrSha : shaOrStage;
  if (!sha) throw new Error("Git returned an invalid file entry");
  if (mode === "160000")
    return {
      text: sha,
      mode,
      notice: "Submodule change. Open its checkout to inspect the files.",
    };
  const size = Number((await git(cwd, ["cat-file", "-s", sha])).trim());
  if (size > MAX_DIFF_BYTES)
    return {
      text: "",
      notice: "File is too large for an inline diff. Open it in your editor.",
      mode,
    };
  const { stdout } = await execute(
    "git",
    ["-C", cwd, "cat-file", "blob", sha],
    { encoding: "buffer", maxBuffer: MAX_DIFF_BYTES + 1, timeout: 30_000 },
  );
  return decode(stdout, mode);
}
async function workingContent(root: string, file: string): Promise<Content> {
  // Intermediate symlinks could disclose files outside the selected checkout.
  const segments = file.split("/");
  let target = root;
  for (const [index, segment] of segments.entries()) {
    target = path.join(target, segment);
    const stat = await fs.lstat(target).catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return null;
      throw error;
    });
    if (!stat) return { text: "" };
    if (stat.isSymbolicLink()) {
      if (index !== segments.length - 1)
        throw new Error("Diff paths cannot follow symbolic-link directories");
      return { text: await fs.readlink(target), mode: "120000" };
    }
    if (index !== segments.length - 1) continue;
    if (stat.isDirectory())
      return {
        text: "",
        notice:
          "Submodule or directory change. Open its checkout to inspect the files.",
      };
    if (!stat.isFile()) throw new Error("This path is not a regular file");
    if (stat.size > MAX_DIFF_BYTES)
      return {
        text: "",
        notice: "File is too large for an inline diff. Open it in your editor.",
      };
    return decode(
      await fs.readFile(target),
      stat.mode & 0o111 ? "100755" : "100644",
    );
  }
  return { text: "" };
}
export async function gitFileDiff(
  input: Omit<GitDiffInput, "projectId">,
): Promise<GitFileDiff> {
  const { worktreePath: root, filePath, previousPath, mode } = input;
  validateFile(filePath);
  if (previousPath) validateFile(previousPath);
  const head = await optionalGit(root, ["rev-parse", "--verify", "HEAD"]);
  let beforeRef: string | undefined;
  let afterRef: string | undefined;
  let beforeLabel: string;
  let afterLabel: string;
  if (mode === "branch") {
    if (!head || !input.baseRef?.startsWith("refs/"))
      throw new Error("The comparison branch is no longer available");
    const base = (
      await git(root, [
        "rev-parse",
        "--verify",
        "--end-of-options",
        `${input.baseRef}^{commit}`,
      ])
    ).trim();
    beforeRef = (await git(root, ["merge-base", base, head])).trim();
    afterRef = head;
    beforeLabel = `Base: ${shortRef(input.baseRef)}`;
    afterLabel = "Committed changes";
  } else if (mode === "staged") {
    beforeRef = head;
    afterRef = ":";
    beforeLabel = "HEAD";
    afterLabel = "Staged";
  } else if (mode === "unstaged") {
    beforeRef = ":";
    beforeLabel = "Staged";
    afterLabel = "Working file";
  } else if (mode === "conflict") {
    beforeRef = ":2";
    beforeLabel = "Ours";
    afterLabel = "Working file with conflict";
  } else if (mode === "untracked") {
    // A previously untracked file may have been staged while its tab stayed open.
    beforeRef = ":";
    beforeLabel = "Index";
    afterLabel = "Working file";
  } else throw new Error(`Unknown diff mode: ${String(mode)}`);
  const [originalBefore, after] = await Promise.all([
    beforeRef
      ? objectContent(root, beforeRef, previousPath ?? filePath)
      : Promise.resolve<Content>({ text: "" }),
    afterRef
      ? objectContent(root, afterRef, filePath)
      : workingContent(root, filePath),
  ]);
  const renamed = Boolean(previousPath && originalBefore.mode);
  // Once a rename is committed, HEAD contains the destination path. An
  // already-open staged diff must not keep showing it as an added file.
  const before =
    previousPath && beforeRef && !renamed
      ? await objectContent(root, beforeRef, filePath)
      : originalBefore;
  const identicalText =
    !before.binary && !after.binary && before.text === after.text;
  return {
    path: filePath,
    before: before.text,
    after: after.text,
    binary: !!(before.binary || after.binary),
    beforeLabel,
    afterLabel,
    notice:
      before.notice ??
      after.notice ??
      (identicalText && !before.mode && after.mode
        ? "Empty file added."
        : identicalText && before.mode && !after.mode
          ? "Empty file deleted."
          : identicalText &&
              before.mode &&
              after.mode &&
              before.mode !== after.mode
            ? `File mode changed: ${before.mode} to ${after.mode}`
            : renamed && identicalText
              ? `Renamed from ${previousPath}`
              : undefined),
  };
}
