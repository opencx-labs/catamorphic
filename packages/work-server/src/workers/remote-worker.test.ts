import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

/**
 * A control plane that runs no agents itself, and a worker that holds no
 * database, secret, or vault key (ADR 0164), talking over real HTTP.
 */
let root: string;
let server: WorkServer;
let base: string;
let operatorSecret: string;
let projectId: string;
let worker: Awaited<ReturnType<typeof startWorkWorker>> | undefined;
const identity: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "remote-worker-test",
};

function operator(
  method: "GET" | "POST" | "DELETE" | "PATCH",
  url: string,
  body?: unknown,
) {
  return server.operatorApp.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 20_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function workerAvailable(): Promise<boolean> {
  const machines = (await operator("GET", "/_work/operator/machines")).json();
  return machines.machines.some(
    (machine: { id: string; available: boolean }) =>
      machine.id === "worker.builder" && machine.available,
  );
}

/** Enroll a worker with its placement and wait until it serves work. */
async function enrollWorker(args: {
  name: string;
  placement: Record<string, unknown>;
  workspaces: string;
  env?: Record<string, string>;
  workers: Array<Awaited<ReturnType<typeof startWorkWorker>>>;
}): Promise<string> {
  const enrollment = await operator("POST", "/_work/operator/workers", {
    name: args.name,
    ...args.placement,
  });
  expect(enrollment.statusCode).toBe(201);
  const dataDir = path.join(root, args.name);
  args.workers.push(
    await startWorkWorker({
      controlPlaneUrl: base,
      dataDir,
      enrollmentCode: enrollment.json().code,
      execution: executionSettingsFromEnv({
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: args.workspaces,
        ...args.env,
      }),
    }),
  );
  await waitFor(async () => {
    const machines = (await operator("GET", "/_work/operator/machines")).json();
    return machines.machines.some(
      (machine: { id: string; available: boolean }) =>
        machine.id === `worker.${args.name}` && machine.available,
    );
  }, `${args.name} to connect`);
  return path.join(dataDir, "sandboxes");
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-remote-worker-"));
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "control-plane"),
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        PATH: process.env.PATH,
      },
    }),
  );
  await server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = server.app.server.address();
  if (!address || typeof address === "string") throw new Error("No address");
  base = `http://127.0.0.1:${address.port}`;
  operatorSecret = fs
    .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
    .trim();
  const project = await server.catamorphic.core.projects.create(identity, {
    name: "Remote execution",
  });
  projectId = project.id;
  await server.catamorphic.core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    identity.externalUserId,
    {
      message: "Configure execution",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            build: { pool: { plane: "worker" }, workloads: ["agent"] },
            server: { pool: { plane: "control" }, workloads: ["agent"] },
            desk: {
              pool: { plane: "worker" },
              strict: true,
              workloads: ["agent"],
            },
            compose: {
              pool: { plane: "worker" },
              workloads: ["agent"],
              requirements: { containers: true },
            },
          },
          defaultEnvironment: "build",
        }),
      },
    },
  );
}, 120_000);

afterAll(async () => {
  await worker?.stop();
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("remote workers (ADR 0164)", () => {
  it("enrolls once and runs agent sandboxes on the worker, not the control plane", async () => {
    // A process-isolated worker for everyone must be marked trusted.
    const enrollment = await operator("POST", "/_work/operator/workers", {
      name: "builder",
      trusted: true,
    });
    expect(enrollment.statusCode).toBe(201);
    const { code, nodeId } = enrollment.json();
    expect(nodeId).toBe("worker.builder");

    const workerDir = path.join(root, "worker");
    worker = await startWorkWorker({
      controlPlaneUrl: base,
      dataDir: workerDir,
      enrollmentCode: code,
      execution: executionSettingsFromEnv({
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: "2",
      }),
    });
    await waitFor(workerAvailable, "the worker to connect");

    // The code was single use.
    const replay = await server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      payload: { code },
    });
    expect(replay.statusCode).toBe(400);

    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    const session = await sessions.create(identity, projectId, {
      environment: "build",
    });
    const result = await sessions.sendMessage(
      identity,
      projectId,
      session.id,
      "execution-location",
    );
    expect(result.metadata?.status).not.toBe("failed");
    expect(result.content).toContain(path.join(workerDir, "sandboxes"));
    // A later turn reuses the same workspace on the worker.
    const again = await sessions.sendMessage(
      identity,
      projectId,
      session.id,
      "execution-location",
    );
    expect(again.content).toContain(path.join(workerDir, "sandboxes"));
    // A restarted worker (an upgrade) keeps the session's workspace.
    await worker.stop();
    worker = await startWorkWorker({
      controlPlaneUrl: base,
      dataDir: workerDir,
      execution: executionSettingsFromEnv({
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: "2",
      }),
    });
    await waitFor(workerAvailable, "the worker to reconnect");
    const afterRestart = await sessions.sendMessage(
      identity,
      projectId,
      session.id,
      "execution-location",
    );
    expect(afterRestart.content).toContain(path.join(workerDir, "sandboxes"));
    // The worker holds its credential and sandboxes, nothing else.
    expect(fs.readdirSync(workerDir).sort()).toEqual([
      "sandboxes",
      "sandboxes.json",
      "worker-credential",
    ]);
    expect(
      fs.statSync(path.join(workerDir, "worker-credential")).mode & 0o777,
    ).toBe(0o600);
  }, 60_000);

  it("runs background processes on the worker and ends them with the chat (ADR 0174)", async () => {
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    const session = await sessions.create(identity, projectId, {
      environment: "build",
    });
    const say = async (message: string) =>
      (await sessions.sendMessage(identity, projectId, session.id, message))
        .content;
    const [server1, pid1] = (await say("background-start")).split(" ");
    const [server2, pid2] = (await say("background-start")).split(" ");
    expect(server1).toMatch(/^proc-/);
    expect(alive(Number(pid1))).toBe(true);
    expect(alive(Number(pid2))).toBe(true);
    expect(JSON.parse(await say("background-list"))).toEqual(
      expect.arrayContaining([
        { processId: server1, status: "running" },
        { processId: server2, status: "running" },
      ]),
    );
    expect(await say(`background-stop ${server2}`)).toBe("exited SIGTERM");
    await waitFor(async () => !alive(Number(pid2)), "the stopped process");
    // Closing the chat releases its workspace; the worker destroys the
    // sandbox and everything still running in it.
    await sessions.close(identity, projectId, session.id);
    await waitFor(
      async () => !alive(Number(pid1)),
      "the chat's background process to end",
      60_000,
    );
  }, 90_000);

  it("keeps agent code off a control plane that runs only workflows", async () => {
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    await expect(
      sessions.create(identity, projectId, { environment: "server" }),
    ).rejects.toThrow();
  });

  it("refuses requests without the worker credential", async () => {
    const response = await server.app.inject({
      method: "POST",
      url: "/api/workers/poll",
      headers: { authorization: "Worker worker.builder:guess" },
      payload: { session: crypto.randomUUID() },
    });
    expect(response.statusCode).toBe(401);
  });

  it("revoking a worker ends its authority at once", async () => {
    const revoked = await operator("DELETE", "/_work/operator/workers/builder");
    expect(revoked.statusCode).toBe(200);
    await waitFor(async () => !(await workerAvailable()), "revocation");
    const listed = (await operator("GET", "/_work/operator/workers")).json();
    expect(listed.workers).toMatchObject([{ name: "builder", revoked: true }]);
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    await expect(
      sessions.create(identity, projectId, { environment: "build" }),
    ).rejects.toThrow();
  }, 30_000);
});

describe("placement by owner (ADR 0167)", () => {
  const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];
  afterAll(async () => {
    await Promise.all(workers.map((running) => running.stop()));
  });

  async function person(username: string): Promise<Identity> {
    const created = await operator("POST", "/_work/operator/users", {
      username,
      name: username,
      password: "correct horse battery staple",
      email: `${username}@example.com`,
      memberships: [],
    });
    expect(created.statusCode).toBe(201);
    return {
      tenantId: SERVER_TENANT_ID,
      externalUserId: created.json().user.id,
    };
  }

  const startWorker = (
    args: Omit<Parameters<typeof enrollWorker>[0], "workers">,
  ) => enrollWorker({ ...args, workers });

  it("puts each person's agents on their own machine, then the shared pool", async () => {
    const alice = await person("alice");
    const bob = await person("bob");
    const aliceDesk = await startWorker({
      name: "alice-desk",
      placement: { access: { people: ["alice@example.com"] } },
      workspaces: "1",
    });
    const shared = await startWorker({
      name: "shared",
      placement: { access: { everyone: true }, trusted: true },
      workspaces: "4",
    });
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    const where = async (who: Identity, environment: string) => {
      const session = await sessions.create(who, projectId, { environment });
      const result = await sessions.sendMessage(
        who,
        projectId,
        session.id,
        "execution-location",
      );
      return result.content;
    };

    expect(await where(alice, "build")).toContain(aliceDesk);
    // Bob never lands on Alice's machine.
    expect(await where(bob, "build")).toContain(shared);
    // Alice's machine is full: the pool takes her next agent, unless strict.
    expect(await where(alice, "build")).toContain(shared);
    await expect(
      sessions.create(alice, projectId, { environment: "desk" }),
    ).rejects.toThrow();
  }, 90_000);

  it("places container Environments only on workers that offer containers (ADR 0176)", async () => {
    const carol = await person("carol");
    const dockerBox = await startWorker({
      name: "docker-box",
      placement: { access: { everyone: true }, trusted: true },
      workspaces: "2",
      // The endpoint starts with the sandbox; no daemon is needed to place.
      env: { WORK_DOCKER_SOCKET: path.join(root, "docker.sock") },
    });
    const sessions = server.catamorphic.core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    const session = await sessions.create(carol, projectId, {
      environment: "compose",
    });
    const location = await sessions.sendMessage(
      carol,
      projectId,
      session.id,
      "execution-location",
    );
    expect(location.content).toContain(dockerBox);
    const dockerHost = await sessions.sendMessage(
      carol,
      projectId,
      session.id,
      "docker-host",
    );
    expect(dockerHost.content).toMatch(/^unix:\/\/.*\.sock$/);
  }, 90_000);

  it("refuses a process-isolated worker shared by several people", async () => {
    const enrollment = await operator("POST", "/_work/operator/workers", {
      name: "team-box",
      access: { groups: ["eng@example.com"] },
    });
    const enrolled = await server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      payload: { code: enrollment.json().code },
    });
    const connect = await server.app.inject({
      method: "POST",
      url: "/api/workers/connect",
      headers: { authorization: `Worker ${enrolled.json().credential}` },
      payload: {
        isolation: "process",
        workspaceRoot: "/workspace",
        capacity: { workspaces: 1 },
      },
    });
    expect(connect.statusCode).toBe(403);
    expect(connect.json().error).toContain("microsandbox");
    // The operator can vouch for the team.
    const trusted = await operator(
      "PATCH",
      "/_work/operator/workers/team-box",
      {
        trusted: true,
      },
    );
    expect(trusted.statusCode).toBe(200);
  });
});

describe("keyed chats on workers (ADR 0173)", () => {
  const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];
  let reviewPool: string;
  let chatBox: string;
  afterAll(async () => {
    await Promise.all(workers.map((running) => running.stop()));
  });

  beforeAll(async () => {
    await server.catamorphic.core.deployment.deploy(
      SERVER_TENANT_ID,
      projectId,
      identity.externalUserId,
      {
        message: "Pools for reviews and chats",
        files: {
          ".work/project.json": JSON.stringify({
            environments: {
              build: { pool: { plane: "worker" }, workloads: ["agent"] },
              server: { pool: { plane: "control" }, workloads: ["agent"] },
              desk: {
                pool: { plane: "worker" },
                strict: true,
                workloads: ["agent"],
              },
              automation: {
                pool: { plane: "control" },
                workloads: ["workflow"],
              },
              review: { pool: { pool: "review" }, workloads: ["agent"] },
              chats: {
                pool: { pool: "chats" },
                workloads: ["agent"],
                idleReleaseMinutes: 5,
              },
            },
            defaultEnvironment: "build",
          }),
          ".work/agents/reviewer.json": JSON.stringify({
            version: 1,
            name: "Reviewer",
            kind: "builtin",
            environment: { allowed: ["review"], preferred: ["review"] },
          }),
        },
      },
    );
    // A trusted pool open only to this project's own work: no person's
    // chat lands there, and the control plane carries no review label.
    reviewPool = await enrollWorker({
      name: "reviewer",
      placement: {
        labels: { pool: "review" },
        access: { projects: [projectId] },
        trusted: true,
      },
      workspaces: "2",
      workers,
    });
    chatBox = await enrollWorker({
      name: "chat-box",
      placement: {
        labels: { pool: "chats" },
        access: { everyone: true },
        trusted: true,
      },
      workspaces: "1",
      workers,
    });
  }, 60_000);

  it("a control-plane workflow's chat runs where its agent prefers, on a pool open only to the project", async () => {
    const core = server.catamorphic.core;
    const sessions = core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    const runId = crypto.randomUUID();
    // A run in the automation Environment, on the control plane.
    await core.db
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
    const delivered = await core.capabilities.call(
      "catamorphic.sessions",
      "deliver",
      {
        caller: identity,
        projectId,
        runId,
        workflowName: "reviewPullRequests",
      },
      {
        key: "pr-11",
        audience: "project",
        agentSlug: "reviewer",
        title: "Review: pull request 11",
        content: "execution-location",
      },
    );
    expect(delivered).toMatchObject({ sessionCreated: true });
    const sessionId =
      delivered && typeof delivered === "object" && "sessionId" in delivered
        ? String(delivered.sessionId)
        : "";
    await waitFor(async () => {
      const chat = await sessions.get(identity, projectId, sessionId);
      return chat.messages.some(
        (message) =>
          message.role === "assistant" && message.content.includes(reviewPool),
      );
    }, "the review to run on the review pool");
    const chat = await sessions.get(identity, projectId, sessionId);
    expect(chat).toMatchObject({
      owner: "project",
      key: "pr-11",
      keyWorkflows: ["reviewPullRequests"],
      environment: "review",
      placement: {
        environment: "review",
        reason: "agent_preferred",
        machine: { id: "worker.reviewer", label: "reviewer" },
      },
    });
    // A person's own chat never lands on a machine opened to the project.
    await expect(
      sessions.create(identity, projectId, { environment: "review" }),
    ).rejects.toThrow();
  }, 60_000);

  it("gives an idle chat's workspace back, rehydrates it on the next turn, and forgets it on close", async () => {
    const core = server.catamorphic.core;
    const sessions = core.agentSessions;
    if (!sessions) throw new Error("Agent sessions are unavailable");
    const session = await sessions.create(identity, projectId, {
      environment: "chats",
    });
    const say = async (message: string) =>
      (await sessions.sendMessage(identity, projectId, session.id, message))
        .content;
    expect(await say("execution-location")).toContain(chatBox);
    await say("write-file notes.md kept across release");
    expect(await say("read-file notes.md")).toBe("kept across release");
    const before = await sessions.get(identity, projectId, session.id);

    // Not idle long enough: nothing moves.
    expect(await sessions.releaseIdleWorkspaces()).toBe(0);
    // Past the Environment's idleReleaseMinutes, the slot is given back.
    expect(
      await sessions.releaseIdleWorkspaces({
        now: new Date(Date.now() + 10 * 60_000),
      }),
    ).toBe(1);
    const released = await core.db
      .selectFrom("execution_allocations")
      .select(["status", "release_reason"])
      .where("id", "=", before.allocationId ?? "")
      .executeTakeFirstOrThrow();
    expect(released).toEqual({ status: "released", release_reason: "idle" });
    await waitFor(async () => {
      const row = await core.db
        .selectFrom("execution_allocations")
        .select("capacity_released_at")
        .where("id", "=", before.allocationId ?? "")
        .executeTakeFirstOrThrow();
      return row.capacity_released_at !== null;
    }, "the worker to destroy the idle workspace");
    const branch = () =>
      core.projectManager.remoteBackend?.withOrigin(
        SERVER_TENANT_ID,
        projectId,
        (origin) => origin.resolveRef(`refs/heads/sessions/${session.id}`),
      );
    expect(await branch()).toMatch(/^[0-9a-f]{40}$/);

    // The next turn admits a fresh workspace and rehydrates it.
    expect(await say("read-file notes.md")).toBe("kept across release");
    const after = await sessions.get(identity, projectId, session.id);
    expect(after.allocationId).not.toBe(before.allocationId);
    expect(after.placement).toMatchObject({
      environment: "chats",
      machine: { id: "worker.chat-box" },
    });

    // Closing forgets the workspace: branch, copy, Allocation, sandbox.
    await sessions.close(identity, projectId, session.id);
    expect(await branch()).toBeNull();
    await waitFor(async () => {
      const row = await core.db
        .selectFrom("execution_allocations")
        .select(["status", "capacity_released_at"])
        .where("id", "=", after.allocationId ?? "")
        .executeTakeFirstOrThrow();
      return row.status === "released" && row.capacity_released_at !== null;
    }, "the worker to destroy the closed chat's workspace");
    expect(
      await core.projectManager.exists(
        SERVER_TENANT_ID,
        projectId,
        `session-${session.id}`,
      ),
    ).toBe(false);
    const closed = await sessions.get(identity, projectId, session.id);
    expect(closed.status).toBe("closed");
    expect(
      closed.messages.some(
        (message) => message.content === "kept across release",
      ),
    ).toBe(true);
  }, 90_000);
});
