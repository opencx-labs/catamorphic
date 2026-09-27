import { execFile, spawn } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "./server.js";
import { testServerOptions } from "./test-support.js";

/**
 * GitHub on a Work server is an ordinary connection (ADR 0177): an operator
 * registers a GitHub App from a manifest, installs it, and the installation
 * becomes the `github` service connection that provisioning, proposals and
 * sync act through. GitHub's API is a fake behind `fetch`; repositories are
 * served over Git smart HTTP by `git http-backend`.
 */

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const runGit = async (cwd: string, args: string[]) =>
  (await promisify(execFile)("git", args, { cwd })).stdout;

const MEMBER_ROLE = { version: 1, name: "Member", agents: ["assistant"] };
const admission = {
  mode: "invitation_only",
  defaultRole: "member",
  approvedDomains: [],
};

let dataDir: string;
let reposDir: string;
let server: WorkServer;
let git: { url: string; close: () => Promise<void> };
let operatorSecret: string;
const api: Array<{ method: string; path: string; body: unknown }> = [];

async function gitHttpServer(root: string) {
  const httpServer = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const child = spawn("git", ["http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method ?? "GET",
        CONTENT_TYPE: request.headers["content-type"] ?? "",
        REMOTE_USER: "test",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    request.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let sent = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (sent) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const [name, ...rest] = line.split(":");
        const value = rest.join(":").trim();
        if (!name) continue;
        if (name.toLowerCase() === "status")
          response.statusCode = Number(value.split(" ")[0]);
        else response.setHeader(name, value);
      }
      sent = true;
      response.write(head.subarray(end + 4));
    });
    child.on("close", () => response.end());
  });
  await new Promise<void>((resolve) =>
    httpServer.listen(0, "127.0.0.1", () => resolve()),
  );
  const address = httpServer.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolve) => httpServer.close(() => resolve())),
  };
}

/** A fake api.github.test that knows one App, installation, and repository. */
function fakeGithubApi(gitBase: string) {
  return async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    api.push({
      method,
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    switch (`${method} ${url.pathname}`) {
      case "POST /app-manifests/manifest-code/conversions":
        return Response.json({
          id: 123,
          slug: "work-acme",
          name: "Work Acme",
          owner: { login: "acme" },
          html_url: "https://github.test/apps/work-acme",
          client_id: "Iv1.acme",
          client_secret: "client-secret",
          webhook_secret: "hook-secret",
          pem: privateKey,
        });
      case "GET /app/installations/77":
        return Response.json({
          id: 77,
          account: { login: "acme", id: 1, type: "Organization" },
          repository_selection: "all",
          permissions: {},
          events: [],
          app_slug: "work-acme",
          suspended_at: null,
        });
      case "POST /app/installations/77/access_tokens":
        return Response.json(
          {
            token: "ghs_installation",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          },
          { status: 201 },
        );
      case "GET /repos/acme/hello":
        return Response.json({
          id: 1,
          full_name: "acme/hello",
          name: "hello",
          owner: { login: "acme" },
          private: true,
          default_branch: "main",
          clone_url: `${gitBase}/acme/hello.git`,
          description: null,
          pushed_at: null,
        });
      case "POST /repos/acme/hello/pulls":
        return Response.json({
          html_url: "https://github.test/acme/hello/pull/3",
          number: 3,
        });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  };
}

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-github-"));
  reposDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-github-repos-"));
  const bare = path.join(reposDir, "acme", "hello.git");
  const seed = path.join(reposDir, "seed");
  fs.mkdirSync(bare, { recursive: true });
  fs.mkdirSync(seed);
  await runGit(bare, ["init", "--bare", "-b", "main"]);
  await runGit(seed, ["init", "-b", "main"]);
  fs.writeFileSync(path.join(seed, "README.md"), "# Hello\n");
  await runGit(seed, ["add", "."]);
  await runGit(seed, [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    "seed",
  ]);
  await runGit(seed, ["push", bare, "main"]);
  git = await gitHttpServer(reposDir);
  const options = testServerOptions({
    dataDir,
    publicBases: ["https://work.acme.test"],
    env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
  });
  server = await createWorkServer({
    ...options,
    hooks: {
      github: {
        apiBaseUrl: "https://api.github.test",
        webBaseUrl: git.url,
        fetch: fakeGithubApi(git.url),
      },
    },
  });
  operatorSecret = fs
    .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
    .trim();
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  await git?.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(reposDir, { recursive: true, force: true });
});

const operator = (method: "POST", url: string, body?: unknown) =>
  server.operatorApp.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

describe("GitHub as the github service connection (ADR 0177)", () => {
  it("offers GitHub as a connection and no GitHub host trigger kinds", () => {
    const core = server.catamorphic.core;
    expect(core.connections?.providerCatalog()).toContainEqual({
      kind: "github",
      displayName: "GitHub",
    });
    expect(core.codeHosts.list()).toEqual([
      { provider: "github", displayName: "GitHub" },
    ]);
    expect(core.triggers.listKinds().map((kind) => kind.name)).not.toContain(
      "github.pull_request",
    );
  });

  let projectId: string;

  it("registers an App from a manifest and connects its installation", async () => {
    const created = await operator("POST", "/_work/operator/projects", {
      name: "brain",
      roles: [{ slug: "member", definition: MEMBER_ROLE }],
      admission,
    });
    expect(created.statusCode).toBe(201);
    projectId = created.json().project.id;

    const unauthorized = await server.operatorApp.inject({
      method: "POST",
      url: "/_work/operator/github/app",
      payload: { name: "Work Acme" },
    });
    expect(unauthorized.statusCode).toBe(401);
    const started = await operator("POST", "/_work/operator/github/app", {
      name: "Work Acme",
      organization: "acme",
      projectId,
    });
    expect(started.statusCode).toBe(201);
    const link = new URL(started.json().url);
    // The browser legs live on the public origin, where the person can reach
    // them; the one-time state authorizes them.
    expect(link.origin).toBe("https://work.acme.test");
    const state = link.pathname.split("/").at(-1) ?? "";

    const browser = (url: string) => server.app.inject({ method: "GET", url });
    expect(
      (
        await server.app.inject({
          method: "POST",
          url: "/_work/operator/github/app",
        })
      ).statusCode,
    ).toBe(404);
    const form = await browser(link.pathname);
    expect(form.statusCode).toBe(200);
    expect(form.body).toContain(
      `action="${git.url}/organizations/acme/settings/apps/new?state=${state}"`,
    );
    const manifest = JSON.parse(
      (/name="manifest" value="([^"]*)"/.exec(form.body)?.[1] ?? "")
        .replaceAll("&quot;", '"')
        .replaceAll("&amp;", "&"),
    );
    expect(manifest).toMatchObject({
      name: "Work Acme",
      url: "https://work.acme.test",
      redirect_url: `https://work.acme.test/_work/github/app/${state}/created`,
      setup_url: `https://work.acme.test/_work/github/app/${state}/installed`,
      callback_urls: [
        "https://work.acme.test/api/connection-authorizations/callback",
      ],
      default_permissions: {
        contents: "write",
        pull_requests: "write",
        checks: "write",
        issues: "write",
        metadata: "read",
        members: "read",
      },
    });
    expect(manifest.default_events).toEqual(
      expect.arrayContaining(["pull_request", "issue_comment", "push"]),
    );
    expect(manifest.hook_attributes.url).toMatch(
      new RegExp(
        `^https://work\\.acme\\.test/api/hooks/${projectId}/github/[\\w-]+$`,
      ),
    );

    const forged = await browser(
      `${link.pathname}/created?code=manifest-code&state=other`,
    );
    expect(forged.statusCode).toBe(404);
    const converted = await browser(
      `${link.pathname}/created?code=manifest-code&state=${state}`,
    );
    expect(converted.statusCode).toBe(302);
    expect(converted.headers.location).toBe(
      `${git.url}/apps/work-acme/installations/new?state=${state}`,
    );

    const installed = await browser(
      `${link.pathname}/installed?installation_id=77&setup_action=install`,
    );
    expect(installed.statusCode).toBe(200);
    expect(installed.body).toContain("GitHub is connected");
    // The project does not declare the secret yet: it is shown once.
    expect(installed.body).toContain("hook-secret");
    const services =
      (await server.catamorphic.core.connections?.listServices({
        identity: {
          tenantId: "00000000-0000-4000-8000-0000000005e1",
          externalUserId: "work-setup-agent",
        },
      })) ?? [];
    expect(services).toContainEqual(
      expect.objectContaining({
        name: "github",
        providerKind: "github",
        principalKind: "tenant_service",
        status: "ready",
        account: expect.objectContaining({ type: "app", installationId: 77 }),
      }),
    );
    // The one-time link is spent.
    expect((await browser(link.pathname)).statusCode).toBe(404);
  });

  it("provisions an attached repository through the service connection and proposes its roles", async () => {
    const response = await operator("POST", "/_work/operator/projects", {
      name: "hello",
      repository: "acme/hello",
      roles: [{ slug: "member", definition: MEMBER_ROLE }],
      admission,
    });
    expect(response.statusCode).toBe(201);
    const result = response.json();
    expect(result.project).toMatchObject({
      remoteUrl: `${git.url}/acme/hello.git`,
      remoteOwnership: "attached",
    });
    expect(result.roles).toMatchObject({
      source: "proposed",
      pullRequest: { url: "https://github.test/acme/hello/pull/3", number: 3 },
    });
    const branch: string = result.roles.branch;
    // The proposal branch reached the repository; main did not move.
    expect(
      await runGit(path.join(reposDir, "acme", "hello.git"), [
        "show",
        `${branch}:.work/roles/member.json`,
      ]),
    ).toContain('"Member"');
    const pulls = api.find(
      (call) =>
        call.method === "POST" && call.path === "/repos/acme/hello/pulls",
    );
    expect(pulls?.body).toMatchObject({ head: branch, base: "main" });
    const minted = api.filter(
      (call) => call.path === "/app/installations/77/access_tokens",
    );
    expect(minted.length).toBeGreaterThan(0);
    expect(
      minted.every((call) => JSON.stringify(call.body).includes("hello")),
    ).toBe(true);
  }, 60_000);
});
