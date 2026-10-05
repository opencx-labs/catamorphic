import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeHetznerCloud } from "@catamorphic/hetzner/testing";
import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "../server.js";
import {
  createTestDatabase,
  oauthAccessToken,
  testServerOptions,
} from "../test-support.js";
import { dedicatedName } from "../workers/machine-rules.js";
import {
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_HEADER,
} from "../workers/worker-protocol.js";

/**
 * Organization administrators manage machines through the API as the
 * operator does on the loopback listener (ADR 0204), with the same
 * handlers; members and anonymous callers cannot.
 */
const databaseUrl = process.env.DATABASE_URL;
const OPERATOR_SECRET = "machine-admin-operator-secret-with-32-characters";
const PUBLIC = "https://brain.example.test";
const IMAGE = "ghcr.io/opencx-labs/work-server:0.1.0-alpha.18";
const TOKEN = "hcloud-admin-test-token";

describe.skipIf(!databaseUrl)("machine administration (ADR 0204)", () => {
  let root: string;
  let database: Awaited<ReturnType<typeof createTestDatabase>>;
  let server: WorkServer;
  const cloud = new FakeHetznerCloud({ token: TOKEN });
  const tokens = { administrator: "", member: "" };
  let danaId: string;

  const operator = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    body?: unknown,
  ) =>
    server.operatorApp.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${OPERATOR_SECRET}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
  const api = (
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    url: string,
    token?: string,
    body?: unknown,
  ) =>
    server.app.inject({
      method,
      url,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });

  beforeAll(async () => {
    database = await createTestDatabase("work_machine_admin");
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-machine-admin-"));
    const machinesFile = path.join(root, "machines.json");
    fs.writeFileSync(
      machinesFile,
      JSON.stringify({
        classes: {
          cloud: {
            platform: "hetzner-cloud",
            serverType: "cpx41",
            location: "nbg1",
            image: "ubuntu-24.04",
            sshKeys: ["ops"],
          },
          office: { platform: "pool" },
        },
      }),
    );
    server = await createWorkServer({
      ...testServerOptions({
        dataDir: path.join(root, "control-plane"),
        publicBases: [PUBLIC],
        env: {
          DATABASE_URL: database.url,
          WORK_SECRET: "machine-admin-test-secret-with-at-least-32-chars",
          WORK_OPERATOR_SECRET: OPERATOR_SECRET,
          WORK_VAULT_KEY: Buffer.alloc(32, 9).toString("base64"),
          WORK_FAKE_AGENT: "1",
          WORK_CONTROL_PLANE_WORKLOADS: "workflow",
          WORK_AUTH_RATE_LIMIT: "off",
          WORK_MACHINES_CONFIG: machinesFile,
          WORK_HETZNER_TOKEN: TOKEN,
          WORK_VERSION: "0.1.0-alpha.18",
          PATH: process.env.PATH,
        },
      }),
      hooks: { hetzner: { fetch: cloud.fetch, sleep: async () => {} } },
    });
    for (const [username, administrator] of [
      ["ada", true],
      ["bob", false],
      ["dana", false],
    ] as const) {
      const created = await operator("POST", "/_work/operator/users", {
        username,
        name: username,
        password: `${username}-test-password`,
        email: `${username}@example.com`,
        administrator,
      });
      expect(created.statusCode).toBe(201);
      if (username === "dana") danaId = created.json().user.id;
    }
    tokens.administrator = await oauthAccessToken({
      app: server.app,
      username: "ada",
      password: "ada-test-password",
    });
    tokens.member = await oauthAccessToken({
      app: server.app,
      username: "bob",
      password: "bob-test-password",
    });
    // What a directory sweep records: Dana is in engineering.
    await sql`
      INSERT INTO work_accounts (user_id, directory_groups, directory_checked_at)
      VALUES (${danaId}, ${JSON.stringify(["eng@example.com"])}::jsonb, now())
      ON CONFLICT (user_id) DO UPDATE SET directory_groups = EXCLUDED.directory_groups
    `.execute(server.catamorphic.core.db);
  }, 120_000);

  afterAll(async () => {
    await server?.shutdown();
    await database?.drop();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("serves the install script with this server's origin and release", async () => {
    const script = await api("GET", "/api/workers/install.sh");
    expect(script.statusCode).toBe(200);
    expect(script.headers["content-type"]).toContain("text/x-shellscript");
    expect(script.body).toContain(`CONTROL_PLANE_URL='${PUBLIC}'`);
    expect(script.body).toContain(`IMAGE='${IMAGE}'`);
  });

  it("lets administrators, and only them, manage machines", async () => {
    const routes = [
      ["GET", "/api/work/machines"],
      ["GET", "/api/work/machines/workers"],
      ["POST", "/api/work/machines/workers"],
      ["PATCH", "/api/work/machines/workers/office-1"],
      ["DELETE", "/api/work/machines/workers/office-1"],
      ["GET", "/api/work/machines/rules"],
      ["PUT", "/api/work/machines/rules/desks"],
      ["DELETE", "/api/work/machines/rules/desks"],
      ["POST", "/api/work/machines/rules/reconcile"],
    ] as const;
    for (const [method, url] of routes) {
      const body = method === "GET" || method === "DELETE" ? undefined : {};
      expect((await api(method, url, undefined, body)).statusCode).toBe(401);
      const member = await api(method, url, tokens.member, body);
      expect(member.statusCode).toBe(403);
      expect(member.json().error).toContain("administrators");
    }
    expect(
      (await api("GET", "/api/work/machines/workers", "not-a-token"))
        .statusCode,
    ).toBe(401);
  });

  it("enrolls pooled machines, writes rules and reconciles, as the operator does", async () => {
    const admin = (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: string,
      body?: unknown,
    ) => api(method, url, tokens.administrator, body);

    // A pooled machine names a pool class and takes no work until a rule
    // assigns it.
    const enrolled = await admin("POST", "/api/work/machines/workers", {
      name: "office-1",
      pool: true,
      labels: { class: "office" },
    });
    expect(enrolled.statusCode).toBe(201);
    const { code } = enrolled.json();
    expect(enrolled.json().install).toBe(
      `curl -fsSL ${PUBLIC}/api/workers/install.sh | sudo sh -s -- --code ${code}`,
    );
    for (const refused of [
      { name: "office-2", pool: true, labels: { class: "cloud" } },
      { name: "office-2", pool: true },
      {
        name: "office-2",
        pool: true,
        labels: { class: "office" },
        access: { everyone: true },
      },
    ])
      expect(
        (await admin("POST", "/api/work/machines/workers", refused)).statusCode,
      ).toBe(400);
    const worker = await server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      headers: {
        [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server),
      },
      payload: { code },
    });
    expect(worker.statusCode).toBe(200);
    const workers = (await admin("GET", "/api/work/machines/workers")).json()
      .workers;
    expect(workers).toContainEqual(
      expect.objectContaining({
        name: "office-1",
        pool: true,
        state: "free",
        placement: {
          labels: { class: "office" },
          access: { nobody: true },
          trusted: false,
        },
      }),
    );
    const patched = await admin(
      "PATCH",
      "/api/work/machines/workers/office-1",
      { labels: { class: "office", rack: "a1" } },
    );
    expect(patched.statusCode).toBe(200);
    expect(patched.json().placement.labels).toEqual({
      class: "office",
      rack: "a1",
    });

    // Rules name configured classes only.
    const unknown = await admin("PUT", "/api/work/machines/rules/desks", {
      group: "eng@example.com",
      machines: "each-member",
      class: "standard-4",
    });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toContain("not configured");
    const desks = await admin("PUT", "/api/work/machines/rules/desks", {
      group: "eng@example.com",
      machines: "each-member",
      class: "cloud",
      retainDays: 3,
    });
    expect(desks.statusCode).toBe(200);
    const danaMachine = dedicatedName("desks", danaId, "cloud");
    expect(desks.json()).toMatchObject({
      rule: { class: "cloud", retainDays: 3 },
      reconcile: { created: [danaMachine], failed: [] },
    });
    expect(cloud.serverNamed(danaMachine)).toMatchObject({
      server_type: "cpx41",
      location: "nbg1",
      ssh_keys: ["ops"],
    });
    expect(cloud.serverNamed(danaMachine)?.user_data).toContain(
      "#cloud-config",
    );
    const listed = (await admin("GET", "/api/work/machines/rules")).json();
    expect(listed).toMatchObject({
      rules: { desks: { class: "cloud", retainDays: 3 } },
      status: {
        desks: { platform: "hetzner-cloud", desired: 1, starting: 1 },
      },
    });
    // The operator sees the same, through the same handlers.
    expect(
      (await operator("GET", "/_work/operator/machine-rules")).json(),
    ).toEqual(listed);
    expect(
      (await admin("POST", "/api/work/machines/rules/reconcile")).json(),
    ).toMatchObject({ created: [], failed: [] });
    expect(
      (await admin("GET", "/api/work/machines")).json().machines,
    ).toBeInstanceOf(Array);

    const removed = await admin("DELETE", "/api/work/machines/rules/desks");
    expect(removed.statusCode).toBe(200);
    // Never enrolled: it goes with its rule.
    expect(removed.json().reconcile.removed).toEqual([danaMachine]);
    expect(cloud.serverNamed(danaMachine)).toBeUndefined();
    expect(
      (await admin("DELETE", "/api/work/machines/rules/desks")).statusCode,
    ).toBe(404);

    expect(
      (await admin("DELETE", "/api/work/machines/workers/office-1")).json(),
    ).toEqual({ ok: true });
    expect(
      (await admin("GET", "/api/work/machines/workers")).json().workers,
    ).toContainEqual(
      expect.objectContaining({ name: "office-1", state: "revoked" }),
    );
  });
});
