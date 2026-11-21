import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateExecutorKeyPair } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DesiredMachine } from "../machines/contract.js";
import { MemoryCloud, machinesHook } from "../machines/contract-kit.js";
import { createWorkServer, type WorkServer } from "../server.js";
import { oauthAccessToken, testServerOptions } from "../test-support.js";
import {
  WORKER_PROTOCOL,
  WORKER_PROTOCOL_HEADER,
} from "../workers/worker-protocol.js";

/**
 * Organization administrators manage machines through the API as the
 * operator does on the loopback listener (ADRs 0205, 0347), with the same
 * handlers; members and anonymous callers cannot. Which machines exist is
 * the host's plan; no route writes rules.
 */
const OPERATOR_SECRET = "machine-admin-operator-secret-with-32-characters";
const PUBLIC = "https://brain.example.test";

describe("machine administration (ADRs 0205, 0347)", () => {
  let root: string;
  let server: WorkServer;
  const cloud = new MemoryCloud();
  /** The host's plan: its own code, here a list a test edits. */
  const plan: { machines: DesiredMachine[]; fails?: string } = { machines: [] };
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
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-machine-admin-"));
    server = await createWorkServer({
      ...testServerOptions({
        dataDir: path.join(root, "control-plane"),
        publicBases: [PUBLIC],
        env: {
          WORK_OPERATOR_SECRET: OPERATOR_SECRET,
          WORK_FAKE_AGENT: "1",
          WORK_CONTROL_PLANE_WORKLOADS: "workflow",
          WORK_AUTH_RATE_LIMIT: "off",
          PATH: process.env.PATH,
        },
      }),
      hooks: {
        machines: machinesHook({
          plan: async () => {
            if (plan.fails) throw new Error(plan.fails);
            return plan.machines;
          },
          provisioner: cloud.provisioner(),
        }),
      },
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
  }, 120_000);

  afterAll(async () => {
    await server?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  }, 60_000);

  it("serves no install script: installing a machine is the host's recipe (ADR 0348)", async () => {
    // The path is no route of the server's: it falls through to the app.
    const response = await api("GET", "/api/workers/install.sh");
    expect(response.headers["content-type"]).not.toContain("shellscript");
    expect(response.body).not.toContain("WORK_WORKER_ENROLLMENT");
  });

  it("lets administrators, and only them, manage machines", async () => {
    const routes = [
      ["GET", "/api/work/machines"],
      ["GET", "/api/work/machines/workers"],
      ["POST", "/api/work/machines/workers"],
      ["PATCH", "/api/work/machines/workers/office-1"],
      ["DELETE", "/api/work/machines/workers/office-1"],
      ["POST", "/api/work/machines/plan"],
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
    // Rules are gone: policy is the host's code.
    for (const [method, url] of [
      ["PUT", "/api/work/machines/rules/desks"],
      ["POST", "/api/work/machines/rules/reconcile"],
    ] as const)
      expect(
        (await api(method, url, tokens.administrator, {})).statusCode,
      ).toBe(404);
  });

  it("enrolls machines by hand, plans now and lists every machine, as the operator does", async () => {
    const admin = (
      method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
      url: string,
      body?: unknown,
    ) => api(method, url, tokens.administrator, body);
    const workers = async () =>
      (await admin("GET", "/api/work/machines/workers")).json();

    // A machine enrolled by hand: a name, labels, and whom it is for. A
    // person is named by the email they sign in with.
    const enrolled = await admin("POST", "/api/work/machines/workers", {
      name: "office-1",
      labels: { pool: "office" },
      for: [{ email: "dana@example.com" }],
    });
    expect(enrolled.statusCode, enrolled.body).toBe(201);
    const { code } = enrolled.json();
    // The start contract; no install script comes from the server.
    expect(enrolled.json()).toMatchObject({
      controlPlaneUrl: PUBLIC,
      start: expect.stringContaining("WORK_WORKER_ENROLLMENT=<code>"),
    });
    expect(enrolled.json().install).toBeUndefined();
    for (const [refused, why] of [
      [{ name: "office-2", for: [{ email: "nobody@example.com" }] }, "email"],
      [{ name: "office-2", for: [{ group: "eng@example.com" }] }, "for"],
      [{ name: "office-2", access: { everyone: true } }, "access"],
      [{ name: "office-2", pool: true }, "pool"],
      [{ name: "office-2", labels: { node: "x" } }, "server sets"],
    ] as const) {
      const response = await admin(
        "POST",
        "/api/work/machines/workers",
        refused,
      );
      expect(response.statusCode, response.body).toBe(400);
      expect(response.json().error).toContain(why);
    }
    expect((await workers()).workers).toContainEqual(
      expect.objectContaining({
        name: "office-1",
        managed: false,
        state: "starting",
        for: [{ user: danaId }],
        labels: { pool: "office" },
        enrolledAt: null,
      }),
    );
    const worker = await server.app.inject({
      method: "POST",
      url: "/api/workers/enroll",
      headers: {
        [WORKER_PROTOCOL_HEADER]: String(WORKER_PROTOCOL.server),
      },
      payload: { code, publicKey: generateExecutorKeyPair().publicKey },
    });
    expect(worker.statusCode).toBe(200);
    const patched = await admin(
      "PATCH",
      "/api/work/machines/workers/office-1",
      { labels: { pool: "office", rack: "a1" } },
    );
    expect(patched.statusCode, patched.body).toBe(200);
    expect(patched.json().placement).toEqual({
      labels: { pool: "office", rack: "a1" },
      for: [{ user: danaId }],
      trusted: false,
    });

    // The host's plan names a machine: plan now makes it, and the listing
    // shows it beside the one enrolled by hand.
    plan.machines = [
      {
        name: "desk-dana",
        for: [{ user: danaId }],
        labels: { pool: "desk" },
        options: { size: "large" },
        reason: "Dana's desk",
      },
    ];
    const planned = await admin("POST", "/api/work/machines/plan");
    expect(planned.statusCode, planned.body).toBe(200);
    expect(planned.json()).toMatchObject({
      created: ["desk-dana"],
      failed: [],
    });
    expect(cloud.alive()).toEqual([
      expect.objectContaining({
        name: "desk-dana",
        options: { size: "large" },
      }),
    ]);
    const listed = await workers();
    expect(listed.plan).toMatchObject({ configured: true, error: null });
    expect(listed.plan.plannedAt).toEqual(expect.any(String));
    expect(listed.workers).toContainEqual(
      expect.objectContaining({
        name: "desk-dana",
        managed: true,
        state: "starting",
        ref: "memory-1",
        for: [{ user: danaId }],
        reason: "Dana's desk",
        options: { size: "large" },
      }),
    );
    // The operator sees the same, through the same handlers.
    expect(
      (await operator("GET", "/_work/operator/workers")).json().workers,
    ).toEqual(listed.workers);
    // A machine the plan made follows the plan, not a PATCH.
    const refusedPatch = await admin(
      "PATCH",
      "/api/work/machines/workers/desk-dana",
      { labels: { pool: "elsewhere" } },
    );
    expect(refusedPatch.statusCode).toBe(400);
    expect(refusedPatch.json().error).toContain("follows the machines hook");
    // And a name the plan uses cannot be enrolled by hand.
    const taken = await admin("POST", "/api/work/machines/workers", {
      name: "desk-dana",
    });
    expect(taken.statusCode).toBe(400);
    expect(taken.json().error).toContain("plan already names");

    // A plan that throws changes nothing, and the listing says why.
    plan.fails = "the directory did not answer";
    const failed = await admin("POST", "/api/work/machines/plan");
    expect(failed.json()).toMatchObject({
      planError: "plan threw: the directory did not answer",
      created: [],
    });
    expect((await workers()).plan.error).toMatchObject({
      message: "plan threw: the directory did not answer",
    });
    expect(cloud.alive()).toHaveLength(1);
    delete plan.fails;

    // Dropped from the plan, never enrolled: it is destroyed and forgotten.
    plan.machines = [];
    expect(
      (await admin("POST", "/api/work/machines/plan")).json(),
    ).toMatchObject({ released: ["desk-dana"], destroyed: ["desk-dana"] });
    expect(cloud.alive()).toHaveLength(0);
    expect((await workers()).plan.error).toBeNull();
    expect(
      (await admin("GET", "/api/work/machines")).json().machines,
    ).toBeInstanceOf(Array);

    // The plan never touched the machine enrolled by hand; revoking it is
    // an operator's or administrator's own act.
    expect(
      (await workers()).workers.map((row: { name: string }) => row.name),
    ).toEqual(["office-1"]);
    expect(
      (await admin("DELETE", "/api/work/machines/workers/office-1")).json(),
    ).toEqual({ ok: true });
    expect((await workers()).workers).toEqual([]);
  });
});
