import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectAssistantId } from "./agents.js";
import { buildStockServer, type StockServer } from "./server.js";

/**
 * The stock server end to end, on a temp data dir with the fake echo
 * agent: boot → project → invite → scoped member chats, and the scope
 * boundaries hold. Everything goes through app.inject — no ports.
 */

let dataDir: string;
let server: StockServer;
let adminToken: string;

let pwaDist: string;

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stock-server-"));
  pwaDist = fs.mkdtempSync(path.join(os.tmpdir(), "stock-pwa-dist-"));
  fs.writeFileSync(
    path.join(pwaDist, "index.html"),
    "<!doctype html><title>pwa-stub</title>",
  );
  server = await buildStockServer({
    dataDir,
    publicBases: ["http://catamorphic.local:4700"],
    env: {
      CATAMORPHIC_FAKE_AGENT: "1",
      CATAMORPHIC_PWA_DIST: pwaDist,
      PATH: process.env.PATH,
    },
  });
  adminToken = server.auth.ensureAdmin().token;
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
  if (pwaDist) fs.rmSync(pwaDist, { recursive: true, force: true });
});

const inject = (
  method: "GET" | "POST" | "PUT" | "DELETE",
  url: string,
  token?: string,
  body?: unknown,
) =>
  server.app.inject({
    method,
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

let projectId: string;
let memberToken: string;

describe("stock server", () => {
  it("reports health and chat availability", async () => {
    const response = await inject("GET", "/healthz");
    expect(response.json()).toEqual({ ok: true, agentSessions: true });
  });

  it("serves the PWA at its root, SPA-falling back on unknown paths", async () => {
    const root = await inject("GET", "/");
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("pwa-stub");
    const deep = await inject("GET", "/anything/else");
    expect(deep.body).toContain("pwa-stub");
  });

  it("rejects unauthenticated and unknown-token API calls", async () => {
    expect((await inject("GET", "/api/me")).statusCode).toBe(401);
    expect((await inject("GET", "/api/me", "nope")).statusCode).toBe(401);
  });

  it("admin creates a project (admin token = root identity)", async () => {
    const denied = await inject("POST", "/admin/projects", undefined, {
      name: "brain",
    });
    expect(denied.statusCode).toBe(401);
    const response = await inject("POST", "/admin/projects", adminToken, {
      name: "brain",
    });
    expect(response.statusCode).toBe(201);
    projectId = response.json().id;
    expect(projectId).toBeTruthy();
  }, 30_000);

  it("mints an invite: role file, membership, token, connect links", async () => {
    const response = await inject("POST", "/admin/invites", adminToken, {
      projectId,
      user: "sam",
    });
    expect(response.statusCode).toBe(201);
    const invite = response.json();
    memberToken = invite.token;
    expect(invite.projectName).toBe("brain");
    expect(invite.connectLinks[0]).toContain(
      "catamorphic://connect?server=http%3A%2F%2Fcatamorphic.local%3A4700%2Fapi",
    );
    expect(invite.connectLinks[0]).toContain(`project=${projectId}`);
    // The plain-URL variant opens the PWA this server serves.
    expect(invite.webLinks[0]).toMatch(
      /^http:\/\/catamorphic\.local:4700\/\?server=/,
    );
  }, 60_000);

  it("the member's /me shows the assistant and nothing more", async () => {
    const response = await inject("GET", "/api/me", memberToken);
    expect(response.statusCode).toBe(200);
    const me = response.json();
    expect(me.identity).toEqual({ externalUserId: "sam", root: false });
    expect(me.projects).toHaveLength(1);
    expect(me.projects[0].projectId).toBe(projectId);
    expect(me.projects[0].builder).toBe(false);
    expect(me.projects[0].agents).toEqual(["assistant"]);
    expect(me.features.agentSessions).toBe(true);
  });

  it("the member sees the project in the list but not its builder record", async () => {
    const list = await inject("GET", "/api/projects", memberToken);
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((p: { id: string }) => p.id)).toEqual([
      projectId,
    ]);
    const record = await inject(
      "GET",
      `/api/projects/${projectId}`,
      memberToken,
    );
    expect(record.statusCode).toBe(403);
  });

  it("a scoped member must address the project assistant explicitly", async () => {
    const bare = await inject(
      "POST",
      `/api/projects/${projectId}/agent/sessions`,
      memberToken,
      {},
    );
    expect(bare.statusCode).toBe(403);
  });

  it("the member chats with the assistant end to end", async () => {
    const created = await inject(
      "POST",
      `/api/projects/${projectId}/agent/sessions`,
      memberToken,
      { agentId: projectAssistantId(projectId) },
    );
    expect(created.statusCode).toBe(201);
    const sessionId = created.json().id;
    const sent = await inject(
      "POST",
      `/api/projects/${projectId}/agent/sessions/${sessionId}/messages`,
      memberToken,
      { message: "hello server" },
    );
    expect(sent.statusCode).toBe(201);
    const detail = await inject(
      "GET",
      `/api/projects/${projectId}/agent/sessions/${sessionId}`,
      memberToken,
    );
    const contents = detail
      .json()
      .messages.map((message: { content: string }) => message.content);
    expect(contents).toContain("hello server");
    expect(contents).toContain("Echo: hello server");
  }, 60_000);

  it("mirrors a desktop session and continues it server-side (ADR 0061)", async () => {
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const messages = [
      {
        id: "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        role: "user",
        content: "hello from the desktop",
        metadata: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: "22222222-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        role: "assistant",
        content: "desktop assistant reply",
        metadata: {
          status: "completed",
          events: [],
          usage: {
            inputTokens: 100,
            cachedInputTokens: 40,
            outputTokens: 25,
            costUsd: 0.012,
            model: "claude-opus-5",
          },
        },
        createdAt: new Date().toISOString(),
      },
    ];
    const mirrorUrl = `/api/projects/${projectId}/agent/sessions/${sessionId}/mirror`;
    const first = await inject("PUT", mirrorUrl, memberToken, {
      title: "Desktop chat",
      icon: "sparkles:orange",
      provider: "ai-sdk",
      messages,
    });
    expect(first.statusCode).toBe(200);
    // Idempotent re-push: same payload, no duplicates.
    expect(
      (await inject("PUT", mirrorUrl, memberToken, { messages })).statusCode,
    ).toBe(200);

    const list = await inject(
      "GET",
      `/api/projects/${projectId}/agent/sessions`,
      memberToken,
    );
    expect(list.json().items.map((s: { id: string }) => s.id)).toContain(
      sessionId,
    );

    // Continue ON THE SERVER: the mirrored transcript seeds the anchor.
    const sent = await inject(
      "POST",
      `/api/projects/${projectId}/agent/sessions/${sessionId}/messages`,
      memberToken,
      { message: "continue here" },
    );
    expect(sent.statusCode).toBe(201);
    const detail = await inject(
      "GET",
      `/api/projects/${projectId}/agent/sessions/${sessionId}`,
      memberToken,
    );
    const contents = detail
      .json()
      .messages.map((m: { content: string }) => m.content);
    expect(contents).toEqual([
      "hello from the desktop",
      "desktop assistant reply",
      "continue here",
      "Echo: continue here",
    ]);

    // The desktop pushes again without the server-side turns → diverged.
    const stale = await inject("PUT", mirrorUrl, memberToken, { messages });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().diverged).toBe(true);
  }, 60_000);

  it("admins see per-member usage, mirrored turns included (ADR 0062)", async () => {
    const denied = await inject("GET", "/admin/usage", memberToken);
    expect(denied.statusCode).toBe(401);
    const response = await inject("GET", "/admin/usage", adminToken);
    expect(response.statusCode).toBe(200);
    const sam = response
      .json()
      .items.find(
        (entry: { user: string; projectId: string }) =>
          entry.user === "sam" && entry.projectId === projectId,
      );
    expect(sam).toBeTruthy();
    expect(sam.inputTokens).toBe(100);
    expect(sam.cachedInputTokens).toBe(40);
    expect(sam.outputTokens).toBe(25);
    expect(sam.costUsd).toBeCloseTo(0.012);
    expect(sam.sessions).toBeGreaterThanOrEqual(2);
    expect(sam.turns).toBeGreaterThanOrEqual(3);
  });

  it("revoking the invite cuts the member off instantly", async () => {
    const revoked = await inject(
      "DELETE",
      `/admin/invites/${memberToken}`,
      adminToken,
    );
    expect(revoked.statusCode).toBe(200);
    expect((await inject("GET", "/api/me", memberToken)).statusCode).toBe(401);
  });
});
