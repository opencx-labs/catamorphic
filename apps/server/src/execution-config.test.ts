import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WorkerNodesService } from "@catamorphic/core";
import { expect, it } from "vitest";
import { stockExecution } from "./execution-config.js";
import { buildStockServer, SERVER_TENANT_ID } from "./server.js";

it("rejects invalid budgets and subprocess resource guarantees before boot", () => {
  expect(() =>
    stockExecution({
      data: "/unused",
      env: { CATAMORPHIC_MAX_WORKSPACES: "0" },
    }),
  ).toThrow("positive integer");
  expect(() =>
    stockExecution({
      data: "/unused",
      env: { CATAMORPHIC_CAPACITY_MEMORY_MB: "1024" },
    }),
  ).toThrow("require CATAMORPHIC_SANDBOX");
  expect(() =>
    stockExecution({
      data: "/unused",
      env: {
        CATAMORPHIC_SANDBOX: "microsandbox",
        CATAMORPHIC_WORKSPACE_CPU_MILLIS: "500",
      },
    }),
  ).toThrow("whole cores");
});

it("a full stock machine preserves existing work and restores an archived session with fresh capacity", async () => {
  const dataDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "catamorphic-capacity-"),
  );
  const server = await buildStockServer({
    dataDir,
    env: {
      DATABASE_URL: "",
      CATAMORPHIC_FAKE_AGENT: "1",
      CATAMORPHIC_MAX_WORKSPACES: "1",
      PATH: process.env.PATH,
    },
  });
  try {
    const core = server.catamorphic.core;
    const identity = {
      tenantId: SERVER_TENANT_ID,
      externalUserId: "capacity-member",
    };
    const project = await core.projects.create(identity, {
      name: "Development",
    });
    const sessions = core.agentSessions;
    if (!sessions) throw Error("Missing sessions");
    const first = await sessions.create(identity, project.id, {
      agentId: "assistant",
      environment: "local",
    });
    await expect(
      sessions.create(identity, project.id, {
        agentId: "assistant",
        environment: "local",
      }),
    ).rejects.toThrow("no workspace capacity");
    await expect(
      sessions.sendMessage(identity, project.id, first.id, "still works"),
    ).resolves.toMatchObject({ content: "Echo: still works" });
    const originalAllocation = first.allocationId;
    await sessions.archive(identity, project.id, first.id);
    await expect
      .poll(
        async () => {
          const row = await core.db
            .selectFrom("execution_allocations")
            .select("capacity_released_at")
            .where("id", "=", originalAllocation ?? "")
            .executeTakeFirst();
          return Boolean(row?.capacity_released_at);
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    const restored = await sessions.unarchive(identity, project.id, first.id);
    expect(restored[0]?.allocationId).not.toBe(originalAllocation);
    await expect(
      sessions.sendMessage(identity, project.id, first.id, "restored"),
    ).resolves.toMatchObject({ content: "Echo: restored" });
    const nodes = new WorkerNodesService(core.db);
    const health = (
      await server.app.inject({ method: "GET", url: "/healthz" })
    ).json();
    const node = await core.db
      .selectFrom("worker_nodes")
      .select("authority_id")
      .where("id", "=", health.machine.id)
      .executeTakeFirstOrThrow();
    const inventory = await nodes.workspaces({
      tenantId: SERVER_TENANT_ID,
      authorityId: node.authority_id,
      nodeId: health.machine.id,
    });
    expect(inventory).toHaveLength(1);
  } finally {
    await server.shutdown();
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}, 30_000);
