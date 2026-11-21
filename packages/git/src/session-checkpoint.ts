import { MANAGED_BRANCH_PREFIX } from "@catamorphic/workflow/project-layout";
import { nativeGit } from "./native-git.js";
import { isValidRefName } from "./ref-names.js";

/**
 * A session's checkpoint (ADR 0342): one commit per save on the session's
 * own ref, never on the agent's branch. Its tree is the working tree as
 * saved; its parents are the checkpoint before it and then the agent's
 * HEAD; its trailers name the agent's branch and HEAD, and the branch this
 * chat last pushed for a pull request. One ref moved by one compare-and-swap
 * keeps a rollback, the agent's commits and its branch name together.
 */
export interface SessionWork {
  /** The commit the agent's checkout stands on. */
  head: string;
  /** The branch checked out there. */
  branch: string;
  /** What this chat last pushed to the project's repository (ADR 0343). */
  pushed?: { branch: string; commit: string };
}

const COMMIT = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;
const BRANCH_TRAILER = "Work-Branch";
const HEAD_TRAILER = "Work-Head";
const PUSHED_TRAILER = "Work-Pushed";

/** Refuse work no checkpoint may record: a bad commit id or branch name. */
export function assertSessionWork(work: SessionWork): void {
  if (!COMMIT.test(work.head))
    throw new Error("A checkpoint names its agent's HEAD by a full commit id");
  if (!isSessionBranchName(work.branch))
    throw new Error(
      `A checkpoint cannot record the branch ${JSON.stringify(work.branch.slice(0, 200))}`,
    );
  if (
    work.pushed &&
    (!COMMIT.test(work.pushed.commit) ||
      !isSessionBranchName(work.pushed.branch))
  )
    throw new Error("A checkpoint cannot record that pushed branch");
}

/** A branch name a session may stand on: Git's rules, and no option or refspec. */
export function isSessionBranchName(name: string): boolean {
  return (
    name.length <= 255 &&
    isValidRefName(name) &&
    !name.startsWith("-") &&
    !name.includes("+") &&
    name !== "HEAD"
  );
}

/**
 * The branch a session's checkout starts on: `work/` and the first eight
 * hex digits of its id, the same on a server and on a person's computer.
 */
export function sessionBranchName(sessionId: string): string {
  return `${MANAGED_BRANCH_PREFIX}${sessionId.replaceAll("-", "").slice(0, 8)}`;
}

/** A checkpoint's commit message: what was saved, then its trailers. */
export function checkpointMessage(input: {
  message: string;
  work: SessionWork;
}): string {
  assertSessionWork(input.work);
  const subject =
    input.message
      .split("\n")
      .map((line) => line.trim())
      .find(Boolean) ?? "Checkpoint";
  return [
    subject,
    "",
    `${BRANCH_TRAILER}: ${input.work.branch}`,
    `${HEAD_TRAILER}: ${input.work.head}`,
    ...(input.work.pushed
      ? [
          `${PUSHED_TRAILER}: ${input.work.pushed.branch} ${input.work.pushed.commit}`,
        ]
      : []),
    "",
  ].join("\n");
}

/**
 * What a checkpoint's message records, or null for a commit that is not a
 * checkpoint (the base a session started on, or one from before sessions
 * kept their agent's branch).
 */
export function parseCheckpointMessage(message: string): SessionWork | null {
  // Trailers are the last paragraph; the subject may quote anything.
  const paragraphs = message.trimEnd().split(/\n{2,}/);
  const last = paragraphs.length > 1 ? paragraphs.at(-1) : undefined;
  if (!last) return null;
  const trailers = new Map<string, string>();
  for (const line of last.split("\n")) {
    const separator = line.indexOf(": ");
    if (separator > 0)
      trailers.set(line.slice(0, separator), line.slice(separator + 2).trim());
  }
  const head = trailers.get(HEAD_TRAILER);
  const branch = trailers.get(BRANCH_TRAILER);
  if (!head || !branch || !COMMIT.test(head) || !isSessionBranchName(branch))
    return null;
  const [pushedBranch = "", pushedCommit = ""] = (
    trailers.get(PUSHED_TRAILER) ?? ""
  ).split(" ");
  return {
    head,
    branch,
    ...(isSessionBranchName(pushedBranch) && COMMIT.test(pushedCommit)
      ? { pushed: { branch: pushedBranch, commit: pushedCommit } }
      : {}),
  };
}

/** Read a commit already identified by the host as a session checkpoint. */
export async function readSessionWork(input: {
  repoPath: string;
  commit: string;
}): Promise<SessionWork | null> {
  if (!COMMIT.test(input.commit)) return null;
  const message = await nativeGit(input.repoPath, [
    "log",
    "-1",
    "--format=%B",
    input.commit,
  ]).catch(() => "");
  return parseCheckpointMessage(message);
}

/**
 * Write a checkpoint commit in the repository at `repoPath`: `tree` as
 * saved, on top of the checkpoint before it, with the agent's HEAD as its
 * second parent so one ref keeps the agent's commits reachable. Returns
 * its id; the caller moves the session's ref.
 */
export async function writeCheckpoint(input: {
  repoPath: string;
  /** A commit or tree whose tree is the working tree as saved. */
  tree: string;
  previous: string;
  message: string;
  author: { name: string; email: string };
  work: SessionWork;
}): Promise<string> {
  assertSessionWork(input.work);
  const tree = (
    await nativeGit(input.repoPath, [
      "rev-parse",
      "--verify",
      `${input.tree}^{tree}`,
    ])
  ).trim();
  // The agent's HEAD must be here whole before a ref makes it reachable.
  await nativeGit(input.repoPath, [
    "cat-file",
    "-e",
    `${input.work.head}^{commit}`,
  ]);
  return (
    await nativeGit(input.repoPath, [
      "-c",
      `user.name=${input.author.name}`,
      "-c",
      `user.email=${input.author.email}`,
      "commit-tree",
      tree,
      "-p",
      input.previous,
      ...(input.work.head === input.previous ? [] : ["-p", input.work.head]),
      "-m",
      checkpointMessage({ message: input.message, work: input.work }),
    ])
  ).trim();
}

/**
 * Where a session's work stands in its copy at `repoPath`: its latest
 * checkpoint and what that records. Before its first checkpoint the agent's
 * HEAD is the workspace's `base` and its branch the session's own.
 */
export async function currentSessionWork(input: {
  repoPath: string;
  sessionId: string;
  base: string;
}): Promise<SessionWork & { checkpoint: string }> {
  const checkpoint = (
    await nativeGit(input.repoPath, [
      "rev-parse",
      "--verify",
      "refs/heads/main^{commit}",
    ])
  ).trim();
  // Older workspaces and rollbacks can point directly at a repository base.
  // Its commit message belongs to the repository, not to this session.
  const recorded =
    checkpoint === input.base
      ? null
      : await readSessionWork({ repoPath: input.repoPath, commit: checkpoint });
  return {
    checkpoint,
    ...(recorded ?? {
      head: input.base,
      branch: sessionBranchName(input.sessionId),
    }),
  };
}
