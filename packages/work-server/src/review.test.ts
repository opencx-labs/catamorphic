import { execFile, spawn } from "node:child_process";
import {
  createHmac,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { type Identity, REVIEW_AUTOMATION_FILES } from "@catamorphic/core";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "./execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import { testServerOptions } from "./test-support.js";
import { startWorkWorker } from "./workers/worker-runtime.js";

/**
 * Code and security review of pull requests (#118), end to end on a Work
 * server: the `reviewing-pull-requests` skill's files deployed verbatim as
 * project code and turned on for the project; a fake GitHub (signed webhook
 * deliveries, the REST endpoints the `github` provider calls, and a Git
 * smart-HTTP upstream holding the repository and `refs/pull/1/head`); a
 * read-only role on this test database as the production replica; a fake
 * Slack API; and a local-process review worker with the `review` pool label.
 *
 * The automations run in the default Environment on the control plane; the
 * review chat runs in `review` on the worker and uses that Environment's
 * service bindings (ADR 0181): Git through the gateway, the replica, Slack,
 * and GitHub's typed actions. No credential reaches the worker.
 */

const execute = promisify(execFile);
const git = async (cwd: string, args: readonly string[]) =>
  (await execute("git", ["-C", cwd, ...args])).stdout.trim();
const author = ["-c", "user.name=Ada", "-c", "user.email=ada@example.test"];

const databaseUrl = process.env.DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const schema = `shop_${suffix}`;
const reader = `review_reader_${suffix}`;
const DB_PASSWORD = `pw${randomBytes(12).toString("hex")}`;
const SLACK_TOKEN = `xoxp-test-${randomBytes(12).toString("hex")}`;
const WEBHOOK_SECRET = `whsec-${randomBytes(12).toString("hex")}`;
const { privateKey: APP_KEY } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const setup: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "work-setup-agent",
};

/** Installation tokens the fake GitHub minted; Git accepts only these. */
const issuedTokens = new Set<string>();
const githubCalls: Array<{
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}> = [];
const slackCalls: Array<{ path: string; authorization?: string }> = [];

/** api.github.test: one App installation on `acme`, one repository. */
async function fakeGithub(input: unknown, init?: RequestInit) {
  const url = new URL(String(input));
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  githubCalls.push({
    method,
    path: url.pathname,
    authorization: new Headers(init?.headers).get("authorization"),
    body,
  });
  switch (`${method} ${url.pathname}`) {
    case "GET /app/installations/77":
      return Response.json({
        id: 77,
        account: { login: "acme", id: 1, type: "Organization" },
        repository_selection: "selected",
        permissions: {},
        events: [],
        app_slug: "work-acme",
        suspended_at: null,
      });
    case "POST /app/installations/77/access_tokens": {
      const token = `ghs_${randomBytes(16).toString("hex")}`;
      issuedTokens.add(token);
      return Response.json(
        {
          token,
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        },
        { status: 201 },
      );
    }
    case "POST /repos/acme/web/pulls/1/reviews":
      return Response.json({
        id: 9001,
        html_url: "https://github.test/acme/web/pull/1#pullrequestreview-9001",
        state:
          body?.event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED",
      });
    case "POST /repos/acme/web/check-runs":
      return Response.json(
        {
          id: 501,
          html_url: "https://github.test/acme/web/runs/501",
          status: body?.status ?? "queued",
          conclusion: body?.conclusion ?? null,
        },
        { status: 201 },
      );
    case "POST /repos/acme/web/issues/1/comments":
      return Response.json(
        {
          id: 3001,
          body: body?.body,
          user: { login: "work-acme[bot]" },
          created_at: new Date().toISOString(),
          html_url: "https://github.test/acme/web/pull/1#issuecomment-3001",
        },
        { status: 201 },
      );
  }
  return Response.json({ message: "Not Found" }, { status: 404 });
}

/** Git smart HTTP for the repositories, behind installation tokens. */
function gitHttpServer(projectRoot: string): http.Server {
  return http.createServer((request, response) => {
    const [scheme, encoded] = (request.headers.authorization ?? "").split(" ");
    const [user, token] = Buffer.from(encoded ?? "", "base64")
      .toString()
      .split(":");
    if (
      scheme !== "Basic" ||
      user !== "x-access-token" ||
      !issuedTokens.has(token ?? "")
    ) {
      response.writeHead(401, { "www-authenticate": 'Basic realm="github"' });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://github.test");
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === "string" ? value : "";
    };
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: "x-access-token",
      REQUEST_METHOD: request.method ?? "GET",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: header("content-type"),
    };
    if (header("content-encoding"))
      env.HTTP_CONTENT_ENCODING = header("content-encoding");
    if (header("git-protocol")) env.GIT_PROTOCOL = header("git-protocol");
    const child = spawn("git", ["http-backend"], { env });
    request.pipe(child.stdin);
    let head = Buffer.alloc(0);
    let started = false;
    child.stdout.on("data", (chunk: Buffer) => {
      if (started) {
        response.write(chunk);
        return;
      }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) return;
      let status = 200;
      const headers: Record<string, string> = {};
      for (const line of head.subarray(0, end).toString().split("\r\n")) {
        const separator = line.indexOf(":");
        const name = line.slice(0, separator).trim();
        const value = line.slice(separator + 1).trim();
        if (name.toLowerCase() === "status")
          status = Number.parseInt(value, 10);
        else headers[name] = value;
      }
      response.writeHead(status, headers);
      started = true;
      const rest = head.subarray(end + 4);
      if (rest.length > 0) response.write(rest);
    });
    child.stdout.on("end", () => response.end());
  });
}

/** slack.test: `search.messages` for a user token. */
const fakeSlack = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://slack.test");
  slackCalls.push({
    path: url.pathname,
    ...(request.headers.authorization
      ? { authorization: request.headers.authorization }
      : {}),
  });
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(
    JSON.stringify(
      url.pathname === "/api/search.messages"
        ? {
            ok: true,
            messages: {
              matches: [
                {
                  text: "Totals must be backfilled in batches",
                  permalink: "https://acme.slack.test/archives/C1/p1",
                },
              ],
            },
          }
        : { ok: false, error: "unknown_method" },
    ),
  );
});

function listen(server: http.Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(
        typeof address === "object" && address
          ? `http://127.0.0.1:${address.port}`
          : "",
      );
    }),
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

describe.skipIf(!databaseUrl)("reviewing pull requests (#118)", () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];
  let root: string;
  let workerDir: string;
  let server: WorkServer;
  let upstream: http.Server;
  let gitBase: string;
  let base: string;
  let projectId: string;
  let hookUrl: string;
  let repository: string;
  let work: string;
  let mainHead: string;
  let pullHead: string;

  const readerUrl = () => {
    const url = new URL(databaseUrl ?? "postgres://localhost/test");
    url.username = reader;
    url.password = DB_PASSWORD;
    return url.toString();
  };

  /** A delivery as GitHub sends it, signed with the webhook secret. */
  const fromGithub = (event: string, payload: object) => {
    const body = JSON.stringify(payload);
    return server.app.inject({
      method: "POST",
      url: hookUrl,
      headers: {
        "content-type": "application/json",
        "user-agent": "GitHub-Hookshot/test",
        "x-github-event": event,
        "x-github-delivery": randomUUID(),
        "x-hub-signature-256": `sha256=${createHmac("sha256", WEBHOOK_SECRET).update(body).digest("hex")}`,
      },
      payload: body,
    });
  };
  const pullRequestEvent = (action: string, body: string) => ({
    action,
    number: 1,
    ...(action === "synchronize" ? { before: mainHead, after: pullHead } : {}),
    pull_request: {
      title: "Add order totals",
      body,
      html_url: "https://github.test/acme/web/pull/1",
      merged: false,
      draft: false,
      state: action === "closed" ? "closed" : "open",
      user: { login: "ada", type: "User" },
      requested_reviewers: [{ login: "grace", type: "User" }],
      head: { sha: pullHead, ref: "totals" },
      base: { sha: mainHead, ref: "main" },
    },
    repository: { full_name: "acme/web" },
    sender: { login: "ada", type: "User" },
  });

  const reviewChat = async () =>
    server.catamorphic.core.db
      .selectFrom("agent_sessions")
      .select([
        "id",
        "status",
        "external_user_id",
        "environment_name",
        "allocation_id",
        "workspace",
        "placement",
      ])
      .where("project_id", "=", projectId)
      .where("chat_key", "=", "pr-acme/web-1")
      .orderBy("created_at", "desc")
      .executeTakeFirst();
  /** The chat's settled answers, oldest first. */
  const answers = async (sessionId: string) =>
    (
      await server.catamorphic.core.db
        .selectFrom("agent_items")
        .select("text")
        .where("session_id", "=", sessionId)
        .where("kind", "=", "assistant_message")
        .where("status", "!=", "in_progress")
        .orderBy("position", "asc")
        .execute()
    ).map((message) => message.text);

  async function waitFor<T>(
    what: string,
    probe: () => Promise<T | undefined> | T | undefined,
    timeoutMs = 90_000,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) {
        const db = server.catamorphic.core.db;
        const state = {
          deliveries: await db
            .selectFrom("project_event_deliveries")
            .select(["status", "error"])
            .execute(),
          runs: await db
            .selectFrom("workflow_runs")
            .select(["workflow_name", "status", "error"])
            .where("project_id", "=", projectId)
            .execute(),
          chat: await reviewChat(),
        };
        throw new Error(
          `Timed out waiting for ${what}: ${JSON.stringify(state)}`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  beforeAll(async () => {
    // The production replica: a table with production's shape and a
    // role that can only read it.
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(
      `CREATE TABLE ${schema}.orders AS
         SELECT n AS id, 'customer' || n || '@example.test' AS email, n * 10 AS subtotal
           FROM generate_series(1, 1200) AS n`,
    );
    await admin.query(`CREATE ROLE ${reader} LOGIN PASSWORD '${DB_PASSWORD}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}`);
    await admin.query(`GRANT SELECT ON ${schema}.orders TO ${reader}`);

    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-review-"));
    // GitHub's side: acme/web with main and pull request 1.
    const repositories = path.join(root, "github");
    repository = path.join(repositories, "acme", "web.git");
    fs.mkdirSync(repository, { recursive: true });
    await git(repository, ["init", "--bare", "-q", "-b", "main"]);
    work = path.join(root, "author");
    fs.mkdirSync(work);
    await git(work, ["init", "-q", "-b", "main"]);
    fs.writeFileSync(path.join(work, "readme.md"), "# Web\n");
    await git(work, ["add", "-A"]);
    await git(work, [...author, "commit", "-q", "-m", "Initial"]);
    mainHead = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", repository, "main"]);
    await git(work, ["checkout", "-q", "-b", "totals"]);
    fs.mkdirSync(path.join(work, "db"));
    fs.writeFileSync(
      path.join(work, "db", "002_totals.sql"),
      "ALTER TABLE orders ADD COLUMN total integer NOT NULL DEFAULT 0;\n",
    );
    await git(work, ["add", "-A"]);
    await git(work, [...author, "commit", "-q", "-m", "Add order totals"]);
    pullHead = await git(work, ["rev-parse", "HEAD"]);
    await git(work, ["push", "-q", repository, "HEAD:refs/pull/1/head"]);
    upstream = gitHttpServer(repositories);
    gitBase = await listen(upstream);
    const slackBase = await listen(fakeSlack);

    const gatewayFile = path.join(root, "gateway.json");
    fs.writeFileSync(
      gatewayFile,
      JSON.stringify({
        connections: [
          {
            type: "postgres",
            kind: "prod-replica",
            displayName: "Production (replica)",
            poolSize: 2,
          },
          {
            type: "http",
            kind: "slack",
            displayName: "Slack",
            baseUrl: `${slackBase}/api`,
            actions: [
              {
                name: "conversations.replies",
                method: "get",
                path: "/conversations.replies",
              },
              {
                name: "search.messages",
                method: "get",
                path: "/search.messages",
              },
            ],
          },
        ],
      }),
    );
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    server = await createWorkServer({
      ...testServerOptions({
        dataDir: path.join(root, "control-plane"),
        publicBases: [base],
        env: {
          WORK_FAKE_AGENT: "1",
          WORK_CONTROL_PLANE_WORKLOADS: "workflow",
          WORK_GATEWAY_CONFIG: gatewayFile,
          PATH: process.env.PATH,
        },
      }),
      hooks: {
        github: {
          apiBaseUrl: "https://api.github.test",
          webBaseUrl: gitBase,
          fetch: fakeGithub,
        },
      },
    });
    await server.app.listen({ port, host: "127.0.0.1" });
    const core = server.catamorphic.core;
    const connections = core.connections;
    const secrets = core.secrets;
    if (!connections || !secrets) throw new Error("Connections are required");

    // An administrator connects the organization's systems once, as named
    // service connections; each provider's own challenge vets them.
    for (const [name, providerKind, callback] of [
      [
        "github",
        "github",
        { appId: "123", privateKey: APP_KEY, installationId: "77" },
      ],
      ["prod-replica", "prod-replica", { connectionString: readerUrl() }],
      ["slack-search", "slack", { apiKey: SLACK_TOKEN }],
    ] as const) {
      const created = await connections.createService({
        identity: setup,
        name,
        providerKind,
        principalKind: "tenant_service",
      });
      const started = await connections.beginServiceAuthorization({
        identity: setup,
        connectionId: created.id,
        redirectUri: `${base}/api/connection-authorizations/callback`,
      });
      await connections.completeAuthorization({
        identity: setup,
        state: started.authorizationId,
        callback,
      });
    }

    // The company repository attached as a project; the skill's files,
    // committed verbatim. The worker runs local processes, which cannot
    // build the project image or give each sandbox its own Docker daemon,
    // so the manifest drops just those two lines for this machine.
    const project = await core.projects.create(setup, { name: "Acme web" });
    projectId = project.id;
    await core.db
      .updateTable("projects")
      .set({
        remote_url: `${gitBase}/acme/web.git`,
        remote_branch: "main",
        default_branch: "main",
        remote_ownership: "attached",
      })
      .where("id", "=", projectId)
      .execute();
    const manifest = (REVIEW_AUTOMATION_FILES[".work/project.json"] ?? "")
      .replace(/\n\s*"image": "[^"]*",/, "")
      .replace(/\n\s*"containers": true,/, "");
    expect(manifest).not.toMatch(/"image"|"containers"/);
    const deployed = await core.deployment.deploy(
      SERVER_TENANT_ID,
      projectId,
      setup.externalUserId,
      {
        message: "Review pull requests",
        files: {
          ...REVIEW_AUTOMATION_FILES,
          ".work/project.json": manifest,
          ".work/package.json": JSON.stringify({
            name: "acme-web-work",
            private: true,
            workspaces: ["workflows"],
          }),
          ".work/workflows/package.json": JSON.stringify({
            name: "@acme/workflows",
            private: true,
            type: "module",
            dependencies: { "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION },
          }),
        },
      },
    );
    expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
    await secrets.upsert({
      identity: setup,
      projectId,
      name: "GITHUB_WEBHOOK_SECRET",
      value: WEBHOOK_SECRET,
    });
    for (const workflowName of [
      "reviewPullRequests",
      "answerReviewComments",
      "closePullRequestChats",
    ]) {
      const request = {
        identity: setup,
        projectId,
        workflowName,
        owner: { type: "project" as const },
      };
      const preview = await core.workflowEnablements.preview(request);
      await core.workflowEnablements.create({
        ...request,
        consentDigest: preview.consentDigest,
      });
    }
    const [endpoint] = await core.webhooks.list({ identity: setup, projectId });
    expect(endpoint).toMatchObject({ name: "github", listening: true });
    hookUrl = `/api${endpoint?.path ?? ""}`;

    // A review machine: the pool label, opened to this project only.
    const operatorSecret = fs
      .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
      .trim();
    const operator = (method: "GET" | "POST", url: string, body?: unknown) =>
      server.operatorApp.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${operatorSecret}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });
    const enrollment = await operator("POST", "/_work/operator/workers", {
      name: "review-1",
      labels: { pool: "review" },
      access: { projects: [projectId] },
      trusted: true,
    });
    expect(enrollment.statusCode, enrollment.body).toBe(201);
    workerDir = path.join(root, "review-1");
    workers.push(
      await startWorkWorker({
        controlPlaneUrl: base,
        dataDir: workerDir,
        enrollmentCode: enrollment.json().code,
        execution: executionSettingsFromEnv({
          WORK_SANDBOX: "local-process",
          PATH: process.env.PATH,
          WORK_MAX_WORKSPACES: "2",
          WORK_UNENFORCED_EGRESS: "accept",
        }),
      }),
    );
    await waitFor("the review worker to connect", async () => {
      const machines = (
        await operator("GET", "/_work/operator/machines")
      ).json();
      return machines.machines.some(
        (machine: { id: string; available: boolean }) =>
          machine.id === "worker.review-1" && machine.available,
      )
        ? true
        : undefined;
    });
  }, 180_000);

  afterAll(async () => {
    await Promise.all(workers.map((running) => running.stop()));
    await server?.shutdown();
    upstream?.closeAllConnections();
    await new Promise((resolve) => upstream?.close(resolve));
    await new Promise((resolve) => fakeSlack.close(resolve));
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${reader}`);
    await admin.end();
    if (root) {
      // Deployment snapshots in the workflow sandbox are read-only.
      const writable = (dir: string) => {
        fs.chmodSync(dir, 0o700);
        for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
          if (entry.isDirectory()) writable(path.join(dir, entry.name));
      };
      writable(root);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);

  let sessionId = "";
  let sandboxDir = "";

  it("an opened pull request gets a review chat in `review` at its head, and the review reaches GitHub", async () => {
    const review = JSON.stringify({
      repository: "acme/web",
      number: 1,
      event: "REQUEST_CHANGES",
      commitId: pullHead,
      body: "One blocking issue: the new NOT NULL column rewrites orders.",
      comments: [
        {
          path: "db/002_totals.sql",
          line: 1,
          body: "This rewrites 1200 rows under a lock; add the column nullable, backfill, then validate.",
        },
      ],
    });
    const check = JSON.stringify({
      repository: "acme/web",
      name: "Work review",
      headSha: pullHead,
      status: "completed",
      conclusion: "failure",
      output: {
        title: "Changes requested: 1 blocking issue",
        summary:
          "Fetched main, read the migration, counted orders on the replica.",
      },
    });
    const query = JSON.stringify({
      sql: `select count(*)::int as orders from ${schema}.orders`,
      purpose: "How many rows the totals migration rewrites",
    });
    // The fake agent acts on the last line it is given: the author's text.
    const script = [
      "run pwd && git fetch -q origin main 2>&1 && git rev-parse HEAD FETCH_HEAD && cat db/002_totals.sql",
      "run env",
      `mcp prod query ${query}`,
      'mcp slack search.messages {"query":{"query":"order totals"}}',
      `mcp github create_review ${review}`,
      `mcp github create_check_run ${check}`,
    ].join(" ;; ");
    const delivered = await fromGithub(
      "pull_request",
      pullRequestEvent("opened", `Adds a total to every order.\n${script}`),
    );
    expect(delivered.statusCode, delivered.body).toBe(202);

    const chat = await waitFor("the review chat", async () => {
      const found = await reviewChat();
      return found && (await answers(found.id)).length > 0 ? found : undefined;
    });
    sessionId = chat.id;
    // A project chat, placed by its agent in `review`, on the review
    // machine, with its workspace at the pull request's head.
    expect(chat).toMatchObject({
      status: "active",
      external_user_id: "catamorphic:project",
      environment_name: "review",
      workspace: { ref: "refs/pull/1/head", commit: pullHead },
    });
    expect(JSON.stringify(chat.placement)).toContain("worker.review-1");
    const run = await server.catamorphic.core.db
      .selectFrom("workflow_runs")
      .select(["environment_name", "status"])
      .where("project_id", "=", projectId)
      .where("workflow_name", "=", "reviewPullRequests")
      .executeTakeFirstOrThrow();
    expect(run.environment_name).toBe("default");

    const [answer = ""] = await answers(sessionId);
    const [located, env, counted, searched, reviewed, checked] =
      answer.split("\n---\n");
    // Git in the sandbox fetched through the gateway with the session's
    // grant; the checkout stands on the pull request head.
    expect(located).toMatch(/^exit=0\n/);
    const lines = (located ?? "").split("\n");
    sandboxDir = lines[1] ?? "";
    expect(sandboxDir).toContain(workerDir);
    expect(lines.slice(2, 4)).toEqual([pullHead, mainHead]);
    expect(located).toContain("ADD COLUMN total integer NOT NULL");
    expect(JSON.parse(counted ?? "")).toMatchObject({
      rows: [{ orders: 1200 }],
    });
    expect(JSON.parse(searched ?? "")).toMatchObject({
      status: 200,
      body: { ok: true },
    });
    expect(JSON.parse(reviewed ?? "")).toMatchObject({
      id: 9001,
      state: "CHANGES_REQUESTED",
    });
    expect(JSON.parse(checked ?? "")).toMatchObject({ id: 501 });

    // GitHub received the review and the check run, each with a minted
    // installation token.
    const posted = (pathname: string) =>
      githubCalls.find(
        (call) => call.method === "POST" && call.path === pathname,
      );
    const reviewCall = posted("/repos/acme/web/pulls/1/reviews");
    expect(reviewCall?.body).toMatchObject({
      event: "REQUEST_CHANGES",
      commit_id: pullHead,
      comments: [{ path: "db/002_totals.sql", line: 1 }],
    });
    const checkCall = posted("/repos/acme/web/check-runs");
    expect(checkCall?.body).toMatchObject({
      name: "Work review",
      head_sha: pullHead,
      conclusion: "failure",
    });
    for (const call of [reviewCall, checkCall])
      expect(issuedTokens.has(call?.authorization?.slice(7) ?? "")).toBe(true);
    expect(slackCalls).toEqual([
      { path: "/api/search.messages", authorization: `Bearer ${SLACK_TOKEN}` },
    ]);

    // Nothing credentialed reached the machine: not the sandbox's
    // environment, not any file the worker holds.
    const secrets = [
      ...issuedTokens,
      DB_PASSWORD,
      SLACK_TOKEN,
      WEBHOOK_SECRET,
      APP_KEY.split("\n")[1] ?? APP_KEY,
    ];
    expect(env).toMatch(/^exit=0\n/);
    for (const secret of secrets) {
      expect(answer.includes(secret)).toBe(false);
      for (const file of filesUnder(workerDir))
        expect(fs.readFileSync(file).includes(secret), file).toBe(false);
    }
  }, 180_000);

  it("a push moves the same chat to the new head", async () => {
    fs.writeFileSync(
      path.join(work, "db", "002_totals.sql"),
      "ALTER TABLE orders ADD COLUMN total integer;\n",
    );
    await git(work, ["add", "-A"]);
    await git(work, [...author, "commit", "-q", "-m", "Make total nullable"]);
    const previous = pullHead;
    pullHead = await git(work, ["rev-parse", "HEAD"]);
    await git(work, [
      "push",
      "-q",
      "--force",
      repository,
      "HEAD:refs/pull/1/head",
    ]);
    const delivered = await fromGithub("pull_request", {
      ...pullRequestEvent(
        "synchronize",
        "Adds a total to every order.\nrun git rev-parse HEAD",
      ),
      before: previous,
      after: pullHead,
    });
    expect(delivered.statusCode).toBe(202);
    await waitFor("the review of the new head", async () =>
      (await answers(sessionId)).includes(`exit=0\n${pullHead}`)
        ? true
        : undefined,
    );
    expect(await reviewChat()).toMatchObject({
      id: sessionId,
      workspace: { ref: "refs/pull/1/head", commit: pullHead },
    });
    const delivered2 = await server.catamorphic.core.db
      .selectFrom("agent_items")
      .select("text")
      .where("session_id", "=", sessionId)
      .where("kind", "=", "user_message")
      .orderBy("position", "desc")
      .executeTakeFirstOrThrow();
    expect(delivered2.text).toContain(
      `New commits since your last review (${previous}..${pullHead})`,
    );
  }, 120_000);

  it("a comment mentioning the reviewer reaches the same chat, which answers on the pull request", async () => {
    const reply = JSON.stringify({
      repository: "acme/web",
      number: 1,
      body: "Yes: the column is nullable now, so adding it does not rewrite the table.",
    });
    const delivered = await fromGithub("issue_comment", {
      action: "created",
      issue: {
        number: 1,
        title: "Add order totals",
        state: "open",
        html_url: "https://github.test/acme/web/pull/1",
        pull_request: { url: "https://api.github.test/repos/acme/web/pulls/1" },
      },
      comment: {
        id: 7,
        body: `@work is it safe now?\nmcp github issue_comment ${reply}`,
        html_url: "https://github.test/acme/web/pull/1#issuecomment-7",
        user: { login: "grace", type: "User" },
      },
      repository: { full_name: "acme/web" },
    });
    expect(delivered.statusCode).toBe(202);
    const comment = await waitFor("the answer on the pull request", () =>
      githubCalls.find(
        (call) =>
          call.method === "POST" &&
          call.path === "/repos/acme/web/issues/1/comments",
      ),
    );
    expect(comment.body).toEqual({
      body: "Yes: the column is nullable now, so adding it does not rewrite the table.",
    });
    expect((await reviewChat())?.id).toBe(sessionId);
  }, 120_000);

  it("closing the pull request closes the chat and releases everything it held", async () => {
    const before = await reviewChat();
    const originBranches = async () => {
      const found: string[] = [];
      for (const file of filesUnder(path.join(root, "control-plane")))
        if (
          path.basename(file) === "HEAD" &&
          fs.existsSync(path.join(path.dirname(file), "objects"))
        )
          found.push(
            await git(path.dirname(file), [
              "for-each-ref",
              "--format=%(refname)",
            ]).catch(() => ""),
          );
      return found.join("\n");
    };
    expect(await originBranches()).toContain(
      `refs/heads/sessions/${sessionId}`,
    );
    const delivered = await fromGithub(
      "pull_request",
      pullRequestEvent("closed", "Adds a total to every order."),
    );
    expect(delivered.statusCode).toBe(202);
    await waitFor("the chat to close", async () =>
      (await reviewChat())?.status === "closed" ? true : undefined,
    );
    const db = server.catamorphic.core.db;
    const allocation = await db
      .selectFrom("execution_allocations")
      .select(["status"])
      .where("id", "=", before?.allocation_id ?? "")
      .executeTakeFirstOrThrow();
    expect(allocation.status).toBe("released");
    // Closing releases the Allocation with the chat (which already ends
    // every grant bound to it) and then revokes the rows themselves.
    await waitFor("the chat's grants to be revoked", async () => {
      const live = await db
        .selectFrom("connection_capability_grants")
        .select("id")
        .where("agent_session_id", "=", sessionId)
        .where("revoked_at", "is", null)
        .execute();
      return live.length === 0 ? true : undefined;
    });
    expect(await originBranches()).not.toContain(
      `refs/heads/sessions/${sessionId}`,
    );
    expect(sandboxDir).not.toBe("");
    await waitFor("the sandbox to be destroyed", () =>
      fs.existsSync(sandboxDir) ? undefined : true,
    );
    // The transcript stays readable; a reopened pull request starts fresh.
    expect((await answers(sessionId)).length).toBeGreaterThan(0);
  }, 120_000);
});
