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

  describe("POST /api/projects/:projectId/agent/sessions/:sessionId/commands", () => {
    const url = `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/commands`;

    it("responds 503 when no coding agent is configured", async () => {
      const app = await buildApp();
      const res = await app.inject({
        method: "POST",
        url,
        payload: {
          type: "send",
          commandId: "command-0001",
          text: "Hello, agent!",
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json()).toEqual({ error: "Coding agent not configured" });
      await app.close();
    });

    it("validates the command before anything runs", async () => {
      const app = await buildApp();
      for (const payload of [
        { type: "send", commandId: "command-0001", text: "" },
        { type: "send", text: "no command id" },
        {
          type: "send",
          commandId: "command-0001",
          text: "x",
          dispatch: "next_turn",
        },
        { type: "answer", commandId: "command-0001" },
      ]) {
        const res = await app.inject({ method: "POST", url, payload });
        expect(res.statusCode).toBe(400);
      }
      await app.close();
    });
  });

  it("no longer serves the routes commands replaced", async () => {
    const app = await buildApp();
    const base = `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}`;
    for (const [method, url] of [
      ["POST", `${base}/messages`],
      ["POST", `${base}/questions/q1/answer`],
      ["GET", `${base}/permissions`],
      ["POST", `${base}/permissions/${SESSION_ID}`],
      ["POST", `${base}/retry`],
      ["PATCH", `${base}/turns/${SESSION_ID}`],
      ["DELETE", `${base}/turns/${SESSION_ID}`],
      ["POST", `${base}/turns/${SESSION_ID}/send-now`],
      ["POST", `${base}/interrupt`],
    ] as const) {
      const res = await app.inject({ method, url, payload: {} });
      expect([method, url, res.statusCode]).toEqual([method, url, 404]);
    }
    await app.close();
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

// The raised body cap is scoped to the commands and mirror routes (base64
// media rides in a send); every other route keeps Fastify's default 1MB cap.
describe("body limits", () => {
  // Past Fastify's 1MB default, within the text-attachment schema cap.
  const bigBody = "x".repeat(1_500_000);

  it("lets a >1MB body through to the commands handler", async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/agent/sessions/${SESSION_ID}/commands`,
      payload: {
        type: "send",
        commandId: "command-0001",
        text: "look at this",
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

describe("personal environments (ADR 0199)", () => {
  it("refuses sign-ins: they stay on the machine they were made on", async () => {
    const replace = vi.fn(async () => ({
      allowed: true,
      files: [],
      setup: null,
    }));
    const server = createTestApp({
      core: { personalEnvironments: { replace } } as never,
    });
    const url = `/api/projects/${PROJECT_ID}/personal-environment`;
    const refused = await server.inject({
      method: "PUT",
      url,
      payload: { logins: { codex: { auth: "{}" } }, files: [] },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().message).toContain(
      "Sign-ins stay on the machine they were made on",
    );
    expect(replace).not.toHaveBeenCalled();
    const kept = await server.inject({
      method: "PUT",
      url,
      payload: { files: [{ path: ".env", content: "QQ==" }] },
    });
    expect([kept.statusCode, kept.json()]).toEqual([
      200,
      { allowed: true, files: [], setup: null },
    ]);
    await server.close();
  });

  it("takes the member's own setup command with their files (ADR 0207)", async () => {
    const replace = vi.fn(async () => ({
      allowed: true,
      files: [],
      setup: { command: "mise install", updatedAt: "2026-10-06T00:00:00.000Z" },
    }));
    const server = createTestApp({
      core: { personalEnvironments: { replace } } as never,
    });
    const url = `/api/projects/${PROJECT_ID}/personal-environment`;
    const sent = await server.inject({
      method: "PUT",
      url,
      payload: { files: [], setup: "mise install" },
    });
    expect(sent.statusCode).toBe(200);
    expect(sent.json().setup).toMatchObject({ command: "mise install" });
    expect(replace).toHaveBeenCalledWith(
      expect.objectContaining({
        input: { files: [], setup: "mise install" },
      }),
    );
    const tooLong = await server.inject({
      method: "PUT",
      url,
      payload: { files: [], setup: "x".repeat(16_385) },
    });
    expect(tooLong.statusCode).toBe(400);
    await server.close();
  });
});
