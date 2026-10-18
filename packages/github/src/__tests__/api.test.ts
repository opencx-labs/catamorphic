import { describe, expect, it } from "vitest";
import {
  GithubApi,
  gitCredentialsFor,
  githubGraphqlUrl,
  pullRequestFromUrl,
} from "../api.js";
import { GithubApiError, GithubGraphqlError } from "../types.js";

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

  it("creates an empty repository for the user or an organization", async () => {
    const calls: Array<{ path: string; method?: string; body: unknown }> = [];
    const api = new GithubApi("tok", {
      fetch: (async (url: unknown, init?: RequestInit) => {
        calls.push({
          path: new URL(String(url)).pathname,
          method: init?.method,
          body: JSON.parse(String(init?.body)),
        });
        return Response.json(REPO({ full_name: "acme/notes", name: "notes" }));
      }) as typeof fetch,
    });
    expect(
      (await api.createRepo({ name: "notes", private: true })).fullName,
    ).toBe("acme/notes");
    await api.createRepo({
      name: "notes",
      organization: "acme",
      private: false,
    });
    expect(calls).toEqual([
      {
        path: "/user/repos",
        method: "POST",
        body: { name: "notes", private: true, auto_init: false },
      },
      {
        path: "/orgs/acme/repos",
        method: "POST",
        body: { name: "notes", private: false, auto_init: false },
      },
    ]);
    await expect(
      api.createRepo({ name: "../etc", private: true }),
    ).rejects.toThrow(GithubApiError);
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

describe("pullRequestStatus", () => {
  const PR = (over: Partial<Record<string, unknown>> = {}) => ({
    number: 12,
    title: "Chips",
    html_url: "https://github.com/octo/hello/pull/12",
    user: { login: "octo" },
    head: { ref: "chips", sha: "abc" },
    base: { ref: "main" },
    draft: false,
    updated_at: "2026-10-01T00:00:00Z",
    state: "open",
    additions: 120,
    deletions: 4,
    changed_files: 3,
    comments: 2,
    review_comments: 5,
    ...over,
  });

  it("reads state, size, comments and checks together", async () => {
    const api = new GithubApi("tok", {
      fetch: fetchRouting({
        "/repos/octo/hello/pulls/12": PR(),
        "/repos/octo/hello/commits/abc/check-runs": {
          check_runs: [
            { status: "completed", conclusion: "success" },
            { status: "completed", conclusion: "skipped" },
            { status: "in_progress", conclusion: null },
          ],
        },
        "/repos/octo/hello/commits/abc/status": {
          state: "pending",
          statuses: [{ state: "success" }],
        },
      }),
    });
    expect(
      await api.pullRequestStatus({ fullName: "octo/hello", number: 12 }),
    ).toEqual({
      number: 12,
      title: "Chips",
      url: "https://github.com/octo/hello/pull/12",
      repository: "octo/hello",
      author: "octo",
      head: "chips",
      base: "main",
      state: "open",
      additions: 120,
      deletions: 4,
      changedFiles: 3,
      comments: 7,
      checks: { state: "pending", passed: 3, failed: 0, pending: 1 },
      updatedAt: "2026-10-01T00:00:00Z",
    });
  });

  it("says merged, closed and draft, and leaves out checks it cannot read", async () => {
    const read = (pr: Record<string, unknown>) =>
      new GithubApi("tok", {
        fetch: fetchRouting({ "/repos/octo/hello/pulls/12": pr }),
      }).pullRequestStatus({ fullName: "octo/hello", number: 12 });
    expect((await read(PR({ state: "closed", merged: true }))).state).toBe(
      "merged",
    );
    expect((await read(PR({ state: "closed" }))).state).toBe("closed");
    const draft = await read(PR({ draft: true }));
    expect(draft.state).toBe("draft");
    expect(draft.checks).toBeUndefined();
  });

  it("counts a failed check over pending ones", async () => {
    const api = new GithubApi("tok", {
      fetch: fetchRouting({
        "/repos/octo/hello/pulls/12": PR(),
        "/repos/octo/hello/commits/abc/check-runs": {
          check_runs: [
            { status: "completed", conclusion: "failure" },
            { status: "queued", conclusion: null },
          ],
        },
      }),
    });
    const status = await api.pullRequestStatus({
      fullName: "octo/hello",
      number: 12,
    });
    expect(status.checks).toEqual({
      state: "failure",
      passed: 0,
      failed: 1,
      pending: 1,
    });
  });
});

describe("pullRequestFromUrl", () => {
  it("reads a pull request's repository and number", () => {
    expect(
      pullRequestFromUrl({
        url: "https://github.com/octo/hello/pull/12/files#diff",
      }),
    ).toEqual({ fullName: "octo/hello", number: 12 });
    expect(
      pullRequestFromUrl({
        url: "https://git.example.com/team/app/pull/3",
        webBaseUrl: "https://git.example.com/",
      }),
    ).toEqual({ fullName: "team/app", number: 3 });
  });

  it("refuses other addresses", () => {
    expect(
      pullRequestFromUrl({ url: "https://github.com/octo/hello" }),
    ).toBeNull();
    expect(
      pullRequestFromUrl({ url: "https://gitlab.com/a/b/pull/1" }),
    ).toBeNull();
    expect(
      pullRequestFromUrl({ url: "https://github.com/octo/hello/pull/0" }),
    ).toBeNull();
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

describe("GraphQL", () => {
  it("lives beside the REST base, on Enterprise Server too", () => {
    expect(githubGraphqlUrl()).toBe("https://api.github.com/graphql");
    expect(githubGraphqlUrl("https://api.github.com/")).toBe(
      "https://api.github.com/graphql",
    );
    expect(githubGraphqlUrl("https://ghe.acme.test/api/v3")).toBe(
      "https://ghe.acme.test/api/graphql",
    );
    expect(githubGraphqlUrl("https://ghe.acme.test/api/v3/")).toBe(
      "https://ghe.acme.test/api/graphql",
    );
    expect(githubGraphqlUrl("https://api.acme.ghe.com")).toBe(
      "https://api.acme.ghe.com/graphql",
    );
  });

  it("posts the query and surfaces errors instead of partial data", async () => {
    const answers: Array<() => Response> = [
      () => Response.json({ data: { viewer: { login: "octo" } } }),
      () =>
        Response.json({
          data: { node: null },
          errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
        }),
      () => Response.json({ message: "Bad credentials" }, { status: 401 }),
      () => Response.json({ data: null }),
    ];
    const calls: Array<{ url: string; body: unknown; auth: string | null }> =
      [];
    const api = new GithubApi("tok", {
      baseUrl: "https://ghe.acme.test/api/v3",
      fetch: (async (url: unknown, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          auth: new Headers(init?.headers).get("authorization"),
        });
        return (answers.shift() ?? (() => Response.json({})))();
      }) as typeof fetch,
    });
    await expect(
      api.graphql("query { viewer { login } }", { a: 1 }),
    ).resolves.toEqual({ viewer: { login: "octo" } });
    expect(calls[0]).toEqual({
      url: "https://ghe.acme.test/api/graphql",
      body: { query: "query { viewer { login } }", variables: { a: 1 } },
      auth: "Bearer tok",
    });
    const failed = await api.graphql("query { node }").catch((e) => e);
    expect(failed).toBeInstanceOf(GithubGraphqlError);
    expect(failed).toMatchObject({
      errors: [{ type: "NOT_FOUND", message: "Could not resolve" }],
      message: "GitHub GraphQL: Could not resolve",
    });
    await expect(api.graphql("query { x }")).rejects.toMatchObject({
      status: 401,
      message: "Bad credentials",
    });
    await expect(api.graphql("query { x }")).rejects.toThrow(/no data/);
  });

  it("reads a review thread by id, and null for anything else", async () => {
    const nodes: unknown[] = [
      {
        data: {
          node: {
            __typename: "PullRequestReviewThread",
            id: "PRRT_1",
            isResolved: false,
            pullRequest: {
              number: 7,
              repository: { nameWithOwner: "octo/hello" },
            },
            comments: {
              nodes: [
                {
                  databaseId: 21,
                  body: "Why?",
                  url: "u",
                  createdAt: "t",
                  author: { __typename: "Bot", login: "work" },
                },
              ],
            },
          },
        },
      },
      { data: { node: { __typename: "Issue" } } },
      { data: { node: null }, errors: [{ type: "NOT_FOUND", message: "x" }] },
      { data: null, errors: [{ type: "FORBIDDEN", message: "no" }] },
    ];
    const api = new GithubApi("tok", {
      fetch: (async () => Response.json(nodes.shift())) as typeof fetch,
    });
    expect(await api.reviewThread({ threadId: "PRRT_1" })).toEqual({
      id: "PRRT_1",
      isResolved: false,
      repository: "octo/hello",
      number: 7,
      firstComment: {
        id: 21,
        body: "Why?",
        url: "u",
        createdAt: "t",
        // GraphQL drops the [bot] suffix REST logins carry; put it back.
        author: { login: "work[bot]", type: "Bot", id: null },
      },
    });
    expect(await api.reviewThread({ threadId: "I_1" })).toBeNull();
    expect(await api.reviewThread({ threadId: "PRRT_x" })).toBeNull();
    await expect(api.reviewThread({ threadId: "PRRT_y" })).rejects.toThrow(
      GithubGraphqlError,
    );
  });
});

describe("conversation comments", () => {
  it("deletes with no body to read, and reports a refusal", async () => {
    const statuses = [204, 403];
    const api = new GithubApi("tok", {
      fetch: (async () => {
        const status = statuses.shift() ?? 500;
        return status === 204
          ? new Response(null, { status })
          : Response.json({ message: "Resource not accessible" }, { status });
      }) as typeof fetch,
    });
    await expect(
      api.deleteIssueComment({ fullName: "octo/hello", commentId: 31 }),
    ).resolves.toBeUndefined();
    await expect(
      api.deleteIssueComment({ fullName: "octo/hello", commentId: 31 }),
    ).rejects.toMatchObject({
      status: 403,
      message: "Resource not accessible",
    });
    await expect(
      api.deleteIssueComment({ fullName: "../x", commentId: 31 }),
    ).rejects.toThrow(GithubApiError);
  });
});
