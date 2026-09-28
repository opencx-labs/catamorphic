import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  EnvironmentIncompatibleError,
  type Identity,
  projectPrincipalIdentity,
} from "@catamorphic/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { oauthAccessToken, testServerOptions } from "../test-support.js";
import { startWorkWorker } from "./worker-runtime.js";

/**
 * Personal credentials in a member's own sessions (ADR 0184), end to end:
 * a member's desktop sends their Claude Code login (no refresh token) and
 * the files they listed; a chat on the `claude-code` host agent runs the
 * CLI (a stand-in speaking the Agent SDK's stdio protocol) in its sandbox
 * on a worker only that member uses, with `CLAUDE_CONFIG_DIR` at their
 * login and no gateway. The files sit at their repository paths, never
 * leave the sandbox, follow the chat to another Environment, and leave
 * with it on close. Project chats, Environments without the flag, and
 * shared process machines are refused with a reason.
 */

const PASSWORD = "correct horse battery staple";
const SECRET_ENV = `API_TOKEN=personal-${crypto.randomUUID()}\n`;
const LOCAL_ENV = `DATABASE_URL=postgres://alice-${crypto.randomUUID()}\n`;
const ACCESS_TOKEN = `sk-ant-oat01-${crypto.randomUUID()}`;

const ENGINEER_ROLE = {
  version: 1,
  name: "Engineer",
  permissions: ["program:*"],
  agents: ["*"],
  workflows: ["*"],
  apps: ["*"],
  environments: ["*"],
  documents: [{ path: "store/**", access: "write" }],
};

let root: string;
let server: WorkServer;
let base: string;
let projectId: string;
const tokens: Record<"alice" | "bob", string> = { alice: "", bob: "" };
const users: Record<"alice" | "bob", string> = { alice: "", bob: "" };
const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];
const workerDirs: Record<string, string> = {};

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitFor(
  check: () => Promise<boolean>,
  what: string,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function filesUnder(directory: string): string[] {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) return [];
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
}

/** Files under a directory whose bytes contain the text. */
function holding(directory: string, text: string): string[] {
  return filesUnder(directory).filter((file) =>
    fs.readFileSync(file).includes(text),
  );
}

const operatorSecret = () =>
  fs
    .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
    .trim();

async function operator(url: string, body: unknown) {
  return server.operatorApp.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${operatorSecret()}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });
}

function claudeLogin(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: ACCESS_TOKEN,
      expiresAt: Date.now() + 8 * 60 * 60_000,
      scopes: ["user:inference"],
      subscriptionType: "max",
      ...overrides,
    },
  });
}

const claudeLoginText = claudeLogin();

async function personal(
  who: "alice" | "bob",
  method: "GET" | "PUT" | "DELETE",
  body?: unknown,
) {
  return server.app.inject({
    method,
    url: `/api/projects/${projectId}/personal-environment`,
    headers: {
      authorization: `Bearer ${tokens[who]}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { payload: JSON.stringify(body) } : {}),
  });
}

const base64 = (text: string) => Buffer.from(text).toString("base64");
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/** A command printing each file's sha256, so no secret enters the transcript. */
const hashes = (files: string[]) =>
  `for f in ${files.join(" ")}; do (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f") | cut -c1-64; done`;

async function memberIdentity(who: "alice" | "bob"): Promise<Identity> {
  const identity = await server.catamorphic.core.memberships.identityForUser({
    tenantId: SERVER_TENANT_ID,
    externalUserId: users[who],
  });
  if (!identity) throw new Error(`${who} is not a member`);
  return identity;
}

const sessions = () => {
  const service = server.catamorphic.core.agentSessions;
  if (!service) throw new Error("Agent sessions are unavailable");
  return service;
};

async function enroll(input: {
  name: string;
  labels: Record<string, string>;
  access: unknown;
  trusted?: boolean;
  bin: string;
}) {
  const enrollment = await operator("/_work/operator/workers", {
    name: input.name,
    labels: input.labels,
    access: input.access,
    ...(input.trusted ? { trusted: true } : {}),
  });
  expect(enrollment.statusCode).toBe(201);
  const dataDir = path.join(root, input.name);
  workerDirs[input.name] = dataDir;
  workers.push(
    await startWorkWorker({
      controlPlaneUrl: base,
      dataDir,
      enrollmentCode: enrollment.json().code,
      execution: executionSettingsFromEnv({
        PATH: `${input.bin}${path.delimiter}${process.env.PATH ?? ""}`,
        WORK_MAX_WORKSPACES: "4",
      }),
    }),
  );
  await waitFor(async () => {
    const machines = (
      await server.operatorApp.inject({
        method: "GET",
        url: "/_work/operator/machines",
        headers: { authorization: `Bearer ${operatorSecret()}` },
      })
    ).json();
    return machines.machines.some(
      (machine: { id: string; available: boolean }) =>
        machine.id === `worker.${input.name}` && machine.available,
    );
  }, `worker ${input.name} to connect`);
}

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-personal-"));
  // The "image": the workers' sandboxes find `claude` on their PATH.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync(
    path.join(import.meta.dirname, "fake-claude-cli.ts"),
    path.join(bin, "claude"),
  );
  fs.chmodSync(path.join(bin, "claude"), 0o755);

  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "control-plane"),
      publicBases: [base],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        PATH: process.env.PATH,
      },
    }),
  );
  await server.app.listen({ port, host: "127.0.0.1" });

  const project = await operator("/_work/operator/projects", {
    name: "personal",
    roles: [{ slug: "engineer", definition: ENGINEER_ROLE }],
    admission: {
      mode: "invitation_only",
      defaultRole: "engineer",
      approvedDomains: [],
    },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().project.id;
  for (const who of ["alice", "bob"] as const) {
    const user = await operator("/_work/operator/users", {
      username: who,
      name: who,
      email: `${who}@example.test`,
      password: PASSWORD,
      memberships: [{ projectId, roles: ["engineer"] }],
    });
    expect(user.statusCode).toBe(201);
    users[who] = user.json().user.id;
    tokens[who] = await oauthAccessToken({
      app: server.app,
      username: who,
      password: PASSWORD,
    });
  }
  const core = server.catamorphic.core;
  await core.deployment.deploy(SERVER_TENANT_ID, projectId, "operator", {
    message: "Environments for personal credentials",
    files: {
      ".work/project.json": JSON.stringify({
        environments: {
          mine: {
            pool: { pool: "alice" },
            workloads: ["agent"],
            personalCredentials: true,
          },
          mine2: {
            pool: { pool: "alice2" },
            workloads: ["agent"],
            personalCredentials: true,
          },
          shared: {
            pool: { pool: "shared" },
            workloads: ["agent"],
            personalCredentials: true,
          },
          plain: { pool: { pool: "alice" }, workloads: ["agent"] },
        },
        defaultEnvironment: "plain",
      }),
      "config/tracked.env": "TRACKED=from-the-repository\n",
    },
  });

  // Alice's own machines, and a shared one whose people trust each other.
  await enroll({
    name: "alice-box",
    labels: { pool: "alice" },
    access: { people: ["alice@example.test"] },
    bin,
  });
  await enroll({
    name: "alice-box-2",
    labels: { pool: "alice2" },
    access: { people: ["alice@example.test"] },
    bin,
  });
  await enroll({
    name: "shared-box",
    labels: { pool: "shared" },
    access: { everyone: true },
    trusted: true,
    bin,
  });
}, 180_000);

afterAll(async () => {
  await Promise.all(workers.map((running) => running.stop()));
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

describe("a member's personal environment (ADR 0184)", () => {
  it("keeps each member's logins and files to themselves", async () => {
    const put = await personal("alice", "PUT", {
      logins: { "claude-code": { credentials: claudeLoginText } },
      files: [
        { path: ".env", content: base64(SECRET_ENV) },
        { path: "apps/api/.env.local", content: base64(LOCAL_ENV) },
        { path: "config/tracked.env", content: base64("TRACKED=alice\n") },
      ],
    });
    expect(put.statusCode).toBe(200);
    const status = put.json();
    expect(status.allowed).toBe(true);
    expect(status.logins["claude-code"]).toMatchObject({
      fingerprint: expect.stringMatching(/^sha256:/),
      needsRefresh: false,
    });
    expect(status.files.map((file: { path: string }) => file.path)).toEqual([
      ".env",
      "apps/api/.env.local",
      "config/tracked.env",
    ]);
    // No value ever comes back.
    expect(JSON.stringify(status)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(status)).not.toContain("personal-");

    // Bob sees only his own (nothing), and his set never touches Alice's.
    expect((await personal("bob", "GET")).json()).toMatchObject({
      logins: {},
      files: [],
    });
    const bobs = await personal("bob", "PUT", {
      files: [{ path: ".env", content: base64("BOB=1\n") }],
    });
    expect(bobs.statusCode).toBe(200);
    const again = (await personal("alice", "GET")).json();
    expect(again.files[0]).toEqual(status.files[0]);
    expect(again.logins["claude-code"].fingerprint).toBe(
      status.logins["claude-code"].fingerprint,
    );

    // Refresh tokens and paths out of the project are refused whole.
    const refresh = await personal("alice", "PUT", {
      logins: {
        "claude-code": {
          credentials: claudeLogin({ refreshToken: "sk-ant-ort01-secret" }),
        },
      },
      files: [],
    });
    expect(refresh.statusCode).toBe(422);
    expect(refresh.json().issues[0]).toContain("refresh token");
    const climb = await personal("alice", "PUT", {
      files: [
        { path: "../outside", content: base64("x") },
        { path: ".git/config", content: base64("x") },
      ],
    });
    expect(climb.statusCode).toBe(422);
    expect(climb.json().issues).toHaveLength(2);
    expect((await personal("alice", "GET")).json().files).toHaveLength(3);

    // Stored sealed; audited by name and fingerprint only.
    const db = server.catamorphic.core.db;
    const rows = await db
      .selectFrom("personal_environment_entries")
      .selectAll()
      .execute();
    expect(JSON.stringify(rows)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(SECRET_ENV.trim());
    const audits = await db
      .selectFrom("connection_audit_events")
      .select(["event_type", "metadata", "actor_external_user_id"])
      .where("event_type", "like", "personal_environment.%")
      .execute();
    expect(audits.map((row) => row.event_type)).toContain(
      "personal_environment.replace",
    );
    expect(JSON.stringify(audits)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(audits)).not.toContain(SECRET_ENV.trim());
  }, 60_000);

  let sessionId = "";

  it("starts a chat with Claude Code on the member's own login", async () => {
    const alice = await memberIdentity("alice");
    const catalog = await sessions().catalog({ identity: alice, projectId });
    const claude = catalog.items.find(
      (item) => item.id === `project:${projectId}:claude-code`,
    );
    expect(claude?.available).toBe(true);
    expect(
      claude?.environments.items.find((item) => item.name === "mine"),
    ).toMatchObject({ personalCredentials: true, available: true });

    const session = await sessions().create(alice, projectId, {
      agentId: `project:${projectId}:claude-code`,
      environment: "mine",
    });
    sessionId = session.id;
    const report = await sessions().sendMessage(
      alice,
      projectId,
      sessionId,
      "report",
    );
    expect(JSON.parse(report.content)).toEqual({
      configDir: true,
      credentials: true,
      accessTokenSha256: sha256(ACCESS_TOKEN),
      refreshToken: false,
      baseUrl: null,
      apiKey: null,
      apiKeyHelper: false,
      // The tracked file was not replaced, and the agent was told.
      note: true,
    });

    const files = await sessions().sendMessage(
      alice,
      projectId,
      sessionId,
      `run: ${hashes([".env", "apps/api/.env.local", "config/tracked.env"])} && git status --porcelain --untracked-files=all && git check-ignore -v .env apps/api/.env.local && (stat -c %a .env 2>/dev/null || stat -f %Lp .env)`,
    );
    expect(files.content).toContain(sha256(SECRET_ENV));
    expect(files.content).toContain(sha256(LOCAL_ENV));
    // The tracked file is the repository's, not Alice's copy.
    expect(files.content).toContain(sha256("TRACKED=from-the-repository\n"));
    expect(files.content).not.toContain(sha256("TRACKED=alice\n"));
    expect(files.content).toContain(".git/info/exclude");
    expect(files.content).toContain("600");
    // Git sees nothing to commit: the files are excluded.
    expect(files.content).not.toContain("?? ");

    // Only Alice's machine holds them: no sync-back, checkpoint, or session
    // branch on the control plane carries them.
    const box = workerDirs["alice-box"] ?? "";
    expect(holding(box, SECRET_ENV.trim()).length).toBeGreaterThan(0);
    expect(holding(box, ACCESS_TOKEN).length).toBeGreaterThan(0);
    const controlPlane = path.join(root, "control-plane");
    const outsideDatabase = (text: string) =>
      holding(controlPlane, text).filter(
        (file) => !file.startsWith(path.join(controlPlane, "db")),
      );
    expect(outsideDatabase(SECRET_ENV.trim())).toEqual([]);
    expect(outsideDatabase(LOCAL_ENV.trim())).toEqual([]);
    expect(outsideDatabase(ACCESS_TOKEN)).toEqual([]);
    // Operations forwarded to the worker drop their payload once taken.
    const forwarded = await server.catamorphic.core.db
      .selectFrom("worker_node_jobs")
      .select(["operation", "response"])
      .execute();
    expect(forwarded.length).toBeGreaterThan(0);
    expect(JSON.stringify(forwarded)).not.toContain(ACCESS_TOKEN);
    expect(JSON.stringify(forwarded)).not.toContain(base64(SECRET_ENV));
    for (const other of ["alice-box-2", "shared-box"])
      expect(holding(workerDirs[other] ?? "", SECRET_ENV.trim())).toEqual([]);

    const delivered = await server.catamorphic.core.db
      .selectFrom("connection_audit_events")
      .select("metadata")
      .where("event_type", "=", "personal_environment.deliver")
      .execute();
    expect(delivered).toHaveLength(1);
    expect(JSON.stringify(delivered[0]?.metadata)).toContain(
      "config/tracked.env",
    );
  }, 120_000);

  it("follows the chat to another Environment", async () => {
    const alice = await memberIdentity("alice");
    await sessions().update(alice, projectId, sessionId, {
      environment: "mine2",
    });
    const moved = await sessions().sendMessage(
      alice,
      projectId,
      sessionId,
      `run: ${hashes([".env", '"$CLAUDE_CONFIG_DIR/.credentials.json"'])}`,
    );
    expect(moved.content).toContain(sha256(SECRET_ENV));
    expect(moved.content).toContain(sha256(claudeLoginText));
    expect(
      holding(workerDirs["alice-box-2"] ?? "", SECRET_ENV.trim()).length,
    ).toBeGreaterThan(0);
  }, 120_000);

  it("fails a turn readably when the login expired", async () => {
    const alice = await memberIdentity("alice");
    const put = await personal("alice", "PUT", {
      logins: {
        "claude-code": {
          credentials: claudeLogin({ expiresAt: Date.now() - 60_000 }),
        },
      },
      files: [{ path: ".env", content: base64(SECRET_ENV) }],
    });
    expect(put.statusCode).toBe(200);
    const failed = await sessions().sendMessage(
      alice,
      projectId,
      sessionId,
      "report",
    );
    expect(failed.content).toContain(
      "Your Claude Code login on this server has expired. Open Work on your computer so it can refresh it.",
    );
    const fresh = await personal("alice", "PUT", {
      logins: { "claude-code": { credentials: claudeLogin() } },
      files: [{ path: ".env", content: base64(SECRET_ENV) }],
    });
    expect(fresh.statusCode).toBe(200);
  }, 120_000);

  it("takes the files and the login out when the chat closes", async () => {
    const alice = await memberIdentity("alice");
    const box = workerDirs["alice-box-2"] ?? "";
    await sessions().sendMessage(alice, projectId, sessionId, "report");
    expect(holding(box, ACCESS_TOKEN).length).toBeGreaterThan(0);
    await sessions().close(alice, projectId, sessionId);
    expect(holding(box, SECRET_ENV.trim())).toEqual([]);
    expect(holding(box, ACCESS_TOKEN)).toEqual([]);
  }, 120_000);

  it("refuses Environments that do not allow it, or share a machine", async () => {
    const alice = await memberIdentity("alice");
    const agentId = `project:${projectId}:claude-code`;
    const plain = await sessions()
      .create(alice, projectId, { agentId, environment: "plain" })
      .catch((error: unknown) => error);
    expect(plain).toBeInstanceOf(EnvironmentIncompatibleError);
    expect(String((plain as Error).message)).toContain(
      `does not allow personal credentials. Add "personalCredentials": true`,
    );
    const shared = await sessions()
      .create(alice, projectId, { agentId, environment: "shared" })
      .catch((error: unknown) => error);
    expect(shared).toBeInstanceOf(EnvironmentIncompatibleError);
    expect(String((shared as Error).message)).toContain(
      "WORK_PERSONAL_CREDENTIALS=accept",
    );
  }, 60_000);

  it("refuses a project chat personal credentials", async () => {
    const principal = projectPrincipalIdentity({
      tenantId: SERVER_TENANT_ID,
      projectId,
      environment: "mine",
    });
    const refused = await sessions()
      .create(principal, projectId, {
        agentId: `project:${projectId}:claude-code`,
        environment: "mine",
      })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(Error);
    expect(String((refused as Error).message)).toMatch(
      /only a member's own chats|No machine for Environment/,
    );
  }, 60_000);

  it("continues a moved Claude Code chat on the member's own login", async () => {
    const mirror = (who: "alice" | "bob", id: string) =>
      server.app.inject({
        method: "PUT",
        url: `/api/projects/${projectId}/agent/sessions/${id}/mirror`,
        headers: {
          authorization: `Bearer ${tokens[who]}`,
          "content-type": "application/json",
        },
        payload: JSON.stringify({
          authority: { hostId: `desktop-${who}`, revision: 1 },
          provider: "claude-code",
          todos: [],
          messages: [
            {
              id: crypto.randomUUID(),
              role: "user",
              content: "Fix the flaky test",
              metadata: null,
              author: { kind: "user", externalUserId: users[who] },
              deliveryMode: "next_turn",
              idempotencyKey: null,
              createdAt: new Date().toISOString(),
            },
          ],
        }),
      });
    const aliceMoved = await mirror("alice", crypto.randomUUID());
    expect(aliceMoved.statusCode, aliceMoved.body).toBe(200);
    expect(aliceMoved.json().agentId).toBe(`project:${projectId}:claude-code`);
    expect(aliceMoved.json().agentNotice).toBeUndefined();

    const bobMoved = await mirror("bob", crypto.randomUUID());
    expect(bobMoved.statusCode, bobMoved.body).toBe(200);
    expect(bobMoved.json().agentId).toBe(`project:${projectId}:assistant`);
    expect(bobMoved.json().agentNotice).toContain(
      "your Claude Code login is not on this server yet",
    );
  }, 60_000);
});
