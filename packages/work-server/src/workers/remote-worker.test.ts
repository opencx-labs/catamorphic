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

async function waitFor(check: () => Promise<boolean>, what: string) {
  const deadline = Date.now() + 20_000;
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
        ".catamorphic/project.json": JSON.stringify({
          environments: {
            build: { pool: { plane: "worker" }, workloads: ["agent"] },
            server: { pool: { plane: "control" }, workloads: ["agent"] },
            desk: {
              pool: { plane: "worker" },
              strict: true,
              workloads: ["agent"],
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

  async function startWorker(args: {
    name: string;
    placement: Record<string, unknown>;
    workspaces: string;
  }): Promise<string> {
    const enrollment = await operator("POST", "/_work/operator/workers", {
      name: args.name,
      ...args.placement,
    });
    expect(enrollment.statusCode).toBe(201);
    const dataDir = path.join(root, args.name);
    workers.push(
      await startWorkWorker({
        controlPlaneUrl: base,
        dataDir,
        enrollmentCode: enrollment.json().code,
        execution: executionSettingsFromEnv({
          PATH: process.env.PATH,
          WORK_MAX_WORKSPACES: args.workspaces,
        }),
      }),
    );
    await waitFor(async () => {
      const machines = (
        await operator("GET", "/_work/operator/machines")
      ).json();
      return machines.machines.some(
        (machine: { id: string; available: boolean }) =>
          machine.id === `worker.${args.name}` && machine.available,
      );
    }, `${args.name} to connect`);
    return path.join(dataDir, "sandboxes");
  }

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
