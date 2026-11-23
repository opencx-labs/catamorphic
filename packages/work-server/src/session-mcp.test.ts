import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { createWorkServer, type WorkServer } from "./server.js";
import { oauthAccessToken, testServerOptions } from "./test-support.js";

/**
 * A member's own agent controls chats on the server (ADR 0346, 0347), end
 * to end with the official MCP client over real HTTP and the Work server's
 * real OAuth: start, wait, be asked, answer and finish, three ways (plain
 * tools, a task, a question asked of the client's person), by a client of
 * each protocol era. The fake agent's `ask <question>` makes it ask.
 */

let dataDir: string;
let server: WorkServer;
let base: string;
let projectId: string;
let member: string;

const ROLE = {
  version: 1,
  name: "Engineer",
  permissions: ["program:*"],
  agents: ["*"],
  workflows: ["*"],
  apps: ["*"],
  environments: ["default"],
  documents: [{ path: "store/**", access: "write" }],
};

const State = z.looseObject({
  sessionId: z.string(),
  state: z.string(),
  cursor: z.string(),
  changed: z.boolean().optional(),
  reply: z.string().nullable(),
  requests: z.array(z.looseObject({ requestId: z.string(), kind: z.string() })),
  error: z.looseObject({ message: z.string() }).nullable(),
});
type State = z.infer<typeof State>;

const TASKS = "io.modelcontextprotocol/tasks";
const Loose = z.looseObject({});

const operatorSecret = () =>
  fs.readFileSync(path.join(dataDir, "operator-secret"), "utf8").trim();

async function connect(options: {
  token?: string;
  mode: "auto" | "legacy";
  url?: string;
  capabilities?: Record<string, unknown>;
  /** Answers what the server asks the client's person. */
  onElicit?: (params: {
    message: string;
    requestedSchema?: unknown;
  }) => Record<string, unknown>;
}): Promise<Client> {
  const client = new Client(
    { name: "work-session-test", version: "1.0.0" },
    {
      versionNegotiation: { mode: options.mode },
      capabilities: {
        ...(options.onElicit ? { elicitation: { form: {} } } : {}),
        ...options.capabilities,
      },
    },
  );
  const onElicit = options.onElicit;
  if (onElicit)
    client.setRequestHandler("elicitation/create", async (request) =>
      z.looseObject({ action: z.enum(["accept", "decline", "cancel"]) }).parse(
        onElicit(
          z
            .looseObject({
              message: z.string(),
              requestedSchema: z.unknown().optional(),
            })
            .parse(request.params),
        ),
      ),
    );
  await client.connect(
    new StreamableHTTPClientTransport(
      new URL(options.url ?? `${base}/api/mcp`),
      {
        requestInit: {
          headers: { authorization: `Bearer ${options.token ?? member}` },
        },
      },
    ),
  );
  return client;
}

/** A tool's answer: the chat's state, or the error a failed call carries. */
async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ state: State; isError: boolean; text: string; links: string[] }> {
  const result = z
    .looseObject({
      content: z.array(z.looseObject({ type: z.string() })),
      structuredContent: z.unknown().optional(),
      isError: z.boolean().optional(),
    })
    .parse(await client.callTool({ name, arguments: args }));
  const text = z
    .string()
    .parse(result.content.find((part) => part.type === "text")?.text);
  const state = State.safeParse(result.structuredContent ?? JSON.parse(text));
  if (!state.success) throw new Error(`${name} answered ${text}`);
  return {
    state: state.data,
    isError: result.isError === true,
    text,
    links: result.content.flatMap((part) =>
      part.type === "resource_link" ? [String(part.uri)] : [],
    ),
  };
}

/** Chats a test started, closed after it: a workspace each, while open. */
const opened = new Set<string>();

async function start(client: Client, message: string) {
  const started = await call(client, "session_start", {
    project: projectId,
    agent: "assistant",
    message,
    idempotencyKey: randomUUID(),
  });
  opened.add(started.state.sessionId);
  return started;
}

/** Loop `session_wait` with the returned cursor, as a client does. */
async function waitFor(client: Client, state: State): Promise<State> {
  let cursor = state.cursor;
  for (let round = 0; round < 30; round += 1) {
    const next = (
      await call(client, "session_wait", {
        sessionIds: [state.sessionId],
        cursor,
        timeoutSeconds: 5,
      })
    ).state;
    if (next.changed) return next;
    cursor = next.cursor;
  }
  throw new Error("The chat never needed its caller");
}

/** One raw request, for what the client library has no method for. */
async function post(
  token: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  url = "/api/mcp",
) {
  return server.app.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    payload: JSON.stringify({ jsonrpc: "2.0", id: 1, ...body }),
  });
}

/**
 * `session_wait` from a client that declares the tasks extension. The
 * core client library has no task results, so this one call is raw.
 */
async function waitAsTask(sessionId: string, cursor: string) {
  const response = await post(
    member,
    {
      method: "tools/call",
      params: {
        name: "session_wait",
        arguments: { sessionIds: [sessionId], cursor },
        _meta: modernMeta({ extensions: { [TASKS]: {} } }),
      },
    },
    {
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "session_wait",
    },
  );
  expect(response.statusCode).toBe(200);
  return z.looseObject({}).parse(response.json().result);
}

const modernMeta = (capabilities: Record<string, unknown> = {}) => ({
  "io.modelcontextprotocol/protocolVersion": "2026-07-28",
  "io.modelcontextprotocol/clientInfo": { name: "raw", version: "1" },
  "io.modelcontextprotocol/clientCapabilities": capabilities,
});

beforeAll(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-session-mcp-"));
  const options = testServerOptions({
    dataDir,
    publicBases: ["https://work.local:4700"],
    env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
  });
  server = await createWorkServer({
    ...options,
    // This file signs one member in many times, with different scopes.
    config: { ...options.config, authRateLimit: false },
  });
  base = await server.app.listen({ port: 0, host: "127.0.0.1" });
  const operator = (url: string, body: unknown) =>
    server.operatorApp.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${operatorSecret()}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  const project = await operator("/_work/operator/projects", {
    name: "brain",
    roles: [{ slug: "engineer", definition: ROLE }],
    admission: {
      mode: "invitation_only",
      defaultRole: "engineer",
      approvedDomains: [],
    },
  });
  expect(project.statusCode).toBe(201);
  projectId = project.json().project.id;
  const user = await operator("/_work/operator/users", {
    username: "engineer",
    name: "engineer",
    password: "correct horse battery staple",
    memberships: [{ projectId, roles: ["engineer"] }],
  });
  expect(user.statusCode).toBe(201);
  member = await oauthAccessToken({
    app: server.app,
    username: "engineer",
    password: "correct horse battery staple",
    scope: "openid profile email offline_access",
  });
}, 120_000);

afterEach(async () => {
  if (opened.size === 0) return;
  const client = await connect({ mode: "auto" });
  for (const sessionId of opened)
    await client.callTool({
      name: "session_close",
      arguments: { sessionId, idempotencyKey: randomUUID() },
    });
  opened.clear();
  await client.close();
});

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("a member's own agent controls chats over MCP", () => {
  it("serves the current protocol and tells a client how to work", async () => {
    const client = await connect({ mode: "auto" });
    expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");
    // The first 512 characters stand alone for clients that read no more.
    const instructions = client.getInstructions() ?? "";
    expect(instructions.slice(0, 512)).toContain("session_start");
    expect(instructions.slice(0, 512)).toContain("session_wait");
    expect(instructions.slice(0, 512)).toContain("idempotencyKey");
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        "project_list",
        "session_start",
        "session_send",
        "session_wait",
        "session_read",
        "session_answer",
        "session_interrupt",
        "session_close",
        "session_list",
      ]),
    );
    // One naming style, and nothing left of the old surface.
    for (const tool of tools) {
      expect(tool.name).toMatch(/^[a-z]+(_[a-z]+)+$/);
      expect(tool.title).toBeTruthy();
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
    expect(tools.map((tool) => tool.name)).not.toContain("ask_agent");
    expect(
      tools.find((tool) => tool.name === "session_wait")?.annotations,
    ).toMatchObject({ readOnlyHint: true, idempotentHint: true });
    const projects = z
      .looseObject({
        structuredContent: z.looseObject({
          projects: z.array(
            z.looseObject({
              id: z.string(),
              agents: z.array(z.looseObject({ id: z.string() })),
            }),
          ),
        }),
      })
      .parse(await client.callTool({ name: "project_list", arguments: {} }));
    expect(projects.structuredContent.projects).toMatchObject([
      { id: projectId, name: "brain" },
    ]);
    expect(
      projects.structuredContent.projects[0]?.agents.length,
    ).toBeGreaterThan(0);
    await client.close();
  }, 60_000);

  it("starts, waits, is asked, answers and finishes with plain tools", async () => {
    const client = await connect({ mode: "auto" });
    const started = await start(client, "ask Which branch?");
    expect(started.state).toMatchObject({ state: "working", reply: null });
    // The result links the chat's resource.
    expect(started.links).toEqual([
      `work://sessions/${started.state.sessionId}`,
    ]);
    const asked = await waitFor(client, started.state);
    expect(asked).toMatchObject({
      state: "needs_input",
      requests: [{ kind: "question" }],
      // A top-level chat that asks needs its person, like any other.
      attentionRequired: true,
    });
    // Its person is told: the notification the phone and the desktop show.
    await expect
      .poll(
        async () =>
          (
            await server.catamorphic.core.db
              .selectFrom("user_notification_events")
              .select("kind")
              .where("session_id", "=", asked.sessionId)
              .execute()
          ).map((event) => event.kind),
        { timeout: 10_000 },
      )
      .toContain("agent_question");
    // And the chats that need them are one resource to read.
    const attention = await client.readResource({ uri: "work://attention" });
    expect(
      z.looseObject({ text: z.string() }).parse(attention.contents[0]).text,
    ).toContain(asked.sessionId);
    const answered = await call(client, "session_answer", {
      sessionId: asked.sessionId,
      requestId: asked.requests[0]?.requestId,
      response: { kind: "question", answers: ["main"] },
      idempotencyKey: randomUUID(),
    });
    const done = await waitFor(client, answered.state);
    expect(done.state).toBe("idle");
    expect(done.reply).toContain("main");
    // The chat is a resource a client can read.
    const resource = await client.readResource({
      uri: `work://sessions/${done.sessionId}`,
    });
    expect(
      State.parse(
        JSON.parse(
          z.looseObject({ text: z.string() }).parse(resource.contents[0]).text,
        ),
      ),
    ).toMatchObject({ sessionId: done.sessionId, state: "idle" });
    await client.close();
  }, 120_000);

  it("gives one chat to a start repeated with its key, and says a failure as a state", async () => {
    const client = await connect({ mode: "auto" });
    const args = {
      project: projectId,
      agent: "assistant",
      message: "[[fail the model said no]]",
      idempotencyKey: randomUUID(),
    };
    const [first, second] = await Promise.all([
      call(client, "session_start", args),
      call(client, "session_start", args),
    ]);
    opened.add(first.state.sessionId);
    expect(second.state.sessionId).toBe(first.state.sessionId);
    const failed = await waitFor(client, first.state);
    expect(failed).toMatchObject({
      state: "failed",
      error: { message: expect.stringContaining("the model said no") },
    });
    // The same key for another call is refused as a tool error with a code.
    const conflict = await client.callTool({
      name: "session_start",
      arguments: { ...args, message: "something else" },
    });
    expect(conflict.isError).toBe(true);
    expect(
      JSON.parse(
        z.looseObject({ text: z.string() }).parse(conflict.content[0]).text,
      ),
    ).toMatchObject({
      error: {
        code: "idempotency_conflict",
        retryable: false,
        sessionId: first.state.sessionId,
      },
    });
    await client.close();
  }, 120_000);

  it("runs the same loop for a client of the handshake era", async () => {
    const client = await connect({ mode: "legacy" });
    expect(client.getNegotiatedProtocolVersion()).not.toBe("2026-07-28");
    const started = await start(client, "ask Which branch?");
    const asked = await waitFor(client, started.state);
    expect(asked.state).toBe("needs_input");
    const answered = await call(client, "session_answer", {
      sessionId: asked.sessionId,
      requestId: asked.requests[0]?.requestId,
      response: { kind: "question", answers: ["legacy"] },
      idempotencyKey: randomUUID(),
    });
    const done = await waitFor(client, answered.state);
    expect(done).toMatchObject({ state: "idle" });
    expect(done.reply).toContain("legacy");
    await client.close();
  }, 120_000);

  it("asks the client's person in the same call when the client can (MRTR)", async () => {
    const asked: string[] = [];
    const client = await connect({
      mode: "auto",
      onElicit: (params) => {
        asked.push(params.message);
        expect(params.requestedSchema).toMatchObject({
          type: "object",
          required: ["answer1"],
        });
        return { action: "accept", content: { answer1: "release" } };
      },
    });
    const started = await start(client, "ask Which branch?");
    // One call: the wait asks, the client answers, the wait goes on.
    let state = (
      await call(client, "session_wait", {
        sessionIds: [started.state.sessionId],
        cursor: started.state.cursor,
        timeoutSeconds: 20,
        onInput: "ask",
      })
    ).state;
    if (state.state !== "idle") state = await waitFor(client, state);
    expect(asked).toHaveLength(1);
    expect(state.state).toBe("idle");
    expect(state.reply).toContain("release");
    await client.close();
  }, 120_000);

  it("refuses a request state that was changed, is another member's, or is old", async () => {
    const started = (await start(await connect({ mode: "auto" }), "ask Which?"))
      .state;
    const wait = (
      extra: Record<string, unknown> = {},
      token = member,
      name = "session_wait",
    ) =>
      post(
        token,
        {
          method: "tools/call",
          params: {
            name,
            arguments: {
              sessionIds: [started.sessionId],
              timeoutSeconds: 20,
              onInput: "ask",
            },
            _meta: modernMeta({ elicitation: {} }),
            ...extra,
          },
        },
        {
          "mcp-protocol-version": "2026-07-28",
          "mcp-method": "tools/call",
          "mcp-name": name,
        },
      );
    const asking = (await wait()).json().result;
    expect(asking).toMatchObject({ resultType: "input_required" });
    const [requestId] = Object.keys(asking.inputRequests);
    expect(asking.inputRequests[requestId ?? ""]).toMatchObject({
      method: "elicitation/create",
      params: { mode: "form" },
    });
    const state: string = asking.requestState;
    const retry = (requestState: string, token = member) =>
      wait(
        {
          requestState,
          inputResponses: {
            [requestId ?? ""]: {
              action: "accept",
              content: { answer1: "x" },
            },
          },
        },
        token,
      );
    // Changed in transit.
    const [body = "", mac = ""] = state.split(".");
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString("utf8")),
        exp: Date.now() + 10 ** 9,
      }),
    ).toString("base64url");
    for (const tampered of [
      `${forged}.${mac}`,
      `${body}.${mac}x`,
      "nonsense",
    ]) {
      const refused = await retry(tampered);
      expect(refused.statusCode).toBe(400);
      expect(refused.json().error).toMatchObject({ code: -32602 });
    }
    // Another member's.
    await server.operatorApp.inject({
      method: "POST",
      url: "/_work/operator/users",
      headers: {
        authorization: `Bearer ${operatorSecret()}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        username: "other",
        name: "other",
        password: "correct horse battery staple",
        memberships: [{ projectId, roles: ["engineer"] }],
      }),
    });
    const other = await oauthAccessToken({
      app: server.app,
      username: "other",
      password: "correct horse battery staple",
    });
    expect((await retry(state, other)).json().error).toMatchObject({
      code: -32602,
    });
    // The agent still waits: nothing above answered it.
    expect(
      (
        await call(await connect({ mode: "auto" }), "session_read", {
          sessionId: started.sessionId,
        })
      ).state.state,
    ).toBe("needs_input");
    // The state it was given, echoed, answers the agent.
    const done = (await retry(state)).json().result;
    expect(done.resultType).toBe("complete");
    expect(done.structuredContent).toMatchObject({ state: "idle" });
  }, 120_000);

  it("hands a client that declares tasks a durable task for a wait", async () => {
    const client = await connect({
      mode: "auto",
      capabilities: { extensions: { [TASKS]: {} } },
    });
    const started = await start(client, "ask Which branch?");
    const created = await waitAsTask(
      started.state.sessionId,
      started.state.cursor,
    );
    expect(created).toMatchObject({
      resultType: "task",
      status: "working",
      pollIntervalMs: expect.any(Number),
      ttlMs: expect.any(Number),
    });
    const taskId = z.string().parse(created.taskId);
    const get = () =>
      client.request({ method: "tasks/get", params: { taskId } }, Loose);
    // The agent asks: the task needs input, as an elicitation.
    await expect
      .poll(async () => (await get()).status, { timeout: 30_000 })
      .toBe("input_required");
    const asking = await get();
    const [key = ""] = Object.keys(
      z.record(z.string(), z.unknown()).parse(asking.inputRequests),
    );
    expect(asking.inputRequests).toMatchObject({
      [key]: { method: "elicitation/create" },
    });
    await client.request(
      {
        method: "tasks/update",
        params: {
          taskId,
          inputResponses: {
            [key]: { action: "accept", content: { answer1: "tasks" } },
          },
        },
      },
      Loose,
    );
    await expect
      .poll(async () => (await get()).status, { timeout: 30_000 })
      .toBe("completed");
    const done = await get();
    expect(done.result).toMatchObject({
      structuredContent: { state: "idle", changed: true },
    });
    // Its outcome never changes, whatever the chat does next.
    await call(client, "session_send", {
      sessionId: started.state.sessionId,
      message: "[[wait 500]] again",
      idempotencyKey: randomUUID(),
    });
    expect((await get()).result).toEqual(done.result);
    // Another member's task id is no task.
    const unknown = await post(
      member,
      {
        method: "tasks/get",
        params: { taskId: randomUUID(), _meta: modernMeta() },
      },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tasks/get" },
    );
    expect(unknown.json().error).toMatchObject({ code: -32602 });
    await client.close();
  }, 120_000);

  it("cancels a task without stopping the agent, and reports a failed turn as a completed error", async () => {
    const client = await connect({
      mode: "auto",
      capabilities: { extensions: { [TASKS]: {} } },
    });
    const wait = waitAsTask;
    const hanging = await start(client, "[[wait 6000]] slow");
    const task = await wait(hanging.state.sessionId, hanging.state.cursor);
    const taskId = z.string().parse(task.taskId);
    await client.request({ method: "tasks/cancel", params: { taskId } }, Loose);
    expect(
      await client.request({ method: "tasks/get", params: { taskId } }, Loose),
    ).toMatchObject({ status: "cancelled" });
    // The agent works on: only the watching ended.
    expect(
      (
        await call(client, "session_read", {
          sessionId: hanging.state.sessionId,
        })
      ).state.state,
    ).toBe("working");

    const failing = await start(client, "[[wait 3000]] [[fail no]]");
    const failed = await wait(failing.state.sessionId, failing.state.cursor);
    const failedId = z.string().parse(failed.taskId);
    await expect
      .poll(
        async () =>
          (
            await client.request(
              { method: "tasks/get", params: { taskId: failedId } },
              Loose,
            )
          ).status,
        { timeout: 30_000 },
      )
      .toBe("completed");
    expect(
      (
        await client.request(
          { method: "tasks/get", params: { taskId: failedId } },
          Loose,
        )
      ).result,
    ).toMatchObject({
      isError: true,
      structuredContent: { state: "failed" },
    });
    await client.close();
  }, 120_000);

  it("tells a listening client when a chat changes", async () => {
    const client = await connect({ mode: "auto" });
    const started = await start(client, "[[wait 1500]] later");
    const uri = `work://sessions/${started.state.sessionId}`;
    const updated: string[] = [];
    client.setNotificationHandler(
      "notifications/resources/updated",
      (notification) => {
        updated.push(notification.params.uri);
      },
    );
    const subscription = await client.listen({
      resourceSubscriptions: [uri, "work://sessions/not-a-chat"],
    });
    // The acknowledgement names what is watched, and only that.
    expect(subscription.honoredFilter).toMatchObject({
      resourceSubscriptions: [uri],
    });
    await expect.poll(() => updated, { timeout: 30_000 }).toContain(uri);
    await subscription.close();
    expect(await subscription.closed).toBe("local");
    await client.close();
  }, 120_000);
});

describe("the wire, as the current revision requires", () => {
  const discover = (headers: Record<string, string>, meta = modernMeta()) =>
    post(
      member,
      { method: "server/discover", params: { _meta: meta } },
      headers,
    );

  it("answers discovery with versions, capabilities and caching hints", async () => {
    const response = await discover({
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "server/discover",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().result).toMatchObject({
      resultType: "complete",
      supportedVersions: expect.arrayContaining(["2026-07-28", "2025-06-18"]),
      capabilities: { tools: {}, resources: {}, extensions: { [TASKS]: {} } },
      ttlMs: expect.any(Number),
      cacheScope: "private",
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "work" } },
    });
  });

  it("refuses headers that disagree with the body", async () => {
    const mismatched = await discover({
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
    });
    expect(mismatched.statusCode).toBe(400);
    expect(mismatched.json().error).toMatchObject({ code: -32020 });
    const missing = await discover({ "mcp-protocol-version": "2026-07-28" });
    expect(missing.statusCode).toBe(400);
    expect(missing.json().error).toMatchObject({ code: -32020 });
    const name = await post(
      member,
      {
        method: "tools/call",
        params: { name: "session_list", arguments: {}, _meta: modernMeta() },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "session_read",
      },
    );
    expect(name.statusCode).toBe(400);
    expect(name.json().error).toMatchObject({ code: -32020 });
  });

  it("names the versions it serves to a client asking for another", async () => {
    const response = await discover(
      { "mcp-protocol-version": "2027-01-01", "mcp-method": "server/discover" },
      {
        ...modernMeta(),
        "io.modelcontextprotocol/protocolVersion": "2027-01-01",
      },
    );
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toMatchObject({
      code: -32022,
      data: {
        requested: "2027-01-01",
        supported: expect.arrayContaining(["2026-07-28"]),
      },
    });
  });

  it("answers an unknown method with 404 and the removed ones are gone", async () => {
    for (const method of ["ping", "logging/setLevel", "no/such"]) {
      const response = await post(
        member,
        { method, params: { _meta: modernMeta() } },
        { "mcp-protocol-version": "2026-07-28", "mcp-method": method },
      );
      expect(response.statusCode).toBe(404);
      expect(response.json().error).toMatchObject({ code: -32601 });
    }
    // GET and DELETE belong to the era of sessions.
    for (const method of ["GET", "DELETE"] as const)
      expect(
        (
          await server.app.inject({
            method,
            url: "/api/mcp",
            headers: { authorization: `Bearer ${member}` },
          })
        ).statusCode,
      ).toBe(405);
  });
});

describe("a token holds what its person granted", () => {
  it("challenges with the scopes to ask for, and lists them", async () => {
    const anonymous = await server.app.inject({
      method: "POST",
      url: "/api/mcp",
      headers: { "content-type": "application/json" },
      payload: "{}",
    });
    expect(anonymous.statusCode).toBe(401);
    expect(String(anonymous.headers["www-authenticate"])).toContain(
      'scope="work:read sessions:run"',
    );
    const metadata = (
      await server.app.inject({
        method: "GET",
        url: "/.well-known/oauth-protected-resource",
      })
    ).json();
    expect(metadata.scopes_supported).toEqual(
      expect.arrayContaining([
        "work:read",
        "sessions:run",
        "sessions:approve",
        "documents:write",
        "program:write",
        "program:publish",
      ]),
    );
    // The authorization server says who it is in its responses (RFC 9207).
    const authorization = (
      await server.app.inject({
        method: "GET",
        url: "/.well-known/oauth-authorization-server",
      })
    ).json();
    expect(authorization.authorization_response_iss_parameter_supported).toBe(
      true,
    );
  });

  it("shows a read-only token no way to act, and steps it up", async () => {
    const reader = await oauthAccessToken({
      app: server.app,
      username: "engineer",
      password: "correct horse battery staple",
      scope: "openid offline_access work:read",
    });
    const client = await connect({ mode: "auto", token: reader });
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["session_read", "session_wait", "session_list"]),
    );
    expect(names).not.toContain("session_start");
    expect(names).not.toContain("session_answer");
    await client.close();
    const refused = await post(
      reader,
      {
        method: "tools/call",
        params: {
          name: "session_start",
          arguments: { project: projectId, message: "x", idempotencyKey: "k" },
          _meta: modernMeta(),
        },
      },
      {
        "mcp-protocol-version": "2026-07-28",
        "mcp-method": "tools/call",
        "mcp-name": "session_start",
      },
    );
    expect(refused.statusCode).toBe(403);
    const challenge = String(refused.headers["www-authenticate"]);
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain('scope="sessions:run"');
    expect(challenge).toContain("/.well-known/oauth-protected-resource");
    // The project's own endpoint narrows the same way: no document writes.
    const project = await connect({
      mode: "auto",
      token: reader,
      url: `${base}/api/projects/${projectId}/mcp`,
    });
    const projectTools = (await project.listTools()).tools.map(
      (tool) => tool.name,
    );
    expect(projectTools).toContain("documents_read");
    expect(projectTools).not.toContain("documents_write");
    expect(projectTools).not.toContain("program_deploy");
    await project.close();
  }, 120_000);

  it("narrows a client that asked for nothing to what its person left ticked", async () => {
    // A client that names no scope is offered the default set, ticked;
    // approving and full access are not in it.
    let page = "";
    const plain = await oauthAccessToken({
      app: server.app,
      username: "engineer",
      password: "correct horse battery staple",
      scope: "openid profile email offline_access",
      onConsentPage: (html) => {
        page = html;
      },
    });
    for (const scope of [
      "work:read",
      "sessions:run",
      "documents:write",
      "program:write",
      "program:publish",
    ])
      expect(page).toContain(`name="scope" value="${scope}" checked`);
    expect(page).not.toContain('value="sessions:approve"');
    expect(page).not.toContain('value="work:full"');
    const client = await connect({ mode: "auto", token: plain });
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "session_start",
    );
    // It runs chats, and cannot approve on its person's behalf.
    const started = await start(client, "ask Which branch?");
    const asked = await waitFor(client, started.state);
    const approval = await client.callTool({
      name: "session_answer",
      arguments: {
        sessionId: asked.sessionId,
        requestId: asked.requests[0]?.requestId,
        response: { kind: "approval", decision: "approved" },
        idempotencyKey: randomUUID(),
      },
    });
    expect(
      JSON.parse(
        z.looseObject({ text: z.string() }).parse(approval.content[0]).text,
      ),
    ).toMatchObject({ error: { code: "not_authorized" } });
    await client.close();

    // Unticking a scope at consent takes its tools away.
    const unticked = await oauthAccessToken({
      app: server.app,
      username: "engineer",
      password: "correct horse battery staple",
      scope: "openid profile email offline_access",
      grant: [
        "openid",
        "profile",
        "email",
        "offline_access",
        "work:read",
        "sessions:run",
        "program:write",
        "program:publish",
      ],
    });
    const project = await connect({
      mode: "auto",
      token: unticked,
      url: `${base}/api/projects/${projectId}/mcp`,
    });
    const names = (await project.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(["documents_read", "session_start"]),
    );
    expect(names).not.toContain("documents_write");
    expect(names).not.toContain("documents_delete");
    await project.close();
    // The default token, with it ticked, has them.
    const full = await connect({
      mode: "auto",
      token: plain,
      url: `${base}/api/projects/${projectId}/mcp`,
    });
    expect((await full.listTools()).tools.map((tool) => tool.name)).toContain(
      "documents_write",
    );
    await full.close();
    // Unticking everything is declining: no grant comes of it.
    await expect(
      oauthAccessToken({
        app: server.app,
        username: "engineer",
        password: "correct horse battery staple",
        scope: "work:read",
        grant: [],
      }),
    ).rejects.toThrow();
  }, 120_000);

  it("gives Work's own apps full access as their person", async () => {
    // What the desktop and the phone ask for when they sign in.
    let page = "";
    const app = await oauthAccessToken({
      app: server.app,
      username: "engineer",
      password: "correct horse battery staple",
      scope: "openid profile email offline_access work:full",
      onConsentPage: (html) => {
        page = html;
      },
    });
    // Said in plain words, to allow or deny as a whole.
    expect(page).toContain("Full access as you");
    expect(page).not.toContain('type="checkbox"');
    const rest = (url: string, payload?: unknown) =>
      server.app.inject({
        method: payload === undefined ? "GET" : "POST",
        url,
        headers: {
          authorization: `Bearer ${app}`,
          "content-type": "application/json",
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    const started = await rest(
      `/api/projects/${projectId}/agent/sessions/start`,
      {
        agent: "assistant",
        message: "ask Which branch?",
        idempotencyKey: randomUUID(),
      },
    );
    expect(started.statusCode).toBe(200);
    const sessionId: string = started.json().sessionId;
    opened.add(sessionId);
    const client = await connect({ mode: "auto", token: app });
    const asked = await waitFor(client, State.parse(started.json()));
    // The person themself may approve: the answer is refused only for
    // what the agent asked (a question), never for who gives it.
    const answered = await rest(
      `/api/projects/${projectId}/agent/sessions/${sessionId}/commands`,
      {
        type: "respond",
        commandId: randomUUID(),
        requestId: asked.requests[0]?.requestId,
        response: { kind: "approval", decision: "approved" },
      },
    );
    expect(answered.statusCode).not.toBe(403);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain(
      "session_answer",
    );
    await client.close();
  }, 120_000);

  it("holds a narrowed token to its scopes over REST as over MCP", async () => {
    const reader = await oauthAccessToken({
      app: server.app,
      username: "engineer",
      password: "correct horse battery staple",
      scope: "openid offline_access work:read",
    });
    const rest = (
      token: string,
      url: string,
      payload?: unknown,
      method: "GET" | "POST" | "PUT" = payload === undefined ? "GET" : "POST",
    ) =>
      server.app.inject({
        method,
        url,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
      });
    // A chat to read and to try to change.
    const owner = await connect({ mode: "auto" });
    const chat = await waitFor(owner, (await start(owner, "Hello")).state);
    await owner.close();
    const sessions = `/api/projects/${projectId}/agent/sessions`;
    // Reading is what it was granted.
    expect(
      (await rest(reader, `${sessions}/${chat.sessionId}`)).statusCode,
    ).toBe(200);
    // Starting, sending and creating are refused, with the scope to ask for.
    const refusals = [
      await rest(reader, `${sessions}/start`, {
        agent: "assistant",
        message: "x",
        idempotencyKey: randomUUID(),
      }),
      await rest(reader, `${sessions}/${chat.sessionId}/commands`, {
        type: "send",
        commandId: randomUUID(),
        text: "x",
      }),
      await rest(reader, `${sessions}/${chat.sessionId}/commands`, {
        type: "interrupt",
        commandId: randomUUID(),
      }),
      await rest(reader, sessions, { agentId: "assistant" }),
    ];
    for (const refused of refusals) {
      expect(refused.statusCode).toBe(403);
      expect(String(refused.headers["www-authenticate"])).toContain(
        'error="insufficient_scope", scope="sessions:run"',
      );
    }
    const project = `/api/projects/${projectId}`;
    for (const { scope, refused } of [
      {
        scope: "documents:write",
        refused: await rest(
          reader,
          `${project}/documents/content`,
          {
            path: "store/should-not-exist.md",
            content: "test",
          },
          "PUT",
        ),
      },
      {
        scope: "sessions:run",
        refused: await rest(reader, `${project}/workflows/example/runs`, {
          input: {},
        }),
      },
      {
        scope: "program:publish",
        refused: await rest(reader, `${project}/publications`, {
          path: "store/should-not-exist.md",
        }),
      },
      {
        scope: "work:full",
        refused: await rest(reader, "/api/service-connections", {}),
      },
      {
        scope: "work:full",
        refused: await rest(
          reader,
          `${sessions}/${chat.sessionId}/previews/3000/`,
        ),
      },
    ]) {
      expect(refused.statusCode).toBe(403);
      expect(String(refused.headers["www-authenticate"])).toContain(
        `error="insufficient_scope", scope="${scope}"`,
      );
    }
    expect((await rest(reader, "/api/work/me/machines")).statusCode).toBe(401);
    // The chat took none of it.
    expect(
      (await rest(reader, `${sessions}/${chat.sessionId}`)).json(),
    ).toMatchObject({
      id: chat.sessionId,
      running: false,
    });
    // A grant without reading reads nothing, on any route.
    const runner = await oauthAccessToken({
      app: server.app,
      username: "engineer",
      password: "correct horse battery staple",
      scope: "openid offline_access sessions:run",
    });
    for (const url of [
      `${sessions}/${chat.sessionId}`,
      `/api/projects/${projectId}`,
      "/api/projects",
    ]) {
      const refused = await rest(runner, url);
      expect(refused.statusCode).toBe(403);
      expect(String(refused.headers["www-authenticate"])).toContain(
        'scope="work:read"',
      );
    }
    const mcp = await post(
      runner,
      { method: "tools/list", params: { _meta: modernMeta() } },
      { "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/list" },
    );
    expect(mcp.statusCode).toBe(403);
  }, 120_000);

  it("cannot approve for its person unless they granted that", async () => {
    // Asked for, but left unticked at consent: it is not granted.
    const runner = await oauthAccessToken({
      app: server.app,
      username: "engineer",
      password: "correct horse battery staple",
      scope: "openid offline_access work:read sessions:run sessions:approve",
    });
    const client = await connect({ mode: "auto", token: runner });
    const started = await start(client, "ask Which branch?");
    const asked = await waitFor(client, started.state);
    expect(asked.state).toBe("needs_input");
    // An approval is refused for its scope before anything else is looked
    // at: this client may not give one.
    const approve = {
      sessionId: asked.sessionId,
      requestId: asked.requests[0]?.requestId,
      response: { kind: "approval", decision: "approved" },
      idempotencyKey: randomUUID(),
    };
    const code = async (answering: Client) =>
      JSON.parse(
        z.looseObject({ text: z.string() }).parse(
          (
            await answering.callTool({
              name: "session_answer",
              arguments: approve,
            })
          ).content[0],
        ).text,
      ).error.code;
    expect(await code(client)).toBe("not_authorized");
    // The person ticked it: their client may approve. Here the agent asked
    // a question, so the approval is refused for what it is, not for who
    // gives it.
    const approver = await oauthAccessToken({
      app: server.app,
      username: "engineer",
      password: "correct horse battery staple",
      scope: "openid offline_access work:read sessions:run sessions:approve",
      grant: [
        "openid",
        "offline_access",
        "work:read",
        "sessions:run",
        "sessions:approve",
      ],
    });
    const trusted = await connect({ mode: "auto", token: approver });
    expect(await code(trusted)).toBe("request_not_pending");
    await client.close();
    await trusted.close();
  }, 120_000);
});
