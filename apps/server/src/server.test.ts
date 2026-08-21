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

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "stock-server-"));
  server = await buildStockServer({
    dataDir,
    publicBases: ["http://catamorphic.local:4700"],
    env: { CATAMORPHIC_FAKE_AGENT: "1", PATH: process.env.PATH },
  });
  adminToken = server.auth.ensureAdmin().token;
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const inject = (
  method: "GET" | "POST" | "DELETE",
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
