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
import {
  createTestDatabase,
  enqueue,
  filesHolding,
  filesUnder,
  replyOf,
  testServerOptions,
} from "../test-support.js";
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
  externalUserId: "work-setup-agent",
};

let root: string;
let server: WorkServer;
let base: string;
let projectId: string;
let workerDir: string;
let upstream: http.Server;
let database: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
const extraServers: WorkServer[] = [];
const SHARED_SECRET = "model-takeover-test-secret-with-at-least-32-characters";
const SHARED_OPERATOR_SECRET =
  "model-takeover-operator-secret-at-least-32-characters";
const SHARED_VAULT_KEY = Buffer.alloc(32, 7).toString("base64");
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
  if (process.env.DATABASE_URL)
    database = await createTestDatabase("model_takeover");
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
        ...(database
          ? {
              DATABASE_URL: database.url,
              WORK_SECRET: SHARED_SECRET,
              WORK_OPERATOR_SECRET: SHARED_OPERATOR_SECRET,
              WORK_VAULT_KEY: SHARED_VAULT_KEY,
            }
          : {}),
        WORK_FAKE_AGENT: "1",
        WORK_CONTROL_PLANE_WORKLOADS: "workflow",
        WORK_GATEWAY_CONFIG: gatewayFile,
        PATH: process.env.PATH,
      },
    }),
    hooks: { connectionGuards: [nightGuard] },
  });
  await server.app.listen({ port, host: "127.0.0.1" });
  const operatorSecret = database
    ? SHARED_OPERATOR_SECRET
    : fs
        .readFileSync(
          path.join(root, "control-plane", "operator-secret"),
          "utf8",
        )
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
        WORK_SANDBOX: "local-process",
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
  await Promise.all(extraServers.map((entry) => entry.shutdown()));
  await server?.shutdown();
  await database?.drop();
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
    const answer = replyOf(
      await sessions().sendMessage(
        identity,
        projectId,
        sessionId,
        "run: printf 'edited by claude code' > notes.md && cat notes.md",
      ),
    );
    expect(answer.content).toContain("Done: edited by claude code");
    // The file is in the sandbox on the worker, not on the control plane.
    const notes = filesUnder(workerDir).find(
      (file) => path.basename(file) === "notes.md",
    );
    if (!notes) throw new Error("notes.md is not in the worker's sandbox");
    expect(fs.readFileSync(notes, "utf8")).toBe("edited by claude code");

    // The CLI's whole transcript is stored with Work by the time the turn
    // settled, the line it writes after its result included (ADR 0198).
    const db = server.catamorphic.core.db;
    const thread = await db
      .selectFrom("agent_provider_threads")
      .select(["id", "native_ref"])
      .where("session_id", "=", sessionId)
      .executeTakeFirstOrThrow();
    const ref = thread.native_ref;
    const nativeId =
      ref && typeof ref === "object" && !Array.isArray(ref) ? ref.id : null;
    const transcript = filesUnder(workerDir).find(
      (file) => path.basename(file) === `${String(nativeId)}.jsonl`,
    );
    if (!transcript) throw new Error("The CLI wrote no transcript");
    const written = fs
      .readFileSync(transcript, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line): unknown => JSON.parse(line));
    const stored = await db
      .selectFrom("agent_provider_thread_entries")
      .select("entry")
      .where("thread_id", "=", thread.id)
      .where("subpath", "=", "")
      .orderBy("seq")
      .execute();
    expect(written.at(-1)).toMatchObject({ subtype: "turn_duration" });
    expect(stored).toHaveLength(written.length);
    expect(stored.map((row) => row.entry)).toEqual(written);

    // Both model calls went through the gateway with the organization's key.
    expect(upstreamKeys).toEqual([REAL_KEY, REAL_KEY]);
    expect(upstreamBodies[0]).toContain("claude-test");

    // Usage: the harness reported the turn, and the gateway counted each call.
    expect(answer.usage).toMatchObject({
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
    const answer = replyOf(
      await sessions().sendMessage(identity, projectId, sessionId, "run: env"),
    );
    expect(answer.content).toContain(
      `ANTHROPIC_BASE_URL=${base}/api/gateway/model/anthropic`,
    );
    expect(answer.content).not.toContain(REAL_KEY);
    expect(filesHolding(workerDir, REAL_KEY)).toEqual([]);
    const file = grantFile();
    if (!file) throw new Error("No grant file in the sandbox");
    expect(fs.readFileSync(file, "utf8").trim()).toMatch(/\S{20,}/);
  }, 120_000);

  it("refuses all model calls between turns before model policy or forwarding", async () => {
    const file = grantFile();
    if (!file) throw new Error("No grant file in the sandbox");
    const grant = fs.readFileSync(file, "utf8").trim();
    const calls = upstreamKeys.length;
    for (const model of ["gpt-5", "claude-forbidden", "claude-test"]) {
      const response = await gatewayCall(grant, model);
      expect(response.status).toBe(401);
      await response.text();
    }
    expect(upstreamKeys).toHaveLength(calls);
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
  it.skipIf(!process.env.DATABASE_URL)(
    "refreshes model authority before a surviving runner continues on a new replica",
    async () => {
      if (!database) throw new Error("A shared database is required");
      const account = await server.workAuth.createLocalUser({
        username: "reviewer",
        name: "Reviewer",
        password: "model-recovery-test-password",
      });
      const admin = { tenantId: SERVER_TENANT_ID, externalUserId: account.id };
      const core = server.catamorphic.core;
      await core.deployment.deploy(
        SERVER_TENANT_ID,
        projectId,
        identity.externalUserId,
        {
          message: "Permit the reviewer",
          files: {
            ".work/roles/reviewer.json": JSON.stringify({
              version: 1,
              name: "Reviewer",
              agents: ["coder"],
              environments: ["build"],
              connections: [
                {
                  environment: "build",
                  alias: "anthropic",
                  capabilities: ["model"],
                },
              ],
            }),
          },
        },
      );
      await core.memberships.grant({
        identity,
        projectId,
        externalUserId: account.id,
        roles: ["reviewer"],
      });
      const member = await core.memberships.identityFor({
        ...admin,
        projectId,
      });
      if (!member) throw new Error("Missing reviewer identity");
      const chat = await sessions().create(member, projectId, {
        agentId: `project:${projectId}:coder`,
        environment: "build",
      });
      const marker = `resume-model-${randomUUID()}`;
      const turnId = await enqueue({
        sessions: sessions(),
        identity: member,
        projectId,
        sessionId: chat.id,
        text: `run: touch ${marker}.started; while [ ! -f ${marker}.continue ]; do sleep 0.05; done; printf recovered`,
      });
      await waitFor(
        async () =>
          filesUnder(workerDir).some((file) =>
            file.endsWith(`${marker}.started`),
          ),
        "the runner's blocked command",
      );
      const before = await core.db
        .selectFrom("agent_turns")
        .selectAll()
        .where("id", "=", turnId)
        .executeTakeFirstOrThrow();
      const attemptId = before.active_attempt_id;
      if (!attemptId) throw new Error("No active attempt");
      const file = filesUnder(workerDir).find((entry) =>
        entry.endsWith(path.join("model-grants", attemptId, "anthropic")),
      );
      if (!file) throw new Error("No attempt model grant");
      const old = fs.readFileSync(file, "utf8");
      await sessions().stopLocalTurns({ timeoutMs: 10_000, handBack: "all" });
      const b = await createWorkServer({
        ...testServerOptions({
          dataDir: path.join(root, "replica-b"),
          publicBases: [base],
          env: {
            DATABASE_URL: database.url,
            WORK_SECRET: SHARED_SECRET,
            WORK_OPERATOR_SECRET: SHARED_OPERATOR_SECRET,
            WORK_VAULT_KEY: SHARED_VAULT_KEY,
            WORK_CONTROL_PLANE_WORKLOADS: "workflow",
            WORK_FAKE_AGENT: "1",
            WORK_GATEWAY_CONFIG: path.join(root, "gateway.json"),
            PATH: process.env.PATH,
          },
        }),
        hooks: { connectionGuards: [nightGuard] },
      });
      extraServers.push(b);
      await waitFor(async () => {
        const current = await core.db
          .selectFrom("agent_turns")
          .selectAll()
          .where("id", "=", turnId)
          .executeTakeFirstOrThrow();
        return (
          current.lease_token !== before.lease_token &&
          current.active_attempt_id === attemptId &&
          fs.readFileSync(file, "utf8") !== old
        );
      }, "the new replica's grant publication");
      const current = await core.db
        .selectFrom("agent_turns")
        .selectAll()
        .where("id", "=", turnId)
        .executeTakeFirstOrThrow();
      expect(current.active_attempt_id).toBe(attemptId);
      const refreshed = await gatewayCall(
        fs.readFileSync(file, "utf8").trim(),
        "claude-test",
      );
      expect(refreshed.status).toBe(200);
      await refreshed.text();
      expect((await gatewayCall(old.trim(), "claude-test")).status).toBe(401);
      // The same CLI makes another model call after its Bash command completes.
      const started = filesUnder(workerDir).find((entry) =>
        entry.endsWith(`${marker}.started`),
      );
      if (!started) throw new Error("Missing runner marker");
      fs.writeFileSync(started.replace(/\.started$/, ".continue"), "go");
      await waitFor(
        async () =>
          (
            await core.db
              .selectFrom("agent_turns")
              .select("status")
              .where("id", "=", turnId)
              .executeTakeFirstOrThrow()
          ).status === "completed",
        "the surviving runner to finish",
        60_000,
      );
      const attempts = await core.db
        .selectFrom("agent_turn_attempts")
        .select("id")
        .where("turn_id", "=", turnId)
        .execute();
      expect(attempts.map((entry) => entry.id)).toEqual([attemptId]);
    },
    120_000,
  );
});
