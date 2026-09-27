import { generateKeyPairSync } from "node:crypto";
import type { CodeHostCredential } from "@catamorphic/core";
import { describe, expect, it } from "vitest";
import { githubCodeHost } from "./github-code-host.js";
import { defineGithubConnectionProvider } from "./github-connection-provider.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const NOW = 1_750_000_000_000;
const REMOTE = "https://github.com/octo/hello.git";

interface Call {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** A fake api.github.com recording each request (ADR 0177). */
function fakeGithub() {
  const calls: Call[] = [];
  let minted = 0;
  const fetchImpl = async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({
      method,
      path: `${url.pathname}${url.search}`,
      authorization: new Headers(init?.headers).get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = `${method} ${url.pathname}`;
    switch (key) {
      case "GET /orgs/octo/installation":
        return Response.json({
          id: 77,
          account: { login: "octo", id: 1, type: "Organization" },
          repository_selection: "selected",
          permissions: {},
          events: [],
          app_slug: "work",
          suspended_at: null,
        });
      case "POST /app/installations/77/access_tokens":
        minted += 1;
        return Response.json(
          {
            token: `ghs_${minted}`,
            expires_at: new Date(NOW + 3_600_000).toISOString(),
          },
          { status: 201 },
        );
      case "POST /repos/octo/hello/pulls":
        return Response.json({
          html_url: "https://github.com/octo/hello/pull/8",
          number: 8,
        });
      case "GET /repos/octo/hello/pulls":
        return Response.json([
          {
            number: 8,
            title: "Fix",
            html_url: "https://github.com/octo/hello/pull/8",
            user: { login: "mona" },
            head: { ref: "work/fix", sha: "a".repeat(40) },
            base: { ref: "main" },
            draft: false,
            updated_at: "2026-09-27T00:00:00Z",
            body: null,
            requested_reviewers: [],
          },
        ]);
      case "GET /search/issues":
        return Response.json({
          items: [{ number: 8 }],
          incomplete_results: false,
          total_count: 1,
        });
      case "GET /installation/repositories":
        return Response.json({ repositories: [repo("hello")] });
      case "GET /user/repos":
        return Response.json([repo("personal")]);
      case "GET /user":
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

function repo(name: string) {
  return {
    id: 1,
    full_name: `octo/${name}`,
    name,
    owner: { login: "octo" },
    private: true,
    default_branch: "main",
    clone_url: `https://github.com/octo/${name}.git`,
    description: null,
    pushed_at: null,
  };
}

function credential(
  args: Awaited<
    ReturnType<
      ReturnType<typeof defineGithubConnectionProvider>["authorizeApp"]
    >
  >,
  principalKind: CodeHostCredential["principalKind"],
): CodeHostCredential {
  return {
    connection: { id: "connection-1", revision: 1 },
    principalKind,
    account: args.account ?? {},
    material: args.material,
  };
}

describe("githubCodeHost", () => {
  it("opens pull requests with an App installation token narrowed to the repository", async () => {
    const github = fakeGithub();
    const provider = defineGithubConnectionProvider({
      fetch: github.fetch,
      now: () => NOW,
    });
    const host = githubCodeHost(provider);
    const app = credential(
      await provider.authorizeApp({ appId: "123", privateKey, owner: "octo" }),
      "tenant_service",
    );
    const pr = await host.createPullRequest?.({
      credential: app,
      remoteUrl: REMOTE,
      title: "Fix",
      head: "work/fix",
      base: "main",
    });
    expect(pr).toEqual({
      url: "https://github.com/octo/hello/pull/8",
      number: 8,
    });
    const mint = github.calls.find(
      (call) => call.path === "/app/installations/77/access_tokens",
    );
    expect(mint?.body).toEqual({
      repositories: ["hello"],
      permissions: { pull_requests: "write", contents: "read" },
    });
    const opened = github.calls.find(
      (call) =>
        call.method === "POST" && call.path === "/repos/octo/hello/pulls",
    );
    expect(opened?.authorization).toMatch(/^Bearer ghs_/);
    expect(opened?.body).toMatchObject({ head: "work/fix", base: "main" });

    // An installation lists what it was granted; it has no viewer.
    expect(
      (await host.listRepositories?.({ credential: app }))?.map(
        (item) => item.fullName,
      ),
    ).toEqual(["octo/hello"]);
    await expect(host.viewer?.({ credential: app })).rejects.toThrow();
    // Repositories of other accounts are outside the installation.
    await expect(
      host.listPullRequests?.({
        credential: app,
        remoteUrl: "https://github.com/someone/else.git",
      }),
    ).rejects.toThrow("outside the GitHub App installation");
  });

  it("acts as the member with their own token", async () => {
    const github = fakeGithub();
    const provider = defineGithubConnectionProvider({
      fetch: github.fetch,
      now: () => NOW,
    });
    const host = githubCodeHost(provider);
    const member = credential(
      await provider.authorizeUser({
        tokens: {
          accessToken: "ghu_member",
          expiresAt: null,
          refreshToken: null,
          refreshTokenExpiresAt: null,
        },
      }),
      "member",
    );
    expect(member.account).toMatchObject({ type: "user", login: "mona" });
    expect(await host.viewer?.({ credential: member })).toEqual({
      login: "mona",
    });
    const pulls = await host.listPullRequests?.({
      credential: member,
      remoteUrl: REMOTE,
    });
    expect(pulls).toMatchObject([
      { number: 8, head: "work/fix", reviewRequestedForViewer: true },
    ]);
    expect(
      (await host.listRepositories?.({ credential: member }))?.map(
        (item) => item.fullName,
      ),
    ).toEqual(["octo/personal"]);
    expect(
      github.calls
        .filter((call) => call.path.startsWith("/repos/"))
        .every((call) => call.authorization === "Bearer ghu_member"),
    ).toBe(true);
    // Git credentials for the member carry their login.
    expect(
      await provider.git.credentials({
        material: member.material,
        remoteUrl: REMOTE,
        access: "write",
      }),
    ).toMatchObject({ username: "mona", password: "ghu_member" });
  });
});
