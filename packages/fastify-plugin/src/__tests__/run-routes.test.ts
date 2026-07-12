import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const apps: ReturnType<typeof createApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("run route contracts", () => {
  it.each([
    "/api/projects/a1b2c3d4-e5f6-4890-abcd-ef1234567890/workflows/example/runs",
    "/api/projects/a1b2c3d4-e5f6-4890-abcd-ef1234567890/workflows/example/test-runs",
  ])("registers POST %s", async (url) => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url,
      payload: {},
    });
    expect(response.statusCode).toBe(503);
  });

  it("does not register the ambiguous playground run route", async () => {
    const app = createApp();
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: "/api/playground/run",
      payload: {},
    });
    expect(response.statusCode).toBe(404);
  });

  it("publishes both explicit trigger operations in OpenAPI", async () => {
    const app = createApp();
    apps.push(app);
    await app.ready();
    const spec = app.swagger();
    const paths = spec.paths ?? {};
    expect(
      paths["/api/projects/{projectId}/workflows/{name}/runs"]?.post,
    ).toBeDefined();
    expect(
      paths["/api/projects/{projectId}/workflows/{name}/test-runs"]?.post,
    ).toBeDefined();
    expect(paths["/api/playground/run"]).toBeUndefined();
  });
});
