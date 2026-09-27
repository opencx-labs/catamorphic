import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { ConnectionActionGuard, Identity } from "@catamorphic/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { executionSettingsFromEnv } from "../execution-config.js";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { testServerOptions } from "../test-support.js";
import { startWorkWorker } from "./worker-runtime.js";

/**
 * Claude Code on a worker with its model through the gateway (ADR 0180),
 * end to end: a project agent of kind `claude-code` whose credentials name
 * the Environment's `anthropic` model connection runs in its sandbox on a
 * local-process worker, as a stand-in CLI speaking the Agent SDK's stdio
 * protocol. Its model calls reach a fake Anthropic API only through the
 * gateway, which alone holds the key.
 */
const REAL_KEY = `sk-ant-real-${randomUUID()}`;
const identity: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "harness-gateway-test",
};

let root: string;
let server: WorkServer;
let base: string;
let projectId: string;
let workerDir: string;
let upstream: http.Server;
const upstreamKeys: string[] = [];
const upstreamBodies: string[] = [];
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

type Json = Record<string, unknown>;
function record(value: unknown): Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/**
 * A fake Anthropic Messages API. A user message `run: <command>` gets a
 * `Bash` tool use; a tool result gets `Done: <output>`. Streams like the
 * real API, and refuses any key but the organization's.
 */
function fakeAnthropic(): http.Server {
  return http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const key = String(request.headers["x-api-key"] ?? "");
      upstreamKeys.push(key);
      upstreamBodies.push(body);
      if (key !== REAL_KEY || request.url !== "/v1/messages") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            type: "error",
            error: {
              type: "authentication_error",
              message: "invalid x-api-key",
            },
          }),
        );
        return;
      }
      const parsed = record(JSON.parse(body));
      const messages = Array.isArray(parsed.messages) ? parsed.messages : [];
      const last = record(messages.at(-1));
      const blocks = Array.isArray(last.content) ? last.content : [];
      const result = blocks
        .map(record)
        .find((block) => block.type === "tool_result");
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (event: Json) =>
        response.write(
          `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`,
        );
      send({
        type: "message_start",
        message: {
          id: `msg_${randomUUID()}`,
          model: parsed.model,
          usage: { input_tokens: 25, output_tokens: 1 },
        },
      });
      if (result) {
        send({
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        });
        send({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: `Done: ${String(result.content)}`,
          },
        });
      } else {
        const command = String(last.content).replace(/^run:\s*/, "");
        send({
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: `toolu_${randomUUID()}`,
            name: "Bash",
            input: {},
          },
        });
        send({
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify({ command }),
          },
        });
      }
      send({ type: "content_block_stop", index: 0 });
      send({ type: "message_delta", usage: { output_tokens: 11 } });
      send({ type: "message_stop" });
      response.end();
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

/** Refuses one model, like a policy on what agents may run. */
const nightGuard: ConnectionActionGuard = {
  name: "model policy",
  kinds: ["model"],
  review: async (context) =>
    record(context.input).model === "claude-forbidden"
      ? { verdict: "deny", reason: "claude-forbidden is not for agents" }
      : { verdict: "allow" },
};

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-harness-gateway-"));
  upstream = fakeAnthropic();
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw new Error("No upstream address");

  // The "image": the worker's sandboxes find `claude` on their PATH.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.copyFileSync(
    path.join(import.meta.dirname, "fake-claude-cli.ts"),
    path.join(bin, "claude"),
  );
  fs.chmodSync(path.join(bin, "claude"), 0o755);

  const gatewayFile = path.join(root, "gateway.json");
  fs.writeFileSync(
    gatewayFile,
    JSON.stringify({
      connections: [
        {
          type: "model",
          kind: "anthropic",
          displayName: "Anthropic",
          api: "anthropic",
          baseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
        },
      ],
    }),
  );
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = await createWorkServer({
    ...testServerOptions({
      dataDir: path.join(root, "control-plane"),
      publicBases: [base],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_GATEWAY_CONFIG: gatewayFile,
        PATH: process.env.PATH,
      },
    }),
    hooks: { connectionGuards: [nightGuard] },
  });
  await server.app.listen({ port, host: "127.0.0.1" });
  const operatorSecret = fs
    .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
    .trim();
  const core = server.catamorphic.core;
  const project = await core.projects.create(identity, { name: "Harnesses" });
  projectId = project.id;
  await core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    identity.externalUserId,
    {
      message: "Claude Code on the build pool",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            build: {
              pool: { pool: "build" },
              workloads: ["agent"],
              connections: {
                anthropic: {
                  provider: "anthropic",
                  principal: "service",
                  service: "anthropic",
                  model: { allow: ["claude-*"] },
                },
              },
            },
          },
          defaultEnvironment: "build",
        }),
        ".work/agents/coder.json": JSON.stringify({
          version: 1,
          name: "Coder",
          kind: "claude-code",
          model: "claude-test",
          credentials: { source: "connection", connection: "anthropic" },
          environment: { allowed: ["build"], preferred: ["build"] },
        }),
      },
    },
  );
  // The organization's key lives only in the control plane's vault.
  const connections = core.connections;
  if (!connections) throw new Error("Connections are unavailable");
  const created = await connections.createService({
    identity,
    name: "anthropic",
    providerKind: "anthropic",
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
    callback: { apiKey: REAL_KEY },
  });

  const enrollment = await server.operatorApp.inject({
    method: "POST",
    url: "/_work/operator/workers",
    headers: {
      authorization: `Bearer ${operatorSecret}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify({
      name: "builder",
      labels: { pool: "build" },
      access: { everyone: true },
      trusted: true,
    }),
  });
  expect(enrollment.statusCode).toBe(201);
  workerDir = path.join(root, "builder");
  workers.push(
    await startWorkWorker({
      controlPlaneUrl: base,
      dataDir: workerDir,
      enrollmentCode: enrollment.json().code,
      execution: executionSettingsFromEnv({
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
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
        machine.id === "worker.builder" && machine.available,
    );
  }, "the build worker to connect");
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((running) => running.stop()));
  await server?.shutdown();
  upstream?.closeAllConnections();
  await new Promise((resolve) => upstream?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

describe("Claude Code on a worker, with its model through the gateway", () => {
  let sessionId = "";
  const sessions = () => {
    const service = server.catamorphic.core.agentSessions;
    if (!service) throw new Error("Agent sessions are unavailable");
    return service;
  };
  const gatewayCall = (grant: string, model: string) =>
    fetch(`${base}/api/gateway/model/anthropic/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": grant,
      },
      body: JSON.stringify({
        model,
        max_tokens: 16,
        messages: [{ role: "user", content: "run: true" }],
      }),
    });
  const grantFile = () =>
    filesUnder(workerDir).find((file) =>
      file.endsWith(path.join(".work-session", "grants", "anthropic")),
    );

  it("edits a file and runs a command in its sandbox on the worker", async () => {
    const session = await sessions().create(identity, projectId, {
      agentId: `project:${projectId}:coder`,
      environment: "build",
    });
    sessionId = session.id;
    const answer = await sessions().sendMessage(
      identity,
      projectId,
      sessionId,
      "run: printf 'edited by claude code' > notes.md && cat notes.md",
    );
    expect(answer.content).toContain("Done: edited by claude code");
    // The file is in the sandbox on the worker, not on the control plane.
    const notes = filesUnder(workerDir).find(
      (file) => path.basename(file) === "notes.md",
    );
    if (!notes) throw new Error("notes.md is not in the worker's sandbox");
    expect(fs.readFileSync(notes, "utf8")).toBe("edited by claude code");

    // Both model calls went through the gateway with the organization's key.
    expect(upstreamKeys).toEqual([REAL_KEY, REAL_KEY]);
    expect(upstreamBodies[0]).toContain("claude-test");

    // Usage: the harness reported the turn, and the gateway counted each call.
    expect(answer.metadata?.usage).toMatchObject({
      inputTokens: 50,
      outputTokens: 22,
    });
    // Usage rows land after each answer ends, off its critical path.
    const usageRows = () =>
      server.catamorphic.core.db
        .selectFrom("model_usage")
        .selectAll()
        .where("agent_session_id", "=", sessionId)
        .execute();
    await waitFor(
      async () => (await usageRows()).length === 2,
      "the gateway's usage rows",
    );
    const usage = await usageRows();
    expect(usage).toHaveLength(2);
    expect(usage.every((row) => Number(row.output_tokens) === 11)).toBe(true);
    expect(usage.every((row) => row.turn_id !== null)).toBe(true);
    expect(usage[0]?.model).toBe("claude-test");
    const audits = () =>
      server.catamorphic.core.db
        .selectFrom("connection_audit_events")
        .select(["action", "outcome", "metadata"])
        .where("event_type", "=", "connection.model")
        .execute();
    const allowed = (rows: Awaited<ReturnType<typeof audits>>) =>
      rows.filter(
        (row) => row.action === "POST v1/messages" && row.outcome === "allowed",
      );
    await waitFor(
      async () => allowed(await audits()).length === 2,
      "the gateway's audits",
    );
    const audit = await audits();
    expect(allowed(audit)).toHaveLength(2);
    // Audits say which model was called, never what it was asked.
    expect(JSON.stringify(audit)).not.toContain("edited by claude code");
  }, 120_000);

  it("holds only the grant in the sandbox, never the key", async () => {
    const answer = await sessions().sendMessage(
      identity,
      projectId,
      sessionId,
      "run: env",
    );
    expect(answer.content).toContain(
      `ANTHROPIC_BASE_URL=${base}/api/gateway/model/anthropic`,
    );
    expect(answer.content).not.toContain(REAL_KEY);
    for (const file of filesUnder(workerDir)) {
      const content = fs.readFileSync(file);
      expect(content.includes(REAL_KEY), file).toBe(false);
    }
    const file = grantFile();
    if (!file) throw new Error("No grant file in the sandbox");
    expect(fs.readFileSync(file, "utf8").trim()).toMatch(/\S{20,}/);
  }, 120_000);

  it("refuses models outside the binding and those a guard denies", async () => {
    const file = grantFile();
    if (!file) throw new Error("No grant file in the sandbox");
    const grant = fs.readFileSync(file, "utf8").trim();
    const calls = upstreamKeys.length;
    const other = await gatewayCall(grant, "gpt-5");
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({
      type: "error",
      error: { type: "permission_error" },
    });
    const forbidden = await gatewayCall(grant, "claude-forbidden");
    expect(forbidden.status).toBe(403);
    expect(await forbidden.text()).toContain(
      "claude-forbidden is not for agents",
    );
    expect(upstreamKeys).toHaveLength(calls);
    // Between turns the grant still reaches the model: spending rules are
    // guards (ADR 0180), and the call is counted without a turn.
    const idle = await gatewayCall(grant, "claude-test");
    expect(idle.status).toBe(200);
    await idle.text();
    expect(upstreamKeys).toEqual([...upstreamKeys.slice(0, calls), REAL_KEY]);
    await waitFor(
      async () =>
        (
          await server.catamorphic.core.db
            .selectFrom("model_usage")
            .select("id")
            .where("agent_session_id", "=", sessionId)
            .where("turn_id", "is", null)
            .execute()
        ).length === 1,
      "the between-turn call's usage",
    );
  }, 60_000);

  it("stops honoring the grant once the chat is closed", async () => {
    const file = grantFile();
    if (!file) throw new Error("No grant file in the sandbox");
    const grant = fs.readFileSync(file, "utf8").trim();
    await sessions().close(identity, projectId, sessionId);
    const refused = await gatewayCall(grant, "claude-test");
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });
  }, 60_000);
});
