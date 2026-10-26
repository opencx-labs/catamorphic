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
import { filesHolding, replyOf, testServerOptions } from "../test-support.js";
import { startWorkWorker } from "./worker-runtime.js";

/**
 * An ACP agent on a worker with its model through the gateway (ADRs 0255,
 * 0256), end to end: a project agent of kind `acp` whose credentials name
 * the Environment's `openrouter` model connection runs its own command in
 * its sandbox on a local-process worker. The command is the ACP adapter's
 * test agent (a real ACP agent process over stdio), standing in for
 * `opencode acp`. Its model calls reach a fake OpenRouter only through the
 * gateway, which alone holds the key and pins the providers it may use.
 */
const REAL_KEY = `sk-or-real-${randomUUID()}`;
const identity: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "work-setup-agent",
};
const TEST_AGENT = path.join(
  import.meta.dirname,
  "../../../acp/src/__tests__/test-agent.mjs",
);

let root: string;
let server: WorkServer;
let base: string;
let projectId: string;
let workerDir: string;
let stateFile: string;
let upstream: http.Server;
const upstreamCalls: Array<{ key: string; url: string; body: string }> = [];
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

/** A fake OpenRouter: Chat Completions that answer the organization's key only. */
function fakeOpenRouter(): http.Server {
  return http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const key = String(request.headers.authorization ?? "").replace(
        /^Bearer /,
        "",
      );
      upstreamCalls.push({ key, url: request.url ?? "", body });
      if (key !== REAL_KEY || request.url !== "/api/v1/chat/completions") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: "No auth" } }));
        return;
      }
      const parsed = JSON.parse(body);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          model: parsed.model,
          choices: [
            {
              message: {
                role: "assistant",
                content: `routed to ${JSON.stringify(parsed.provider?.only)}`,
              },
            },
          ],
          usage: { prompt_tokens: 12, completion_tokens: 3 },
        }),
      );
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

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-acp-gateway-"));
  stateFile = path.join(root, "agent-state.json");
  upstream = fakeOpenRouter();
  await new Promise<void>((resolve) =>
    upstream.listen(0, "127.0.0.1", resolve),
  );
  const upstreamAddress = upstream.address();
  if (!upstreamAddress || typeof upstreamAddress === "string")
    throw new Error("No upstream address");

  // The "image": the worker's sandboxes find `opencode` on their PATH.
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, "opencode"),
    `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(TEST_AGENT)} ${JSON.stringify(stateFile)}\n`,
    { mode: 0o755 },
  );

  const gatewayFile = path.join(root, "gateway.json");
  fs.writeFileSync(
    gatewayFile,
    JSON.stringify({
      connections: [
        {
          type: "model",
          kind: "openrouter",
          displayName: "OpenRouter",
          api: "openai",
          baseUrl: `http://127.0.0.1:${upstreamAddress.port}/api/v1`,
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
    hooks: {
      // The server's own code (ADR 0261): it names the project to
      // OpenRouter and pins the providers it may route to, with zero data
      // retention, whatever an agent asks.
      modelRequestRewrites: [
        {
          name: "attribute and pin",
          kinds: ["openrouter"],
          rewrite: ({ body, context }) => ({
            ...body,
            user: `project:${context.projectId}`,
            provider: {
              only: ["provider-a", "provider-b"],
              allow_fallbacks: false,
              data_collection: "deny",
            },
          }),
        },
      ],
    },
  });
  await server.app.listen({ port, host: "127.0.0.1" });
  const operatorSecret = fs
    .readFileSync(path.join(root, "control-plane", "operator-secret"), "utf8")
    .trim();
  const core = server.catamorphic.core;
  const project = await core.projects.create(identity, { name: "Reviews" });
  projectId = project.id;
  await core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    identity.externalUserId,
    {
      message: "An OpenCode reviewer on the review pool",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            review: {
              pool: { pool: "review" },
              workloads: ["agent"],
              connections: {
                openrouter: {
                  provider: "openrouter",
                  principal: "service",
                  service: "openrouter",
                  model: { allow: ["deepseek/*"] },
                },
              },
            },
          },
          defaultEnvironment: "review",
        }),
        ".work/agents/reviewer.json": JSON.stringify({
          version: 1,
          name: "Reviewer",
          kind: "acp",
          acp: { command: ["opencode", "acp"] },
          model: "deepseek/v4-flash",
          credentials: { source: "connection", connection: "openrouter" },
          environment: { allowed: ["review"], preferred: ["review"] },
        }),
      },
    },
  );
  // The organization's key lives only in the control plane's vault.
  const connections = core.connections;
  if (!connections) throw new Error("Connections are unavailable");
  const created = await connections.createService({
    identity,
    name: "openrouter",
    providerKind: "openrouter",
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
      name: "reviewer",
      labels: { pool: "review" },
      access: { everyone: true },
      trusted: true,
    }),
  });
  expect(enrollment.statusCode).toBe(201);
  workerDir = path.join(root, "reviewer");
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
        machine.id === "worker.reviewer" && machine.available,
    );
  }, "the review worker to connect");
}, 120_000);

afterAll(async () => {
  await Promise.all(workers.map((running) => running.stop()));
  await server?.shutdown();
  upstream?.closeAllConnections();
  await new Promise((resolve) => upstream?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
}, 120_000);

describe("an ACP agent on a worker, with its model through the gateway", () => {
  const sessions = () => {
    const service = server.catamorphic.core.agentSessions;
    if (!service) throw new Error("Agent sessions are unavailable");
    return service;
  };

  it("runs its own command in its sandbox and reaches its model only through the gateway, pinned", async () => {
    const session = await sessions().create(identity, projectId, {
      agentId: `project:${projectId}:reviewer`,
      environment: "review",
    });
    const answer = replyOf(
      await sessions().sendMessage(
        identity,
        projectId,
        session.id,
        "[[model]]",
      ),
    );
    // The provider saw the organization's key, the definition's model, and
    // the providers the gateway pinned, not anything the agent chose.
    expect(answer.content).toBe(
      'Model said (200): routed to ["provider-a","provider-b"]',
    );
    expect(upstreamCalls).toHaveLength(1);
    const call = upstreamCalls[0];
    expect(call?.key).toBe(REAL_KEY);
    expect(JSON.parse(call?.body ?? "{}")).toMatchObject({
      model: "deepseek/v4-flash",
      user: `project:${projectId}`,
      provider: {
        only: ["provider-a", "provider-b"],
        allow_fallbacks: false,
        data_collection: "deny",
      },
    });

    // The agent ran in the worker's sandbox, in its workspace.
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    const [opened] = Object.values(state.sessions) as Array<{ cwd: string }>;
    expect(opened?.cwd).toBeTruthy();
    // Neither the worker's files nor the agent's hold the key.
    expect(filesHolding(workerDir, REAL_KEY)).toEqual([]);
    expect(fs.readFileSync(stateFile, "utf8")).not.toContain(REAL_KEY);

    // The gateway counted the call against the session.
    await waitFor(
      async () =>
        (
          await server.catamorphic.core.db
            .selectFrom("model_usage")
            .select("output_tokens")
            .where("agent_session_id", "=", session.id)
            .execute()
        ).some((row) => Number(row.output_tokens) === 3),
      "the gateway's usage row",
    );
  }, 120_000);
});
