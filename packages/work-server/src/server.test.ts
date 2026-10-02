import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionMirrorDivergedError } from "@catamorphic/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectAssistantId } from "./agents.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import {
  oauthAccessToken as oauthAccessTokenFor,
  say,
  testServerOptions,
} from "./test-support.js";

/**
 * The Work server end to end, on a temp data dir with the fake echo
 * agent: boot → project → invite → scoped member chats, and the scope
 * boundaries hold. Everything goes through app.inject — no ports.
 */

let dataDir: string;
let server: WorkServer;

let pwaDist: string;

const oauthAccessToken = (credentials: {
  username: string;
  password: string;
}) => oauthAccessTokenFor({ app: server.app, ...credentials });

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-server-"));
  pwaDist = fs.mkdtempSync(path.join(os.tmpdir(), "work-pwa-dist-"));
  fs.writeFileSync(
    path.join(pwaDist, "index.html"),
    "<!doctype html><title>pwa-stub</title>",
  );
  fs.writeFileSync(
    path.join(pwaDist, "manifest.webmanifest"),
    JSON.stringify({ name: "Work", start_url: "/" }),
  );
  server = await createWorkServer(
    testServerOptions({
      dataDir,
      publicBases: ["http://work.local:4700"],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_PWA_DIST: pwaDist,
        PATH: process.env.PATH,
      },
    }),
  );
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
let memberInvitationId: string;
let managerToken: string;

const MEMBER_ROLE = {
  version: 1,
  name: "Member",
  agents: ["assistant"],
  environments: ["default"],
  documents: [{ path: "store/users/{user}/**", access: "write" }],
};

const MANAGER_ROLE = {
  version: 1,
  name: "Manager",
  permissions: ["program:*", "memberships:write", "roles:write"],
  agents: ["*"],
  workflows: ["*"],
  apps: ["*"],
  environments: ["default"],
  documents: [{ path: "store/**", access: "write" }],
};

describe("Work server", () => {
  it("refuses token requests with repeated or unsupported parameters", async () => {
    const token = (body: string) =>
      server.app.inject({
        method: "POST",
        url: "/api/auth/mcp/token",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: body,
      });
    const repeated = await token(
      "grant_type=authorization_code&grant_type=refresh_token&refresh_token=x",
    );
    expect(repeated.statusCode).toBe(400);
    expect(repeated.json().error).toBe("invalid_request");
    const empty = await token(
      "grant_type=refresh_token&refresh_token=&refresh_token=x",
    );
    expect(empty.json().error).toBe("invalid_request");
    const missing = await token("grant_type=refresh_token");
    expect(missing.json().error).toBe("invalid_request");
    const other = await token("grant_type=client_credentials");
    expect(other.json().error).toBe("unsupported_grant_type");
  });

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
      resource: "http://work.local:4700/api",
      authorization_servers: expect.any(Array),
    });
  });
  it("reports health and chat availability", async () => {
    const response = await inject("GET", "/healthz");
    expect(response.json()).toMatchObject({
      ok: true,
      agentSessions: true,
      machine: {
        id: expect.stringMatching(/^node\./),
        label: "Work server",
      },
    });
  });

  it("serves the PWA at its root, SPA-falling back on unknown paths", async () => {
    const root = await inject("GET", "/");
    expect(root.statusCode).toBe(200);
    expect(root.body).toContain("pwa-stub");
    const deep = await inject("GET", "/anything/else");
    expect(deep.body).toContain("pwa-stub");
    const launch = "/?server=https%3A%2F%2Fexample.test%2Fapi&project=p-1";
    const manifest = await inject(
      "GET",
      `/manifest.webmanifest?launch=${encodeURIComponent(launch)}`,
    );
    expect(manifest.json()).toMatchObject({ start_url: launch });
    const externalManifest = await inject(
      "GET",
      "/manifest.webmanifest?launch=https%3A%2F%2Fevil.example%2F",
    );
    expect(externalManifest.json()).toMatchObject({ start_url: "/" });
  });

  it("rejects unauthenticated and unknown-token API calls", async () => {
    const missing = await inject("GET", "/api/me");
    expect(missing.statusCode).toBe(401);
    expect(missing.headers["www-authenticate"]).toContain(
      'resource_metadata="http://work.local:4700/.well-known/oauth-protected-resource"',
    );
    const invalid = await inject("GET", "/api/me", "nope");
    expect(invalid.statusCode).toBe(401);
    expect(invalid.headers["www-authenticate"]).toContain(
      'error="invalid_token"',
    );
  });

  it("receives webhooks without an account and runs project automations (ADR 0156)", async () => {
    const kinds = server.catamorphic.core.triggers
      .listKinds()
      .map((kind) => kind.name);
    expect(kinds).toEqual(expect.arrayContaining(["webhook", "schedule"]));
    // The intake is public: a sender has no account, only the URL.
    const unknown = await server.app.inject({
      method: "POST",
      url: "/api/hooks/00000000-0000-4000-8000-000000000001/support/token",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json()).toEqual({
      error: "No workflow listens on this webhook",
    });
  });

  it("resolves an OAuth access token to the current authenticated user", async () => {
    const user = await server.workAuth.createLocalUser({
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
      "/_work/operator/projects",
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
      "/_work/operator/projects",
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
      "/_work/operator/users",
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
    memberInvitationId = invite.id;
    expect(invite.connectLinks[0]).toContain(
      "work://connect?server=http%3A%2F%2Fwork.local%3A4700%2Fapi",
    );
    expect(invite.connectLinks[0]).toContain(`project=${projectId}`);
    expect(invite.connectLinks[0]).toContain(`invitation=${invite.id}`);
    expect(invite.connectLinks[0]).not.toContain("token=");
    expect(invite.webLinks[0]).toMatch(/^http:\/\/work\.local:4700\/\?server=/);

    const member = await server.workAuth.createLocalUser({
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
      // A member is not an organization administrator (ADR 0172).
      controlPlanePermissions: [],
    });
    expect(me.projects).toHaveLength(1);
    expect(me.projects[0].projectId).toBe(projectId);
    expect(me.projects[0].permissions).toEqual([]);
    expect(me.projects[0].agents).toEqual(["assistant"]);
    expect(me.features.agentSessions).toBe(true);
  });

  it("the member sees project metadata without program files", async () => {
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
    expect(record.statusCode).toBe(200);
    expect(record.json().files).toEqual([]);
    expect(
      (await inject("GET", `/api/projects/${projectId}/files`, memberToken))
        .statusCode,
    ).toBe(403);
  });

  /** The member as the server resolves them: scoped by their roles. */
  const member = async () => {
    const identity = await server.catamorphic.core.memberships.identityForUser({
      tenantId: SERVER_TENANT_ID,
      externalUserId: memberUserId,
    });
    if (!identity) throw new Error("The member is not a member");
    return identity;
  };
  const sessions = () => {
    const service = server.catamorphic.core.agentSessions;
    if (!service) throw new Error("Agent sessions are unavailable");
    return service;
  };
  /** A chat as people read it, in order. */
  const contentsOf = async (sessionId: string) =>
    (await sessions().transcript(await member(), projectId, sessionId)).map(
      (message) => message.content,
    );

  it("a scoped member starts with the permitted project default", async () => {
    const bare = await sessions().create(await member(), projectId, {});
    expect(bare.agentId).toBe(projectAssistantId(projectId));
  });

  it("the member chats with the assistant end to end", async () => {
    const identity = await member();
    const created = await sessions().create(identity, projectId, {
      agentId: projectAssistantId(projectId),
    });
    const answer = await say({
      sessions: sessions(),
      identity,
      projectId,
      sessionId: created.id,
      text: "hello server",
    });
    expect(answer.content).toBe("Echo: hello server");
    expect(await contentsOf(created.id)).toEqual([
      "hello server",
      "Echo: hello server",
    ]);
  }, 60_000);

  it("mirrors a desktop session and continues it server-side (ADR 0061)", async () => {
    // The member's desktop: another host with its own copy of the chat.
    const desktopDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-desktop-"));
    const desktop = await createWorkServer(
      testServerOptions({
        dataDir: desktopDir,
        env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
      }),
    );
    try {
      const local = {
        tenantId: SERVER_TENANT_ID,
        externalUserId: memberUserId,
      };
      const desktopSessions = desktop.catamorphic.core.agentSessions;
      if (!desktopSessions) throw new Error("Desktop chat is unavailable");
      const desktopProject = await desktop.catamorphic.core.projects.create(
        local,
        { name: "Desktop" },
      );
      const chat = await desktopSessions.create(local, desktopProject.id, {});
      await say({
        sessions: desktopSessions,
        identity: local,
        projectId: desktopProject.id,
        sessionId: chat.id,
        text: "hello from the desktop",
      });
      const todos = [
        {
          id: "33333333-cccc-4ccc-8ccc-cccccccccccc",
          title: "Continue on the server",
          description:
            "Verify that the mirrored task can continue on another host.",
          status: "in_progress" as const,
        },
      ];
      const push = async (after: number | null) => ({
        authority: { hostId: "desktop:test-host", revision: 1 },
        title: "Desktop chat",
        icon: "sparkles:orange",
        source: "desktop" as const,
        todos,
        ...(await desktopSessions.mirrorExport({
          identity: local,
          projectId: desktopProject.id,
          sessionId: chat.id,
          after,
        })),
      });
      const identity = await member();
      const first = await sessions().mirror(
        identity,
        projectId,
        chat.id,
        await push(null),
      );
      // Pushing again from where the copy is adds nothing.
      const again = await sessions().mirror(
        identity,
        projectId,
        chat.id,
        await push(first.sequence),
      );
      expect(again.sequence).toBe(first.sequence);
      expect(
        (await sessions().get(identity, projectId, chat.id)).todos,
      ).toEqual(todos);
      expect(await contentsOf(chat.id)).toEqual([
        "hello from the desktop",
        "Echo: hello from the desktop",
      ]);

      // Continuing is explicit: claim authority first, then send.
      const resumed = await sessions().resume(identity, projectId, chat.id, {
        expectedAuthorityRevision: 1,
      });
      expect(resumed.authorityRevision).toBe(2);
      const answer = await say({
        sessions: sessions(),
        identity,
        projectId,
        sessionId: chat.id,
        text: "continue here",
      });
      // The server's agent was handed what happened on the desktop.
      expect(answer.content).toMatch(
        /^Echo: .*hello from the desktop.*continue here$/,
      );
      expect(await contentsOf(chat.id)).toEqual([
        "hello from the desktop",
        "Echo: hello from the desktop",
        "continue here",
        answer.content,
      ]);

      // The desktop pushes again without the server-side turns: diverged.
      await expect(
        sessions().mirror(
          identity,
          projectId,
          chat.id,
          await push(first.sequence),
        ),
      ).rejects.toBeInstanceOf(SessionMirrorDivergedError);
    } finally {
      await desktop.shutdown();
      fs.rmSync(desktopDir, { recursive: true, force: true });
    }
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
    const replay = await inject(
      "POST",
      `/api/projects/${projectId}/admission/invitations/${memberInvitationId}/redeem`,
      memberToken,
    );
    expect(replay.statusCode).toBe(404);
    expect(replay.json().error).toBe("This invitation is no longer available");
    expect(
      (await inject("GET", "/api/me", memberToken)).json().projects,
    ).toEqual([]);
  });
});
