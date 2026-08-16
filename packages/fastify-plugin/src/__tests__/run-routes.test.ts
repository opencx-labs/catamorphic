import { afterEach, describe, expect, it } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const RUN_ID = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const ATTEMPT_ID = "c3d4e5f6-a7b8-4890-acde-123456789012";
const ITEM_ID = "d4e5f6a7-b8c9-4890-8efa-234567890123";
const PAUSE_ID = "e5f6a7b8-c9d0-4890-9fab-345678901234";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("run route contracts", () => {
  it.each([
    {
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/workflows/example/runs`,
      payload: { input: { key: "value" } },
    },
    {
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/workflows/example/runs`,
    },
    { method: "GET", url: `/api/runs/${RUN_ID}` },
    { method: "POST", url: `/api/runs/${RUN_ID}/cancel`, payload: {} },
    { method: "POST", url: `/api/runs/${RUN_ID}/pause` },
    { method: "POST", url: `/api/runs/${RUN_ID}/resume` },
    {
      method: "POST",
      url: `/api/runs/${RUN_ID}/pauses/${PAUSE_ID}/resume`,
      payload: { idempotencyKey: "resume-1", value: { approved: true } },
    },
    {
      method: "GET",
      url: `/api/runs/${RUN_ID}/steps/${ATTEMPT_ID}/items`,
    },
    {
      method: "GET",
      url: `/api/runs/${RUN_ID}/steps/${ATTEMPT_ID}/items/${ITEM_ID}/steps`,
    },
  ] satisfies readonly {
    method: "GET" | "POST";
    url: string;
    payload?: object;
  }[])("registers $method $url", async ({ method, url, payload }) => {
    const app = createTestApp();
    apps.push(app);
    const response = await app.inject({ method, url, payload });
    expect(response.statusCode).toBe(503);
  });

  it.each([
    ["POST", `/api/projects/${PROJECT_ID}/workflows/example/batch-runs`],
    ["POST", `/api/projects/${PROJECT_ID}/workflows/example/durable-runs`],
    ["POST", `/api/projects/${PROJECT_ID}/workflows/example/test-runs`],
    ["GET", `/api/batch-runs/${RUN_ID}`],
    ["GET", `/api/durable-runs/${RUN_ID}`],
    ["POST", `/api/runs/${RUN_ID}/report`],
    ["POST", "/api/playground/run"],
  ] as const)("does not register legacy %s %s", async (method, url) => {
    const app = createTestApp();
    apps.push(app);
    const response = await app.inject({ method, url, payload: {} });
    expect(response.statusCode).toBe(404);
  });

  it("publishes only canonical unified run paths", async () => {
    const app = createTestApp();
    apps.push(app);
    await app.ready();
    const paths = app.swagger().paths ?? {};

    expect(
      paths["/api/projects/{projectId}/workflows/{name}/runs"]?.post,
    ).toBeDefined();
    expect(paths["/api/runs/{runId}"]?.get).toBeDefined();
    expect(paths["/api/runs/{runId}/cancel"]?.post).toBeDefined();
    expect(paths["/api/runs/{runId}/pause"]?.post).toBeDefined();
    expect(paths["/api/runs/{runId}/resume"]?.post).toBeDefined();
    expect(
      paths["/api/runs/{runId}/pauses/{pauseId}/resume"]?.post,
    ).toBeDefined();
    expect(
      paths["/api/runs/{runId}/steps/{workflowStepAttemptId}/items"]?.get,
    ).toBeDefined();
    expect(
      paths[
        "/api/runs/{runId}/steps/{workflowStepAttemptId}/items/{itemId}/steps"
      ]?.get,
    ).toBeDefined();

    expect(Object.keys(paths).some((path) => path.includes("batch-runs"))).toBe(
      false,
    );
    expect(
      Object.keys(paths).some((path) => path.includes("durable-runs")),
    ).toBe(false);
    expect(paths["/api/runs/{runId}/report"]).toBeUndefined();
  });

  it("publishes capabilities without workflow kind or execution descriptors", async () => {
    const app = createTestApp();
    apps.push(app);
    await app.ready();
    const paths = app.swagger().paths ?? {};
    const workflowOperations = JSON.stringify([
      paths["/api/projects/{projectId}/workflows"]?.get,
      paths["/api/projects/{projectId}/workflows/{name}"]?.get,
    ]);

    expect(workflowOperations).toContain('"capabilities"');
    expect(workflowOperations).toContain('"durable-boundary"');
    expect(workflowOperations).toContain('"batch"');
    expect(workflowOperations).toContain('"pause"');
    expect(workflowOperations).toContain('"call-workflow"');
    // Trigger bindings legitimately expose a `kind` (the trigger kind name);
    // the internal workflow-kind discriminators must still stay internal.
    expect(workflowOperations).not.toContain('"durable-workflow"');
    expect(workflowOperations).not.toContain('"execution"');
  });

  it("publishes ordered Batch processing scopes instead of singular progress", async () => {
    const app = createTestApp();
    apps.push(app);
    await app.ready();
    const runOperations = JSON.stringify([
      app.swagger().paths?.["/api/projects/{projectId}/workflows/{name}/runs"]
        ?.get,
      app.swagger().paths?.["/api/runs/{runId}"]?.get,
    ]);

    expect(runOperations).toContain('"batchScopes"');
    expect(runOperations).toContain('"workflowStepAttemptId"');
    expect(runOperations).toContain('"stepIndex"');
    expect(runOperations).toContain('"nodeId"');
    expect(runOperations).not.toContain('"batchProgress"');
  });

  it("publishes recursive JSON-compatible run inputs", async () => {
    const app = createTestApp();
    apps.push(app);
    await app.ready();
    const spec = app.swagger();
    const requestSchemas = JSON.stringify([
      spec.paths?.["/api/projects/{projectId}/workflows/{name}/runs"]?.post,
      spec.paths?.["/api/runs/{runId}/pauses/{pauseId}/resume"]?.post,
      spec,
    ]);

    expect(requestSchemas).toContain(
      '"$ref":"#/components/schemas/JsonValueInput"',
    );
    expect(requestSchemas).toContain('"type":"array"');
    expect(requestSchemas).toContain('"additionalProperties"');
  });
});
