import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { Identity } from "@catamorphic/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { replyOf, testServerOptions } from "../test-support.js";
import { startWorkWorker } from "./worker-runtime.js";

/**
 * HTTP APIs through the gateway (ADR 0211), end to end: a logging
 * cluster's HTTP interface behind Basic auth (as ClickHouse's is), a
 * service connection holding its password on the control plane, and a
 * chat on a local-process worker whose code calls it with nothing but the
 * session's grant, found through `.work-session/env/gateway.sh`.
 */
const UPSTREAM_PASSWORD = `logs-secret-${randomUUID()}`;
const UPSTREAM_KEY = `reader:${UPSTREAM_PASSWORD}`;
const identity: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "http-gateway-test",
};

let root: string;
let server: WorkServer;
let base: string;
let projectId: string;
let upstream: http.Server;
let workerDir: string;
const received: Array<{ method: string; url: string; body: string }> = [];
const refusedUpstream: string[] = [];
const workers: Array<Awaited<ReturnType<typeof startWorkWorker>>> = [];

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

/** A logging cluster's HTTP interface: queries in the URL, rows in bodies. */
function logsApi(): http.Server {
  const expected = `Basic ${Buffer.from(UPSTREAM_KEY).toString("base64")}`;
  return http.createServer((request, response) => {
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      if (request.headers.authorization !== expected) {
        refusedUpstream.push(request.url ?? "");
        response.writeHead(401, { "content-type": "text/plain" });
        response.end("Authentication failed\n");
        return;
      }
      const body = Buffer.concat(parts).toString("utf8");
      received.push({
        method: request.method ?? "",
        url: request.url ?? "",
        body,
      });
      response.writeHead(200, { "content-type": "text/plain" });
      response.end(
        request.method === "POST" ? `inserted ${body.length}\n` : "1\n",
      );
    });
  });
}

async function waitFor(
  check: () => Promise<boolean> | boolean,
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

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-http-gateway-"));
  upstream = logsApi();
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw new Error("No upstream address");

  const gatewayFile = path.join(root, "gateway.json");
  fs.writeFileSync(
    gatewayFile,
    JSON.stringify({
      connections: [
        {
          type: "http",
          kind: "logs-cluster",
          displayName: "Logs",
          baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
          auth: { basic: true },
        },
      ],
    }),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "control-plane"),
      publicBases: [base],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_GATEWAY_CONFIG: gatewayFile,
        PATH: process.env.PATH,
      },
    }),
  );
  await server.app.listen({ port, host: "127.0.0.1" });
  const operatorSecret = fs
    .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
    .trim();
  const core = server.catamorphic.core;
  const project = await core.projects.create(identity, { name: "Service" });
  projectId = project.id;
  await core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    identity.externalUserId,
    {
      message: "Development reads the logging cluster through the gateway",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            dev: {
              pool: { pool: "dev" },
              workloads: ["agent"],
              connections: {
                logs: {
                  provider: "logs-cluster",
                  principal: "service",
                  service: "logs",
                  capabilities: ["get", "post"],
                },
              },
            },
          },
          defaultEnvironment: "dev",
        }),
        ".work/agents/developer.json": JSON.stringify({
          version: 1,
          name: "Developer",
          kind: "builtin",
          environment: { allowed: ["dev"], preferred: ["dev"] },
          connections: ["logs"],
        }),
        ".work/agents/inspector.json": JSON.stringify({
          version: 1,
          name: "Inspector",
          kind: "builtin",
          sandboxing: "contained",
          environment: { allowed: ["dev"], preferred: ["dev"] },
          connections: ["logs"],
        }),
      },
    },
  );
  // The cluster's password lives only in the control plane's vault.
  const connections = core.connections;
  if (!connections) throw new Error("Connections are unavailable");
  const created = await connections.createService({
    identity,
    name: "logs",
    providerKind: "logs-cluster",
    principalKind: "project_service",
    projectId,
  });
  const started = await connections.beginServiceAuthorization({
    identity,
    connectionId: created.id,
    redirectUri: `${base}/api/connection-authorizations/callback`,
  });
  await connections.completeAuthorization({
    identity,
    state: started.authorizationId,
    callback: { apiKey: UPSTREAM_KEY },
  });

  const enrollment = await server.operatorApp.inject({
    method: "POST",
    url: "/_work/operator/workers",
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      name: "developer",
      labels: { pool: "dev" },
      access: { everyone: true },
      trusted: true,
    }),
  });
  expect(enrollment.statusCode).toBe(201);
  workerDir = path.join(root, "developer");
  workers.push(
    await startWorkWorker({
      controlPlaneUrl: base,
      dataDir: workerDir,
      enrollmentCode: enrollment.json().code,
      execution: executionSettingsFromEnv({
        PATH: process.env.PATH,
        WORK_MAX_WORKSPACES: "2",
      }),
    }),
  );
  await waitFor(async () => {
    const machines = (
      await server.operatorApp.inject({
        method: "GET",
        url: "/_work/operator/machines",
        headers: { authorization: `Bearer ${operatorSecret}` },
      })
    ).json();
    return machines.machines.some(
      (machine: { id: string; available: boolean }) =>
        machine.id === "worker.developer" && machine.available,
    );
  }, "the development worker to connect");
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((running) => running.stop()));
  await server?.shutdown();
  upstream?.closeAllConnections();
  await new Promise((resolve) => upstream?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

describe("code in a chat's sandbox calls an HTTP API through the gateway", () => {
  const sessions = () => {
    const service = server.catamorphic.core.agentSessions;
    if (!service) throw new Error("Agent sessions are unavailable");
    return service;
  };
  const chats: string[] = [];
  const open = async (agent: string) => {
    const { id } = await sessions().create(identity, projectId, {
      agentId: `project:${projectId}:${agent}`,
      environment: "dev",
    });
    chats.push(id);
    return id;
  };
  const run = async (sessionId: string, command: string) =>
    replyOf(
      await sessions().sendMessage(
        identity,
        projectId,
        sessionId,
        `run ${command}`,
      ),
    ).content;
  /** A query as a dev server would send it: the grant read per request. */
  const query = (sql: string) =>
    `curl -sS -u "work:$(cat "$WORK_HTTP_LOGS_GRANT_FILE")" "$WORK_HTTP_LOGS/?query=${encodeURIComponent(sql)}"`;
  const gatewayFiles = () =>
    filesUnder(workerDir).filter(
      (file) =>
        file.endsWith(path.join(".work-session", "env", "gateway.sh")) ||
        file.endsWith(path.join(".work-session", "grants", "logs")),
    );
  let sessionId = "";

  it("names the alias's URL and grant file, and queries with the session's grant", async () => {
    sessionId = await open("developer");
    const named = await run(
      sessionId,
      'printf "%s\\n%s" "$WORK_HTTP_LOGS" "$WORK_HTTP_LOGS_GRANT_FILE"',
    );
    const [status, url, grantFile] = named.split("\n");
    expect(status).toBe("exit=0");
    expect(url).toBe(`${base}/api/gateway/http/logs`);
    expect(grantFile).toMatch(/\/\.work-session\/grants\/logs$/);
    expect(fs.readFileSync(grantFile ?? "", "utf8")).toMatch(/^\S+$/);

    expect(await run(sessionId, query("SELECT 1"))).toBe("exit=0\n1");
    expect(
      await run(
        sessionId,
        `curl -sS -H "x-work-grant: $(cat "$WORK_HTTP_LOGS_GRANT_FILE")" --data-binary '{"level":"info"}' "$WORK_HTTP_LOGS/?query=INSERT%20INTO%20logs%20FORMAT%20JSONEachRow"`,
      ),
    ).toBe("exit=0\ninserted 16");
    expect(received).toEqual([
      { method: "GET", url: "/?query=SELECT%201", body: "" },
      {
        method: "POST",
        url: "/?query=INSERT%20INTO%20logs%20FORMAT%20JSONEachRow",
        body: '{"level":"info"}',
      },
    ]);
    expect(refusedUpstream).toEqual([]);

    // The password is nowhere in the sandbox: not in its environment, not
    // in any file the worker holds.
    expect(await run(sessionId, "env")).not.toContain(UPSTREAM_PASSWORD);
    for (const file of filesUnder(workerDir))
      expect(fs.readFileSync(file).includes(UPSTREAM_PASSWORD), file).toBe(
        false,
      );

    // Each request is audited with its method, path and query.
    const audit = await server.catamorphic.core.db
      .selectFrom("connection_audit_events")
      .select(["action", "outcome", "metadata"])
      .where("event_type", "=", "connection.http")
      .execute();
    expect(audit.map((row) => `${row.action} ${row.outcome}`).sort()).toEqual([
      "get allowed",
      "post allowed",
    ]);
    expect(JSON.stringify(audit)).toContain("SELECT 1");
    expect(JSON.stringify(audit)).not.toContain('"level"');
  }, 120_000);

  it("lets a contained agent's code read but not write", async () => {
    const inspector = await open("inspector");
    expect(await run(inspector, query("SELECT 2"))).toBe("exit=0\n1");
    const written = await run(
      inspector,
      `curl -sS -w ' %{http_code}' -u "work:$(cat "$WORK_HTTP_LOGS_GRANT_FILE")" --data-binary 'x' "$WORK_HTTP_LOGS/?query=INSERT%20INTO%20logs"`,
    );
    expect(written).toContain("sandboxing is contained");
    expect(written).toMatch(/ 403$/);
    expect(
      received.filter((request) => request.method === "POST"),
    ).toHaveLength(1);
  }, 120_000);

  it("stops honoring the grant, and takes the files out, once the chat is closed", async () => {
    const grantFile = filesUnder(workerDir).find((file) =>
      file.endsWith(path.join(".work-session", "grants", "logs")),
    );
    if (!grantFile) throw new Error("No grant file in the sandbox");
    const grant = fs.readFileSync(grantFile, "utf8").trim();
    const select = () =>
      fetch(`${base}/api/gateway/http/logs?query=SELECT%203`, {
        headers: { authorization: `Bearer ${grant}` },
      });
    // The test may find either chat's grant: close both.
    const before = gatewayFiles().length;
    expect(before).toBeGreaterThan(0);
    for (const opened of chats)
      await sessions().close(identity, projectId, opened);
    const refused = await select();
    expect(refused.status).toBe(401);
    expect(refused.headers.get("www-authenticate")).toContain("Basic");
    await waitFor(
      () => gatewayFiles().length === 0,
      "the gateway's files to leave the sandboxes",
    );
  }, 120_000);
});
