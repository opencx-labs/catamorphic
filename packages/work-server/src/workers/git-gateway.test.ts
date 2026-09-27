import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Identity } from "@catamorphic/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { testServerOptions } from "../test-support.js";
import { startWorkWorker } from "./worker-runtime.js";

const execute = promisify(execFile);
async function nativeGit(
  cwd: string,
  args: readonly string[],
): Promise<string> {
  return (await execute("git", ["-C", cwd, ...args])).stdout;
}

/**
 * Git through the gateway (ADR 0175) and workspaces at a ref (ADR 0178),
 * end to end: an upstream served by `git http-backend` behind Basic auth, a
 * service connection holding its password on the control plane, and a
 * keyed chat on a local-process worker whose sandbox fetches and pushes
 * with nothing but its session grant.
 */
const UPSTREAM_USER = "robot";
const UPSTREAM_SECRET = `upstream-secret-${randomUUID()}`;
const identity: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "git-gateway-test",
};
const author = [
  "-c",
  "user.name=Upstream",
  "-c",
  "user.email=upstream@example.test",
];

let root: string;
let server: WorkServer;
let base: string;
let operatorSecret: string;
let projectId: string;
let upstream: http.Server;
let upstreamBase: string;
let repository: string;
let work: string;
let workerDir: string;
const refusedUpstreamRequests: string[] = [];
const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];

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

/** A smart-HTTP Git server: `git http-backend` behind Basic auth. */
function gitHttpServer(projectRoot: string): http.Server {
  const expected = `Basic ${Buffer.from(`${UPSTREAM_USER}:${UPSTREAM_SECRET}`).toString("base64")}`;
  return http.createServer((request, response) => {
    if (request.headers.authorization !== expected) {
      if (request.headers.authorization)
        refusedUpstreamRequests.push(request.url ?? "");
      response.writeHead(401, {
        "www-authenticate": 'Basic realm="upstream"',
      });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://upstream");
    const header = (name: string) => {
      const value = request.headers[name];
      return typeof value === "string" ? value : undefined;
    };
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      REMOTE_USER: UPSTREAM_USER,
      REQUEST_METHOD: request.method ?? "GET",
      PATH_INFO: decodeURIComponent(url.pathname),
      QUERY_STRING: url.search.slice(1),
      CONTENT_TYPE: header("content-type") ?? "",
    };
    const encoding = header("content-encoding");
    if (encoding) env.HTTP_CONTENT_ENCODING = encoding;
    const protocol = header("git-protocol");
    if (protocol) env.GIT_PROTOCOL = protocol;
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
      const headers: Record<string, string> = {};
      let status = 200;
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

async function commit(files: Record<string, string>, message: string) {
  for (const [name, content] of Object.entries(files))
    fs.writeFileSync(path.join(work, name), content);
  await nativeGit(work, ["add", "-A"]);
  await nativeGit(work, [...author, "commit", "-q", "-m", message]);
  return (await nativeGit(work, ["rev-parse", "HEAD"])).trim();
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

let mainHead: string;
let pullHead: string;

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-git-gateway-"));
  // The upstream: `main` and a pull request head, like a code host.
  const projects = path.join(root, "upstream");
  repository = path.join(projects, "repo.git");
  fs.mkdirSync(repository, { recursive: true });
  await nativeGit(repository, ["init", "--bare", "-q", "-b", "main"]);
  await nativeGit(repository, ["config", "http.receivepack", "true"]);
  work = path.join(root, "upstream-work");
  fs.mkdirSync(work);
  await nativeGit(work, ["init", "-q", "-b", "main"]);
  mainHead = await commit({ "readme.md": "hello\n" }, "Initial");
  await nativeGit(work, ["push", "-q", repository, "main"]);
  await nativeGit(work, ["checkout", "-q", "-b", "feature"]);
  pullHead = await commit({ "app.ts": "export const one = 1;\n" }, "Add app");
  await nativeGit(work, ["push", "-q", repository, "HEAD:refs/pull/42/head"]);
  upstream = gitHttpServer(projects);
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw new Error("No upstream address");
  upstreamBase = `http://127.0.0.1:${upstreamAddress.port}/`;

  const gatewayFile = path.join(root, "gateway.json");
  fs.writeFileSync(
    gatewayFile,
    JSON.stringify({
      connections: [
        {
          type: "git",
          kind: "upstream-git",
          displayName: "Upstream Git",
          baseUrl: upstreamBase,
        },
      ],
    }),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "control-plane"),
      publicBases: [base],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_GATEWAY_CONFIG: gatewayFile,
        PATH: process.env.PATH,
      },
    }),
  );
  await server.app.listen({ port, host: "127.0.0.1" });
  operatorSecret = fs
    .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
    .trim();
  const core = server.catamorphic.core;
  const project = await core.projects.create(identity, { name: "Reviews" });
  projectId = project.id;
  await core.db
    .updateTable("projects")
    .set({
      remote_url: `${upstreamBase}repo.git`,
      remote_branch: "main",
      default_branch: "main",
      remote_ownership: "attached",
    })
    .where("id", "=", projectId)
    .execute();
  await core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    identity.externalUserId,
    {
      message: "Reviews run on the review pool with Git",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            automation: {
              pool: { plane: "control" },
              workloads: ["workflow"],
            },
            review: {
              pool: { pool: "review" },
              workloads: ["agent"],
              idleReleaseMinutes: 5,
              connections: {
                code: {
                  provider: "upstream-git",
                  principal: "service",
                  service: "upstream",
                  git: { push: ["work/*"] },
                },
              },
            },
          },
          defaultEnvironment: "review",
        }),
        ".work/agents/reviewer.json": JSON.stringify({
          version: 1,
          name: "Reviewer",
          kind: "builtin",
          environment: { allowed: ["review"], preferred: ["review"] },
          connections: ["code"],
        }),
      },
    },
  );
  // The upstream password lives only in the control plane's vault.
  const connections = core.connections;
  if (!connections) throw new Error("Connections are unavailable");
  const created = await connections.createService({
    identity,
    name: "upstream",
    providerKind: "upstream-git",
    principalKind: "project_service",
    projectId,
  });
  const started = await connections.beginServiceAuthorization({
    identity,
    connectionId: created.id,
    redirectUri: `${base}/api/connection-authorizations/callback`,
  });
  await connections.completeAuthorization({
    identity,
    state: started.authorizationId,
    callback: { username: UPSTREAM_USER, password: UPSTREAM_SECRET },
  });

  const enrollment = await server.operatorApp.inject({
    method: "POST",
    url: "/_work/operator/workers",
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      name: "reviewer",
      labels: { pool: "review" },
      access: { everyone: true },
      trusted: true,
    }),
  });
  expect(enrollment.statusCode).toBe(201);
  workerDir = path.join(root, "reviewer");
  workers.push(
    await startWorkWorker({
      controlPlaneUrl: base,
      dataDir: workerDir,
      enrollmentCode: enrollment.json().code,
      execution: executionSettingsFromEnv({
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: "2",
      }),
    }),
  );
  await waitFor(async () => {
    const machines = (
      await server.operatorApp.inject({
        method: "GET",
        url: "/_work/operator/machines",
        headers: { authorization: `Bearer ${operatorSecret}` },
      })
    ).json();
    return machines.machines.some(
      (machine: { id: string; available: boolean }) =>
        machine.id === "worker.reviewer" && machine.available,
    );
  }, "the review worker to connect");
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((running) => running.stop()));
  await server?.shutdown();
  await new Promise((resolve) => upstream?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}, 60_000);

describe("a pull request review chat with Git through the gateway", () => {
  let sessionId = "";
  let runId = "";

  const deliver = async (input: {
    content: string;
    workspace?: { ref: string; update?: "reset" | "rebase" };
  }) => {
    const delivered = await server.catamorphic.core.capabilities.call(
      "catamorphic.sessions",
      "deliver",
      {
        caller: identity,
        projectId,
        runId,
        workflowName: "reviewPullRequests",
      },
      {
        key: "pr-42",
        agentSlug: "reviewer",
        title: "Review: pull request 42",
        content: input.content,
        idempotencyKey: randomUUID(),
        ...(input.workspace ? { workspace: input.workspace } : {}),
      },
    );
    if (
      !delivered ||
      typeof delivered !== "object" ||
      !("sessionId" in delivered)
    )
      throw new Error("No session");
    return String(delivered.sessionId);
  };
  const answers = async () => {
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    return (await sessions.get(identity, projectId, sessionId)).messages
      .filter((message) => message.role === "assistant")
      .map((message) => message.content);
  };
  const run = async (command: string) => {
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    return (
      await sessions.sendMessage(
        identity,
        projectId,
        sessionId,
        `run ${command}`,
      )
    ).content;
  };

  beforeAll(async () => {
    runId = randomUUID();
    await server.catamorphic.core.db
      .insertInto("workflow_runs")
      .values({
        id: runId,
        project_id: projectId,
        workflow_name: "reviewPullRequests",
        provenance: {},
        status: "running",
        environment_name: "automation",
      })
      .execute();
  });

  it("starts the chat's workspace at the pull request head and moves it on a new push", async () => {
    sessionId = await deliver({
      content: "run git rev-parse HEAD && git log --format=%s",
      workspace: { ref: "refs/pull/42/head" },
    });
    await waitFor(
      async () => (await answers()).some((answer) => answer.includes(pullHead)),
      "the agent to see the pull request head",
    );
    expect((await answers()).at(-1)).toBe(`exit=0\n${pullHead}\nAdd app`);
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    expect(
      (await sessions.get(identity, projectId, sessionId)).workspace,
    ).toEqual({ ref: "refs/pull/42/head", commit: pullHead });

    // A new push to the pull request, delivered to the same chat.
    const nextHead = await commit(
      { "app.ts": "export const one = 2;\n" },
      "Fix app",
    );
    await nativeGit(work, ["push", "-q", repository, "HEAD:refs/pull/42/head"]);
    expect(
      await deliver({
        content: "run git rev-parse HEAD refs/work/base",
        workspace: { ref: "refs/pull/42/head", update: "reset" },
      }),
    ).toBe(sessionId);
    await waitFor(
      async () =>
        (await answers()).some((answer) =>
          answer.includes(`${nextHead}\n${nextHead}`),
        ),
      "the checkout to move to the new head",
    );
    pullHead = nextHead;
    expect(
      (await sessions.get(identity, projectId, sessionId)).workspace,
    ).toEqual({ ref: "refs/pull/42/head", commit: nextHead });

    // Idle release and rehydration keep the base.
    expect(
      await sessions.releaseIdleWorkspaces({
        now: new Date(Date.now() + 10 * 60_000),
      }),
    ).toBe(1);
    expect(
      await run("git rev-parse HEAD refs/work/base && git status --porcelain"),
    ).toBe(`exit=0\n${nextHead}\n${nextHead}`);
  }, 120_000);

  it("fetches and pushes work branches with the session grant, and refuses the rest", async () => {
    expect(
      await run("git fetch -q origin main 2>&1 && git rev-parse FETCH_HEAD"),
    ).toBe(`exit=0\n${mainHead}`);
    const pushed = await run(
      "git checkout -q -b work/fix && printf fixed > fix.txt && git add fix.txt && git -c user.name=Agent -c user.email=agent@example.test commit -qm 'Fix it' && git push -q origin work/fix 2>&1",
    );
    expect(pushed).toMatch(/^exit=0/);
    const fixHead = (
      await nativeGit(repository, ["rev-parse", "refs/heads/work/fix"])
    ).trim();
    expect(fixHead).toMatch(/^[0-9a-f]{40}$/);

    const toMain = await run("git push --force origin HEAD:main 2>&1");
    expect(toMain).not.toMatch(/^exit=0/);
    expect(toMain).toContain("default branch");
    const deleted = await run("git push origin :work/fix 2>&1");
    expect(deleted).not.toMatch(/^exit=0/);
    expect(deleted).toContain("does not delete");
    const elsewhere = await run("git push origin HEAD:feature 2>&1");
    expect(elsewhere).toContain("may push only work/*");
    expect(
      (await nativeGit(repository, ["rev-parse", "refs/heads/main"])).trim(),
    ).toBe(mainHead);

    // No upstream credential anywhere in the sandbox: not in its
    // environment, not in any file the worker holds.
    expect(await run("env")).not.toContain(UPSTREAM_SECRET);
    for (const file of filesUnder(workerDir)) {
      const content = fs.readFileSync(file);
      expect(content.includes(UPSTREAM_SECRET), file).toBe(false);
    }
    expect(refusedUpstreamRequests).toEqual([]);

    // Every fetch and push was audited with its refs and outcome.
    const audit = await server.catamorphic.core.db
      .selectFrom("connection_audit_events")
      .select(["action", "outcome", "metadata"])
      .where("event_type", "=", "connection.git")
      .execute();
    expect(
      audit.some((row) => row.action === "fetch" && row.outcome === "allowed"),
    ).toBe(true);
    expect(
      audit.some(
        (row) =>
          row.action === "push" &&
          row.outcome === "allowed" &&
          JSON.stringify(row.metadata).includes("refs/heads/work/fix"),
      ),
    ).toBe(true);
    expect(
      audit.filter((row) => row.action === "push" && row.outcome === "denied"),
    ).toHaveLength(3);
  }, 120_000);

  it("stops honoring the grant once the chat is closed", async () => {
    const grantFile = filesUnder(workerDir).find((file) =>
      file.endsWith(path.join(".work-session", "grants", "code")),
    );
    if (!grantFile) throw new Error("No grant file in the sandbox");
    const grant = fs.readFileSync(grantFile, "utf8").trim();
    const infoRefs = () =>
      fetch(
        `${base}/api/gateway/git/code/repo.git/info/refs?service=git-upload-pack`,
        {
          headers: {
            authorization: `Basic ${Buffer.from(`work:${grant}`).toString("base64")}`,
          },
        },
      );
    expect((await infoRefs()).status).toBe(200);
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    await sessions.close(identity, projectId, sessionId);
    const refused = await infoRefs();
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain("Basic");
  }, 60_000);
});
