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
 * The one push rule (ADR 0170). On an attached remote Work may only create or
 * fast-forward branches under `work/`; the default branch and every other
 * branch belong to the people who share the repository, and history there is
 * never rewritten. Owned remotes are unrestricted.
 */
export function assertPushAllowed(input: {
  ownership: RemoteOwnership;
  remoteBranch: string;
  force?: boolean;
}): void {
  if (input.ownership === "owned") return;
  if (!isManagedBranch(input.remoteBranch)) {
    throw new RemotePushRefusedError(
      input.remoteBranch,
      `this repository is attached, so Work only pushes branches it creates under '${MANAGED_BRANCH_PREFIX}'. Open a pull request instead.`,
    );
  }
  if (input.force) {
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
}): Promise<void> {
  const { ref, remoteBranch } = opts;
  // Plain names only: a `+`, `:` or leading `-` would smuggle a forced or
  // retargeted refspec past the rule below.
  for (const name of [ref, remoteBranch]) {
    if (!name || /[:\s+]|^-|^refs\/heads\//.test(name)) {
      throw new RemotePushRefusedError(name, "not a plain branch or ref name.");
    }
  }
  assertPushAllowed(opts);
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
