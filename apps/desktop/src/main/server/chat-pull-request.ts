import { createHash } from "node:crypto";
import type {
  ChatPullRequest,
  Identity,
  PullRequestsService,
} from "@catamorphic/core";
import { nativeGit, sessionBranchName } from "@catamorphic/git";
import {
  type SessionCheckoutDescription,
  usableCheckout,
} from "./session-checkouts.js";

/** What opening a chat's pull request needs of the chat's checkouts. */
export interface PullRequestCheckouts {
  describe(input: {
    projectId: string;
    sessionId: string;
  }): Promise<SessionCheckoutDescription>;
  /** Checkpoint the chat's own worktree, so its changes are commits. */
  preparePullRequest(input: {
    projectId: string;
    sessionId: string;
    message: string;
  }): Promise<{ path: string; branch: string }>;
}

/**
 * A desktop chat's `create_pull_request` (ADR 0345): find the chat's
 * checkout, its own worktree or the project folder, and run core's one
 * function on it. A worktree of the chat's own is checkpointed first; the
 * project folder and a worktree the person assigned push what they
 * committed, and the result names the rest. What the chat last pushed is
 * kept in the repository under a key for the chat, checkout, and branch.
 */
export async function openChatPullRequest(input: {
  pullRequests: Pick<PullRequestsService, "openForChat" | "remoteBranch">;
  checkouts: PullRequestCheckouts;
  identity: Identity;
  projectId: string;
  sessionId: string;
  title: string;
  body?: string;
}): Promise<ChatPullRequest> {
  const { projectId, sessionId } = input;
  const described = usableCheckout(
    await input.checkouts.describe({ projectId, sessionId }),
  );
  const repoPath =
    described.kind === "managed"
      ? (
          await input.checkouts.preparePullRequest({
            projectId,
            sessionId,
            message: input.title,
          })
        ).path
      : described.path;
  const read = async (args: string[]) =>
    (await nativeGit(repoPath, args)).trim();
  const commit = await read(["rev-parse", "--verify", "HEAD^{commit}"]);
  const branch =
    (await read(["branch", "--show-current"])) || sessionBranchName(sessionId);
  const uncommitted = (
    await nativeGit(repoPath, [
      "status",
      "--porcelain=v1",
      "--no-renames",
      "-z",
    ])
  )
    .split("\0")
    .filter(Boolean)
    .map((entry) => entry.slice(3));
  const remoteBranch = input.pullRequests.remoteBranch({ branch, sessionId });
  const gitDirectory = await read(["rev-parse", "--absolute-git-dir"]);
  const pushRef = (branch: string) => {
    const key = createHash("sha256")
      .update(JSON.stringify([projectId, sessionId, gitDirectory, branch]))
      .digest("hex");
    return `refs/work/pushed/${key}`;
  };
  const lastPushed = await read([
    "rev-parse",
    "-q",
    "--verify",
    `${pushRef(remoteBranch)}^{commit}`,
  ]).catch(() => "");
  return input.pullRequests.openForChat({
    identity: input.identity,
    projectId,
    sessionId,
    title: input.title,
    ...(input.body !== undefined ? { body: input.body } : {}),
    checkout: { repoPath, commit, branch },
    uncommitted,
    ...(lastPushed
      ? { pushed: { branch: remoteBranch, commit: lastPushed } }
      : {}),
    principal: "either",
    remember: async (pushed) => {
      await nativeGit(repoPath, [
        "update-ref",
        pushRef(pushed.branch),
        pushed.commit,
      ]);
    },
  });
}
