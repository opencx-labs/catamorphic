import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectPrincipalIdentity } from "@catamorphic/core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { oauthAccessToken, testServerOptions } from "../test-support.js";
import { startWorkWorker } from "../workers/worker-runtime.js";

/**
 * The acceptance path of ADR 0172: an administrator connects a read-only
 * replica once; a project commits a binding for its `review` Environment;
 * an unattended project chat on an enrolled worker queries the replica
 * through the gateway with no person's credential, and the worker never
 * sees the connection string.
 */
const databaseUrl = process.env.DATABASE_URL;
const suffix = randomBytes(4).toString("hex");
const schema = `replica_${suffix}`;
const reader = `replica_reader_${suffix}`;
const password = `pw${randomBytes(12).toString("hex")}`;

function readerUrl(): string {
  const url = new URL(databaseUrl ?? "postgres://localhost/test");
  url.username = reader;
  url.password = password;
  return url.toString();
}

const McpResult = z.object({
  result: z
    .object({
      tools: z.array(z.object({ name: z.string() })).optional(),
      structuredContent: z.unknown().optional(),
      isError: z.boolean().optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
});

describe.skipIf(!databaseUrl)("service connections (ADR 0172)", () => {
  const admin = new pg.Client({ connectionString: databaseUrl });
  let root: string;
  let workerDir: string;
  let server: WorkServer;
  let base: string;
  let operatorSecret: string;
  let worker: Awaited<ReturnType<typeof startWorkWorker>> | undefined;
  let adaToken: string;
  let bobToken: string;
  let connectionId: string;

  const operator = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    body?: unknown,
  ) =>
    server.operatorApp.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${operatorSecret}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
  const api = (
    method: "GET" | "POST" | "DELETE",
    url: string,
    token: string,
    body?: unknown,
  ) =>
    server.app.inject({
      method,
      url,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { payload: JSON.stringify(body) } : {}),
    });
  const authorizeWith = async (connectionString: string) => {
    const started = await api(
      "POST",
      `/api/service-connections/${connectionId}/authorize`,
      adaToken,
    );
    expect(started.statusCode).toBe(200);
    expect(started.json().challenge).toMatchObject({
      kind: "form",
      fields: [{ name: "connectionString", secret: true }],
    });
    return api("POST", "/api/connection-authorizations/complete", adaToken, {
      state: started.json().authorizationId,
      callback: { connectionString },
    });
  };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    await admin.query(
      `CREATE TABLE ${schema}.tickets AS
         SELECT n AS id, 'Refund for order ' || n AS subject
           FROM generate_series(1, 50) AS n`,
    );
    await admin.query(`CREATE ROLE ${reader} LOGIN PASSWORD '${password}'`);
    await admin.query(`GRANT USAGE ON SCHEMA ${schema} TO ${reader}`);
    await admin.query(`GRANT SELECT ON ${schema}.tickets TO ${reader}`);

    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-service-connections-"));
    const gatewayFile = path.join(root, "gateway.json");
    fs.writeFileSync(
      gatewayFile,
      JSON.stringify({
        connections: [
          {
            type: "postgres",
            kind: "prod-replica",
            displayName: "Production replica",
            poolSize: 2,
          },
        ],
      }),
    );
    server = await createWorkServer(
      testServerOptions({
        dataDir: path.join(root, "control-plane"),
        env: {
          WORK_FAKE_AGENT: "1",
          WORK_CONTROL_PLANE_WORKLOADS: "workflow",
          WORK_GATEWAY_CONFIG: gatewayFile,
          PATH: process.env.PATH,
        },
      }),
    );
    await server.app.listen({ port: 0, host: "127.0.0.1" });
    const address = server.app.server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    base = `http://127.0.0.1:${address.port}`;
    operatorSecret = fs
      .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
      .trim();

    const enrollment = await operator("POST", "/_work/operator/workers", {
      name: "reviewer",
      trusted: true,
    });
    expect(enrollment.statusCode).toBe(201);
    workerDir = path.join(root, "worker");
    worker = await startWorkWorker({
      controlPlaneUrl: base,
      dataDir: workerDir,
      enrollmentCode: enrollment.json().code,
      execution: executionSettingsFromEnv({
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: "2",
      }),
    });
    const deadline = Date.now() + 20_000;
    for (;;) {
      const machines = (
        await operator("GET", "/_work/operator/machines")
      ).json();
      if (
        machines.machines.some(
          (machine: { id: string; available: boolean }) =>
            machine.id === "worker.reviewer" && machine.available,
        )
      )
        break;
      if (Date.now() > deadline) throw new Error("The worker never connected");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 120_000);

  afterAll(async () => {
    await worker?.stop();
    await server?.shutdown();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.query(`DROP ROLE IF EXISTS ${reader}`);
    await admin.end();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it("only an organization administrator connects a service connection", async () => {
    for (const [username, administrator] of [
      ["adaadmin", true],
      ["bobmember", false],
    ] as const) {
      const created = await operator("POST", "/_work/operator/users", {
        username,
        name: username,
        password: `${username}-test-password`,
        administrator,
      });
      expect(created.statusCode).toBe(201);
    }
    adaToken = await oauthAccessToken({
      app: server.app,
      username: "adaadmin",
      password: "adaadmin-test-password",
    });
    bobToken = await oauthAccessToken({
      app: server.app,
      username: "bobmember",
      password: "bobmember-test-password",
    });
    expect(
      (await api("GET", "/api/me", adaToken)).json().identity
        .controlPlanePermissions,
    ).toEqual(["connections:read", "connections:write"]);
    expect(
      (await api("GET", "/api/me", bobToken)).json().identity
        .controlPlanePermissions,
    ).toEqual([]);
    const input = {
      name: "prod-replica",
      providerKind: "prod-replica",
      principalKind: "tenant_service",
    };
    expect(
      (await api("POST", "/api/service-connections", bobToken, input))
        .statusCode,
    ).toBe(403);
    expect(
      (await api("GET", "/api/work/administrators", bobToken)).statusCode,
    ).toBe(403);
    const administrators = await api(
      "GET",
      "/api/work/administrators",
      adaToken,
    );
    expect(administrators.json().administrators).toHaveLength(1);
    const adaId = administrators.json().administrators[0].userId;
    // The organization keeps an administrator; only the operator may remove
    // the last one.
    expect(
      (await api("DELETE", `/api/work/administrators/${adaId}`, adaToken))
        .statusCode,
    ).toBe(409);
    const providers = await api("GET", "/api/connection-providers", adaToken);
    // GitHub and the model keys are built in (ADRs 0177, 0180); the
    // gateway adds the replica.
    expect(providers.json()).toEqual([
      { kind: "github", displayName: "GitHub" },
      { kind: "anthropic", displayName: "Anthropic" },
      { kind: "openai", displayName: "OpenAI" },
      { kind: "prod-replica", displayName: "Production replica" },
    ]);
    const created = await api(
      "POST",
      "/api/service-connections",
      adaToken,
      input,
    );
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      name: "prod-replica",
      status: "pending",
    });
    connectionId = created.json().id;
    expect(
      (await api("POST", "/api/service-connections", adaToken, input))
        .statusCode,
    ).toBe(409);

    // The provider's own challenge vets the credential: a role that can
    // write is refused, a dedicated read-only role is accepted.
    expect((await authorizeWith(databaseUrl ?? "")).statusCode).toBe(409);
    const connected = await authorizeWith(readerUrl());
    expect(connected.statusCode).toBe(200);
    expect(connected.json()).toMatchObject({
      name: "prod-replica",
      status: "ready",
      capabilities: ["query", "explain", "schema"],
    });
    const listed = await api("GET", "/api/service-connections", adaToken);
    expect(listed.json()).toHaveLength(1);
    expect(listed.body).not.toContain(password);
  });

  it("an unattended project chat on a worker queries the bound replica through the gateway", async () => {
    const core = server.catamorphic.core;
    const project = await core.projects.create(
      { tenantId: SERVER_TENANT_ID, externalUserId: "work-setup-agent" },
      { name: "Support brain" },
    );
    await core.deployment.deploy(
      SERVER_TENANT_ID,
      project.id,
      "work-setup-agent",
      {
        message: "Bind the replica for reviews",
        files: {
          ".work/project.json": JSON.stringify({
            environments: {
              review: {
                workloads: ["agent"],
                pool: { plane: "worker" },
                connections: {
                  prod: {
                    provider: "prod-replica",
                    principal: "service",
                    service: "prod-replica",
                    capabilities: ["query", "schema"],
                  },
                },
              },
            },
            defaultEnvironment: "review",
          }),
          ".work/agents/reviewer.json": JSON.stringify({
            version: 1,
            name: "Reviewer",
            kind: "builtin",
            connections: ["prod"],
          }),
        },
      },
    );
    // What a project automation's run holds (ADR 0156): the project, the
    // Environment, and the consented alias; no person at all.
    const principal = projectPrincipalIdentity({
      tenantId: SERVER_TENANT_ID,
      projectId: project.id,
      environment: "review",
      connections: [{ alias: "prod" }],
    });
    const sessions = core.agentSessions;
    const grants = core.connectionGrants;
    if (!sessions || !grants) throw new Error("Agents and grants are required");
    const session = await sessions.create(principal, project.id, {
      agentId: `project:${project.id}:reviewer`,
      environment: "review",
    });
    const located = await sessions.sendMessage(
      principal,
      project.id,
      session.id,
      "execution-location",
    );
    expect(
      located.metadata?.status,
      JSON.stringify({ content: located.content, metadata: located.metadata }),
    ).not.toBe("failed");
    expect(located.content).toContain(path.join(workerDir, "sandboxes"));
    const allocation = await core.executionAllocations.get({
      identity: principal,
      allocationId: session.allocationId ?? "",
    });
    expect(allocation?.policy.connections).toEqual([
      {
        connectionId,
        alias: "prod",
        providerKind: "prod-replica",
        principalKind: "tenant_service",
        capabilities: ["query", "schema"],
      },
    ]);

    // The harness holds the grant it got when the chat was anchored (#122).
    // A long-lived chat idles past its expiry; its next turn extends that
    // same grant rather than leaving the harness with a dead bearer.
    const anchored = await core.db
      .selectFrom("connection_capability_grants")
      .select("id")
      .where("agent_session_id", "=", session.id)
      .where("channel", "=", "mcp")
      .where("revoked_at", "is", null)
      .executeTakeFirstOrThrow();
    await core.db
      .updateTable("connection_capability_grants")
      .set({ expires_at: new Date(Date.now() - 60_000) })
      .where("id", "=", anchored.id)
      .execute();
    const later = await sessions.sendMessage(
      principal,
      project.id,
      session.id,
      "execution-location",
    );
    expect(later.metadata?.status).not.toBe("failed");
    const extended = await core.db
      .selectFrom("connection_capability_grants")
      .select(["revoked_at", "expires_at"])
      .where("id", "=", anchored.id)
      .executeTakeFirstOrThrow();
    expect(extended.revoked_at).toBeNull();
    expect(new Date(extended.expires_at).getTime()).toBeGreaterThan(
      Date.now() + 30 * 60_000,
    );

    // The agent reaches the alias the way its harness does: the brokered
    // connection MCP endpoint with a short-lived, session-bound grant.
    const grant = await grants.issue({
      identity: principal,
      allocationId: allocation?.id ?? "",
      agentSessionId: session.id,
      alias: "prod",
    });
    const mcp = async (method: string, params: unknown = {}) =>
      McpResult.parse(
        (
          await server.app.inject({
            method: "POST",
            url: "/api/connection-mcp",
            headers: {
              authorization: `Bearer ${grant.token}`,
              "content-type": "application/json",
            },
            payload: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
          })
        ).json(),
      );
    const tools = await mcp("tools/list");
    expect(tools.result?.tools?.map((tool) => tool.name)).toEqual([
      "query",
      "schema",
    ]);
    const answer = await mcp("tools/call", {
      name: "query",
      arguments: {
        sql: `SELECT subject FROM ${schema}.tickets WHERE id = $1`,
        params: [7],
        purpose: "Review ticket 7",
      },
    });
    expect(answer.result?.structuredContent).toMatchObject({
      rows: [{ subject: "Refund for order 7" }],
    });
    // The binding narrowed the alias: explain was not committed.
    expect(
      (
        await mcp("tools/call", {
          name: "explain",
          arguments: { sql: "SELECT 1" },
        })
      ).error?.message,
    ).toContain("outside the connection grant");

    // The worker never saw the credential: not in its files, not in any
    // operation forwarded to it.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    walk(workerDir);
    for (const file of files) {
      expect(fs.readFileSync(file, "utf8")).not.toContain(password);
    }
    const forwarded = await core.db
      .selectFrom("remote_operations")
      .select(["operation", "response"])
      .where("executor", "=", "node:worker.reviewer")
      .execute();
    expect(JSON.stringify(forwarded)).not.toContain(password);

    // Revoking the service connection ends the alias at once.
    const revoked = await api(
      "DELETE",
      `/api/connections/${connectionId}`,
      adaToken,
    );
    expect(revoked.statusCode).toBe(204);
    const after = await server.app.inject({
      method: "POST",
      url: "/api/connection-mcp",
      headers: {
        authorization: `Bearer ${grant.token}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(after.statusCode).toBe(401);
    // Its pooled sessions closed with it.
    const deadline = Date.now() + 5_000;
    let open = -1;
    while (Date.now() < deadline) {
      open = (
        await admin.query(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE usename = $1",
          [reader],
        )
      ).rows[0]?.n;
      if (open === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(open).toBe(0);
  }, 90_000);
});
