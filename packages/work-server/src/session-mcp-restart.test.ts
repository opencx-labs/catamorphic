import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, expect, it } from "vitest";
import { z } from "zod";
import { createWorkServer, type WorkServer } from "./server.js";
import { oauthAccessToken, testServerOptions } from "./test-support.js";

/**
 * A server restart loses nothing a client was told (ADR 0347): the chat a
 * start returned is found again by its idempotency key, a wait cut off by
 * the restart is retried as it was, and a task's id still names its wait.
 * Everything a caller holds (a session id, a cursor, a task id) is a name
 * for state in the database, never for a process.
 */

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-mcp-restart-"));
let server: WorkServer | undefined;

const State = z.looseObject({
  sessionId: z.string(),
  state: z.string(),
  cursor: z.string(),
  changed: z.boolean().optional(),
});

async function boot(): Promise<string> {
  server = await createWorkServer(
    testServerOptions({
      dataDir,
      publicBases: ["https://work.local:4700"],
      env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
    }),
  );
  return server.app.listen({ port: 0, host: "127.0.0.1" });
}

async function connect(base: string, token: string): Promise<Client> {
  const client = new Client(
    { name: "work-restart-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}/api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
) {
  const result = await client.callTool({ name, arguments: args });
  return State.parse(result.structuredContent);
}

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

it("keeps a chat, a wait and a task across a restart mid-turn", async () => {
  const before = await boot();
  const first = server;
  if (!first) throw new Error("The server did not start");
  const operator = (url: string, body: unknown) =>
    first.operatorApp.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${fs
          .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
          .trim()}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  const project = await operator("/_work/operator/projects", {
    name: "restart",
    roles: [
      {
        slug: "engineer",
        definition: {
          version: 1,
          name: "Engineer",
          permissions: [],
          agents: ["*"],
          workflows: [],
          apps: [],
          environments: ["default"],
          documents: [],
        },
      },
    ],
    admission: {
      mode: "invitation_only",
      defaultRole: "engineer",
      approvedDomains: [],
    },
  });
  expect(project.statusCode).toBe(201);
  const projectId: string = project.json().project.id;
  expect(
    (
      await operator("/_work/operator/users", {
        username: "engineer",
        name: "engineer",
        password: "correct horse battery staple",
        memberships: [{ projectId, roles: ["engineer"] }],
      })
    ).statusCode,
  ).toBe(201);
  const token = await oauthAccessToken({
    app: first.app,
    username: "engineer",
    password: "correct horse battery staple",
  });

  const start = {
    project: projectId,
    agent: "assistant",
    message: "[[wait 4000]] Restarted",
    idempotencyKey: randomUUID(),
  };
  const client = await connect(before, token);
  const started = await call(client, "session_start", start);
  expect(started.state).toBe("working");
  // A task for the wait, from a client that declares the extension.
  const wait = {
    sessionIds: [started.sessionId],
    cursor: started.cursor,
    timeoutSeconds: 30,
  };
  const task = await first.app.inject({
    method: "POST",
    url: "/api/mcp",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "session_wait",
    },
    payload: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "session_wait",
        arguments: wait,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientCapabilities": {
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
        },
      },
    }),
  });
  const taskId = z.string().parse(task.json().result.taskId);

  // The server goes away while the turn runs and a call waits on it.
  const cut = call(client, "session_wait", wait).then(
    (state) => state.state,
    () => "cut off",
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
  await first.shutdown();
  server = undefined;
  // The call was cut off, or answered with nothing new: never a reply
  // that was not there.
  expect(await cut).not.toBe("idle");

  const after = await boot();
  const again = await connect(after, token);
  // The same start, retried: the same chat, and no second message.
  expect((await call(again, "session_start", start)).sessionId).toBe(
    started.sessionId,
  );
  // The same wait, retried as it was, until the chat needs its caller.
  let state = await call(again, "session_wait", wait);
  for (let round = 0; round < 12 && !state.changed; round += 1)
    state = await call(again, "session_wait", {
      ...wait,
      cursor: state.cursor,
    });
  expect(state).toMatchObject({ sessionId: started.sessionId, changed: true });
  expect(["idle", "failed"]).toContain(state.state);
  // The task's id names the same wait on the server that came back.
  const found = await again.request(
    { method: "tasks/get", params: { taskId } },
    z.looseObject({ status: z.string() }),
  );
  expect(found.status).toBe("completed");
  await again.close();
}, 180_000);
