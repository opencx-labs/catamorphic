import nodeFs from "node:fs";
import { MANAGED_BRANCH_PREFIX } from "@catamorphic/workflow/project-layout";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import { nativeGit } from "./native-git.js";
import type { GitCredentials } from "./types.js";

export interface CloneFromRemoteOptions {
  native?: boolean;
  /** Directory that already holds an initialized (empty) git repo. */
  repoPath: string;
  url: string;
  credentials?: GitCredentials;
  /** Branch to clone; defaults to the remote's default branch. */
  branch?: string;
}

function onAuthFor(credentials?: GitCredentials) {
  return credentials
    ? () => ({
        username: credentials.username,
        password: credentials.password,
      })
    : undefined;
}

/**
 * Populate a freshly-initialized repo from a network git remote (e.g. a
 * GitHub repository). The remote's history lands on the local `main` branch
 * regardless of the remote's branch name — catamorphic's internal sync
 * (`git-sync`, drafts, checkout seeding) assumes `main` throughout, so the remote
 * branch name is only remembered by the caller for push-back.
 *
 * Returns the checked-out sha and the remote's branch name.
 */
export async function cloneFromRemote(
  opts: CloneFromRemoteOptions,
): Promise<{ sha: string; remoteBranch: string }> {
  if (opts.native) {
    const auth = opts.credentials
      ? { ...opts.credentials, url: opts.url }
      : undefined;
    await nativeGit(opts.repoPath, ["remote", "add", "origin", opts.url]);
    await nativeGit(opts.repoPath, ["fetch", "--tags", "origin"], auth);
    const remoteBranch =
      opts.branch ??
      (
        await nativeGit(
          opts.repoPath,
          ["ls-remote", "--symref", "origin", "HEAD"],
          auth,
        )
      ).match(/ref: refs\/heads\/(.+)\tHEAD/)?.[1];
    if (!remoteBranch)
      throw new Error("The repository has no default branch to check out");
    await nativeGit(opts.repoPath, [
      "checkout",
      "-B",
      remoteBranch,
      "--track",
      `origin/${remoteBranch}`,
    ]);
    await nativeGit(opts.repoPath, [
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      `refs/remotes/origin/${remoteBranch}`,
    ]);
    return {
      sha: (await nativeGit(opts.repoPath, ["rev-parse", "HEAD"])).trim(),
      remoteBranch,
    };
  }
  await git.addRemote({
    fs: nodeFs,
    dir: opts.repoPath,
    remote: "origin",
    url: opts.url,
    force: true,
  });

  const result = await git.fetch({
    fs: nodeFs,
    http,
    dir: opts.repoPath,
    remote: "origin",
    ...(opts.branch ? { ref: opts.branch } : {}),
    singleBranch: true,
    tags: false,
    onAuth: onAuthFor(opts.credentials),
  });

  const sha = result.fetchHead;
  if (!sha) {
    throw new Error(`Remote '${opts.url}' has no commits to clone`);
  }
  const remoteBranch =
    opts.branch ??
    (result.defaultBranch
      ? result.defaultBranch.replace(/^refs\/heads\//, "")
      : "main");

  await git.writeRef({
    fs: nodeFs,
    dir: opts.repoPath,
    ref: "refs/heads/main",
    value: sha,
    force: true,
  });
  await git.checkout({
    fs: nodeFs,
    dir: opts.repoPath,
    ref: "main",
    force: true,
  });

  return { sha, remoteBranch };
}

/**
 * Who created a linked network remote (ADR 0170). `owned`: Work created the
 * repository, so ADR 0044 sync may update its tracked branch. `attached`: the
 * repository existed before Work (an opened folder with an origin, a clone,
 * an imported company repository). Work never updates its default branch or
 * any branch it did not create there.
 */
export type RemoteOwnership = "owned" | "attached";

export class RemotePushRefusedError extends Error {
  constructor(
    readonly remoteBranch: string,
    reason: string,
  ) {
    super(`Work will not push '${remoteBranch}': ${reason}`);
    this.name = "RemotePushRefusedError";
  }
}

/** Whether `branch` is one Work creates: `work/<something>`. */
export function isManagedBranch(branch: string): boolean {
  return (
    branch.startsWith(MANAGED_BRANCH_PREFIX) &&
    branch.length > MANAGED_BRANCH_PREFIX.length
  );
}

/**
 * The one push rule (ADRs 0170, 0343). On an attached remote Work may only
 * create or fast-forward branches under `work/`; the default branch and
 * every other branch belong to the people who share the repository.
 * History there is rewritten in one case only: a chat force-updates its
 * own `work/` branch with a lease on the commit it last pushed, so
 * anything anyone else pushed there refuses the push instead of being
 * overwritten. Owned remotes are unrestricted.
 */
export function assertPushAllowed(input: {
  ownership: RemoteOwnership;
  remoteBranch: string;
  force?: boolean;
  /** The push names the commit it expects to replace. */
  lease?: boolean;
}): void {
  if (input.ownership === "owned") return;
  if (!isManagedBranch(input.remoteBranch)) {
    throw new RemotePushRefusedError(
      input.remoteBranch,
      `this repository is attached, so Work only pushes branches it creates under '${MANAGED_BRANCH_PREFIX}'. Open a pull request instead.`,
    );
  }
  if (input.force && !input.lease) {
    throw new RemotePushRefusedError(
      input.remoteBranch,
      "Work never rewrites history in an attached repository.",
    );
  }
}

/**
 * Push a local ref to a network git remote, bypassing the repo's configured
 * `origin` (which catamorphic points at its internal remote backend). Every
 * network push goes through here, so {@link assertPushAllowed} decides what
 * may reach a remote before anything is sent.
 */
export async function pushToRemote(opts: {
  repoPath: string;
  native?: boolean;
  url: string;
  credentials?: GitCredentials;
  /** Who created the remote: attached remotes only accept Work's branches. */
  ownership: RemoteOwnership;
  /** Local ref to push. */
  ref: string;
  /** Branch name on the remote (a plain name, not `refs/heads/...`). */
  remoteBranch: string;
  force?: boolean;
  /**
   * Replace the branch only while it still holds `expected` (null: only
   * while it does not exist). Native Git only.
   */
  lease?: { expected: string | null };
}): Promise<void> {
  const { ref, remoteBranch } = opts;
  // Plain names only: a `+`, `:` or leading `-` would smuggle a forced or
  // retargeted refspec past the rule below.
  for (const name of [ref, remoteBranch]) {
    if (!name || /[:\s+]|^-|^refs\/heads\//.test(name)) {
      throw new RemotePushRefusedError(name, "not a plain branch or ref name.");
    }
  }
  assertPushAllowed({
    ownership: opts.ownership,
    remoteBranch,
    force: opts.force ?? opts.lease !== undefined,
    lease: opts.lease !== undefined,
  });
  if (opts.lease) {
    const expected = opts.lease.expected ?? "";
    if (!opts.native || (expected && !/^[0-9a-f]{40,64}$/.test(expected)))
      throw new RemotePushRefusedError(
        remoteBranch,
        "a push with a lease names the commit it replaces.",
      );
    await nativeGit(
      opts.repoPath,
      [
        "push",
        `--force-with-lease=refs/heads/${remoteBranch}:${expected}`,
        opts.url,
        `${ref}:refs/heads/${remoteBranch}`,
      ],
      opts.credentials ? { ...opts.credentials, url: opts.url } : undefined,
    );
    return;
  }
  if (opts.native) {
    await nativeGit(
      opts.repoPath,
      [
        "push",
        ...(opts.force ? ["--force-with-lease"] : []),
        opts.url,
        `${ref}:refs/heads/${remoteBranch}`,
      ],
      opts.credentials ? { ...opts.credentials, url: opts.url } : undefined,
    );
    return;
  }
  await git.push({
    fs: nodeFs,
    http,
    dir: opts.repoPath,
    url: opts.url,
    ref,
    remoteRef: `refs/heads/${remoteBranch}`,
    force: opts.force ?? false,
    onAuth: onAuthFor(opts.credentials),
  });
}

/** The branch a chat last pushed to the project's repository (ADR 0343). */
export interface PushedBranch {
  branch: string;
  commit: string;
}

/**
 * Push a chat's branch (ADR 0343): a `work/` branch it creates, moves
 * forward, or, after a rebase, replaces. It replaces only a branch it
 * pushed before, and only while that branch still holds the commit it last
 * pushed there; anything a person or another chat pushed since refuses
 * the push. Never a branch outside `work/`, and never a deletion.
 */
export async function pushOwnBranch(opts: {
  repoPath: string;
  url: string;
  credentials?: GitCredentials;
  ownership: RemoteOwnership;
  /** The local commit to push. */
  commit: string;
  remoteBranch: string;
  /** What this chat last pushed, when it pushed before. */
  pushed?: PushedBranch;
}): Promise<{ outcome: "created" | "updated" | "replaced" | "unchanged" }> {
  const { remoteBranch, commit } = opts;
  if (!isManagedBranch(remoteBranch) || /[:\s+]|^-/.test(remoteBranch))
    throw new RemotePushRefusedError(
      remoteBranch,
      `a chat pushes only its own branch under '${MANAGED_BRANCH_PREFIX}'.`,
    );
  if (!/^[0-9a-f]{40,64}$/.test(commit))
    throw new RemotePushRefusedError(remoteBranch, "not a commit to push.");
  const auth = opts.credentials
    ? { ...opts.credentials, url: opts.url }
    : undefined;
  const listed = await nativeGit(
    opts.repoPath,
    ["ls-remote", opts.url, `refs/heads/${remoteBranch}`],
    auth,
  );
  const remote = listed.trim().split(/\s+/)[0] || null;
  const push = (lease: { expected: string | null } | undefined) =>
    pushToRemote({
      repoPath: opts.repoPath,
      native: true,
      url: opts.url,
      ...(opts.credentials ? { credentials: opts.credentials } : {}),
      ownership: opts.ownership,
      ref: commit,
      remoteBranch,
      ...(lease ? { lease } : {}),
    });
  const stale = (error: unknown): never => {
    throw isStaleLease(error)
      ? new RemotePushRefusedError(
          remoteBranch,
          "the branch changed in the repository while it was being pushed. Try again.",
        )
      : error;
  };
  if (!remote) {
    // Created only where nothing stands: a branch that appeared meanwhile
    // is someone else's.
    await push({ expected: null }).catch(stale);
    return { outcome: "created" };
  }
  // What is already there, or only moves forward, overwrites nothing:
  // the agent may have pushed its branch itself through the gateway.
  if (remote === commit) return { outcome: "unchanged" };
  const forward = await nativeGit(opts.repoPath, [
    "merge-base",
    "--is-ancestor",
    remote,
    commit,
  ]).then(
    () => true,
    () => false,
  );
  if (forward) {
    await push(undefined);
    return { outcome: "updated" };
  }
  // Replacing is for the chat's own branch alone, as it last left it.
  if (opts.pushed?.branch !== remoteBranch)
    throw new RemotePushRefusedError(
      remoteBranch,
      "a branch of that name is already in the repository with other commits, and this chat did not create it. Switch to another branch name and try again.",
    );
  if (remote !== opts.pushed.commit)
    throw new RemotePushRefusedError(
      remoteBranch,
      "someone else pushed to this branch since this chat last did, so it was not overwritten. Fetch the branch, rebase or merge onto it, and try again.",
    );
  await push({ expected: opts.pushed.commit }).catch(stale);
  return { outcome: "replaced" };
}

function isStaleLease(error: unknown): boolean {
  const text =
    error && typeof error === "object" && "stderr" in error
      ? String(error.stderr)
      : error instanceof Error
        ? error.message
        : "";
  return /stale info|\[rejected\]|already exists/i.test(text);
}

/**
 * Fetch a branch from a network remote into a tracking ref without touching
 * the working tree. Returns the fetched sha (null when the remote branch does
 * not exist).
 */
export async function fetchFromRemote(opts: {
  repoPath: string;
  url: string;
  credentials?: GitCredentials;
  branch: string;
}): Promise<{ sha: string | null }> {
  // Disposable origin snapshots have no network remote/refspec. Keep this
  // tracking namespace separate from the host's internal origin.
  const remote = "catamorphic-network";
  await git.addRemote({
    fs: nodeFs,
    dir: opts.repoPath,
    remote,
    url: opts.url,
    force: true,
  });
  try {
    const result = await git.fetch({
      fs: nodeFs,
      http,
      dir: opts.repoPath,
      url: opts.url,
      remote,
      ref: opts.branch,
      remoteRef: opts.branch,
      singleBranch: true,
      tags: false,
      onAuth: onAuthFor(opts.credentials),
    });
    return { sha: result.fetchHead };
  } catch (err) {
    if (
      err instanceof git.Errors.NotFoundError &&
      err.data.what === opts.branch
    ) {
      return { sha: null };
    }
    throw err;
  }
}
