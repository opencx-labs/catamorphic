import {
  type FetchLike,
  type GithubActor,
  GithubApiError,
  type GithubCheckRun,
  type GithubCheckRunFields,
  type GithubComment,
  GithubGraphqlError,
  type GithubPullRequest,
  type GithubPullRequestFile,
  type GithubPullRequestReview,
  type GithubPullRequestStatus,
  type GithubRepo,
  type GithubRepositoryEvent,
  type GithubReviewComment,
  type GithubReviewEvent,
  type GithubReviewThread,
  type GithubReviewThreadComment,
  type GithubUser,
} from "./types.js";

const API_BASE = "https://api.github.com";

export interface GithubApiOptions {
  fetch?: FetchLike;
  baseUrl?: string;
  signal?: AbortSignal;
}

interface RawRepo {
  id: number;
  full_name: string;
  name: string;
  owner: { login: string };
  private: boolean;
  default_branch: string;
  clone_url: string;
  description: string | null;
  pushed_at: string | null;
}

interface RawPullRequest {
  number: number;
  title: string;
  html_url: string;
  user: { login: string } | null;
  head: { ref: string; sha?: string };
  body?: string | null;
  requested_reviewers?: Array<{ login: string }>;
  base: { ref: string };
  draft: boolean;
  updated_at: string;
}

/** The fields of a single pull request that its list entries lack. */
interface RawPullRequestDetail extends RawPullRequest {
  state: "open" | "closed";
  merged?: boolean;
  merged_at?: string | null;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  comments?: number;
  review_comments?: number;
}

interface RawCommitStatus {
  state: string;
  statuses: Array<{ state: string }>;
}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "startup_failure",
  "stale",
]);

interface RawWatchPull {
  id: number;
  number: number;
  updated_at: string;
  user: { login: string } | null;
  head: { sha: string };
  [key: string]: unknown;
}

interface RawPullReview {
  id: number;
  state: string;
  submitted_at: string;
  user: { login: string } | null;
  [key: string]: unknown;
}

interface RawWorkflowRun {
  id: number;
  run_attempt: number;
  status: string;
  conclusion: string | null;
  updated_at: string;
  actor: { login: string } | null;
  [key: string]: unknown;
}

interface RawCheckRun {
  id: number;
  status: string;
  conclusion: string | null;
  updated_at: string;
  app: { slug: string } | null;
  [key: string]: unknown;
}

interface RawCheckSuite {
  id: number;
  status: string;
  conclusion: string | null;
  updated_at: string;
  app: { slug: string } | null;
  [key: string]: unknown;
}

interface RawDiscussionComment {
  id: number;
  body: string;
  user: { login: string } | null;
  created_at?: string;
  submitted_at?: string;
  html_url: string;
  state?: string;
  path?: string;
  line?: number | null;
  in_reply_to_id?: number;
  diff_hunk?: string;
  side?: "LEFT" | "RIGHT";
}

interface RawUser {
  login: string;
  id: number;
  type?: string;
}

interface RawReview {
  id: number;
  state: string;
  user: RawUser | null;
  body: string | null;
  commit_id: string | null;
  submitted_at?: string | null;
  html_url: string;
  pull_request_url?: string;
}

interface RawComment {
  id: number;
  user: RawUser | null;
  body: string | null;
  html_url: string;
  pull_request_url?: string;
  issue_url?: string;
  in_reply_to_id?: number;
}

/** GraphQL's actor: a bot's login has no `[bot]` suffix there. */
interface RawGraphqlActor {
  __typename: string;
  login: string;
  databaseId?: number | null;
}

interface RawThreadComment {
  databaseId: number;
  body: string;
  url: string;
  createdAt: string;
  author: RawGraphqlActor | null;
}

interface RawThreadComments {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: RawThreadComment[];
}

interface RawThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: "LEFT" | "RIGHT" | null;
  comments: RawThreadComments;
}

/** Any node by id: only a review thread fills the thread fields. */
interface RawThreadNode {
  __typename: string;
  id?: string;
  isResolved?: boolean;
  pullRequest?: { number: number; repository: { nameWithOwner: string } };
  comments?: { nodes: RawThreadComment[] };
}

const THREAD_COMMENT_FIELDS = `databaseId body url createdAt
  author { __typename login ... on User { databaseId } }`;

const REVIEW_THREADS_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line startLine diffSide
          comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT_FIELDS} } }
        }
      }
    }
  }
}`;

const THREAD_COMMENTS_QUERY = `query ThreadComments($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT_FIELDS} } }
    }
  }
}`;

const REVIEW_THREAD_QUERY = `query ReviewThread($id: ID!) {
  node(id: $id) {
    __typename
    ... on PullRequestReviewThread {
      id isResolved
      pullRequest { number repository { nameWithOwner } }
      comments(first: 1) { nodes { ${THREAD_COMMENT_FIELDS} } }
    }
  }
}`;

const RESOLVE_REVIEW_THREAD_MUTATION = `mutation ResolveReviewThread($id: ID!) {
  resolveReviewThread(input: { threadId: $id }) { thread { id isResolved } }
}`;

/** Most pages any paginated read follows, so a loop always ends. */
const MAX_PAGES = 50;

function actorOf(user: RawUser | null): GithubActor | null {
  return user
    ? { login: user.login, type: user.type ?? "User", id: user.id }
    : null;
}

function graphqlActorOf(actor: RawGraphqlActor | null): GithubActor | null {
  if (!actor) return null;
  const bot = actor.__typename === "Bot";
  return {
    login:
      bot && !actor.login.endsWith("[bot]")
        ? `${actor.login}[bot]`
        : actor.login,
    type: actor.__typename,
    id: actor.databaseId ?? null,
  };
}

function threadCommentOf(raw: RawThreadComment): GithubReviewThreadComment {
  return {
    id: raw.databaseId,
    author: graphqlActorOf(raw.author),
    body: raw.body,
    url: raw.url,
    createdAt: raw.createdAt,
  };
}

function reviewOf(raw: RawReview): GithubPullRequestReview {
  return {
    id: raw.id,
    state: raw.state,
    author: actorOf(raw.user),
    body: raw.body ?? "",
    commitId: raw.commit_id ?? null,
    submittedAt: raw.submitted_at ?? null,
    url: raw.html_url,
    number: trailingNumber(raw.pull_request_url, "pulls"),
  };
}

function commentOf(raw: RawComment): GithubComment {
  return {
    id: raw.id,
    author: actorOf(raw.user),
    body: raw.body ?? "",
    url: raw.html_url,
    number:
      trailingNumber(raw.pull_request_url, "pulls") ??
      trailingNumber(raw.issue_url, "issues"),
    ...(raw.in_reply_to_id ? { inReplyTo: raw.in_reply_to_id } : {}),
  };
}

/** `…/pulls/42` → 42; null when the URL does not end that way. */
function trailingNumber(
  url: string | undefined,
  collection: "pulls" | "issues",
): number | null {
  const match = url ? new RegExp(`/${collection}/(\\d+)$`).exec(url) : null;
  return match?.[1] ? Number(match[1]) : null;
}

function pullRequestSummary(pr: RawPullRequest): GithubPullRequest {
  return {
    number: pr.number,
    body: pr.body ?? "",
    headSha: pr.head.sha,
    requestedReviewers: pr.requested_reviewers?.map((user) => user.login) ?? [],
    title: pr.title,
    url: pr.html_url,
    author: pr.user?.login ?? "unknown",
    head: pr.head.ref,
    base: pr.base.ref,
    draft: pr.draft,
    updatedAt: pr.updated_at,
  };
}

function discussionComment(raw: RawDiscussionComment) {
  return {
    id: raw.id,
    body: raw.body ?? "",
    author: raw.user,
    createdAt: raw.created_at ?? raw.submitted_at ?? "",
    url: raw.html_url,
    ...(raw.state ? { state: raw.state } : {}),
    ...(raw.path ? { path: raw.path, line: raw.line } : {}),
    ...(raw.in_reply_to_id ? { replyToId: raw.in_reply_to_id } : {}),
    ...(raw.diff_hunk ? { diffHunk: raw.diff_hunk } : {}),
    ...(raw.side ? { side: raw.side } : {}),
  };
}

/** Minimal REST client bound to one user access token. */
export class GithubApi {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;
  private readonly signal?: AbortSignal;

  constructor(
    private readonly accessToken: string,
    opts?: GithubApiOptions,
  ) {
    this.fetch = opts?.fetch ?? fetch;
    this.baseUrl = opts?.baseUrl ?? API_BASE;
    this.signal = opts?.signal;
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...(this.signal ? { signal: this.signal } : {}),
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init?.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new GithubApiError(
        response.status,
        body.message ?? `GitHub API returned ${response.status}`,
      );
    }
    return (await response.json()) as T;
  }

  private async requestPages<T>(path: string): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>(
        `${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
      );
      values.push(...batch);
      if (batch.length < 100) return values;
    }
  }

  /** A call GitHub answers with no body (204), such as a DELETE. */
  private async requestNoContent(path: string, method: string): Promise<void> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
      ...(this.signal ? { signal: this.signal } : {}),
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${this.accessToken}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        message?: string;
      };
      throw new GithubApiError(
        response.status,
        body.message ?? `GitHub API returned ${response.status}`,
      );
    }
  }

  /**
   * One GraphQL request against {@link githubGraphqlUrl} of the API base.
   * HTTP failures throw {@link GithubApiError}; an answer carrying `errors`
   * throws {@link GithubGraphqlError}, so a partial answer is never taken
   * for a whole one.
   */
  async graphql<T>(
    query: string,
    variables: Readonly<Record<string, unknown>> = {},
  ): Promise<T> {
    const response = await this.fetch(githubGraphqlUrl(this.baseUrl), {
      ...(this.signal ? { signal: this.signal } : {}),
      method: "POST",
      redirect: "error",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await response.json().catch(() => ({}))) as {
      data?: T | null;
      errors?: Array<{ message?: string; type?: string }>;
      message?: string;
    };
    if (!response.ok) {
      throw new GithubApiError(
        response.status,
        body.message ?? `GitHub GraphQL returned ${response.status}`,
      );
    }
    if (body.errors?.length) {
      throw new GithubGraphqlError(
        body.errors.map((error) => ({
          message: error.message ?? "unknown error",
          ...(error.type ? { type: error.type } : {}),
        })),
        response.status,
      );
    }
    if (body.data === undefined || body.data === null) {
      throw new GithubApiError(
        response.status,
        "GitHub GraphQL returned no data",
      );
    }
    return body.data;
  }

  /**
   * Every review thread of a pull request with all of its comments, oldest
   * first, following GraphQL's pages.
   */
  async reviewThreads(input: {
    fullName: string;
    number: number;
  }): Promise<GithubReviewThread[]> {
    const [owner = "", name = ""] = repositoryPath(input.fullName).split("/");
    const threads: GithubReviewThread[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: RawThread[];
            };
          } | null;
        } | null;
      } = await this.graphql(REVIEW_THREADS_QUERY, {
        owner,
        name,
        number: positive(input.number),
        after,
      });
      const connection = data.repository?.pullRequest?.reviewThreads;
      if (!connection) {
        throw new GithubApiError(
          404,
          `Pull request ${input.fullName}#${input.number} was not found`,
        );
      }
      for (const thread of connection.nodes) {
        const comments = thread.comments.nodes.map(threadCommentOf);
        let more = thread.comments.pageInfo;
        for (let next = 0; more.hasNextPage && next < MAX_PAGES; next++) {
          const rest: { node: { comments: RawThreadComments } | null } =
            await this.graphql(THREAD_COMMENTS_QUERY, {
              id: thread.id,
              after: more.endCursor,
            });
          if (!rest.node) break;
          comments.push(...rest.node.comments.nodes.map(threadCommentOf));
          more = rest.node.comments.pageInfo;
        }
        threads.push({
          id: thread.id,
          isResolved: thread.isResolved,
          isOutdated: thread.isOutdated,
          path: thread.path,
          line: thread.line,
          startLine: thread.startLine,
          side: thread.diffSide,
          comments,
        });
      }
      if (!connection.pageInfo.hasNextPage) return threads;
      after = connection.pageInfo.endCursor;
    }
    throw new GithubApiError(
      422,
      `${input.fullName}#${input.number} has more review threads than Work reads`,
    );
  }

  /**
   * One review thread by node id: where it lives, whether it is resolved,
   * and its first comment. Null when the id names no review thread.
   */
  async reviewThread(input: { threadId: string }): Promise<{
    id: string;
    isResolved: boolean;
    repository: string;
    number: number;
    firstComment: GithubReviewThreadComment | null;
  } | null> {
    const data = await this.graphql<{ node: RawThreadNode | null }>(
      REVIEW_THREAD_QUERY,
      { id: input.threadId },
    ).catch((error: unknown) => {
      if (
        error instanceof GithubGraphqlError &&
        error.errors.every((entry) => entry.type === "NOT_FOUND")
      )
        return null;
      throw error;
    });
    const node = data?.node;
    if (
      node?.__typename !== "PullRequestReviewThread" ||
      !node.id ||
      !node.pullRequest
    )
      return null;
    const [first] = node.comments?.nodes ?? [];
    return {
      id: node.id,
      isResolved: node.isResolved === true,
      repository: node.pullRequest.repository.nameWithOwner,
      number: node.pullRequest.number,
      firstComment: first ? threadCommentOf(first) : null,
    };
  }

  /** Mark a review thread resolved (GraphQL `resolveReviewThread`). */
  async resolveReviewThread(input: {
    threadId: string;
  }): Promise<{ id: string; isResolved: boolean }> {
    const data = await this.graphql<{
      resolveReviewThread: {
        thread: { id: string; isResolved: boolean };
      } | null;
    }>(RESOLVE_REVIEW_THREAD_MUTATION, { id: input.threadId });
    const thread = data.resolveReviewThread?.thread;
    if (!thread) {
      throw new GithubApiError(422, "GitHub did not resolve the review thread");
    }
    return { id: thread.id, isResolved: thread.isResolved };
  }

  /** Replace a pull request's description. */
  async updatePullRequest(input: {
    fullName: string;
    number: number;
    body: string;
  }): Promise<{ number: number; url: string; body: string }> {
    const raw = await this.request<{
      number: number;
      html_url: string;
      body: string | null;
    }>(
      `/repos/${repositoryPath(input.fullName)}/pulls/${positive(input.number)}`,
      { method: "PATCH", body: { body: input.body } },
    );
    return { number: raw.number, url: raw.html_url, body: raw.body ?? "" };
  }

  /** A pull request's reviews, oldest first. */
  async listReviews(input: {
    fullName: string;
    number: number;
  }): Promise<GithubPullRequestReview[]> {
    const raw = await this.requestPages<RawReview>(
      `/repos/${repositoryPath(input.fullName)}/pulls/${positive(input.number)}/reviews`,
    );
    return raw.map(reviewOf);
  }

  async review(input: {
    fullName: string;
    number: number;
    reviewId: number;
  }): Promise<GithubPullRequestReview> {
    return reviewOf(
      await this.request<RawReview>(
        `/repos/${repositoryPath(input.fullName)}/pulls/${positive(input.number)}/reviews/${positive(input.reviewId)}`,
      ),
    );
  }

  /**
   * Dismiss a review that approved or requested changes, so it no longer
   * counts toward the pull request's review decision.
   */
  async dismissReview(input: {
    fullName: string;
    number: number;
    reviewId: number;
    message: string;
  }): Promise<GithubPullRequestReview> {
    return reviewOf(
      await this.request<RawReview>(
        `/repos/${repositoryPath(input.fullName)}/pulls/${positive(input.number)}/reviews/${positive(input.reviewId)}/dismissals`,
        {
          method: "PUT",
          body: { message: input.message, event: "DISMISS" },
        },
      ),
    );
  }

  /** A pull request review comment (an inline comment) by id. */
  async reviewComment(input: {
    fullName: string;
    commentId: number;
  }): Promise<GithubComment> {
    return commentOf(
      await this.request<RawComment>(
        `/repos/${repositoryPath(input.fullName)}/pulls/comments/${positive(input.commentId)}`,
      ),
    );
  }

  /** An issue or pull request conversation comment by id. */
  async issueComment(input: {
    fullName: string;
    commentId: number;
  }): Promise<GithubComment> {
    return commentOf(
      await this.request<RawComment>(
        `/repos/${repositoryPath(input.fullName)}/issues/comments/${positive(input.commentId)}`,
      ),
    );
  }

  async updateIssueComment(input: {
    fullName: string;
    commentId: number;
    body: string;
  }): Promise<GithubComment> {
    return commentOf(
      await this.request<RawComment>(
        `/repos/${repositoryPath(input.fullName)}/issues/comments/${positive(input.commentId)}`,
        { method: "PATCH", body: { body: input.body } },
      ),
    );
  }

  async deleteIssueComment(input: {
    fullName: string;
    commentId: number;
  }): Promise<void> {
    await this.requestNoContent(
      `/repos/${repositoryPath(input.fullName)}/issues/comments/${positive(input.commentId)}`,
      "DELETE",
    );
  }

  async getUser(): Promise<GithubUser> {
    const raw = await this.request<{
      login: string;
      id: number;
      avatar_url: string;
      name: string | null;
    }>("/user");
    return {
      login: raw.login,
      id: raw.id,
      avatarUrl: raw.avatar_url,
      name: raw.name,
    };
  }

  async getRepo(fullName: string): Promise<GithubRepo> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
    }
    return mapRepo(await this.request<RawRepo>(`/repos/${fullName}`));
  }

  /**
   * Create an empty repository for the authenticated user, or in
   * `organization` when given. Nothing is initialized, so the first push
   * defines its history.
   */
  async createRepo(input: {
    name: string;
    organization?: string;
    private: boolean;
    description?: string;
  }): Promise<GithubRepo> {
    if (!/^[\w.-]+$/.test(input.name)) {
      throw new GithubApiError(400, `Invalid repository name: ${input.name}`);
    }
    if (input.organization && !/^[\w.-]+$/.test(input.organization)) {
      throw new GithubApiError(
        400,
        `Invalid organization: ${input.organization}`,
      );
    }
    return mapRepo(
      await this.request<RawRepo>(
        input.organization
          ? `/orgs/${input.organization}/repos`
          : "/user/repos",
        {
          method: "POST",
          body: {
            name: input.name,
            private: input.private,
            auto_init: false,
            ...(input.description !== undefined
              ? { description: input.description }
              : {}),
          },
        },
      ),
    );
  }

  /**
   * Open a pull request. `head` and `base` are branch names in the same
   * repository (cross-fork PRs are out of scope for now).
   */
  async createPullRequest(
    fullName: string,
    input: { title: string; head: string; base: string; body?: string },
  ): Promise<{ url: string; number: number }> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
    }
    const raw = await this.request<{ html_url: string; number: number }>(
      `/repos/${fullName}/pulls`,
      {
        method: "POST",
        body: {
          title: input.title,
          head: input.head,
          base: input.base,
          ...(input.body !== undefined ? { body: input.body } : {}),
        },
      },
    );
    return { url: raw.html_url, number: raw.number };
  }

  async pullRequestDiscussion(input: { fullName: string; number: number }) {
    const base = `/repos/${input.fullName}`;
    const pull = await this.request<{
      state: string;
      merged: boolean;
      head: { sha: string };
      assignees: Array<{ login: string }>;
      requested_reviewers: Array<{ login: string }>;
    }>(`${base}/pulls/${input.number}`);
    const [reviews, comments, inlineComments, checks] = await Promise.all([
      this.requestPages<RawDiscussionComment>(
        `${base}/pulls/${input.number}/reviews`,
      ),
      this.requestPages<RawDiscussionComment>(
        `${base}/issues/${input.number}/comments`,
      ),
      this.requestPages<RawDiscussionComment>(
        `${base}/pulls/${input.number}/comments`,
      ),
      this.request<{
        check_runs: Array<{
          name: string;
          status: string;
          conclusion: string | null;
          html_url: string;
        }>;
      }>(`${base}/commits/${pull.head.sha}/check-runs?per_page=100`),
    ]);
    return {
      state: pull.merged ? "MERGED" : pull.state.toUpperCase(),
      reviewDecision: null,
      assignees: pull.assignees.map(({ login }) => ({ login })),
      reviewRequests: pull.requested_reviewers.map(({ login }) => ({ login })),
      reviews: reviews.map(discussionComment),
      comments: comments.map(discussionComment),
      inlineComments: inlineComments.map(discussionComment),
      inlineCommentsUnavailable: false,
      statusCheckRollup: checks.check_runs.map((check) => ({
        name: check.name,
        status: check.status.toUpperCase(),
        conclusion: check.conclusion?.toUpperCase() ?? null,
        detailsUrl: check.html_url,
      })),
    };
  }

  async commentOnPullRequest(input: {
    fullName: string;
    number: number;
    body: string;
    replyTo?: number;
  }) {
    const endpoint = input.replyTo
      ? `/repos/${input.fullName}/pulls/${input.number}/comments/${input.replyTo}/replies`
      : `/repos/${input.fullName}/issues/${input.number}/comments`;
    return discussionComment(
      await this.request<RawDiscussionComment>(endpoint, {
        method: "POST",
        body: { body: input.body },
      }),
    );
  }

  /**
   * Submit a pull request review, optionally with inline comments anchored
   * to lines of the diff. Without `event` the review stays pending on GitHub;
   * `COMMENT` publishes it without a verdict.
   */
  async createReview(input: {
    fullName: string;
    number: number;
    event?: GithubReviewEvent;
    body?: string;
    /** The revision reviewed; defaults to the pull request's current head. */
    commitId?: string;
    comments?: readonly GithubReviewComment[];
  }): Promise<{ id: number; url: string; state: string }> {
    const raw = await this.request<{
      id: number;
      html_url: string;
      state: string;
    }>(
      `/repos/${repositoryPath(input.fullName)}/pulls/${positive(input.number)}/reviews`,
      {
        method: "POST",
        body: {
          ...(input.event ? { event: input.event } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.commitId ? { commit_id: input.commitId } : {}),
          ...(input.comments?.length
            ? {
                comments: input.comments.map((comment) => ({
                  path: comment.path,
                  body: comment.body,
                  ...(comment.line !== undefined ? { line: comment.line } : {}),
                  ...(comment.side ? { side: comment.side } : {}),
                  ...(comment.startLine !== undefined
                    ? { start_line: comment.startLine }
                    : {}),
                  ...(comment.startSide
                    ? { start_side: comment.startSide }
                    : {}),
                })),
              }
            : {}),
        },
      },
    );
    return { id: raw.id, url: raw.html_url, state: raw.state };
  }

  /** Report a check run on a commit (requires the app's `checks` permission). */
  async createCheckRun(
    input: GithubCheckRunFields & {
      fullName: string;
      name: string;
      headSha: string;
    },
  ): Promise<GithubCheckRun> {
    return mapCheckRun(
      await this.request<RawCheckRunResult>(
        `/repos/${repositoryPath(input.fullName)}/check-runs`,
        {
          method: "POST",
          body: {
            name: input.name,
            head_sha: input.headSha,
            ...checkRunBody(input),
          },
        },
      ),
    );
  }

  async updateCheckRun(
    input: GithubCheckRunFields & {
      fullName: string;
      checkRunId: number;
      name?: string;
    },
  ): Promise<GithubCheckRun> {
    return mapCheckRun(
      await this.request<RawCheckRunResult>(
        `/repos/${repositoryPath(input.fullName)}/check-runs/${positive(input.checkRunId)}`,
        {
          method: "PATCH",
          body: {
            ...(input.name ? { name: input.name } : {}),
            ...checkRunBody(input),
          },
        },
      ),
    );
  }

  /** Tie each review to the exact revision the reviewer inspected. */
  async reviewPullRequest(input: {
    fullName: string;
    number: number;
    headSha: string;
    decision: "APPROVE" | "REQUEST_CHANGES";
    body: string;
  }): Promise<void> {
    const current = await this.request<{
      state: string;
      head: { sha: string };
    }>(`/repos/${input.fullName}/pulls/${input.number}`);
    if (current.state !== "open" || current.head.sha !== input.headSha)
      throw new Error(
        "This proposal changed since you opened it. Refresh and review the latest changes.",
      );
    await this.request(
      `/repos/${input.fullName}/pulls/${input.number}/reviews`,
      {
        method: "POST",
        body: {
          commit_id: input.headSha,
          event: input.decision,
          body: input.body,
        },
      },
    );
  }

  async mergePullRequest(input: {
    fullName: string;
    number: number;
    headSha: string;
  }): Promise<{ sha: string }> {
    const result = await this.request<{
      merged: boolean;
      sha: string;
      message: string;
    }>(`/repos/${input.fullName}/pulls/${input.number}/merge`, {
      method: "PUT",
      body: { sha: input.headSha, merge_method: "squash" },
    });
    if (!result.merged)
      throw new Error(result.message || "The proposal could not be applied");
    return { sha: result.sha };
  }

  /** GitHub includes direct and team requests in review-requested:@me. */
  private async requestedReviewNumbers(fullName: string): Promise<Set<number>> {
    const numbers = new Set<number>();
    const query = encodeURIComponent(
      `repo:${fullName} is:pr is:open review-requested:@me`,
    );
    for (let page = 1; page <= 10; page++) {
      const result = await this.request<{
        items: Array<{ number: number }>;
        incomplete_results: boolean;
        total_count: number;
      }>(`/search/issues?q=${query}&per_page=100&page=${page}`);
      if (result.incomplete_results || result.total_count > 1000)
        throw new Error("Review request search is incomplete");
      for (const item of result.items) numbers.add(item.number);
      if (result.items.length < 100 || numbers.size >= result.total_count)
        return numbers;
    }
    throw new Error("Review request search is incomplete");
  }

  /** Open pull requests, most recently updated first. */
  async listPullRequests(fullName: string): Promise<GithubPullRequest[]> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
    }
    const raw = await this.requestPages<RawPullRequest>(
      `/repos/${fullName}/pulls?state=open&sort=updated&direction=desc`,
    );
    const requested = raw.length
      ? await this.requestedReviewNumbers(fullName).catch(() => undefined)
      : new Set<number>();
    return raw.map((pr) => ({
      ...(requested
        ? { reviewRequestedForViewer: requested.has(pr.number) }
        : { reviewRequestsUnavailable: true }),
      ...pullRequestSummary(pr),
    }));
  }

  /** Read an individual pull request, including completed proposals. */
  async pullRequest(input: {
    fullName: string;
    number: number;
  }): Promise<GithubPullRequest> {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(input.fullName) ||
      !Number.isSafeInteger(input.number) ||
      input.number <= 0
    )
      throw new GithubApiError(400, "Invalid pull request");
    return pullRequestSummary(
      await this.request<RawPullRequest>(
        `/repos/${input.fullName}/pulls/${input.number}`,
      ),
    );
  }

  /**
   * Where a pull request stands: open, draft, merged or closed, how much it
   * changes, how many comments it has and what its head's checks say. A
   * token that cannot read checks still reads the rest.
   */
  async pullRequestStatus(input: {
    fullName: string;
    number: number;
  }): Promise<GithubPullRequestStatus> {
    if (
      !/^[\w.-]+\/[\w.-]+$/.test(input.fullName) ||
      !Number.isSafeInteger(input.number) ||
      input.number <= 0
    )
      throw new GithubApiError(400, "Invalid pull request");
    const pr = await this.request<RawPullRequestDetail>(
      `/repos/${input.fullName}/pulls/${input.number}`,
    );
    const checks =
      pr.state === "open" && pr.head.sha
        ? await this.checksOf(input.fullName, pr.head.sha).catch(
            () => undefined,
          )
        : undefined;
    return {
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      repository: input.fullName,
      author: pr.user?.login ?? "unknown",
      head: pr.head.ref,
      base: pr.base.ref,
      state:
        pr.merged || pr.merged_at
          ? "merged"
          : pr.state === "closed"
            ? "closed"
            : pr.draft
              ? "draft"
              : "open",
      additions: pr.additions ?? 0,
      deletions: pr.deletions ?? 0,
      changedFiles: pr.changed_files ?? 0,
      comments: (pr.comments ?? 0) + (pr.review_comments ?? 0),
      ...(checks ? { checks } : {}),
      updatedAt: pr.updated_at,
    };
  }

  /** Check runs and commit statuses on one commit, counted together. */
  private async checksOf(
    fullName: string,
    sha: string,
  ): Promise<GithubPullRequestStatus["checks"]> {
    const [runs, status] = await Promise.all([
      this.request<{ check_runs: RawCheckRun[] }>(
        `/repos/${fullName}/commits/${sha}/check-runs?per_page=100`,
      ),
      this.request<RawCommitStatus>(
        `/repos/${fullName}/commits/${sha}/status`,
      ).catch(() => undefined),
    ]);
    const counts = { passed: 0, failed: 0, pending: 0 };
    for (const run of runs.check_runs) {
      if (run.status !== "completed") counts.pending += 1;
      else if (run.conclusion && FAILED_CONCLUSIONS.has(run.conclusion))
        counts.failed += 1;
      else counts.passed += 1;
    }
    for (const entry of status?.statuses ?? []) {
      if (entry.state === "pending") counts.pending += 1;
      else if (entry.state === "success") counts.passed += 1;
      else counts.failed += 1;
    }
    if (counts.passed + counts.failed + counts.pending === 0) return undefined;
    return {
      state:
        counts.failed > 0
          ? "failure"
          : counts.pending > 0
            ? "pending"
            : "success",
      ...counts,
    };
  }

  /** Changed files of a pull request, with unified-diff patches. */
  async pullRequestFiles(
    fullName: string,
    number: number,
  ): Promise<GithubPullRequestFile[]> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
    }
    const raw = await this.requestPages<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch?: string;
      previous_filename?: string;
    }>(`/repos/${fullName}/pulls/${number}/files`);
    return raw.map((file) => ({
      path: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      // Absent for binary/huge files — the viewer shows a placeholder.
      patch: file.patch ?? null,
      ...(file.previous_filename
        ? { previousPath: file.previous_filename }
        : {}),
    }));
  }

  /** Repository activity available to the connected user. */
  async listRepositoryEvents(
    fullName: string,
  ): Promise<GithubRepositoryEvent[]> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
    }
    const raw = await this.request<
      Array<{
        id: string;
        type: string;
        actor: { login: string } | null;
        created_at: string;
        payload: unknown;
      }>
    >(`/repos/${fullName}/events?per_page=100`);
    return raw.map((event) => ({
      id: event.id,
      type: event.type,
      actor: event.actor?.login ?? null,
      createdAt: event.created_at,
      payload: event.payload,
    }));
  }

  /**
   * Complete polling surface for desktop Watchers. The repository Events API
   * omits some check and Actions transitions, so merge state-stamped snapshots
   * from the dedicated APIs. Unsupported permission slices degrade to the
   * events the connected user can read instead of disabling the monitor.
   */
  async listRepositoryWatchEvents(
    fullName: string,
  ): Promise<GithubRepositoryEvent[]> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
    }
    const [events, pulls, workflowRuns] = await Promise.all([
      this.listRepositoryEvents(fullName),
      this.optionalRequest<RawWatchPull[]>(
        `/repos/${fullName}/pulls?state=all&sort=updated&direction=desc&per_page=25`,
        [],
      ),
      this.optionalRequest<{ workflow_runs: RawWorkflowRun[] }>(
        `/repos/${fullName}/actions/runs?per_page=100`,
        { workflow_runs: [] },
      ),
    ]);
    const recentPulls = pulls.slice(0, 3);
    const pullDetails = await Promise.all(
      recentPulls.map(async (pull) => {
        const [reviews, runs, suites] = await Promise.all([
          this.optionalRequest<RawPullReview[]>(
            `/repos/${fullName}/pulls/${pull.number}/reviews?per_page=100`,
            [],
          ),
          this.optionalRequest<{ check_runs: RawCheckRun[] }>(
            `/repos/${fullName}/commits/${pull.head.sha}/check-runs?filter=all&per_page=100`,
            { check_runs: [] },
          ),
          this.optionalRequest<{ check_suites: RawCheckSuite[] }>(
            `/repos/${fullName}/commits/${pull.head.sha}/check-suites?per_page=100`,
            { check_suites: [] },
          ),
        ]);
        return {
          pull,
          reviews,
          runs: runs.check_runs,
          suites: suites.check_suites,
        };
      }),
    );
    const snapshots: GithubRepositoryEvent[] = [
      ...pulls.map((pull) => ({
        id: `pull_request:${pull.id}:${pull.updated_at}`,
        type: "PullRequestEvent",
        actor: pull.user?.login ?? null,
        createdAt: pull.updated_at,
        payload: { action: "updated", number: pull.number, pull_request: pull },
      })),
      ...workflowRuns.workflow_runs.map((run) => ({
        id: `workflow_run:${run.id}:${run.run_attempt}:${run.updated_at}:${run.status}:${run.conclusion ?? ""}`,
        type: "WorkflowRunEvent",
        actor: run.actor?.login ?? null,
        createdAt: run.updated_at,
        payload: { action: run.status, workflow_run: run },
      })),
      ...pullDetails.flatMap(({ pull, reviews, runs, suites }) => [
        ...reviews.map((review) => ({
          id: `pull_request_review:${review.id}:${review.submitted_at}:${review.state}`,
          type: "PullRequestReviewEvent",
          actor: review.user?.login ?? null,
          createdAt: review.submitted_at,
          payload: { action: "submitted", review, pull_request: pull },
        })),
        ...runs.map((run) => ({
          id: `check_run:${run.id}:${run.updated_at}:${run.status}:${run.conclusion ?? ""}`,
          type: "CheckRunEvent",
          actor: run.app?.slug ?? null,
          createdAt: run.updated_at,
          payload: { action: run.status, check_run: run, pull_request: pull },
        })),
        ...suites.map((suite) => ({
          id: `check_suite:${suite.id}:${suite.updated_at}:${suite.status}:${suite.conclusion ?? ""}`,
          type: "CheckSuiteEvent",
          actor: suite.app?.slug ?? null,
          createdAt: suite.updated_at,
          payload: {
            action: suite.status,
            check_suite: suite,
            pull_request: pull,
          },
        })),
      ]),
    ];
    return [...events, ...snapshots]
      .filter(
        (event, index, all) =>
          all.findIndex((candidate) => candidate.id === event.id) === index,
      )
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  private async optionalRequest<T>(path: string, fallback: T): Promise<T> {
    try {
      return await this.request<T>(path);
    } catch (error) {
      if (
        error instanceof GithubApiError &&
        (error.status === 403 || error.status === 404)
      ) {
        return fallback;
      }
      throw error;
    }
  }

  /**
   * Repositories the authenticated user can access. GitHub supports this one
   * endpoint for GitHub App user tokens, fine-grained tokens, and the OAuth
   * token exposed by `gh`, so every credential source follows the same API.
   */
  async listAccessibleRepos(opts?: {
    perPage?: number;
  }): Promise<GithubRepo[]> {
    const perPage = opts?.perPage ?? 100;
    const repos: GithubRepo[] = [];
    let page = 1;
    for (;;) {
      const result = await this.request<RawRepo[]>(
        `/user/repos?per_page=${perPage}&page=${page}&sort=pushed&direction=desc`,
      );
      repos.push(...result.map(mapRepo));
      if (result.length < perPage) break;
      page += 1;
    }
    return repos.sort((a, b) =>
      (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
    );
  }

  /** Repositories a GitHub App installation token can reach. */
  async listInstallationRepos(): Promise<GithubRepo[]> {
    const repos: GithubRepo[] = [];
    for (let page = 1; ; page += 1) {
      const result = await this.request<{ repositories: RawRepo[] }>(
        `/installation/repositories?per_page=100&page=${page}`,
      );
      repos.push(...result.repositories.map(mapRepo));
      if (result.repositories.length < 100) break;
    }
    return repos.sort((a, b) =>
      (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
    );
  }
}

interface RawCheckRunResult {
  id: number;
  html_url: string | null;
  status: string;
  conclusion: string | null;
}

function mapCheckRun(raw: RawCheckRunResult): GithubCheckRun {
  return {
    id: raw.id,
    url: raw.html_url,
    status: raw.status,
    conclusion: raw.conclusion,
  };
}

function checkRunBody(fields: GithubCheckRunFields) {
  return {
    ...(fields.status ? { status: fields.status } : {}),
    ...(fields.conclusion ? { conclusion: fields.conclusion } : {}),
    ...(fields.detailsUrl ? { details_url: fields.detailsUrl } : {}),
    ...(fields.externalId ? { external_id: fields.externalId } : {}),
    ...(fields.startedAt ? { started_at: fields.startedAt } : {}),
    ...(fields.completedAt ? { completed_at: fields.completedAt } : {}),
    ...(fields.output
      ? {
          output: {
            title: fields.output.title,
            summary: fields.output.summary,
            ...(fields.output.text ? { text: fields.output.text } : {}),
            ...(fields.output.annotations?.length
              ? {
                  annotations: fields.output.annotations.map((annotation) => ({
                    path: annotation.path,
                    start_line: annotation.startLine,
                    end_line: annotation.endLine,
                    annotation_level: annotation.level,
                    message: annotation.message,
                    ...(annotation.title ? { title: annotation.title } : {}),
                  })),
                }
              : {}),
          },
        }
      : {}),
  };
}

/**
 * The GraphQL endpoint beside a REST API base: `https://api.github.com/graphql`
 * for github.com (and GHE.com's `api.<subdomain>.ghe.com`), and `/api/graphql`
 * for GitHub Enterprise Server, whose REST base is `https://HOST/api/v3`.
 */
export function githubGraphqlUrl(apiBaseUrl: string = API_BASE): string {
  const url = new URL(apiBaseUrl);
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = /\/api\/v3$/.test(path)
    ? `${path.slice(0, -"/v3".length)}/graphql`
    : `${path}/graphql`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function repositoryPath(fullName: string): string {
  if (!/^[\w.-]+\/[\w.-]+$/.test(fullName) || fullName.includes("..")) {
    throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
  }
  return fullName;
}

function positive(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new GithubApiError(400, `Invalid number: ${value}`);
  }
  return value;
}

function mapRepo(raw: RawRepo): GithubRepo {
  return {
    id: raw.id,
    fullName: raw.full_name,
    name: raw.name,
    owner: raw.owner.login,
    private: raw.private,
    defaultBranch: raw.default_branch,
    cloneUrl: raw.clone_url,
    description: raw.description,
    pushedAt: raw.pushed_at,
  };
}

/**
 * Git-over-HTTPS credentials for a user access token. GitHub accepts the
 * token as the password with the fixed `x-access-token` username.
 */
export function gitCredentialsFor(accessToken: string): {
  username: string;
  password: string;
} {
  return { username: "x-access-token", password: accessToken };
}

/** True when the remote URL points at github.com (https or ssh form). */
export function isGithubRemoteUrl(url: string): boolean {
  return repoFullNameFromUrl(url) !== null;
}

/**
 * The repository and number of a pull request's web address
 * (`https://github.com/owner/repo/pull/12`, anything after the number
 * ignored), under `webBaseUrl` for GitHub Enterprise. Null otherwise.
 */
export function pullRequestFromUrl({
  url,
  webBaseUrl = "https://github.com",
}: {
  url: string;
  webBaseUrl?: string;
}): { fullName: string; number: number } | null {
  const base = webBaseUrl.replace(/\/+$/, "");
  const trimmed = url.trim();
  if (!trimmed.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return null;
  const match = /^([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(
    trimmed.slice(base.length + 1),
  );
  const number = Number(match?.[2]);
  return match?.[1] && Number.isSafeInteger(number) && number > 0
    ? { fullName: match[1], number }
    : null;
}

/**
 * Extract `owner/repo` from a github.com clone URL
 * (`https://github.com/owner/repo.git`, `git@github.com:owner/repo.git`).
 * Returns null for anything that is not a github.com remote.
 */
export function repoFullNameFromUrl(url: string): string | null {
  const match =
    /^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/.exec(
      url.trim(),
    );
  return match?.[1] ?? null;
}
