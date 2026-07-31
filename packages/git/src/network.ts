import nodeFs from "node:fs";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import type { GitCredentials } from "./types.js";

export interface CloneFromRemoteOptions {
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
 * (`git-sync`, `openDev` seeding) assumes `main` throughout, so the remote
 * branch name is only remembered by the caller for push-back.
 *
 * Returns the checked-out sha and the remote's branch name.
 */
export async function cloneFromRemote(
  opts: CloneFromRemoteOptions,
): Promise<{ sha: string; remoteBranch: string }> {
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
 * Push a local ref to a network git remote, bypassing the repo's configured
 * `origin` (which catamorphic points at its internal remote backend). Used to
 * push project history back to a linked external repo such as GitHub.
 */
export async function pushToRemote(opts: {
  repoPath: string;
  url: string;
  credentials?: GitCredentials;
  /** Local ref to push. Defaults to `main`. */
  ref?: string;
  /** Branch name on the remote. Defaults to `ref`. */
  remoteBranch?: string;
  force?: boolean;
}): Promise<void> {
  const ref = opts.ref ?? "main";
  await git.push({
    fs: nodeFs,
    http,
    dir: opts.repoPath,
    url: opts.url,
    ref,
    remoteRef: `refs/heads/${opts.remoteBranch ?? ref}`,
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
  try {
    const result = await git.fetch({
      fs: nodeFs,
      http,
      dir: opts.repoPath,
      url: opts.url,
      ref: opts.branch,
      singleBranch: true,
      tags: false,
      onAuth: onAuthFor(opts.credentials),
    });
    return { sha: result.fetchHead };
  } catch (err) {
    if (err instanceof Error && /could not find/i.test(err.message)) {
      return { sha: null };
    }
    throw err;
  }
}
