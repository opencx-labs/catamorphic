/**
 * The GitHub trigger library skills teach (ADR 0171, 0177): project trigger
 * kinds over the signed `github` webhook, for a repository or GitHub App
 * sending JSON to the project's `github` URL. One source, so the
 * `writing-workflows` and `reviewing-pull-requests` skills show the same
 * file a project commits as `.work/triggers/github.ts`.
 */
export const GITHUB_TRIGGER_LIBRARY = `// .work/triggers/github.ts
import { defineSecrets, defineTrigger, type Narrow, type TriggerPayload, trigger } from "@catamorphic/workflow";

/** Verifies deliveries on the control plane; never handed to a run. */
export const githubSecrets = defineSecrets({
  GITHUB_WEBHOOK_SECRET: { label: "GitHub webhook secret", use: "webhook" },
});

type Delivery<Body> = Narrow<TriggerPayload<"webhook">, { payload: { body: Body } }>;

export interface GithubUser {
  login: string;
  type: string;
}

export interface PullRequestEvent {
  action: string;
  number: number;
  /** On synchronize: the head before and after the push. */
  before?: string;
  after?: string;
  pull_request: {
    title: string;
    body: string | null;
    html_url: string;
    merged: boolean;
    draft: boolean;
    user: GithubUser;
    requested_reviewers: GithubUser[];
    head: { sha: string; ref: string };
    base: { sha: string; ref: string };
  };
  repository: { full_name: string };
  sender: GithubUser;
}

export interface IssueCommentEvent {
  action: string;
  issue: { number: number; title: string; state: string; html_url: string; pull_request?: { url: string } };
  comment: { id: number; body: string; html_url: string; user: GithubUser };
  repository: { full_name: string };
}

export interface PullRequestReviewCommentEvent {
  action: string;
  pull_request: { number: number; title: string; state: string; html_url: string };
  comment: { id: number; body: string; html_url: string; path: string; line: number | null; user: GithubUser };
  repository: { full_name: string };
}

/** Every signed delivery from the repository's webhook. */
export const delivery = defineTrigger({
  name: "github.delivery",
  description: "Any delivery from the GitHub webhook",
  from: trigger("webhook", {
    name: "github",
    verify: { scheme: "hmac", secret: "GITHUB_WEBHOOK_SECRET", header: "x-hub-signature-256", prefix: "sha256=" },
  }),
});

export const pullRequest = defineTrigger<Delivery<PullRequestEvent>>({
  name: "github.pull_request",
  description: "A pull request was opened, updated, or closed",
  from: trigger("github.delivery"),
  where: { payload: { headers: { "x-github-event": "pull_request" } } },
});

export const issueComment = defineTrigger<Delivery<IssueCommentEvent>>({
  name: "github.issue_comment",
  description: "Someone commented on an issue or pull request",
  from: trigger("github.delivery"),
  where: { payload: { headers: { "x-github-event": "issue_comment" }, body: { action: "created" } } },
});

export const pullRequestReviewComment = defineTrigger<Delivery<PullRequestReviewCommentEvent>>({
  name: "github.pull_request_review_comment",
  description: "Someone commented on a line of a pull request's diff",
  from: trigger("github.delivery"),
  where: { payload: { headers: { "x-github-event": "pull_request_review_comment" }, body: { action: "created" } } },
});
`;
