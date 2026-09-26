import nodeFs from "node:fs";
import { MANAGED_BRANCH_PREFIX } from "@catamorphic/workflow/project-layout";
import git from "isomorphic-git";
import { nativeGit } from "./native-git.js";
import { NativeProjectRepo } from "./native-project-repo.js";
import {
  fetchFromRemote,
  pushToRemote,
  type RemoteOwnership,
} from "./network.js";
import type { GitCredentials, ProjectRepo } from "./types.js";

export type NetworkSyncStatus =
  /** Not on `main` (a deploy owns the tree right now) — nothing done. */
  | "no-op"
  | "up-to-date"
  /** Owned remotes: local commits pushed (including creating a missing
   * remote branch). */
  | "pushed"
  /** Remote commits fast-forwarded into the local tree. */
  | "pulled"
  /** Owned remotes: histories diverged; a clean 3-way merge landed and was
   * pushed. */
  | "merged"
  /** The tree has uncommitted edits and integrating the remote would touch
   * it — deferred untouched; the next sync retries. */
  | "deferred"
  /** Attached remotes: the local branch has commits the remote does not
   * (or the remote branch does not exist). Work never pushes them; they
   * reach the repository as a pull request. */
  | "ahead"
  /** Histories diverged. Owned remotes: the merge conflicts, and local
   * `main` was pushed to `rescueBranch` so no work is stranded. Attached
   * remotes: nothing was merged or pushed; the local commits reach the
   * repository as a pull request. The user's tree is never touched. */
  | "diverged";

export interface NetworkSyncResult {
  status: NetworkSyncStatus;
  localSha: string | null;
  remoteSha: string | null;
  rescueBranch?: string;
}

/**
 * Converge the dev repo's current branch with a branch on a network git
 * remote. Knows nothing about any particular code host — a URL plus optional
 * credentials is the entire contract (ADR 0044).
 *
 * Both ownerships fetch, report equality, and fast-forward over a clean tree
 * when strictly behind. Only an owned remote is ever written to (ADR 0170):
 * missing remote branch or strictly ahead → push; diverged → 3-way merge
 * that aborts on conflict (a background sync must NEVER leave conflict
 * markers), falling back to pushing a rescue branch. An attached remote
 * reports `ahead` or `diverged` instead and pushes nothing.
 */
export async function syncWithNetworkRemote(opts: {
  dev: ProjectRepo;
  url: string;
  credentials?: GitCredentials;
  remoteBranch: string;
  /** Who created the remote; only owned remotes are pushed to. */
  ownership: RemoteOwnership;
  author: { name: string; email: string };
  /** Injectable clock for deterministic rescue-branch names in tests. */
  now?: Date;
}): Promise<NetworkSyncResult> {
  const { dev } = opts;
  const dir = dev.repoPath;
  const owned = opts.ownership === "owned";

  const currentBranch = await dev.currentBranch();
  if (dev instanceof NativeProjectRepo) {
    if (currentBranch === "HEAD")
      return { status: "no-op", localSha: null, remoteSha: null };
    const localSha = await dev.resolveRef();
    const auth = opts.credentials
      ? { ...opts.credentials, url: opts.url }
      : undefined;
    const target =
      (
        await nativeGit(dir, [
          "config",
          "--get",
          `branch.${currentBranch}.merge`,
        ]).catch(() => "")
      )
        .trim()
        .replace(/^refs\/heads\//, "") || currentBranch;
    const remote = (
      await nativeGit(
        dir,
        ["ls-remote", opts.url, `refs/heads/${target}`],
        auth,
      )
    ).trim();
    const remoteSha = remote.split(/\s+/)[0] || null;
    const push = async (): Promise<NetworkSyncResult> => {
      if (!owned) return { status: "ahead", localSha, remoteSha };
      await pushToRemote({
        repoPath: dir,
        native: true,
        url: opts.url,
        credentials: opts.credentials,
        ownership: opts.ownership,
        ref: currentBranch,
        remoteBranch: target,
      });
      return { status: "pushed", localSha, remoteSha: localSha };
    };
    if (!remoteSha) return push();
    if (remoteSha === localSha)
      return { status: "up-to-date", localSha, remoteSha };
    await nativeGit(dir, ["fetch", opts.url, `refs/heads/${target}`], auth);
    if (
      await nativeGit(dir, [
        "merge-base",
        "--is-ancestor",
        remoteSha,
        localSha,
      ]).then(
        () => true,
        () => false,
      )
    ) {
      return push();
    }
    if (
      !(await nativeGit(dir, [
        "merge-base",
        "--is-ancestor",
        localSha,
        remoteSha,
      ]).then(
        () => true,
        () => false,
      ))
    ) {
      return { status: "diverged", localSha, remoteSha };
    }
    if ((await dev.status()).dirty)
      return { status: "deferred", localSha, remoteSha };
    await nativeGit(dir, ["merge", "--ff-only", remoteSha]);
    return { status: "pulled", localSha: remoteSha, remoteSha };
  }
  if (currentBranch !== "main") {
    return { status: "no-op", localSha: null, remoteSha: null };
  }

  const localSha = await dev.resolveRef("refs/heads/main");
  const { sha: remoteSha } = await fetchFromRemote({
    repoPath: dir,
    url: opts.url,
    credentials: opts.credentials,
    branch: opts.remoteBranch,
  });

  const push = (remoteBranch: string) =>
    pushToRemote({
      repoPath: dir,
      url: opts.url,
      credentials: opts.credentials,
      ownership: opts.ownership,
      ref: "main",
      remoteBranch,
    });

  if (!remoteSha) {
    if (!owned) return { status: "ahead", localSha, remoteSha };
    await push(opts.remoteBranch);
    return { status: "pushed", localSha, remoteSha: localSha };
  }
  if (remoteSha === localSha) {
    return { status: "up-to-date", localSha, remoteSha };
  }

  const isDescendent = (oid: string, ancestor: string) =>
    git
      .isDescendent({ fs: nodeFs, dir, oid, ancestor, depth: -1 })
      .catch(() => false);

  if (await isDescendent(localSha, remoteSha)) {
    if (!owned) return { status: "ahead", localSha, remoteSha };
    await push(opts.remoteBranch);
    return { status: "pushed", localSha, remoteSha: localSha };
  }

  const behind = await isDescendent(remoteSha, localSha);
  if (!behind && !owned) return { status: "diverged", localSha, remoteSha };

  const { dirty } = await dev.status();
  if (dirty) return { status: "deferred", localSha, remoteSha };

  if (behind) {
    await git.writeRef({
      fs: nodeFs,
      dir,
      ref: "refs/heads/main",
      value: remoteSha,
      force: true,
    });
    await git.checkout({ fs: nodeFs, dir, ref: "main", force: true });
    return { status: "pulled", localSha: remoteSha, remoteSha };
  }

  // Diverged histories on an owned remote.
  try {
    const merge = await git.merge({
      fs: nodeFs,
      dir,
      ours: "main",
      theirs: remoteSha,
      author: opts.author,
      committer: opts.author,
      fastForward: true,
      abortOnConflict: true,
      message: `Merge remote ${opts.remoteBranch} into main`,
    });
    await git.checkout({ fs: nodeFs, dir, ref: "main", force: true });
    const mergedSha = merge.oid ?? (await dev.resolveRef("refs/heads/main"));
    await push(opts.remoteBranch);
    return { status: "merged", localSha: mergedSha, remoteSha: mergedSha };
  } catch (err) {
    if ((err as { code?: string })?.code !== "MergeConflictError") throw err;
    const rescueBranch = rescueBranchName(opts.now ?? new Date());
    await push(rescueBranch);
    return { status: "diverged", localSha, remoteSha, rescueBranch };
  }
}

/** `work/diverged-YYYY-MM-DD_HH-mm` — groups rescue pushes on the host. */
function rescueBranchName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${MANAGED_BRANCH_PREFIX}diverged-${now.getUTCFullYear()}-${pad(
    now.getUTCMonth() + 1,
  )}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(
    now.getUTCMinutes(),
  )}`;
}
