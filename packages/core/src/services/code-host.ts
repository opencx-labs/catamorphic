import type { Json } from "@catamorphic/db";
import type { ConnectionCredentialVersion } from "./connection-providers.js";
import type { ConnectionPrincipalKind } from "./connection-types.js";

/**
 * One connection a code-host operation acts through (ADR 0177), opened for
 * the duration of a single call on the control plane. `material` is the
 * connection's sealed credential; it never leaves the host process.
 */
export interface CodeHostCredential {
  connection: ConnectionCredentialVersion;
  principalKind: ConnectionPrincipalKind;
  /** The provider's account summary (a login, an App installation). */
  account: Json;
  material: Uint8Array;
}

/** A repository as a code host describes it. */
export interface CodeHostRepository {
  /** Host-specific path, e.g. `owner/name`. */
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  description: string | null;
  /** ISO timestamp of the last push. */
  pushedAt: string | null;
}

interface CodeHostCall {
  credential: CodeHostCredential;
  remoteUrl: string;
}

/**
 * What a code host adds on top of a connection (ADRs 0044, 0177). Git
 * credentials for sync come from the connection provider's `git`
 * capability; a code host adds pull requests and repositories. Each call
 * receives the connection that backs the project's origin: the caller's own
 * member connection when they have one, else the service connection named
 * like the provider. Core never imports anything provider-specific;
 * `githubCodeHost` from `@catamorphic/server-sdk` is the first
 * implementation.
 */
export interface CodeHost {
  /** Kind of the connection provider this host acts through, e.g. `github`. */
  readonly provider: string;
  /** Open a pull request; `head` is already pushed. */
  createPullRequest?(
    input: CodeHostCall & {
      title: string;
      head: string;
      base: string;
      body?: string;
    },
  ): Promise<{ url: string; number: number }>;
  /** Open pull requests, most recently updated first. */
  listPullRequests?(input: CodeHostCall): Promise<PullRequestSummary[]>;
  /** One pull request regardless of its lifecycle state. */
  pullRequest?(
    input: CodeHostCall & { number: number },
  ): Promise<PullRequestSummary>;
  pullRequestDiscussion?(
    input: CodeHostCall & { number: number },
  ): Promise<PullRequestDiscussion>;
  commentOnPullRequest?(
    input: CodeHostCall & { number: number; body: string; replyTo?: number },
  ): Promise<PullRequestComment>;
  /** A pull request's changed files with patches. */
  pullRequestFiles?(
    input: CodeHostCall & { number: number },
  ): Promise<PullRequestFile[]>;
  /** Approve or request changes on the reviewed head. */
  reviewPullRequest?(
    input: CodeHostCall & {
      number: number;
      headSha: string;
      decision: "approve" | "request_changes";
      body?: string;
    },
  ): Promise<void>;
  /** Merge the reviewed head into its base. */
  mergePullRequest?(
    input: CodeHostCall & { number: number; headSha: string },
  ): Promise<void>;
  /** Who the connection acts as, for "your review" signals. */
  viewer?(input: { credential: CodeHostCredential }): Promise<{
    login: string;
  }>;
  /** Repositories the connection can reach, most recently pushed first. */
  listRepositories?(input: {
    credential: CodeHostCredential;
  }): Promise<CodeHostRepository[]>;
  repository?(input: {
    credential: CodeHostCredential;
    fullName: string;
  }): Promise<CodeHostRepository>;
  /** Create an empty repository; the first push defines its history. */
  createRepository?(input: {
    credential: CodeHostCredential;
    name: string;
    organization?: string;
    private: boolean;
  }): Promise<CodeHostRepository>;
}

/** Host-neutral PR shapes — what review surfaces render. */
export interface PullRequestSummary {
  body?: string;
  headSha?: string;
  viewerLogin?: string;
  requestedReviewers?: string[];
  reviewRequestedForViewer?: boolean;
  reviewRequestsUnavailable?: boolean;

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

export interface PullRequestComment {
  id: number;
  body: string;
  author: { login: string } | null;
  createdAt: string;
  url: string;
  state?: string;
  path?: string;
  line?: number | null;
  replyToId?: number;
  diffHunk?: string;
  side?: "LEFT" | "RIGHT";
}

export interface PullRequestDiscussion {
  state: string;
  reviewDecision: string | null;
  assignees: Array<{ login: string }>;
  reviewRequests: Array<{ login: string }>;
  reviews: PullRequestComment[];
  comments: PullRequestComment[];
  inlineComments: PullRequestComment[];
  inlineCommentsUnavailable: boolean;
  statusCheckRollup: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    detailsUrl: string;
  }>;
}
