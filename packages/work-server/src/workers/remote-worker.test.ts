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
  method: "GET" | "POST" | "DELETE",
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
            build: { binding: "workers", workloads: ["agent"] },
            server: { binding: "local", workloads: ["agent"] },
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
    const enrollment = await operator("POST", "/_work/operator/workers", {
      name: "builder",
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
    // The worker holds its credential and sandboxes, nothing else.
    expect(fs.readdirSync(workerDir).sort()).toEqual([
      "sandboxes",
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
