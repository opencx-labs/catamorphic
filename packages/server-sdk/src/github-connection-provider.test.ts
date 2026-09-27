import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  defineGithubConnectionProvider,
  GITHUB_CONNECTION_ACTIONS,
} from "./github-connection-provider.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const NOW = 1_750_000_000_000;
const SHA = "a".repeat(40);

interface Call {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/** A fake github.com + api.github.com, recording each request. */
function fakeGithub(overrides: Record<string, () => Response> = {}) {
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
    const key = `${method} ${url.pathname}`;
    const override = overrides[key];
    if (override) return override();
    if (key === "GET /orgs/octo/installation") {
      return Response.json({
        id: 77,
        account: { login: "octo", id: 1, type: "Organization" },
        repository_selection: "all",
        permissions: {},
        events: [],
        app_slug: "work",
        suspended_at: null,
      });
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

function appProvider(overrides?: Record<string, () => Response>) {
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

  it("mints a token narrowed to the repository a REST path addresses", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    const result = await provider.invoke({
      material,
      action: "get",
      input: { path: "/repos/octo/hello/pulls", query: { state: "open" } },
      capabilities: ALL,
    });
    expect(result).toMatchObject({ status: 200, body: [{ number: 7 }] });
    const mint = github.calls.find((call) =>
      call.url.endsWith("/access_tokens"),
    );
    expect(mint?.body).toEqual({ repositories: ["hello"] });
    expect(mint?.authorization).toMatch(/^Bearer ey/);
    const request = github.calls.at(-1);
    expect(request?.url).toBe(
      "https://api.github.com/repos/octo/hello/pulls?state=open",
    );
    expect(request?.authorization).toBe("Bearer ghs_1");
    // The token is cached for the next call on the same repository.
    await provider.invoke({
      material,
      action: "get",
      input: { path: "/repos/octo/hello/pulls" },
      capabilities: ALL,
    });
    expect(
      github.calls.filter((call) => call.url.endsWith("/access_tokens")),
    ).toHaveLength(1);
  });

  it("accepts the JSON credential an operator pastes", async () => {
    const { github, provider } = appProvider();
    const material = new TextEncoder().encode(
      JSON.stringify({ appId: 12345, privateKey, installationId: "77" }),
    );
    await provider.invoke({
      material,
      action: "get",
      input: { path: "/repos/octo/hello/pulls" },
      capabilities: ALL,
    });
    expect(github.calls.at(-1)?.authorization).toBe("Bearer ghs_1");
    await expect(
      provider.invoke({
        material: new TextEncoder().encode("{}"),
        action: "get",
        input: { path: "/user" },
        capabilities: ALL,
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
        material,
        action: "post",
        input: { path: "/repos/octo/hello/issues", body: {} },
        capabilities: ["get"],
      }),
    ).rejects.toThrow(/outside the connection grant/);
    await expect(
      provider.invoke({
        material,
        action: "get",
        input: { path: "/repos/../user" },
        capabilities: ALL,
      }),
    ).rejects.toThrow();
  });

  it("reviews pull requests with inline comments on a narrowed token", async () => {
    const { github, provider } = appProvider();
    const material = await appMaterial(provider);
    const files = await provider.invoke({
      material,
      action: "pull_request_files",
      input: { repository: "octo/hello", number: 7 },
      capabilities: ALL,
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
        material,
        action: "issue_comment",
        input: { repository: "other/hello", number: 1, body: "hi" },
        capabilities: ALL,
      }),
    ).rejects.toThrow(/outside the GitHub App installation on octo/);
    await expect(
      provider.invoke({
        material,
        action: "create_check_run",
        input: { repository: "octo/hello", name: "x", headSha: "short" },
        capabilities: ALL,
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

describe("GitHub connections: members (user-to-server OAuth)", () => {
  it("refuses member authorization without an OAuth client", async () => {
    const { provider } = appProvider();
    await expect(
      provider.beginAuthorization?.({
        tenantId: "t",
        projectId: "p",
        externalUserId: "u",
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
      material,
      action: "get",
      input: { path: "/repos/octo/hello/pulls" },
      capabilities: ALL,
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
      material: next,
      action: "get",
      input: { path: "/user" },
      capabilities: ALL,
    });
    expect(github.calls.at(-1)?.authorization).toBe("Bearer ghu_2");

    clock += 9 * 3_600_000;
    await expect(
      provider.invoke({
        material,
        action: "get",
        input: { path: "/user" },
        capabilities: ALL,
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
        material,
        action: "get",
        input: { path: "/repos/octo/hello" },
        capabilities: ALL,
      }),
    ).rejects.toMatchObject({ code: "connection_authorization_expired" });
    await provider.revoke?.({ material });
    expect(github.calls.at(-1)).toMatchObject({
      method: "DELETE",
      url: "https://api.github.com/applications/Iv1/token",
      body: { access_token: "ghu_1" },
    });
  });

  it("serves GitHub Enterprise Server origins", async () => {
    const provider = defineGithubConnectionProvider({
      apiBaseUrl: "https://ghe.acme.test/api/v3",
      webBaseUrl: "https://ghe.acme.test",
    });
    expect(provider.git.remoteBaseUrls).toEqual(["https://ghe.acme.test/"]);
    expect(() =>
      defineGithubConnectionProvider({ apiBaseUrl: "http://ghe.acme.test" }),
    ).toThrow(/HTTPS/);
  });
});
