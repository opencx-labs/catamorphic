import { nativeGit } from "@catamorphic/git";

/** The most paths one answer names; past it the answer is `truncated`. */
export const CHANGED_PATHS_LIMIT = 2_000;

/** A full commit id: 40 (SHA-1) or 64 (SHA-256) lowercase hex characters. */
export const COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The paths that differ between two commits of a chat (ADR 0346). */
export interface ChangedPaths {
  /** Repository-relative paths in Git's order, at most the limit. */
  paths: string[];
  /** More paths differ than `paths` names. */
  truncated: boolean;
  /**
   * False when the repository does not hold one of the two commits: nothing
   * was compared, so everything may have changed.
   */
  complete: boolean;
}

/**
 * The paths that differ between two commits a repository holds: added,
 * modified and deleted files, a rename as its old and its new path. The
 * first `limit` in Git's order are named, and `truncated` says more differ.
 * A commit the repository does not hold answers `complete: false` with no
 * paths; a commit compared with itself differs in nothing.
 */
export async function changedPaths(input: {
  repoPath: string;
  from: string;
  to: string;
  /** Default {@link CHANGED_PATHS_LIMIT}. */
  limit?: number;
}): Promise<ChangedPaths> {
  const limit = input.limit ?? CHANGED_PATHS_LIMIT;
  // The ids are arguments of a Git command: never an option or a ref.
  for (const commit of [input.from, input.to])
    if (!COMMIT_ID_PATTERN.test(commit))
      throw new TypeError("A commit is named by its full id");
  if (input.from === input.to)
    return { paths: [], truncated: false, complete: true };
  for (const commit of [input.from, input.to])
    if (!(await holdsCommit({ repoPath: input.repoPath, commit })))
      return { paths: [], truncated: false, complete: false };
  const listed = await nativeGit(input.repoPath, [
    "diff-tree",
    "-r",
    "--no-renames",
    "--name-only",
    "-z",
    input.from,
    input.to,
  ]).then(
    (output) => ({ output, whole: true }),
    (error: unknown) => {
      const output = overflowedOutput(error);
      if (output === undefined) throw error;
      return { output, whole: false };
    },
  );
  const paths = listed.output.split("\0");
  // Every path ends with NUL: what follows the last one is empty, or the
  // start of a path a full buffer cut.
  paths.pop();
  return {
    paths: paths.slice(0, limit),
    truncated: !listed.whole || paths.length > limit,
    complete: true,
  };
}

/** Whether the repository holds this commit. */
async function holdsCommit(input: {
  repoPath: string;
  commit: string;
}): Promise<boolean> {
  return nativeGit(input.repoPath, [
    "cat-file",
    "-e",
    `${input.commit}^{commit}`,
  ]).then(
    () => true,
    (error: unknown) => {
      // Git ran and said no. Anything else (no Git, a timeout) is a
      // failure, never an answer.
      if (typeof property(error, "code") === "number") return false;
      throw error;
    },
  );
}

/**
 * What Git had listed when its output outgrew the buffer `nativeGit` reads
 * into: far more paths than an answer names, so its start is enough.
 */
function overflowedOutput(error: unknown): string | undefined {
  if (property(error, "code") !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return undefined;
  const output = property(error, "stdout");
  return typeof output === "string" ? output : undefined;
}

function property(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null
    ? Reflect.get(value, name)
    : undefined;
}
