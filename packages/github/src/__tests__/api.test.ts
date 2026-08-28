import { describe, expect, it } from "vitest";
import { GithubApi, gitCredentialsFor } from "../api.js";
import { GithubApiError } from "../types.js";

const REPO = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 1,
  full_name: "octo/hello",
  name: "hello",
  owner: { login: "octo" },
  private: false,
  default_branch: "main",
  clone_url: "https://github.com/octo/hello.git",
  description: null,
  pushed_at: "2026-07-01T00:00:00Z",
  ...over,
});

function fetchRouting(routes: Record<string, unknown>) {
  return (async (url: unknown) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    for (const [prefix, payload] of Object.entries(routes)) {
      if (path.startsWith(prefix)) {
        return new Response(JSON.stringify(payload), { status: 200 });
      }
    }
    return new Response(JSON.stringify({ message: "Not Found" }), {
      status: 404,
    });
  }) as typeof fetch;
}

describe("GithubApi", () => {
  it("maps the authenticated user", async () => {
    const api = new GithubApi("tok", {
      fetch: fetchRouting({
        "/user": { login: "octo", id: 7, avatar_url: "a", name: "Octo" },
      }),
    });
    expect(await api.getUser()).toEqual({
      login: "octo",
      id: 7,
      avatarUrl: "a",
      name: "Octo",
    });
  });

  it("lists the authenticated user's repos sorted by pushed_at", async () => {
    const api = new GithubApi("tok", {
      fetch: fetchRouting({
        "/user/repos": [
          REPO({ id: 1, pushed_at: "2026-01-01T00:00:00Z" }),
          REPO({
            id: 2,
            full_name: "org/newer",
            pushed_at: "2026-06-01T00:00:00Z",
          }),
        ],
      }),
    });
    const repos = await api.listAccessibleRepos();
    expect(repos.map((r) => r.id)).toEqual([2, 1]);
    expect(repos[1]?.cloneUrl).toBe("https://github.com/octo/hello.git");
  });

  it("throws GithubApiError with status on failures", async () => {
    const api = new GithubApi("tok", { fetch: fetchRouting({}) });
    await expect(api.getUser()).rejects.toMatchObject({ status: 404 });
    await expect(api.getUser()).rejects.toThrow(GithubApiError);
  });

  it("lists repository events without discarding provider payload", async () => {
    const api = new GithubApi("tok", {
      fetch: fetchRouting({
        "/repos/octo/hello/events": [
          {
            id: "123",
            type: "PullRequestEvent",
            actor: { login: "octo" },
            created_at: "2026-08-28T10:00:00Z",
            payload: { action: "synchronize", number: 42 },
          },
        ],
      }),
    });

    expect(await api.listRepositoryEvents("octo/hello")).toEqual([
      {
        id: "123",
        type: "PullRequestEvent",
        actor: "octo",
        createdAt: "2026-08-28T10:00:00Z",
        payload: { action: "synchronize", number: 42 },
      },
    ]);
  });

  it("merges pull request, review, check, suite, and workflow state for watchers", async () => {
    const api = new GithubApi("tok", {
      fetch: fetchRouting({
        "/repos/octo/hello/events": [],
        "/repos/octo/hello/pulls?": [
          {
            id: 42,
            number: 7,
            updated_at: "2026-08-28T10:00:00Z",
            user: { login: "octo" },
            head: { sha: "abc123" },
          },
        ],
        "/repos/octo/hello/actions/runs": {
          workflow_runs: [
            {
              id: 51,
              run_attempt: 1,
              status: "completed",
              conclusion: "success",
              updated_at: "2026-08-28T10:04:00Z",
              actor: { login: "octo" },
            },
          ],
        },
        "/repos/octo/hello/pulls/7/reviews": [
          {
            id: 61,
            state: "approved",
            submitted_at: "2026-08-28T10:01:00Z",
            user: { login: "reviewer" },
          },
        ],
        "/repos/octo/hello/commits/abc123/check-runs": {
          check_runs: [
            {
              id: 71,
              status: "completed",
              conclusion: "success",
              updated_at: "2026-08-28T10:02:00Z",
              app: { slug: "ci" },
            },
          ],
        },
        "/repos/octo/hello/commits/abc123/check-suites": {
          check_suites: [
            {
              id: 81,
              status: "completed",
              conclusion: "success",
              updated_at: "2026-08-28T10:03:00Z",
              app: { slug: "ci" },
            },
          ],
        },
      }),
    });

    expect(
      (await api.listRepositoryWatchEvents("octo/hello")).map(
        (event) => event.type,
      ),
    ).toEqual([
      "WorkflowRunEvent",
      "CheckSuiteEvent",
      "CheckRunEvent",
      "PullRequestReviewEvent",
      "PullRequestEvent",
    ]);
  });
});

describe("gitCredentialsFor", () => {
  it("uses the x-access-token username convention", () => {
    expect(gitCredentialsFor("ghu_abc")).toEqual({
      username: "x-access-token",
      password: "ghu_abc",
    });
  });
});
