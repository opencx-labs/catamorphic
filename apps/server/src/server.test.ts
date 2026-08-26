import { createHash, randomBytes } from "node:crypto";
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

let pwaDist: string;

async function oauthAccessToken(options: {
  username: string;
  password: string;
}): Promise<string> {
  const login = await server.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/username",
    payload: options,
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.headers["set-cookie"];
  expect(cookie).toBeTruthy();

  const redirectUri = "http://127.0.0.1:49152/callback";
  const registered = await server.app.inject({
    method: "POST",
    url: "/api/auth/mcp/register",
    payload: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Stock server test",
    },
  });
  expect(registered.statusCode).toBe(201);
  const clientId = registered.json().client_id as string;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(
    "/api/auth/mcp/authorize",
    "http://catamorphic.local:4700",
  );
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email offline_access");
  authorize.searchParams.set("state", "stock-server-state");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  const authorized = await server.app.inject({
    method: "GET",
    url: `${authorize.pathname}${authorize.search}`,
    headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie },
  });
  expect(authorized.statusCode).toBe(302);
  const code = new URL(authorized.headers.location ?? "").searchParams.get(
    "code",
  );
  expect(code).toBeTruthy();

  const token = await server.app.inject({
    method: "POST",
    url: "/api/auth/mcp/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code: code ?? "",
      code_verifier: verifier,
    }).toString(),
  });
  expect(token.statusCode).toBe(200);
  return token.json().access_token as string;
}

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

const operatorInject = (url: string, token?: string, body?: unknown) =>
  server.operatorApp.inject({
    method: "POST",
    url,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });

let projectId: string;
let memberToken: string;
let memberUserId: string;
let managerToken: string;

const MEMBER_ROLE = {
  version: 1,
  name: "Member",
  agents: ["assistant"],
  environments: ["local"],
  documents: [{ path: "store/users/{user}/**", access: "write" }],
};

const MANAGER_ROLE = {
  version: 1,
  name: "Manager",
  builder: true,
  permissions: ["memberships:manage", "roles:manage"],
  agents: ["assistant"],
  environments: ["local"],
  documents: [{ path: "store/**", access: "write" }],
};

describe("stock server", () => {
  it("publishes OAuth authorization and protected-resource discovery", async () => {
    const authorization = await server.app.inject({
      method: "GET",
      url: "/.well-known/oauth-authorization-server",
    });
    expect(authorization.statusCode).toBe(200);
    expect(authorization.json()).toMatchObject({
      authorization_endpoint: expect.stringContaining(
        "/api/auth/mcp/authorize",
      ),
      token_endpoint: expect.stringContaining("/api/auth/mcp/token"),
    });
    const resource = await server.app.inject({
      method: "GET",
      url: "/.well-known/oauth-protected-resource",
    });
    expect(resource.statusCode).toBe(200);
    expect(resource.json()).toMatchObject({
      resource: "http://catamorphic.local:4700/api",
      authorization_servers: expect.any(Array),
    });
  });
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
    const missing = await inject("GET", "/api/me");
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain(
      'resource_metadata="http://catamorphic.local:4700/.well-known/oauth-protected-resource"',
    );
    const invalid = await inject("GET", "/api/me", "nope");
    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers["www-authenticate"]).toContain(
      'error="invalid_token"',
    );
  });

  it("resolves an OAuth access token to the current authenticated user", async () => {
    const user = await server.stockAuth.createLocalUser({
      username: "oauthuser",
      name: "OAuth User",
      password: "correct horse battery staple",
    });
    const accessToken = await oauthAccessToken({
      username: "oauthuser",
      password: "correct horse battery staple",
    });

    const response = await inject("GET", "/api/me", accessToken);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      identity: { externalUserId: user.id, root: false },
      projects: [],
    });
  });

  it("a setup agent establishes the project and first ordinary manager", async () => {
    const operatorSecret = fs
      .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
      .trim();
    const publicIngress = await inject(
      "POST",
      "/_catamorphic/operator/projects",
      operatorSecret,
      {
        name: "brain",
        roles: [
          { slug: "member", definition: MEMBER_ROLE },
          { slug: "manager", definition: MANAGER_ROLE },
        ],
        admission: {
          mode: "invitation_only",
          defaultRole: "member",
          approvedDomains: [],
        },
      },
    );
    expect(publicIngress.statusCode).toBe(404);

    const projectResponse = await operatorInject(
      "/_catamorphic/operator/projects",
      operatorSecret,
      {
        name: "brain",
        roles: [
          { slug: "member", definition: MEMBER_ROLE },
          { slug: "manager", definition: MANAGER_ROLE },
        ],
        admission: {
          mode: "invitation_only",
          defaultRole: "member",
          approvedDomains: [],
        },
      },
    );
    expect(projectResponse.statusCode).toBe(201);
    projectId = projectResponse.json().project.id;
    const managerResponse = await operatorInject(
      "/_catamorphic/operator/users",
      operatorSecret,
      {
        username: "manager",
        name: "Project Manager",
        password: "correct horse battery staple",
        memberships: [{ projectId, roles: ["manager"] }],
      },
    );
    expect(managerResponse.statusCode).toBe(201);
    expect(managerResponse.json().memberships).toHaveLength(1);
    const manager = managerResponse.json().user as { id: string };
    expect(manager.id).toBeTruthy();
    managerToken = await oauthAccessToken({
      username: "manager",
      password: "correct horse battery staple",
    });

    expect((await inject("GET", "/api/me", managerToken)).statusCode).toBe(200);
    expect((await inject("POST", "/admin/projects")).statusCode).toBe(404);
  }, 30_000);

  it("a manager configures admission and creates a credential-free invitation", async () => {
    const policy = await inject(
      "PUT",
      `/api/projects/${projectId}/admission/policy`,
      managerToken,
      {
        mode: "invitation_only",
        defaultRole: "member",
        approvedDomains: [],
      },
    );
    expect(policy.statusCode).toBe(200);
    const response = await inject(
      "POST",
      `/api/projects/${projectId}/admission/invitations`,
      managerToken,
      {},
    );
    expect(response.statusCode).toBe(201);
    const invite = response.json();
    expect(invite.connectLinks[0]).toContain(
      "catamorphic://connect?server=http%3A%2F%2Fcatamorphic.local%3A4700%2Fapi",
    );
    expect(invite.connectLinks[0]).toContain(`project=${projectId}`);
    expect(invite.connectLinks[0]).toContain(`invitation=${invite.id}`);
    expect(invite.connectLinks[0]).not.toContain("token=");
    expect(invite.webLinks[0]).toMatch(
      /^http:\/\/catamorphic\.local:4700\/\?server=/,
    );

    const member = await server.stockAuth.createLocalUser({
      username: "memberuser",
      name: "Sam Member",
      password: "correct horse battery staple",
    });
    memberUserId = member.id;
    memberToken = await oauthAccessToken({
      username: "memberuser",
      password: "correct horse battery staple",
    });
    const redeemed = await inject(
      "POST",
      `/api/projects/${projectId}/admission/invitations/${invite.id}/redeem`,
      memberToken,
    );
    expect(redeemed.statusCode).toBe(200);
  }, 60_000);

  it("the member's /me shows the assistant and nothing more", async () => {
    const response = await inject("GET", "/api/me", memberToken);
    expect(response.statusCode).toBe(200);
    const me = response.json();
    expect(me.identity).toEqual({
      externalUserId: memberUserId,
      root: false,
    });
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

  it("project administration belongs to the manager role", async () => {
    const denied = await inject(
      "GET",
      `/api/projects/${projectId}/memberships`,
      memberToken,
    );
    expect(denied.statusCode).toBe(403);
    const listed = await inject(
      "GET",
      `/api/projects/${projectId}/memberships`,
      managerToken,
    );
    expect(listed.statusCode).toBe(200);
    expect(
      listed
        .json()
        .map(
          (membership: { externalUserId: string }) => membership.externalUserId,
        ),
    ).toEqual(expect.arrayContaining([memberUserId]));
  });

  it("revoking membership cuts project access without invalidating sign-in", async () => {
    const revoked = await inject(
      "DELETE",
      `/api/projects/${projectId}/memberships/${encodeURIComponent(memberUserId)}`,
      managerToken,
    );
    expect(revoked.statusCode).toBe(204);
    const me = await inject("GET", "/api/me", memberToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().projects).toEqual([]);
  });
});
