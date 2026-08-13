import {
  type FetchLike,
  GithubApiError,
  type GithubPullRequest,
  type GithubPullRequestFile,
  type GithubRepo,
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
    >(`/repos/${fullName}/pulls?state=open&sort=updated&direction=desc&per_page=50`);
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

  /**
   * Repositories the user granted this GitHub App access to, across all of
   * their installations (personal account + orgs), most recently pushed
   * first. Uses the installations API rather than `/user/repos` so the list
   * matches exactly what the app can clone.
   */
  async listAccessibleRepos(opts?: {
    perPage?: number;
  }): Promise<GithubRepo[]> {
    const perPage = opts?.perPage ?? 100;
    const { installations } = await this.request<{
      installations: { id: number }[];
    }>("/user/installations");

    const repos: GithubRepo[] = [];
    for (const installation of installations) {
      let page = 1;
      for (;;) {
        const result = await this.request<{ repositories: RawRepo[] }>(
          `/user/installations/${installation.id}/repositories?per_page=${perPage}&page=${page}`,
        );
        repos.push(...result.repositories.map(mapRepo));
        if (result.repositories.length < perPage) break;
        page += 1;
      }
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
