import {
  type FetchLike,
  GithubApiError,
  type GithubPullRequest,
  type GithubPullRequestFile,
  type GithubRepo,
  type GithubRepositoryEvent,
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
