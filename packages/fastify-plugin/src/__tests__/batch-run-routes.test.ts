import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("batch run route contracts", () => {
  it.each([
    {
      method: "POST",
      url: "/api/projects/a1b2c3d4-e5f6-4890-abcd-ef1234567890/workflows/analyze/batch-runs",
    },
    {
      method: "GET",
      url: "/api/projects/a1b2c3d4-e5f6-4890-abcd-ef1234567890/workflows/analyze/batch-runs",
    },
    {
      method: "GET",
      url: "/api/batch-runs/a1b2c3d4-e5f6-4890-abcd-ef1234567890",
    },
    {
      method: "GET",
      url: "/api/batch-runs/a1b2c3d4-e5f6-4890-abcd-ef1234567890/items",
    },
    {
      method: "GET",
      url: "/api/batch-runs/a1b2c3d4-e5f6-4890-abcd-ef1234567890/items/b2c3d4e5-f6a7-4890-bcde-a12345678901/steps",
    },
    {
      method: "POST",
      url: "/api/batch-runs/a1b2c3d4-e5f6-4890-abcd-ef1234567890/pause",
    },
    {
      method: "POST",
      url: "/api/batch-runs/a1b2c3d4-e5f6-4890-abcd-ef1234567890/resume",
    },
    {
      method: "POST",
      url: "/api/batch-runs/a1b2c3d4-e5f6-4890-abcd-ef1234567890/cancel",
    },
    {
      method: "POST",
      url: "/api/batch-runs/a1b2c3d4-e5f6-4890-abcd-ef1234567890/retry-failed",
    },
  ] satisfies readonly {
    method: "GET" | "POST";
    url: string;
  }[])("registers $method $url", async ({ method, url }) => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({ method, url, payload: {} });
    expect(response.statusCode).toBe(503);
  });

  it("publishes batch lifecycle operations in OpenAPI", async () => {
    const app = createApp();
    apps.push(app);
    await app.ready();
    const paths = app.swagger().paths ?? {};
    expect(
      paths["/api/projects/{projectId}/workflows/{name}/batch-runs"]?.post,
    ).toBeDefined();
    expect(paths["/api/batch-runs/{batchRunId}/pause"]?.post).toBeDefined();
    expect(paths["/api/batch-runs/{batchRunId}/resume"]?.post).toBeDefined();
    expect(paths["/api/batch-runs/{batchRunId}/cancel"]?.post).toBeDefined();
    expect(
      paths["/api/batch-runs/{batchRunId}/retry-failed"]?.post,
    ).toBeDefined();
  });
});
