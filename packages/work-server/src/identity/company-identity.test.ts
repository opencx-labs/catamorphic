import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "../server.js";
import { testServerOptions } from "../test-support.js";
import {
  type DirectoryAccountStatus,
  type DirectoryProvider,
  DirectoryUnavailableError,
} from "./directory.js";

/**
 * Company identity end to end (ADR 0161). A fake directory governs Better
 * Auth's local "credential" accounts, whose account id is the user id, so
 * every lifecycle path runs through the real OAuth server and token gate.
 */
class FakeDirectory implements DirectoryProvider {
  readonly providerId = "credential";
  readonly requiredGroups: string[] = [];
  readonly accounts = new Map<string, DirectoryAccountStatus>();
  unavailable = false;
  calls = 0;

  async check(args: {
    accountId: string;
    groups: readonly string[];
  }): Promise<DirectoryAccountStatus> {
    this.calls += 1;
    if (this.unavailable) throw new DirectoryUnavailableError("offline");
    const status = this.accounts.get(args.accountId) ?? {
      active: true,
      groups: [],
    };
    return status.active
      ? {
          active: true,
          groups: status.groups.filter((group) => args.groups.includes(group)),
        }
      : status;
  }
}

const PASSWORD = "correct horse battery staple";
const MEMBER_ROLE = {
  version: 1,
  name: "Member",
  agents: ["assistant"],
  environments: ["default"],
};
const ENGINEER_ROLE = {
  version: 1,
  name: "Engineer",
  permissions: ["program:read"],
  agents: ["*"],
  environments: ["default"],
};

let dataDir: string;
let server: WorkServer;
let operatorSecret: string;
let projectId: string;
const directory = new FakeDirectory();

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-identity-"));
  server = await createWorkServer({
    ...testServerOptions({
      dataDir,
      env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
    }),
    hooks: { directories: [directory] },
  });
  operatorSecret = fs
    .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
    .trim();
  const project = await operator("/_work/operator/projects", {
    name: "brain",
    roles: [
      { slug: "member", definition: MEMBER_ROLE },
      { slug: "engineer", definition: ENGINEER_ROLE },
    ],
    admission: {
      mode: "invitation_only",
      defaultRole: "member",
      directoryRoles: [{ group: "eng@example.com", roles: ["engineer"] }],
    },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().project.id;
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function operator(url: string, body: unknown) {
  return server.operatorApp.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

async function createUser(
  username: string,
  memberships: Array<{ projectId: string; roles: string[] }> = [],
): Promise<string> {
  const response = await operator("/_work/operator/users", {
    username,
    name: username,
    password: PASSWORD,
    memberships,
  });
  expect(response.statusCode).toBe(201);
  return response.json().user.id;
}

async function signIn(username: string) {
  const login = await server.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/username",
    payload: { username, password: PASSWORD },
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.headers["set-cookie"];
  const redirectUri = "http://127.0.0.1:49152/callback";
  const registered = await server.app.inject({
    method: "POST",
    url: "/api/auth/mcp/register",
    payload: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Identity test",
    },
  });
  const clientId: string = registered.json().client_id;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "identity",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorized = await server.app.inject({
    method: "GET",
    url: `/api/auth/mcp/authorize?${authorize}`,
    headers: { cookie: Array.isArray(cookie) ? cookie[0] : cookie },
  });
  const code =
    new URL(authorized.headers.location ?? "").searchParams.get("code") ?? "";
  const token = await server.app.inject({
    method: "POST",
    url: "/api/auth/mcp/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }).toString(),
  });
  return { clientId, response: token };
}

async function signedIn(username: string) {
  const { clientId, response } = await signIn(username);
  expect(response.statusCode).toBe(200);
  return {
    clientId,
    accessToken: response.json().access_token as string,
    refreshToken: response.json().refresh_token as string,
  };
}

function refresh(clientId: string, refreshToken: string) {
  return server.app.inject({
    method: "POST",
    url: "/api/auth/mcp/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    }).toString(),
  });
}

function me(accessToken: string) {
  return server.app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${accessToken}` },
  });
}

async function rolesOf(userId: string): Promise<string[]> {
  const membership = await server.catamorphic.core.db
    .selectFrom("memberships")
    .select("roles")
    .where("project_id", "=", projectId)
    .where("external_user_id", "=", userId)
    .executeTakeFirst();
  return Array.isArray(membership?.roles)
    ? membership.roles.filter((role) => typeof role === "string").sort()
    : [];
}

describe("company identity", () => {
  it("issues short-lived access tokens", async () => {
    await createUser("short");
    const { response } = await signIn("short");
    expect(response.json().expires_in).toBe(15 * 60);
  });

  it("rotates refresh tokens and revokes the whole family on reuse", async () => {
    await createUser("rotate");
    const first = await signedIn("rotate");

    const rotated = await refresh(first.clientId, first.refreshToken);
    expect(rotated.statusCode).toBe(200);
    const second = rotated.json();
    expect((await me(first.accessToken)).statusCode).toBe(401);
    expect((await me(second.access_token)).statusCode).toBe(200);

    const replay = await refresh(first.clientId, first.refreshToken);
    expect(replay.statusCode).toBe(400);
    expect(replay.json().error_description).toMatch(/reuse/);
    expect((await me(second.access_token)).statusCode).toBe(401);
    expect(
      (await refresh(first.clientId, second.refresh_token)).statusCode,
    ).toBe(400);
  });

  it("ends a session family at its maximum age", async () => {
    await createUser("aging");
    const session = await signedIn("aging");
    await server.catamorphic.core.db
      .updateTable("work_token_families")
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where("client_id", "=", session.clientId)
      .execute();
    const response = await refresh(session.clientId, session.refreshToken);
    expect(response.statusCode).toBe(400);
    expect(response.json().error_description).toMatch(/maximum age/);
  });

  it("disables a suspended account within one sweep and lets it back when restored", async () => {
    const userId = await createUser("leaver", [
      { projectId, roles: ["member"] },
    ]);
    const session = await signedIn("leaver");
    expect((await me(session.accessToken)).statusCode).toBe(200);

    directory.accounts.set(userId, { active: false, reason: "suspended" });
    const sweep = await server.accounts.sweep();
    expect(sweep.disabled).toBeGreaterThanOrEqual(1);

    expect((await me(session.accessToken)).statusCode).toBe(401);
    expect(
      (await refresh(session.clientId, session.refreshToken)).statusCode,
    ).toBe(400);
    expect((await signIn("leaver")).response.statusCode).toBe(400);
    // Memberships and history stay for audit; only authentication ends.
    expect(await rolesOf(userId)).toEqual(["member"]);

    directory.accounts.delete(userId);
    const restored = await signedIn("leaver");
    expect((await me(restored.accessToken)).statusCode).toBe(200);
  });

  it("tolerates a directory outage only within the grace window", async () => {
    const userId = await createUser("outage");
    const session = await signedIn("outage");
    const setCheckedAgo = (minutes: number) =>
      server.catamorphic.core.db
        .updateTable("work_accounts")
        .set({ directory_checked_at: new Date(Date.now() - minutes * 60_000) })
        .where("user_id", "=", userId)
        .execute();
    directory.unavailable = true;
    try {
      await setCheckedAgo(10);
      const withinGrace = await refresh(session.clientId, session.refreshToken);
      expect(withinGrace.statusCode).toBe(200);

      await setCheckedAgo(45);
      const beyondGrace = await refresh(
        session.clientId,
        withinGrace.json().refresh_token,
      );
      expect(beyondGrace.statusCode).toBe(400);
      expect(beyondGrace.json().error_description).toMatch(/directory/);
      // A new sign-in fails closed while the directory is unreachable.
      expect((await signIn("outage")).response.statusCode).toBe(400);
    } finally {
      directory.unavailable = false;
    }
  });

  it("maps directory groups to roles and removes only the roles it granted", async () => {
    const member = await createUser("engineer", [
      { projectId, roles: ["member"] },
    ]);
    const outsider = await createUser("contractor");

    directory.accounts.set(member, {
      active: true,
      groups: ["eng@example.com"],
    });
    directory.accounts.set(outsider, {
      active: true,
      groups: ["eng@example.com"],
    });
    await server.accounts.refreshStanding({ userId: member, force: true });
    await server.accounts.refreshStanding({ userId: outsider, force: true });
    expect(await rolesOf(member)).toEqual(["engineer", "member"]);
    expect(await rolesOf(outsider)).toEqual(["engineer"]);

    directory.accounts.set(member, { active: true, groups: [] });
    directory.accounts.set(outsider, { active: true, groups: [] });
    await server.accounts.refreshStanding({ userId: member, force: true });
    await server.accounts.refreshStanding({ userId: outsider, force: true });
    expect(await rolesOf(member)).toEqual(["member"]);
    expect(await rolesOf(outsider)).toEqual([]);
  });
});
