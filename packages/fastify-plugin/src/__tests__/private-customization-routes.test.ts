import { DocumentConflictError } from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp, TEST_IDENTITY } from "./test-app.js";

const projectId = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("private customization routes", () => {
  it("requires a version and preserves a typed conflict from the authorized state service", async () => {
    const write = vi.fn(async () => {
      throw new DocumentConflictError("store/tasks.json", 2);
    });
    const app = createTestApp({ core: { privateState: { write } } as never });
    apps.push(app);
    const url = `/api/projects/${projectId}/private-state`;
    const missing = await app.inject({
      method: "PUT",
      url,
      payload: { key: "tasks", value: [] },
    });
    expect(missing.statusCode).toBe(400);
    expect(write).not.toHaveBeenCalled();
    const stale = await app.inject({
      method: "PUT",
      url,
      payload: { key: "tasks", value: [], ifVersion: 1 },
    });
    expect(stale.statusCode).toBe(409);
    expect(write).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      projectId,
      key: "tasks",
      value: [],
      ifVersion: 1,
    });
  });

  it("attaches the host identity and explicit member lifetime when retaining workflow source", async () => {
    const artifact = {
      id: "b1b2c3d4-e5f6-4890-abcd-ef1234567890",
      projectId,
      sessionId: null,
      lifetime: "member",
      workflowEnablementId: null,
      kind: "workflow",
      name: "reminders",
      title: "Reminders",
      sourcePath: ".work/workflows/src/reminders.ts",
      remoteBranch: "private",
      commitSha: "a".repeat(40),
      revision: 1,
      status: "active",
      appName: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const create = vi.fn(async () => artifact);
    const app = createTestApp({
      core: { sessionArtifacts: { create } } as never,
    });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/private-workflows`,
      payload: {
        name: "reminders",
        source: "export const reminders = workflow",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual(artifact);
    expect(create).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      projectId,
      lifetime: "member",
      kind: "workflow",
      name: "reminders",
      source: "export const reminders = workflow",
    });
  });

  it("publishes to the calling member and rejects external routes", async () => {
    const notify = vi.fn(async () => ({ published: true }));
    const app = createTestApp({ core: { notifications: { notify } } as never });
    apps.push(app);
    const url = `/api/projects/${projectId}/notifications`;
    const invalid = await app.inject({
      method: "POST",
      url,
      payload: {
        title: "Due",
        route: "//another-host/",
        idempotencyKey: "due:1",
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(notify).not.toHaveBeenCalled();
    const sent = await app.inject({
      method: "POST",
      url,
      payload: { title: "Due", idempotencyKey: "due:1" },
    });
    expect(sent.statusCode).toBe(200);
    expect(notify).toHaveBeenCalledWith({
      identity: TEST_IDENTITY,
      projectId,
      title: "Due",
      body: "",
      idempotencyKey: "due:1",
    });
  });
});
