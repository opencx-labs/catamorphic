import {
  type FetchLike,
  GithubApiError,
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

  private async request<T>(path: string): Promise<T> {
    const response = await this.fetch(`${this.baseUrl}${path}`, {
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
