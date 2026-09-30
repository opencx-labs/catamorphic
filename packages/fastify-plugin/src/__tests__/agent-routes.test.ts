import {
  AccessDeniedError,
  AgentNotConfiguredError,
  EnvironmentPolicyInvalidError,
} from "@catamorphic/core";
import { describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const SESSION_ID = "b2c3d4e5-f6a7-4890-bcde-a12345678901";

async function buildApp() {
  const app = createTestApp();
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

    it("answers 422 when the project's Environment policy is invalid", async () => {
      const app = createTestApp({
        core: {
          agentSessions: {
            create: vi.fn(async () => {
              throw new EnvironmentPolicyInvalidError(
                "defaultEnvironment must name a valid declared Environment",
              );
            }),
          },
        } as never,
      });
      await app.ready();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/agent/sessions`,
        payload: {},
      });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toEqual({
        error:
          "Invalid .work/project.json: defaultEnvironment must name a valid declared Environment",
        code: "environment_policy_invalid",
      });
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

    it("rejects an unknown session source", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/agent/sessions`,
        payload: { source: "untrusted-widget" },
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

  it("rejects ambiguous or invalid hierarchy list queries", async () => {
    const app = await buildApp();
    for (const query of [
      `rootsOnly=true&parentSessionId=${SESSION_ID}`,
      "rootsOnly=yes",
      "parentSessionId=unknown",
    ]) {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${PROJECT_ID}/agent/sessions?${query}`,
      });
      expect(response.statusCode).toBe(400);
    }
    await app.close();
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

  describe("POST /api/projects/:projectId/agent/sessions/:sessionId/attention/acknowledge", () => {
    it("registers the acknowledgement route", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/attention/acknowledge`,
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Coding agent not configured" });
      await app.close();
    });
  });

  describe("agent session coordination", () => {
    it("registers peer listing and activity routes", async () => {
      const app = await buildApp();
      const peers = await app.inject({
        method: "GET",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/peers`,
      });
      const activity = await app.inject({
        method: "PATCH",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/activity`,
        payload: { activity: "Editing the renewal deck" },
      });
      expect(peers.statusCode).toBe(503);
      expect(activity.statusCode).toBe(503);
      await app.close();
    });

    it("bounds session activity", async () => {
      const app = await buildApp();
      const response = await app.inject({
        method: "PATCH",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/activity`,
        payload: { activity: "x".repeat(501) },
      });
      expect(response.statusCode).toBe(400);
      await app.close();
    });

    it("reports an unavailable subsession agent as a client error", async () => {
      const app = createTestApp({
        core: {
          agentSessions: {
            createSubsession: vi.fn(async () => {
              throw new AgentNotConfiguredError("retired-agent");
            }),
          },
        } as never,
      });
      await app.ready();
      const response = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/subsessions`,
        payload: { task: "Review the release" },
      });
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({
        error: "Coding agent 'retired-agent' is not configured",
      });
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

  describe("watcher lifecycle routes", () => {
    it("registers list and stop routes", async () => {
      const app = await buildApp();
      const list = await app.inject({
        method: "GET",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/watchers`,
      });
      const stop = await app.inject({
        method: "DELETE",
        url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/watchers/${SESSION_ID}`,
      });
      expect(list.statusCode).toBe(503);
      expect(stop.statusCode).toBe(503);
      await app.close();
    });
  });

  describe("cross-host session mailbox routes", () => {
    it("registers list and acknowledgement routes", async () => {
      const app = await buildApp();
      const list = await app.inject({
        method: "GET",
        url: `/api/projects/${PROJECT_ID}/session-mailboxes?destinationHostId=desktop:test`,
      });
      const acknowledge = await app.inject({
        method: "POST",
        url: `/api/projects/${PROJECT_ID}/session-mailboxes/${SESSION_ID}/acknowledge`,
        payload: { destinationHostId: "desktop:test" },
      });
      expect(list.statusCode).toBe(503);
      expect(acknowledge.statusCode).toBe(503);
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

// The raised body cap is scoped to the messages route (base64 media rides
// in the message body); every other route keeps Fastify's default 1MB cap.
describe("body limits", () => {
  // Past Fastify's 1MB default, within the text-attachment schema cap.
  const bigBody = "x".repeat(1_500_000);

  it("lets a >1MB body through to the messages handler", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/messages`,
      payload: {
        message: "look at this",
        attachments: [
          {
            kind: "text",
            name: "paste",
            text: bigBody,
            source: { type: "paste" },
          },
        ],
      },
    });
    // 503 (no coding agent), not 413 — the parser accepted the body.
    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("rejects a >1MB body on other routes with 413", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/agent/sessions`,
      payload: { note: bigBody },
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});

describe("tool permission routes (no core → 503, validation first)", () => {
  it("lists 503 without a broker and validates ids", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/permissions`,
    });
    expect(res.statusCode).toBe(503);
    const bad = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/permissions/not-a-uuid`,
      payload: { decision: "allow" },
    });
    expect(bad.statusCode).toBe(400);
    const badBody = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/permissions/${SESSION_ID}`,
      payload: { decision: "maybe" },
    });
    expect(badBody.statusCode).toBe(400);
    await app.close();
  });
});

describe("tool permission routes with named approvers (ADR 0176)", () => {
  const APPROVAL_ID = "c3d4e5f6-a7b8-4890-8def-123456789012";
  const OPEN_ID = "d4e5f6a7-b8c9-4890-8ef0-234567890123";
  const request = {
    server: "connection_prod",
    tool: "query",
    description: "Needs approval",
    input: {},
  };
  const pending = [
    {
      id: APPROVAL_ID,
      sessionId: SESSION_ID,
      request,
      createdAt: "2026-09-27T00:00:00.000Z",
      expiresAt: "2026-09-27T00:30:00.000Z",
      approvers: ["alice"],
    },
    {
      id: OPEN_ID,
      sessionId: SESSION_ID,
      request,
      createdAt: "2026-09-27T00:00:00.000Z",
      expiresAt: "2026-09-27T00:30:00.000Z",
    },
  ];
  /** The chat is held by the test user; alice only approves. */
  function app() {
    const answered: string[] = [];
    const server = createTestApp({
      core: {
        agentSessions: {
          assertSession: async (identity: { externalUserId: string }) => {
            if (identity.externalUserId !== "test-user")
              throw new AccessDeniedError();
          },
        },
        toolPermissions: {
          list: async () => pending,
          get: async (id: string) => pending.find((entry) => entry.id === id),
          answer: async (id: string) => {
            answered.push(id);
            return true;
          },
        },
      } as never,
    });
    return { server, answered };
  }
  const asAlice = {
    "x-catamorphic-tenant-id": "test-tenant",
    "x-external-user-id": "alice",
  };
  const ids = (body: { permissions: Array<{ id: string }> }) =>
    body.permissions.map((entry) => entry.id);

  it("shows an ask that names approvers to them alone", async () => {
    const { server } = app();
    const holder = await server.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/permissions`,
    });
    expect(ids(holder.json())).toEqual([OPEN_ID]);
    const approver = await server.inject({
      method: "GET",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/permissions`,
      headers: asAlice,
    });
    expect(ids(approver.json())).toEqual([APPROVAL_ID]);
    await server.close();
  });

  it("lets only the named approvers answer it", async () => {
    const { server, answered } = app();
    const holder = await server.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/permissions/${APPROVAL_ID}`,
      payload: { decision: "allow" },
    });
    expect(holder.statusCode).toBe(403);
    const approver = await server.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/permissions/${APPROVAL_ID}`,
      payload: { decision: "allow" },
      headers: asAlice,
    });
    expect(approver.statusCode).toBe(200);
    expect(answered).toEqual([APPROVAL_ID]);
    await server.close();
  });
});

describe("keyed chats a caller may not see (ADR 0173)", () => {
  it("answer exactly like no chat at all", async () => {
    const denied = async () => {
      throw new AccessDeniedError();
    };
    const server = createTestApp({
      core: {
        agentSessions: {
          keyedChatId: async ({ key }: { key: string }) =>
            key === "pr-1" ? SESSION_ID : undefined,
          get: denied,
          close: denied,
        },
      } as never,
    });
    for (const key of ["pr-1", "pr-2"]) {
      const url = `/api/projects/${PROJECT_ID}/agent/chats/${key}?member=alice`;
      const found = await server.inject({ method: "GET", url });
      expect([found.statusCode, found.json()]).toEqual([
        404,
        { error: "No open chat" },
      ]);
      const closed = await server.inject({ method: "DELETE", url });
      expect([closed.statusCode, closed.json()]).toEqual([
        200,
        { sessionId: null, closed: false },
      ]);
    }
    await server.close();
  });
});
