/** Mirror of core's host-neutral PR shapes. */
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

/** Unavailable is an expected project/connection state, not a failed request. */
export type PullRequestListResult =
  | { status: "ready"; items: PullRequestSummary[] }
  | {
      status: "unavailable";
      reason: "connection-disabled" | "sign-in-required" | "no-github-remote";
      message: string;
    };
