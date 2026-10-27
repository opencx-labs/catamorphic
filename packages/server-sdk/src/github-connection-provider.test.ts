import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  defineGithubConnectionProvider,
  GITHUB_CONNECTION_ACTIONS,
} from "./github-connection-provider.js";

const TEST_CONNECTION = { id: "connection-1", revision: 1 };

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const NOW = 1_750_000_000_000;
const SHA = "a".repeat(40);
const INSTALLATION_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  metadata: "read",
  workflows: "write",
};
/** What a read (GET) token asks for: the installation's, at read level. */
const READ_PERMISSIONS = {
  contents: "read",
  pull_requests: "read",
  metadata: "read",
};

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A fake github.com + api.github.com, recording each request. */
function fakeGithub(
  overrides: Record<string, (body: unknown, url: URL) => Response> = {},
) {
  const calls: Call[] = [];
  let minted = 0;
  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const rawBody = init?.body ? String(init.body) : undefined;
    const body = rawBody
      ? rawBody.startsWith("{")
        ? JSON.parse(rawBody)
        : Object.fromEntries(new URLSearchParams(rawBody))
      : undefined;
    calls.push({
      method,
      url: url.toString(),
      authorization: new Headers(init?.headers).get("authorization"),
      body,
    });
    // Enterprise Server serves REST below /api/v3 and GraphQL at /api/graphql.
    const pathname = url.pathname
      .replace(/^\/api\/v3(?=\/)/, "")
      .replace(/^\/api\/graphql$/, "/graphql");
    const key = `${method} ${pathname}`;
    const override = overrides[key];
    if (override) return override(body, url);
    if (key === "GET /orgs/octo/installation") {
      return Response.json({
        id: 77,
        account: { login: "octo", id: 1, type: "Organization" },
        repository_selection: "all",
        permissions: INSTALLATION_PERMISSIONS,
        events: [],
        app_slug: "work",
        suspended_at: null,
      });
    }
    if (key === "GET /app/installations/77") {
      return Response.json({
        id: 77,
        account: { login: "octo", id: 1, type: "Organization" },
        repository_selection: "all",
        permissions: INSTALLATION_PERMISSIONS,
        events: [],
        app_slug: "work",
        suspended_at: null,
      });
    }
    if (key === "GET /repos/octo/hello") {
      return Response.json({ full_name: "octo/hello", default_branch: "main" });
    }
    if (key === "POST /app/installations/77/access_tokens") {
      minted += 1;
      return Response.json(
        {
          token: `ghs_${minted}`,
          expires_at: new Date(NOW + 3_600_000).toISOString(),
        },
        { status: 201 },
      );
    }
    if (key === "GET /repos/octo/hello/pulls/7/files") {
      return Response.json([
        {
          filename: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-x\n+y",
        },
        {
          filename: "big.txt",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "p".repeat(50),
        },
      ]);
    }
    if (key === "POST /repos/octo/hello/pulls/7/reviews") {
      return Response.json({
        id: 9,
        html_url: "https://github.com/octo/hello/pull/7#review-9",
        state: "COMMENTED",
      });
    }
    if (key === "POST /repos/octo/hello/check-runs") {
      return Response.json({
        id: 5,
        html_url: "https://github.com/octo/hello/runs/5",
        status: "in_progress",
        conclusion: null,
      });
    }
    if (key === "GET /repos/octo/hello/pulls") {
      return Response.json([{ number: 7 }]);
    }
    if (key === "POST /login/device/code") {
      return Response.json({
        device_code: "dc",
        user_code: "ABCD-1234",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    }
    if (key === "POST /login/oauth/access_token") {
      return Response.json({
        access_token: body?.grant_type === "refresh_token" ? "ghu_2" : "ghu_1",
        expires_in: 28_800,
        refresh_token: "ghr_1",
        refresh_token_expires_in: 15_897_600,
      });
    }
    if (key === "GET /user") {
      return Response.json({
        login: "mona",
        id: 3,
        avatar_url: "",
        name: "Mona",
      });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
  return { calls, fetch: fetchImpl };
}

function appProvider(
  overrides?: Record<string, (body: unknown, url: URL) => Response>,
) {
  const github = fakeGithub(overrides);
  const provider = defineGithubConnectionProvider({
    fetch: github.fetch,
    now: () => NOW,
    maxPatchChars: 20,
  });
  return { github, provider };
}

async function appMaterial(
  provider: ReturnType<typeof defineGithubConnectionProvider>,
) {
  const authorized = await provider.authorizeApp({
    appId: "12345",
    privateKey,
    owner: "octo",
  });
  return authorized.material;
}

const ALL = GITHUB_CONNECTION_ACTIONS;
/** The binding's repositories (the project's linked remote). */
const REPOS = ["octo/hello"];

describe("GitHub connections: App installation (service)", () => {
  it("finds the installation from the owner and grants every action", async () => {
    const { provider } = appProvider();
    const authorized = await provider.authorizeApp({
      appId: "12345",
      privateKey,
      owner: "octo",
    });
    expect(authorized.account).toEqual({
      type: "app",
      appId: "12345",
      installationId: 77,
      account: "octo",
      repositorySelection: "all",
    });
    expect(authorized.capabilities).toEqual(ALL);
    expect(
      JSON.parse(new TextDecoder().decode(authorized.material)),
    ).toMatchObject({ kind: "app", appId: "12345", installationId: 77 });
    await expect(
      provider.authorizeApp({ appId: "1", privateKey: "nope", owner: "octo" }),
    ).rejects.toThrow(/PEM/);
    await expect(
      provider.authorizeApp({ appId: "1", privateKey, owner: "ghost" }),
    ).rejects.toThrow(/not installed on ghost/);
  });

  it("asks an administrator for the App through a form, even without OAuth (ADR 0177)", async () => {
    const { provider } = appProvider();
    const started = await provider.beginAuthorization?.({
      tenantId: "t",
      externalUserId: "admin",
      principal: "service",
      redirectUri: "https://work.test/callback",
      state: "s",
    });
    expect(started?.challenge).toMatchObject({
      kind: "form",
      fields: expect.arrayContaining([
        expect.objectContaining({ name: "appId", required: true }),
        expect.objectContaining({
          name: "privateKey",
          secret: true,
          // A PEM key keeps its line breaks only in a multiline field.
          multiline: true,
        }),
      ]),
    });
    const authorized = await provider.completeAuthorization?.({
      tenantId: "t",
      externalUserId: "admin",
      principal: "service",
      callback: {
        appId: "12345",
        privateKey,
        owner: "octo",
        installationId: "",
      },
    });
    expect(authorized?.account).toMatchObject({
      type: "app",
      installationId: 77,
    });
    await expect(
      provider.completeAuthorization?.({
        tenantId: "t",
        externalUserId: "admin",
        principal: "service",
        callback: { appId: "12345" },
      }),
    ).rejects.toThrow();
  });

  it("passes workflow cancellation to both REST and typed GitHub transports", async () => {
    for (const action of ["get", "pull_request_files"] as const) {
      const abort = new AbortController();
      let started = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const provider = defineGithubConnectionProvider({
        fetch: async (_url, init) => {
          started();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => reject(init.signal?.reason),
              { once: true },
            );
          });
        },
      });
      const material = new TextEncoder().encode(
        JSON.stringify({
          kind: "user",
          login: "fixture",
          userId: 1,
          tokens: {
            accessToken: "fixture-only",
            expiresAt: null,
            refreshToken: null,
            refreshTokenExpiresAt: null,
          },
        }),
      );
      const request = provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action,
        input:
          action === "get"
            ? { path: "/repos/octo/hello/pulls" }
            : { repository: "octo/hello", number: 7 },
        capabilities: [action],
        repositories: REPOS,
        signal: abort.signal,
      });
      const rejected = expect(request).rejects.toThrow("attempt canceled");
      await ready;
      abort.abort(new Error("attempt canceled"));
      await rejected;
    }
  });

  it("mints a token narrowed to the repository a REST path addresses", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    const result = await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "get",
      input: { path: "/repos/octo/hello/pulls", query: { state: "open" } },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(result).toMatchObject({ status: 200, body: [{ number: 7 }] });
    const mint = github.calls.find((call) =>
      call.url.endsWith("/access_tokens"),
    );
    expect(mint?.body).toEqual({
      repositories: ["hello"],
      permissions: READ_PERMISSIONS,
    });
    expect(mint?.authorization).toMatch(/^Bearer ey/);
    const request = github.calls.at(-1);
    expect(request?.url).toBe(
      "https://api.github.com/repos/octo/hello/pulls?state=open",
    );
    expect(request?.authorization).toBe("Bearer ghs_1");
    // The token is cached for the next call on the same repository.
    await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "get",
      input: { path: "/repos/octo/hello/pulls" },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(
      github.calls.filter((call) => call.url.endsWith("/access_tokens")),
    ).toHaveLength(1);
  });

  it("keeps REST calls to the binding's repositories and GETs read-only", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    const call = (
      action: string,
      input: Record<string, unknown>,
      repositories: readonly string[] | null = REPOS,
    ) =>
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action,
        input: JSON.parse(JSON.stringify(input)),
        capabilities: ALL,
        ...(repositories ? { repositories } : {}),
      });
    const before = github.calls.length;
    // Another repository, or none named by the binding.
    await expect(
      call("get", { path: "/repos/octo/secret/contents/a" }),
    ).rejects.toThrow(/outside this connection's repositories/);
    await expect(
      call("get", { path: "/repos/octo/hello/pulls" }, null),
    ).rejects.toThrow(/reaches no repository/);
    await expect(
      call("pull_request_files", { repository: "octo/secret", number: 1 }),
    ).rejects.toThrow(/outside this connection's repositories/);
    // Paths outside one repository mint an installation-wide token.
    for (const path of ["/graphql", "/search/code", "/orgs/octo/repos"]) {
      await expect(call("post", { path, body: {} })).rejects.toThrow(
        /reaches only its repositories/,
      );
    }
    await expect(
      call("get", { path: "/repos/octo/./secret/pulls" }),
    ).rejects.toThrow();
    expect(github.calls.slice(before)).toEqual([]);
    // Case differs, same repository.
    await call("get", { path: "/repos/Octo/Hello/pulls" });
    // A write mints the installation's own permissions.
    await call("post", { path: "/repos/octo/hello/issues", body: {} });
    const mints = github.calls
      .filter((entry) => entry.url.endsWith("/access_tokens"))
      .map((entry) => entry.body);
    expect(mints).toEqual([
      { repositories: ["Hello"], permissions: READ_PERMISSIONS },
      { repositories: ["hello"] },
    ]);
    // A host may open named paths beyond repositories.
    const opened = defineGithubConnectionProvider({
      fetch: github.fetch,
      now: () => NOW,
      unscopedRestPaths: ["/user"],
    });
    await opened.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "get",
      input: { path: "/user" },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(github.calls.at(-1)?.url).toBe("https://api.github.com/user");
  });

  it("never writes the default branch through the REST API", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    const call = (action: string, input: Record<string, unknown>) =>
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action,
        input: JSON.parse(JSON.stringify(input)),
        capabilities: ALL,
        repositories: REPOS,
      });
    const content = { message: "m", content: "eA==" };
    await expect(
      call("put", { path: "/repos/octo/hello/contents/a.md", body: content }),
    ).rejects.toThrow(/without naming a branch/);
    await expect(
      call("put", {
        path: "/repos/octo/hello/contents/a.md",
        body: { ...content, branch: "main" },
      }),
    ).rejects.toThrow(/main is the default branch of octo\/hello/);
    await expect(
      call("delete", {
        path: "/repos/octo/hello/contents/a.md",
        body: { message: "m", sha: SHA, branch: "refs/heads/main" },
      }),
    ).rejects.toThrow(/default branch/);
    await expect(
      call("patch", {
        path: "/repos/octo/hello/git/refs/heads/main",
        body: { sha: SHA, force: true },
      }),
    ).rejects.toThrow(/default branch/);
    await expect(
      call("delete", { path: "/repos/octo/hello/git/refs/heads/main" }),
    ).rejects.toThrow(/default branch/);
    await expect(
      call("post", {
        path: "/repos/octo/hello/merges",
        body: { base: "main", head: "work/x" },
      }),
    ).rejects.toThrow(/default branch/);
    const writes = () =>
      github.calls.filter(
        (entry) =>
          entry.method !== "GET" && entry.url.includes("/repos/octo/hello/"),
      );
    expect(writes()).toEqual([]);
    // Other branches are fine.
    await call("put", {
      path: "/repos/octo/hello/contents/a.md",
      body: { ...content, branch: "work/docs" },
    });
    await call("patch", {
      path: "/repos/octo/hello/git/refs/heads/work/docs",
      body: { sha: SHA },
    });
    expect(writes().map((entry) => `${entry.method} ${entry.url}`)).toEqual([
      "PUT https://api.github.com/repos/octo/hello/contents/a.md",
      "PATCH https://api.github.com/repos/octo/hello/git/refs/heads/work/docs",
    ]);
  });

  it("accepts the JSON credential an operator pastes", async () => {
    const { github, provider } = appProvider();
    const material = new TextEncoder().encode(
      JSON.stringify({ appId: 12345, privateKey, installationId: "77" }),
    );
    await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "get",
      input: { path: "/repos/octo/hello/pulls" },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(github.calls.at(-1)?.authorization).toBe("Bearer ghs_1");
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material: new TextEncoder().encode("{}"),
        action: "get",
        input: { path: "/user" },
        capabilities: ALL,
        repositories: REPOS,
      }),
    ).rejects.toThrow("GitHub connection credentials are not readable");
  });

  it("narrows actions by capability", async () => {
    const { provider } = appProvider();
    const material = await appMaterial(provider);
    const listed = await provider.listActions?.({
      material,
      capabilities: ["get", "pull_request_files"],
    });
    expect(listed?.map((action) => action.name)).toEqual([
      "get",
      "pull_request_files",
    ]);
    expect(listed?.[0]?.inputSchema).toMatchObject({
      type: "object",
      required: ["path"],
    });
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action: "post",
        input: { path: "/repos/octo/hello/issues", body: {} },
        capabilities: ["get"],
        repositories: REPOS,
      }),
    ).rejects.toThrow(/outside the connection grant/);
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action: "get",
        input: { path: "/repos/../user" },
        capabilities: ALL,
        repositories: REPOS,
      }),
    ).rejects.toThrow();
  });

  it("reviews pull requests with inline comments on a narrowed token", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    const files = await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "pull_request_files",
      input: { repository: "octo/hello", number: 7 },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(files).toEqual({
      files: [
        {
          path: "src/a.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-x\n+y",
        },
        {
          path: "big.txt",
          status: "added",
          additions: 1,
          deletions: 0,
          patch: "p".repeat(20),
          patchTruncated: true,
        },
      ],
    });
    const review = await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "create_review",
      input: {
        repository: "octo/hello",
        number: 7,
        body: "Two notes",
        comments: [
          { path: "src/a.ts", line: 1, body: "Why y?" },
          { path: "src/a.ts", startLine: 1, line: 2, body: "Range" },
        ],
      },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(review).toEqual({
      id: 9,
      url: "https://github.com/octo/hello/pull/7#review-9",
      state: "COMMENTED",
    });
    const mints = github.calls.filter((call) =>
      call.url.endsWith("/access_tokens"),
    );
    expect(mints.map((call) => call.body)).toEqual([
      { repositories: ["hello"], permissions: { pull_requests: "read" } },
      { repositories: ["hello"], permissions: { pull_requests: "write" } },
    ]);
    expect(github.calls.at(-1)?.body).toEqual({
      event: "COMMENT",
      body: "Two notes",
      comments: [
        { path: "src/a.ts", body: "Why y?", line: 1 },
        { path: "src/a.ts", body: "Range", line: 2, start_line: 1 },
      ],
    });
  });

  it("reports check runs and refuses repositories outside the installation", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    const run = await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "create_check_run",
      input: {
        repository: "octo/hello",
        name: "Work review",
        headSha: SHA,
        status: "in_progress",
        output: {
          title: "Reviewing",
          summary: "Started",
          annotations: [
            {
              path: "src/a.ts",
              startLine: 1,
              endLine: 1,
              level: "warning",
              message: "Check this",
            },
          ],
        },
      },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(run).toEqual({
      id: 5,
      url: "https://github.com/octo/hello/runs/5",
      status: "in_progress",
      conclusion: null,
    });
    expect(github.calls.at(-1)?.body).toEqual({
      name: "Work review",
      head_sha: SHA,
      status: "in_progress",
      output: {
        title: "Reviewing",
        summary: "Started",
        annotations: [
          {
            path: "src/a.ts",
            start_line: 1,
            end_line: 1,
            annotation_level: "warning",
            message: "Check this",
          },
        ],
      },
    });
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action: "issue_comment",
        input: { repository: "other/hello", number: 1, body: "hi" },
        capabilities: ALL,
        repositories: REPOS,
      }),
    ).rejects.toThrow(/outside this connection's repositories \(octo\/hello\)/);
    // A binding naming a repository beyond the installation still stops there.
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action: "issue_comment",
        input: { repository: "other/hello", number: 1, body: "hi" },
        capabilities: ALL,
        repositories: [...REPOS, "other/hello"],
      }),
    ).rejects.toThrow(/outside the GitHub App installation on octo/);
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action: "create_check_run",
        input: { repository: "octo/hello", name: "x", headSha: "short" },
        capabilities: ALL,
        repositories: REPOS,
      }),
    ).rejects.toThrow();
  });

  it("hands the gateway repository-scoped Git credentials", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    expect(provider.git.remoteBaseUrls).toEqual(["https://github.com/"]);
    const credentials = await provider.git.credentials({
      material,
      remoteUrl: "https://github.com/octo/hello.git",
      access: "write",
    });
    expect(credentials).toEqual({
      username: "x-access-token",
      password: "ghs_1",
    });
    expect(github.calls.at(-1)?.body).toEqual({
      repositories: ["hello"],
      permissions: { contents: "write" },
    });
    await provider.git.credentials({
      material,
      remoteUrl: "https://github.com/octo/hello",
      access: "read",
    });
    expect(github.calls.at(-1)?.body).toEqual({
      repositories: ["hello"],
      permissions: { contents: "read" },
    });
    for (const remoteUrl of [
      "https://evil.test/octo/hello.git",
      "https://github.com.evil.test/octo/hello",
      "https://github.com/octo/../x",
      "https://github.com/octo",
    ]) {
      await expect(
        provider.git.credentials({ material, remoteUrl, access: "read" }),
      ).rejects.toThrow();
    }
  });

  it("revokes cached installation tokens", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    await provider.git.credentials({
      material,
      remoteUrl: "https://github.com/octo/hello",
      access: "read",
    });
    await provider.revoke?.({ material });
    expect(github.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.github.com/installation/token",
      authorization: "Bearer ghs_1",
    });
  });
});

/** GitHub's App bot over REST, as the fake installation's slug names it. */
const BOT = { login: "work[bot]", id: 900, type: "Bot" };
const ADA = { login: "ada", id: 5, type: "User" };
const PULLS = "https://api.github.com/repos/octo/hello/pulls";

/** GraphQL answers by operation name; a bot's login has no `[bot]` there. */
function graphqlFixture(
  body: unknown,
): Record<string, unknown> | { errors: unknown[] } {
  const request = body as {
    query: string;
    variables: Record<string, unknown>;
  };
  const operation = /^(?:query|mutation) (\w+)/.exec(request.query)?.[1];
  const variables = request.variables;
  const comment = (id: number, login: string, typename = "Bot") => ({
    databaseId: id,
    body: `comment ${id}`,
    url: `https://github.com/octo/hello/pull/7#discussion_r${id}`,
    createdAt: "2026-10-01T00:00:00Z",
    author:
      typename === "Bot"
        ? { __typename: "Bot", login }
        : { __typename: "User", login, databaseId: 5 },
  });
  const thread = (id: string, comments: unknown[], more = false) => ({
    id,
    isResolved: id === "PRRT_done",
    isOutdated: false,
    path: "src/a.ts",
    line: 1,
    startLine: null,
    diffSide: "RIGHT",
    comments: {
      pageInfo: { hasNextPage: more, endCursor: more ? "k1" : null },
      nodes: comments,
    },
  });
  switch (operation) {
    case "ReviewThreads":
      return {
        repository: {
          pullRequest: {
            reviewThreads:
              variables.after === null
                ? {
                    pageInfo: { hasNextPage: true, endCursor: "c1" },
                    nodes: [
                      thread("PRRT_own", [comment(21, "work")], true),
                      thread("PRRT_human", [comment(41, "ada", "User")]),
                    ],
                  }
                : {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [thread("PRRT_done", [comment(51, "work")])],
                  },
          },
        },
      };
    case "ThreadComments":
      return {
        node: {
          comments: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [comment(22, "ada", "User")],
          },
        },
      };
    case "ReviewThread": {
      const id = String(variables.id);
      if (id === "PRRT_missing")
        return {
          errors: [
            {
              type: "NOT_FOUND",
              message: `Could not resolve to a node with the global id of '${id}'`,
            },
          ],
        };
      if (id === "I_issue") return { node: { __typename: "Issue" } };
      return {
        node: {
          __typename: "PullRequestReviewThread",
          id,
          isResolved: id === "PRRT_done",
          pullRequest: {
            number: id === "PRRT_other" ? 8 : 7,
            repository: { nameWithOwner: "octo/hello" },
          },
          comments: {
            nodes: [
              id === "PRRT_human"
                ? comment(41, "ada", "User")
                : comment(21, "work"),
            ],
          },
          latest: {
            nodes: [
              id === "PRRT_replied"
                ? { ...comment(25, "work"), body: "Fixed in abc. turn=t1" }
                : id === "PRRT_human"
                  ? comment(41, "ada", "User")
                  : comment(22, "ada", "User"),
            ],
          },
        },
      };
    }
    case "ResolveReviewThread":
      return {
        resolveReviewThread: {
          thread: { id: String(variables.id), isResolved: true },
        },
      };
  }
  return { errors: [{ message: `Unknown operation ${operation}` }] };
}

const review_ = (id: number, state: string, user = BOT, pull = 7) => ({
  id,
  state,
  user,
  body: `review ${id}`,
  commit_id: SHA,
  submitted_at: "2026-10-01T00:00:00Z",
  html_url: `https://github.com/octo/hello/pull/${pull}#pullrequestreview-${id}`,
  pull_request_url: `${PULLS}/${pull}`,
});

/** The review, thread, and comment endpoints the poster's actions use. */
const REVIEW_ROUTES: Record<string, (body: unknown) => Response> = {
  "POST /graphql": (body) => {
    const answer = graphqlFixture(body);
    return Response.json("errors" in answer ? answer : { data: answer });
  },
  "PATCH /repos/octo/hello/pulls/7": (body) =>
    Response.json({
      number: 7,
      html_url: "https://github.com/octo/hello/pull/7",
      body: (body as { body: string }).body,
    }),
  "GET /repos/octo/hello/pulls/7/reviews": () =>
    Response.json([
      review_(11, "CHANGES_REQUESTED"),
      review_(12, "APPROVED", ADA),
    ]),
  "GET /repos/octo/hello/pulls/7/reviews/11": () =>
    Response.json(review_(11, "CHANGES_REQUESTED")),
  "GET /repos/octo/hello/pulls/7/reviews/12": () =>
    Response.json(review_(12, "APPROVED", ADA)),
  "GET /repos/octo/hello/pulls/7/reviews/13": () =>
    Response.json(review_(13, "COMMENTED")),
  "GET /repos/octo/hello/pulls/7/reviews/14": () =>
    Response.json(review_(14, "DISMISSED")),
  "GET /repos/octo/hello/pulls/7/reviews/15": () =>
    Response.json(review_(15, "CHANGES_REQUESTED", BOT, 8)),
  "PUT /repos/octo/hello/pulls/7/reviews/11/dismissals": () =>
    Response.json(review_(11, "DISMISSED")),
  "GET /repos/octo/hello/pulls/comments/21": () =>
    Response.json({
      id: 21,
      user: BOT,
      body: "Why y?",
      html_url: "https://github.com/octo/hello/pull/7#discussion_r21",
      pull_request_url: `${PULLS}/7`,
    }),
  "GET /repos/octo/hello/pulls/comments/22": () =>
    Response.json({
      id: 22,
      user: ADA,
      body: "Because",
      html_url: "https://github.com/octo/hello/pull/7#discussion_r22",
      pull_request_url: `${PULLS}/7`,
      in_reply_to_id: 21,
    }),
  "GET /repos/octo/hello/pulls/comments/23": () =>
    Response.json({
      id: 23,
      user: BOT,
      body: "Elsewhere",
      html_url: "https://github.com/octo/hello/pull/8#discussion_r23",
      pull_request_url: `${PULLS}/8`,
    }),
  "POST /repos/octo/hello/pulls/7/comments/21/replies": (body) =>
    Response.json(
      {
        id: 99,
        user: BOT,
        body: (body as { body: string }).body,
        html_url: "https://github.com/octo/hello/pull/7#discussion_r99",
        pull_request_url: `${PULLS}/7`,
        in_reply_to_id: 21,
      },
      { status: 201 },
    ),
  "GET /repos/octo/hello/issues/comments/31": () =>
    Response.json({
      id: 31,
      user: BOT,
      body: "Reviewing",
      html_url: "https://github.com/octo/hello/pull/7#issuecomment-31",
      issue_url: "https://api.github.com/repos/octo/hello/issues/7",
    }),
  "GET /repos/octo/hello/issues/comments/32": () =>
    Response.json({
      id: 32,
      user: ADA,
      body: "Thanks",
      html_url: "https://github.com/octo/hello/pull/7#issuecomment-32",
      issue_url: "https://api.github.com/repos/octo/hello/issues/7",
    }),
  "PATCH /repos/octo/hello/issues/comments/31": (body) =>
    Response.json({
      id: 31,
      user: BOT,
      body: (body as { body: string }).body,
      html_url: "https://github.com/octo/hello/pull/7#issuecomment-31",
      issue_url: "https://api.github.com/repos/octo/hello/issues/7",
    }),
  "DELETE /repos/octo/hello/issues/comments/31": () =>
    new Response(null, { status: 204 }),
};

describe("GitHub connections: the actions a review poster needs", () => {
  async function setup() {
    const { github, provider } = appProvider(REVIEW_ROUTES);
    const material = await appMaterial(provider);
    const call = (action: string, input: Record<string, unknown>) =>
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action,
        input: JSON.parse(JSON.stringify(input)),
        capabilities: ALL,
        repositories: REPOS,
      });
    const mints = () =>
      github.calls
        .filter((entry) => entry.url.endsWith("/access_tokens"))
        .map((entry) => entry.body);
    const requests = () =>
      github.calls
        .filter(
          (entry) =>
            !entry.url.endsWith("/access_tokens") &&
            !entry.url.includes("/app/installations/") &&
            !entry.url.includes("/orgs/octo/installation"),
        )
        .map((entry) => `${entry.method} ${new URL(entry.url).pathname}`);
    return { github, call, mints, requests };
  }

  async function setupWith(
    routes: Record<string, (body: unknown, url: URL) => Response>,
  ) {
    const { github, provider } = appProvider({ ...REVIEW_ROUTES, ...routes });
    const material = await appMaterial(provider);
    const call = (action: string, input: Record<string, unknown>) =>
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action,
        input: JSON.parse(JSON.stringify(input)),
        capabilities: ALL,
        repositories: REPOS,
      });
    return { github, call };
  }

  it("lists conversation comments with connection ownership for read-only reconciliation", async () => {
    const { github, call } = await setupWith({
      "GET /repos/octo/hello/issues/7": () =>
        Response.json({ number: 7, pull_request: { url: `${PULLS}/7` } }),
      "GET /repos/octo/hello/issues/7/comments": () =>
        Response.json([
          {
            id: 301,
            user: BOT,
            body: "<!-- effect=one -->",
            html_url: "https://github.com/octo/hello/pull/7#issuecomment-301",
          },
          {
            id: 302,
            user: ADA,
            body: "<!-- effect=one -->",
            html_url: "https://github.com/octo/hello/pull/7#issuecomment-302",
          },
        ]),
    });
    await expect(
      call("issue_comments", { repository: "octo/hello", number: 7 }),
    ).resolves.toEqual({
      comments: [
        {
          id: 301,
          body: "<!-- effect=one -->",
          own: true,
          url: "https://github.com/octo/hello/pull/7#issuecomment-301",
        },
        {
          id: 302,
          body: "<!-- effect=one -->",
          own: false,
          url: "https://github.com/octo/hello/pull/7#issuecomment-302",
        },
      ],
    });
    expect(
      github.calls
        .filter((entry) => entry.url.endsWith("/access_tokens"))
        .at(-1)?.body,
    ).toMatchObject({ permissions: { pull_requests: "read" } });
    await expect(
      call("issue_comments", { repository: "octo/other", number: 7 }),
    ).rejects.toThrow();
  });

  it("lists every review thread with every comment, marking the App's own", async () => {
    const { github, call, mints } = await setup();
    const result = await call("review_threads", {
      repository: "octo/hello",
      number: 7,
    });
    expect(result).toEqual({
      threads: [
        expect.objectContaining({
          id: "PRRT_own",
          isResolved: false,
          path: "src/a.ts",
          line: 1,
          side: "RIGHT",
          comments: [
            expect.objectContaining({ id: 21, author: "work[bot]", own: true }),
            expect.objectContaining({ id: 22, author: "ada", own: false }),
          ],
        }),
        expect.objectContaining({
          id: "PRRT_human",
          comments: [expect.objectContaining({ id: 41, own: false })],
        }),
        expect.objectContaining({ id: "PRRT_done", isResolved: true }),
      ],
    });
    const queries = github.calls
      .filter((entry) => entry.url === "https://api.github.com/graphql")
      .map((entry) => entry.body as { variables: unknown });
    expect(queries.map((query) => query.variables)).toEqual([
      { owner: "octo", name: "hello", number: 7, after: null },
      { id: "PRRT_own", after: "k1" },
      { owner: "octo", name: "hello", number: 7, after: "c1" },
    ]);
    expect(mints()).toEqual([
      { repositories: ["hello"], permissions: { pull_requests: "read" } },
    ]);
  });

  it("resolves the pull request's threads the App opened, each reply once, checking all first", async () => {
    const { github, call, mints, requests } = await setup();
    const resolve = (threads: Array<{ threadId: string; reply?: string }>) =>
      call("resolve_review_thread", {
        repository: "octo/hello",
        number: 7,
        threads,
      });
    // A refused thread anywhere in the list stops the whole call first.
    for (const [threadId, refusal] of [
      ["PRRT_other", /not a review thread of octo\/hello#7/],
      ["PRRT_missing", /not a review thread of octo\/hello#7/],
      ["I_issue", /not a review thread of octo\/hello#7/],
      [
        "PRRT_human",
        /opened by ada; this connection resolves only threads it opened/,
      ],
    ] as const)
      await expect(
        resolve([{ threadId: "PRRT_own", reply: "Fixed." }, { threadId }]),
        threadId,
      ).rejects.toThrow(refusal);
    expect(requests().filter((entry) => entry !== "POST /graphql")).toEqual([]);
    const graphqlBefore = requests().length;
    await expect(
      resolve([
        { threadId: "PRRT_own", reply: "Fixed in abc. turn=t1" },
        { threadId: "PRRT_replied", reply: "Fixed in abc. turn=t1" },
        { threadId: "PRRT_done" },
      ]),
    ).resolves.toEqual({
      threads: [
        { id: "PRRT_own", isResolved: true, replied: true },
        { id: "PRRT_replied", isResolved: true, replied: false },
        { id: "PRRT_done", isResolved: true, replied: false },
      ],
    });
    // Three lookups, one reply (the other thread already ends with it),
    // two resolutions (one was resolved).
    expect(requests().slice(graphqlBefore)).toEqual([
      "POST /graphql",
      "POST /graphql",
      "POST /graphql",
      "POST /repos/octo/hello/pulls/7/comments/21/replies",
      "POST /graphql",
      "POST /graphql",
    ]);
    const replies = github.calls.filter((entry) =>
      entry.url.endsWith("/replies"),
    );
    expect(replies.map((entry) => entry.body)).toEqual([
      { body: "Fixed in abc. turn=t1" },
    ]);
    await expect(
      resolve([{ threadId: "PRRT_own" }, { threadId: "PRRT_own" }]),
    ).rejects.toThrow(/PRRT_own is listed twice/);
    await expect(resolve([])).rejects.toThrow();
    await expect(resolve([{ threadId: "x y" }])).rejects.toThrow();
    await expect(
      resolve(
        Array.from({ length: 21 }, (_, index) => ({ threadId: `T_${index}` })),
      ),
    ).rejects.toThrow();
    expect(mints()).toEqual([
      { repositories: ["hello"], permissions: { pull_requests: "write" } },
    ]);
  });

  it("writes the description and dismisses only its own change requests", async () => {
    const { github, call, mints, requests } = await setup();
    await expect(
      call("update_pull_request", {
        repository: "octo/hello",
        number: 7,
        body: "Adds totals.\n\n<!-- work-review:start -->ok<!-- work-review:end -->",
      }),
    ).resolves.toMatchObject({
      number: 7,
      url: "https://github.com/octo/hello/pull/7",
    });
    expect(github.calls.at(-1)?.body).toEqual({
      body: "Adds totals.\n\n<!-- work-review:start -->ok<!-- work-review:end -->",
    });
    await expect(
      call("list_reviews", { repository: "octo/hello", number: 7 }),
    ).resolves.toEqual({
      reviews: [
        expect.objectContaining({
          id: 11,
          state: "CHANGES_REQUESTED",
          author: "work[bot]",
          own: true,
          commitId: SHA,
        }),
        expect.objectContaining({ id: 12, author: "ada", own: false }),
      ],
    });
    const dismiss = (reviewIds: number[]) =>
      call("dismiss_review", {
        repository: "octo/hello",
        number: 7,
        reviewIds,
        message: "Resolved in a later push",
      });
    // One refused review stops the whole call before anything changes.
    await expect(dismiss([11, 12])).rejects.toThrow(
      /ada's; this connection dismisses only its own/,
    );
    await expect(dismiss([11, 13])).rejects.toThrow(
      /COMMENTED; only reviews that approved or requested changes/,
    );
    await expect(dismiss([15])).rejects.toThrow(/not on octo\/hello#7/);
    await expect(dismiss([11, 11])).rejects.toThrow(/listed twice/);
    await expect(dismiss([14, 11])).resolves.toEqual({
      reviews: [
        expect.objectContaining({ id: 14, state: "DISMISSED" }),
        expect.objectContaining({ id: 11, state: "DISMISSED" }),
      ],
    });
    expect(github.calls.at(-1)?.body).toEqual({
      message: "Resolved in a later push",
      event: "DISMISS",
    });
    expect(requests().filter((entry) => !entry.startsWith("GET "))).toEqual([
      "PATCH /repos/octo/hello/pulls/7",
      "PUT /repos/octo/hello/pulls/7/reviews/11/dismissals",
    ]);
    expect(mints()).toEqual([
      { repositories: ["hello"], permissions: { pull_requests: "write" } },
      { repositories: ["hello"], permissions: { pull_requests: "read" } },
    ]);
  });

  it("replies in the pull request's threads and changes only its own comments", async () => {
    const { github, call, mints, requests } = await setup();
    const reply = (commentId: number) =>
      call("reply_to_review_comment", {
        repository: "octo/hello",
        number: 7,
        commentId,
        body: "Fixed in abc. turn=t1",
      });
    await expect(reply(23)).rejects.toThrow(
      /not a review comment of octo\/hello#7/,
    );
    await expect(reply(21)).resolves.toEqual({
      id: 99,
      url: "https://github.com/octo/hello/pull/7#discussion_r99",
    });
    // A reply to a reply joins the thread its first comment opened.
    await reply(22);
    expect(requests().filter((entry) => entry.startsWith("POST "))).toEqual([
      "POST /repos/octo/hello/pulls/7/comments/21/replies",
      "POST /repos/octo/hello/pulls/7/comments/21/replies",
    ]);
    expect(github.calls.at(-1)?.body).toEqual({
      body: "Fixed in abc. turn=t1",
    });

    for (const action of ["update_issue_comment", "delete_issue_comment"])
      await expect(
        call(action, {
          repository: "octo/hello",
          commentId: 32,
          ...(action === "update_issue_comment" ? { body: "x" } : {}),
        }),
      ).rejects.toThrow(/ada's; this connection changes only its own comments/);
    await expect(
      call("update_issue_comment", {
        repository: "octo/hello",
        commentId: 31,
        body: "Reviewed abc.",
      }),
    ).resolves.toEqual({
      id: 31,
      url: "https://github.com/octo/hello/pull/7#issuecomment-31",
    });
    await expect(
      call("delete_issue_comment", { repository: "octo/hello", commentId: 31 }),
    ).resolves.toEqual({ id: 31, deleted: true });
    expect(
      requests().filter(
        (entry) => entry.includes("/issues/") && !entry.startsWith("GET "),
      ),
    ).toEqual([
      "PATCH /repos/octo/hello/issues/comments/31",
      "DELETE /repos/octo/hello/issues/comments/31",
    ]);
    expect(mints()).toEqual([
      { repositories: ["hello"], permissions: { pull_requests: "write" } },
      { repositories: ["hello"], permissions: { issues: "write" } },
    ]);
    // Typed actions keep to the binding's repositories like REST does.
    await expect(
      call("delete_issue_comment", {
        repository: "octo/secret",
        commentId: 31,
      }),
    ).rejects.toThrow(/outside this connection's repositories/);
  });

  it("finds a stamped review, check run, comment or reply on sequential redelivery", async () => {
    const STAMP_MARK = "<!-- work-review turn=t1 -->";
    const posted = {
      reviews: [] as unknown[],
      runs: [] as unknown[],
      comments: [] as unknown[],
      replies: [] as unknown[],
    };
    const { github, provider } = appProvider({
      ...REVIEW_ROUTES,
      "GET /repos/octo/hello/pulls/7/reviews": () =>
        Response.json(posted.reviews),
      "POST /repos/octo/hello/pulls/7/reviews": (body) => {
        const review = {
          ...review_(901, "CHANGES_REQUESTED"),
          body: (body as { body: string }).body,
        };
        posted.reviews.push(review);
        return Response.json(review);
      },
      [`GET /repos/octo/hello/commits/${SHA}/check-runs`]: () =>
        Response.json({
          total_count: posted.runs.length,
          check_runs: posted.runs,
        }),
      "POST /repos/octo/hello/check-runs": (body) => {
        const run = {
          id: 77,
          html_url: "https://github.com/octo/hello/runs/77",
          status: "completed",
          conclusion: "failure",
          external_id: (body as { external_id?: string }).external_id ?? null,
          app: { slug: "work" },
        };
        posted.runs.push(run);
        return Response.json(run, { status: 201 });
      },
      "GET /repos/octo/hello/issues/7": () =>
        Response.json({ number: 7, pull_request: { url: `${PULLS}/7` } }),
      "GET /repos/octo/hello/issues/7/comments": () =>
        Response.json(posted.comments),
      "POST /repos/octo/hello/issues/7/comments": (body) => {
        const comment = {
          id: 300 + posted.comments.length,
          user: BOT,
          body: (body as { body: string }).body,
          html_url: "https://github.com/octo/hello/pull/7#issuecomment-300",
          issue_url: "https://api.github.com/repos/octo/hello/issues/7",
        };
        posted.comments.push(comment);
        return Response.json(comment, { status: 201 });
      },
      "GET /repos/octo/hello/pulls/7/comments": () =>
        Response.json(posted.replies),
      "POST /repos/octo/hello/pulls/7/comments/21/replies": (body) => {
        const reply = {
          id: 400,
          user: BOT,
          body: (body as { body: string }).body,
          html_url: "https://github.com/octo/hello/pull/7#discussion_r400",
          pull_request_url: `${PULLS}/7`,
          in_reply_to_id: 21,
        };
        posted.replies.push(reply);
        return Response.json(reply, { status: 201 });
      },
    });
    const material = await appMaterial(provider);
    const call = (action: string, input: Record<string, unknown>) =>
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action,
        input: JSON.parse(JSON.stringify(input)),
        capabilities: ALL,
        repositories: REPOS,
      });
    const writes = {
      create_review: {
        repository: "octo/hello",
        number: 7,
        event: "REQUEST_CHANGES",
        body: `Blocking.\n\n${STAMP_MARK}`,
        stamp: STAMP_MARK,
      },
      create_check_run: {
        repository: "octo/hello",
        name: "Work review",
        headSha: SHA,
        conclusion: "failure",
        stamp: "turn=t1",
      },
      issue_comment: {
        repository: "octo/hello",
        number: 7,
        body: `Yes.\n\n${STAMP_MARK}`,
        stamp: STAMP_MARK,
      },
      reply_to_review_comment: {
        repository: "octo/hello",
        number: 7,
        commentId: 21,
        body: `Because.\n\n${STAMP_MARK}`,
        stamp: STAMP_MARK,
      },
    };
    for (const [action, input] of Object.entries(writes)) {
      const first = await call(action, input);
      const again = await call(action, input);
      expect(first, action).not.toHaveProperty("existing");
      expect(again, action).toMatchObject({ existing: true });
    }
    expect(posted.reviews).toHaveLength(1);
    expect(posted.runs).toHaveLength(1);
    expect(posted.comments).toHaveLength(1);
    expect(posted.replies).toHaveLength(1);
    // The stamp is the run's external id.
    expect(posted.runs[0]).toMatchObject({ external_id: "turn=t1" });
    // A stamp the body lacks could never be found again.
    await expect(
      call("create_review", { ...writes.create_review, body: "Blocking." }),
    ).rejects.toThrow(/must contain its stamp/);
    await expect(
      call("create_check_run", {
        ...writes.create_check_run,
        externalId: "other",
      }),
    ).rejects.toThrow(/external id is its stamp/);
    // A comment on a pull request needs pull_requests, never the whole
    // installation; an issue's needs issues.
    const commentMints = github.calls
      .filter((entry) => entry.url.endsWith("/access_tokens"))
      .map((entry) => entry.body);
    expect(commentMints).toContainEqual({
      repositories: ["hello"],
      permissions: { pull_requests: "write" },
    });
    expect(commentMints).not.toContainEqual({ repositories: ["hello"] });
  });

  it("lists a commit's check runs, marking the App's own", async () => {
    const { github, call } = await setupWith({
      [`GET /repos/octo/hello/commits/${SHA}/check-runs`]: () =>
        Response.json({
          total_count: 2,
          check_runs: [
            {
              id: 1,
              external_id: "turn=t1",
              app: { slug: "work" },
              status: "completed",
              conclusion: "failure",
              html_url: "u1",
            },
            {
              id: 2,
              external_id: "turn=t2",
              app: { slug: "github-actions" },
              status: "completed",
              conclusion: "success",
              html_url: "u2",
            },
          ],
        }),
    });
    await expect(
      call("check_runs", {
        repository: "octo/hello",
        commit: SHA,
        name: "Work review",
      }),
    ).resolves.toEqual({
      runs: [
        expect.objectContaining({ id: 1, conclusion: "failure", own: true }),
        expect.objectContaining({ id: 2, conclusion: "success", own: false }),
      ],
    });
    expect(github.calls.at(-1)?.url).toContain("check_name=Work%20review");
  });

  it("comments on an issue with issues alone", async () => {
    const { github, provider } = appProvider({
      ...REVIEW_ROUTES,
      "GET /repos/octo/hello/issues/8": () => Response.json({ number: 8 }),
      "POST /repos/octo/hello/issues/8/comments": () =>
        Response.json(
          {
            id: 1,
            user: BOT,
            body: "x",
            html_url: "https://github.com/octo/hello/issues/8#issuecomment-1",
          },
          { status: 201 },
        ),
    });
    const material = await appMaterial(provider);
    await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "issue_comment",
      input: { repository: "octo/hello", number: 8, body: "x" },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(
      github.calls
        .filter((entry) => entry.url.endsWith("/access_tokens"))
        .map((entry) => entry.body),
    ).toEqual([
      { repositories: ["hello"], permissions: READ_PERMISSIONS },
      { repositories: ["hello"], permissions: { issues: "write" } },
    ]);
  });

  it("refuses to dismiss a review whose pull request it cannot read, and takes up to 100", async () => {
    const { call } = await setupWith({
      "GET /repos/octo/hello/pulls/7/reviews/16": () =>
        Response.json({
          ...review_(16, "CHANGES_REQUESTED"),
          pull_request_url: undefined,
        }),
    });
    const dismiss = (reviewIds: number[]) =>
      call("dismiss_review", {
        repository: "octo/hello",
        number: 7,
        reviewIds,
        message: "m",
      });
    await expect(dismiss([16])).rejects.toThrow(/not on octo\/hello#7/);
    await expect(
      dismiss(Array.from({ length: 101 }, (_, index) => index + 1)),
    ).rejects.toThrow();
  });

  it("throws when GitHub fails to serve a read, so the caller asks again", async () => {
    const { call } = await setupWith({
      "GET /repos/octo/hello/pulls/9": () =>
        Response.json({ message: "Server Error" }, { status: 502 }),
    });
    await expect(
      call("get", { path: "/repos/octo/hello/pulls/9" }),
    ).rejects.toMatchObject({ status: 502 });
    // An answer GitHub did give, a 404 included, is data.
    await expect(
      call("get", { path: "/repos/octo/hello/pulls/10" }),
    ).resolves.toMatchObject({ status: 404 });
  });

  it("lists the read actions as read-only", async () => {
    const { provider } = appProvider();
    const material = await appMaterial(provider);
    const listed = await provider.listActions?.({
      material,
      capabilities: ALL,
    });
    const readOnly = (listed ?? [])
      .filter(
        (action) =>
          (action.annotations as { readOnlyHint?: boolean } | undefined)
            ?.readOnlyHint === true,
      )
      .map((action) => action.name);
    expect(readOnly).toEqual([
      "get",
      "pull_request_files",
      "review_threads",
      "check_runs",
      "list_reviews",
      "issue_comments",
    ]);
  });
});

describe("GitHub connections: members (user-to-server OAuth)", () => {
  it("refuses member authorization without an OAuth client", async () => {
    const { provider } = appProvider();
    await expect(
      provider.beginAuthorization?.({
        tenantId: "t",
        projectId: "p",
        externalUserId: "u",
        principal: "member",
        redirectUri: "https://work.test/cb",
        state: "s",
      }),
    ).rejects.toThrow(/accepts only GitHub App connections/);
  });

  it("runs the device flow and acts as the person", async () => {
    const github = fakeGithub();
    const sleeps: number[] = [];
    let pending = 1;
    let clock = NOW;
    const provider = defineGithubConnectionProvider({
      oauth: { clientId: "Iv1" },
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
      fetch: async (input, init) => {
        if (
          String(input).endsWith("/login/oauth/access_token") &&
          pending-- > 0
        ) {
          return Response.json({ error: "authorization_pending" });
        }
        return github.fetch(input, init);
      },
    });
    const begun = await provider.beginAuthorization?.({
      tenantId: "t",
      projectId: "p",
      externalUserId: "u",
      principal: "member",
      redirectUri: "https://work.test/cb",
      state: "s",
    });
    expect(begun?.challenge).toEqual({
      kind: "device",
      verificationUrl: "https://github.com/login/device",
      userCode: "ABCD-1234",
      expiresAt: new Date(NOW + 900_000).toISOString(),
    });
    const authorized = await provider.completeAuthorization?.({
      tenantId: "t",
      projectId: "p",
      externalUserId: "u",
      principal: "member",
      callback: {},
      privateState: begun?.privateState,
    });
    expect(sleeps).toEqual([5000]);
    expect(authorized?.account).toEqual({
      type: "user",
      login: "mona",
      id: 3,
      name: "Mona",
    });
    expect(authorized?.expiresAt).toEqual(new Date(clock + 28_800_000));
    const material = authorized?.material ?? new Uint8Array();

    await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "get",
      input: { path: "/repos/octo/hello/pulls" },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(github.calls.at(-1)?.authorization).toBe("Bearer ghu_1");
    expect(
      github.calls.some((call) => call.url.endsWith("/access_tokens")),
    ).toBe(false);
    expect(
      await provider.git.credentials({
        material,
        remoteUrl: "https://github.com/octo/hello.git",
        access: "write",
      }),
    ).toEqual({
      username: "mona",
      password: "ghu_1",
      expiresAt: new Date(clock + 28_800_000),
    });

    const refreshed = await provider.refresh?.({ material });
    const next = refreshed?.material ?? new Uint8Array();
    await provider.invoke({
      connection: TEST_CONNECTION,
      material: next,
      action: "get",
      input: { path: "/repos/octo/hello/pulls" },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(github.calls.at(-1)?.authorization).toBe("Bearer ghu_2");

    clock += 9 * 3_600_000;
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action: "get",
        input: { path: "/repos/octo/hello/pulls" },
        capabilities: ALL,
        repositories: REPOS,
      }),
    ).rejects.toMatchObject({ code: "connection_authorization_expired" });
  });

  it("uses the web flow with a client secret and expires on a 401", async () => {
    const github = fakeGithub({
      "GET /repos/octo/hello": () =>
        Response.json({ message: "Bad credentials" }, { status: 401 }),
    });
    const provider = defineGithubConnectionProvider({
      oauth: { clientId: "Iv1", clientSecret: "shh" },
      fetch: github.fetch,
      now: () => NOW,
    });
    const begun = await provider.beginAuthorization?.({
      tenantId: "t",
      projectId: "p",
      externalUserId: "u",
      principal: "member",
      redirectUri: "https://work.test/cb",
      state: "s1",
    });
    expect(begun?.challenge).toEqual({
      kind: "url",
      url: "https://github.com/login/oauth/authorize?client_id=Iv1&redirect_uri=https%3A%2F%2Fwork.test%2Fcb&state=s1",
    });
    const authorized = await provider.completeAuthorization?.({
      tenantId: "t",
      projectId: "p",
      externalUserId: "u",
      principal: "member",
      callback: { code: "c1", state: "s1" },
      privateState: begun?.privateState,
    });
    const exchange = github.calls.find((call) =>
      call.url.endsWith("/login/oauth/access_token"),
    );
    expect(exchange?.body).toMatchObject({
      client_id: "Iv1",
      client_secret: "shh",
      code: "c1",
      redirect_uri: "https://work.test/cb",
    });
    const material = authorized?.material ?? new Uint8Array();
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action: "get",
        input: { path: "/repos/octo/hello" },
        capabilities: ALL,
        repositories: REPOS,
      }),
    ).rejects.toMatchObject({ code: "connection_authorization_expired" });
    await provider.revoke?.({ material });
    expect(github.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.github.com/applications/Iv1/token",
      body: { access_token: "ghu_1" },
    });
  });

  it("counts the connected person's own reviews and comments as theirs", async () => {
    const github = fakeGithub(REVIEW_ROUTES);
    const provider = defineGithubConnectionProvider({
      oauth: { clientId: "Iv1" },
      fetch: github.fetch,
      now: () => NOW,
    });
    const { material } = await provider.authorizeUser({
      tokens: {
        accessToken: "ghu_1",
        expiresAt: null,
        refreshToken: null,
        refreshTokenExpiresAt: null,
      },
    });
    // Mona (id 3) connected; ada wrote review 12 and the App review 11.
    const reviews = await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "list_reviews",
      input: { repository: "octo/hello", number: 7 },
      capabilities: ALL,
      repositories: REPOS,
    });
    expect(reviews).toMatchObject({
      reviews: [
        { id: 11, own: false },
        { id: 12, own: false },
      ],
    });
    await expect(
      provider.invoke({
        connection: TEST_CONNECTION,
        material,
        action: "dismiss_review",
        input: {
          repository: "octo/hello",
          number: 7,
          reviewIds: [11],
          message: "m",
        },
        capabilities: ALL,
        repositories: REPOS,
      }),
    ).rejects.toThrow(/work\[bot\]'s; this connection dismisses only its own/);
    const adaGithub = fakeGithub({
      ...REVIEW_ROUTES,
      "GET /user": () =>
        Response.json({ login: "ada", id: 5, avatar_url: "", name: "Ada" }),
    });
    const asAda = defineGithubConnectionProvider({
      oauth: { clientId: "Iv1" },
      fetch: adaGithub.fetch,
      now: () => NOW,
    });
    const adaMaterial = (
      await asAda.authorizeUser({
        tokens: {
          accessToken: "ghu_ada",
          expiresAt: null,
          refreshToken: null,
          refreshTokenExpiresAt: null,
        },
      })
    ).material;
    await expect(
      asAda.invoke({
        connection: TEST_CONNECTION,
        material: adaMaterial,
        action: "list_reviews",
        input: { repository: "octo/hello", number: 7 },
        capabilities: ALL,
        repositories: REPOS,
      }),
    ).resolves.toMatchObject({
      reviews: [
        { id: 11, own: false },
        { id: 12, own: true },
      ],
    });
  });

  it("serves GitHub Enterprise Server origins, GraphQL included", async () => {
    const github = fakeGithub(REVIEW_ROUTES);
    const provider = defineGithubConnectionProvider({
      apiBaseUrl: "https://ghe.acme.test/api/v3",
      webBaseUrl: "https://ghe.acme.test",
      fetch: github.fetch,
      now: () => NOW,
    });
    expect(provider.git.remoteBaseUrls).toEqual(["https://ghe.acme.test/"]);
    expect(() =>
      defineGithubConnectionProvider({ apiBaseUrl: "http://ghe.acme.test" }),
    ).toThrow(/HTTPS/);
    const material = await appMaterial(provider);
    await provider.invoke({
      connection: TEST_CONNECTION,
      material,
      action: "resolve_review_thread",
      input: {
        repository: "octo/hello",
        number: 7,
        threads: [{ threadId: "PRRT_own" }],
      },
      capabilities: ALL,
      repositories: REPOS,
    });
    const graphql = github.calls.filter((call) => call.url.endsWith("graphql"));
    expect(graphql.map((call) => call.url)).toEqual([
      "https://ghe.acme.test/api/graphql",
      "https://ghe.acme.test/api/graphql",
    ]);
    expect(graphql.every((call) => call.authorization === "Bearer ghs_1")).toBe(
      true,
    );
  });
});
