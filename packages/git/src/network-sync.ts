import nodeFs from "node:fs";
import git from "isomorphic-git";
import { fetchFromRemote, pushToRemote } from "./network.js";
import type { GitCredentials, ProjectRepo } from "./types.js";

export type NetworkSyncStatus =
  /** Not on `main` (a deploy owns the tree right now) — nothing done. */
  | "no-op"
  | "up-to-date"
  /** Local commits pushed (including creating a missing remote branch). */
  | "pushed"
  /** Remote commits fast-forwarded into the local tree. */
  | "pulled"
  /** Histories diverged; a clean 3-way merge landed and was pushed. */
  | "merged"
  /** The tree has uncommitted edits and integrating the remote would touch
   * it — deferred untouched; the next sync retries. */
  | "deferred"
  /** Histories diverged and the merge conflicts. Local `main` was pushed to
   * `rescueBranch` on the remote so no work is stranded; resolution happens
   * at review level (e.g. a PR from that branch), never in the user's tree. */
  | "diverged";

export interface NetworkSyncResult {
  status: NetworkSyncStatus;
  localSha: string | null;
  remoteSha: string | null;
  rescueBranch?: string;
}

/**
 * Converge the dev repo's `main` with a branch on a network git remote.
 * Knows nothing about any particular code host — a URL plus optional
 * credentials is the entire contract (ADR 0044). Policy, in order: missing
 * remote branch → push; equal → up-to-date; strictly behind → fast-forward
 * (only over a clean tree); strictly ahead → push; diverged → 3-way merge
 * that aborts on conflict (a background sync must NEVER leave conflict
 * markers), falling back to pushing a rescue branch.
 */
export async function syncWithNetworkRemote(opts: {
  dev: ProjectRepo;
  url: string;
  credentials?: GitCredentials;
  remoteBranch: string;
  author: { name: string; email: string };
  /** Injectable clock for deterministic rescue-branch names in tests. */
  now?: Date;
}): Promise<NetworkSyncResult> {
  const { dev } = opts;
  const dir = dev.repoPath;

  const currentBranch = await dev.currentBranch();
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
      ref: "main",
      remoteBranch,
    });

  if (!remoteSha) {
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
    await push(opts.remoteBranch);
    return { status: "pushed", localSha, remoteSha: localSha };
  }

  const { dirty } = await dev.status();

  if (await isDescendent(remoteSha, localSha)) {
    if (dirty) return { status: "deferred", localSha, remoteSha };
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

  // Diverged histories.
  if (dirty) return { status: "deferred", localSha, remoteSha };
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

/** `catamorphic/diverged-YYYY-MM-DD_HH-mm` — groups rescue pushes on the host. */
function rescueBranchName(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `catamorphic/diverged-${now.getUTCFullYear()}-${pad(
    now.getUTCMonth() + 1,
  )}-${pad(now.getUTCDate())}_${pad(now.getUTCHours())}-${pad(
    now.getUTCMinutes(),
  )}`;
}
