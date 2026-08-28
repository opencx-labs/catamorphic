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

/** Minimal REST client bound to one user access token. */
export class GithubApi {
  private readonly fetch: FetchLike;
  private readonly baseUrl: string;

  constructor(
    private readonly accessToken: string,
    opts?: GithubApiOptions,
  ) {
    this.fetch = opts?.fetch ?? fetch;
    this.baseUrl = opts?.baseUrl ?? API_BASE;
  }

  private async request<T>(
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
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

  /** Open pull requests, most recently updated first. */
  async listPullRequests(fullName: string): Promise<GithubPullRequest[]> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
    }
    const raw = await this.request<
      Array<{
        number: number;
        title: string;
        html_url: string;
        user: { login: string } | null;
        head: { ref: string };
        base: { ref: string };
        draft: boolean;
        updated_at: string;
      }>
    >(
      `/repos/${fullName}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
    );
    return raw.map((pr) => ({
      number: pr.number,
      title: pr.title,
      url: pr.html_url,
      author: pr.user?.login ?? "unknown",
      head: pr.head.ref,
      base: pr.base.ref,
      draft: pr.draft,
      updatedAt: pr.updated_at,
    }));
  }

  /** Changed files of a pull request, with unified-diff patches. */
  async pullRequestFiles(
    fullName: string,
    number: number,
  ): Promise<GithubPullRequestFile[]> {
    if (!/^[\w.-]+\/[\w.-]+$/.test(fullName)) {
      throw new GithubApiError(400, `Invalid repository name: ${fullName}`);
    }
    const raw = await this.request<
      Array<{
        filename: string;
        status: string;
        additions: number;
        deletions: number;
        patch?: string;
        previous_filename?: string;
      }>
    >(`/repos/${fullName}/pulls/${number}/files?per_page=100`);
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
