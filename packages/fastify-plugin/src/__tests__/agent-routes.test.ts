import { describe, expect, it } from "vitest";
import { createApp } from "../app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const SESSION_ID = "b2c3d4e5-f6a7-4890-bcde-a12345678901";
const RUN_ID = "d4e5f6a7-b8c9-4890-9ef0-1234567890ab";

async function buildApp() {
  const app = createApp();
  await app.ready();
  return app;
}

// Without a `codingAgent` on the core (and without a core at all in these
// tests), agent-session routes respond 503 — validation still runs first.
describe("agent routes", () => {
  describe("POST /api/projects/:projectId/agent/sessions", () => {
    it("responds 503 when no coding agent is configured", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/agent/sessions`,
        payload: {},
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Coding agent not configured" });
      await app.close();
    });

    it("rejects invalid projectId", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: "/api/projects/not-a-uuid/agent/sessions",
        payload: {},
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("GET /api/projects/:projectId/agent/sessions", () => {
    it("returns an empty list", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${PROJECT_ID}/agent/sessions`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ items: [], total: 0 });
      await app.close();
    });
  });

  describe("GET /api/projects/:projectId/agent/sessions/:sessionId", () => {
    it("responds 503 when no coding agent is configured", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`,
      });
      expect(res.statusCode).toBe(503);
      await app.close();
    });
  });

  describe("POST /api/projects/:projectId/agent/sessions/:sessionId/messages", () => {
    it("responds 503 when no coding agent is configured", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        payload: {
          message: "Hello, agent!",
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Coding agent not configured" });
      await app.close();
    });

    it("rejects empty message", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
        payload: {
          message: "",
        },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });
  });

  describe("DELETE /api/projects/:projectId/agent/sessions/:sessionId", () => {
    it("responds 503 when no coding agent is configured", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "DELETE",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`,
      });
      expect(res.statusCode).toBe(503);
      await app.close();
    });
  });

  describe("GET /api/projects/:projectId/skills", () => {
    it("responds 503 when the service is not configured", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "GET",
        url: `/api/projects/${PROJECT_ID}/skills`,
      });
      expect(res.statusCode).toBe(503);
      await app.close();
    });
  });
});

describe("run report route", () => {
  describe("POST /api/runs/:runId/report", () => {
    it("accepts a valid run report payload", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/runs/${RUN_ID}/report`,
        payload: {
          runId: RUN_ID,
          status: "completed",
          result: { output: "done" },
          steps: [
            {
              nodeId: "step-1",
              name: "myStep",
              status: "completed",
              input: { x: 1 },
              output: { y: 2 },
              startedAt: "2026-04-11T00:00:00.000Z",
              completedAt: "2026-04-11T00:00:01.000Z",
            },
          ],
          startedAt: "2026-04-11T00:00:00.000Z",
          completedAt: "2026-04-11T00:00:01.000Z",
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Service not configured" });
      await app.close();
    });

    it("rejects invalid run report (missing required fields)", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/runs/${RUN_ID}/report`,
        payload: {
          status: "invalid-status",
        },
      });
      expect(res.statusCode).toBe(400);
      await app.close();
    });

    it("accepts a failed run report", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/runs/${RUN_ID}/report`,
        payload: {
          runId: RUN_ID,
          status: "failed",
          error: "Something went wrong",
          steps: [],
          startedAt: "2026-04-11T00:00:00.000Z",
          completedAt: "2026-04-11T00:00:01.000Z",
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Service not configured" });
      await app.close();
    });
  });
});
