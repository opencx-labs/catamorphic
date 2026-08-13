import type { GitCredentials } from "@catamorphic/git";
import type { Identity } from "../identity.js";

/**
 * The seam between generic git sync and a specific code host (ADR 0044).
 * The sync engine needs only `credentials`; everything else is an optional
 * capability. GitHub is the first implementation; GitLab, a self-hosted git
 * server, or git bolted onto S3-compatible storage are new implementations,
 * not rewrites — core never imports anything provider-specific.
 */
export interface CodeHost {
  /** Stable provider id, e.g. "github". */
  id: string;
  /** Whether this host can authenticate operations on the remote URL. */
  handles(remoteUrl: string): boolean;
  /**
   * Git-over-HTTP(S) credentials for the identity, or undefined when the
   * identity is not connected to this host.
   */
  credentials(identity: Identity): Promise<GitCredentials | undefined>;
  /** Optional capability: open a pull request on the host. */
  createPullRequest?(
    identity: Identity,
    input: {
      remoteUrl: string;
      title: string;
      /** Head branch name (already pushed to the remote). */
      head: string;
      /** Base branch name. */
      base: string;
      body?: string;
    },
  ): Promise<{ url: string; number: number }>;
  /** Optional capability: open pull requests, most recently updated first. */
  listPullRequests?(
    identity: Identity,
    input: { remoteUrl: string },
  ): Promise<PullRequestSummary[]>;
  /** Optional capability: a pull request's changed files with patches. */
  pullRequestFiles?(
    identity: Identity,
    input: { remoteUrl: string; number: number },
  ): Promise<PullRequestFile[]>;
}

/** Host-neutral PR shapes — what review surfaces render. */
export interface PullRequestSummary {
  number: number;
  title: string;
  url: string;
  author: string;
  head: string;
  base: string;
  draft: boolean;
  updatedAt: string;
}

export interface PullRequestFile {
  path: string;
  /** added | modified | removed | renamed | … */
  status: string;
  additions: number;
  deletions: number;
  /** Unified-diff hunk text; null for binary or oversized files. */
  patch: string | null;
  previousPath?: string;
}
