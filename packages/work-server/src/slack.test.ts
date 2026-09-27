import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import {
  HOST_SKILLS,
  type Identity,
  projectPrincipalIdentity,
} from "@catamorphic/core";
import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "./server.js";
import { oauthAccessToken, testServerOptions } from "./test-support.js";

/**
 * Slack from project code (#117, ADR 0179), end to end on a Work server:
 * the `slack` skill's trigger library and workflows deployed as ordinary
 * project code, a fake Slack Web API behind a named-operation `http`
 * gateway connection, and recorded Slack payloads signed with a test
 * signing secret. Mentions become one project chat per thread, retries are
 * stored once, and the settled reply reaches the thread through the gateway
 * without the bot token ever reaching a workflow.
 */

const SIGNING_SECRET = "8f742231b10e8888abcd99yyyzzz85a5";
const BOT_TOKEN = `xoxb-test-${crypto.randomBytes(12).toString("hex")}`;

const SKILL = HOST_SKILLS["slack/SKILL.md"] ?? "";
const blocks = [...SKILL.matchAll(/```typescript\n([\s\S]*?)```/g)].map(
  (match) => match[1] ?? "",
);
const LIBRARY = blocks.find((source) =>
  source.startsWith("// .work/triggers/slack.ts"),
);
const WORKFLOWS = blocks.find((source) =>
  source.includes("export const postSlackReplies"),
);
const AGENT = /```json\n(\{\n {2}"version": 1,[\s\S]*?)```/.exec(SKILL)?.[1];

interface SlackCall {
  method: string;
  path: string;
  authorization: string | undefined;
  body: Record<string, unknown>;
}

const slackCalls: SlackCall[] = [];
const fakeSlack = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on("data", (chunk: Buffer) => chunks.push(chunk));
  request.on("end", () => {
    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url ?? "/", "http://slack.test");
    slackCalls.push({
      method: request.method ?? "",
      path: url.pathname,
      authorization: request.headers.authorization,
      body: text ? JSON.parse(text) : Object.fromEntries(url.searchParams),
    });
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(
      JSON.stringify(
        url.pathname === "/api/chat.postMessage"
          ? { ok: true, channel: "C1", ts: `${Date.now() / 1000}` }
          : url.pathname === "/api/conversations.replies"
            ? {
                ok: true,
                messages: [
                  {
                    user: "U0ADA",
                    text: "The release waits on the billing migration.",
                    ts: url.searchParams.get("ts"),
                  },
                ],
                has_more: false,
              }
            : { ok: false, error: "unknown_method" },
      ),
    );
  });
});

let root: string;
let server: WorkServer;
let projectId: string;
let hookUrl: string;
const setup: Identity = {
  tenantId: SERVER_TENANT_ID,
  externalUserId: "work-setup-agent",
};

const operator = (url: string, body: unknown) =>
  server.operatorApp.inject({
    method: "POST",
    url,
    headers: {
      authorization: `Bearer ${fs
        .readFileSync(path.join(root, "server", "operator-secret"), "utf8")
        .trim()}`,
      "content-type": "application/json",
    },
    payload: JSON.stringify(body),
  });

const api = (
  method: "GET" | "POST",
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

/** A request as Slack sends it: `v0:{timestamp}:{body}` signed. */
function fromSlack(payload: object, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex");
  return server.app.inject({
    method: "POST",
    url: hookUrl,
    headers: {
      "content-type": "application/json",
      "user-agent": "Slackbot 1.0 (+https://api.slack.com/robots)",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": `v0=${signature}`,
      ...headers,
    },
    payload: body,
  });
}

/** A recorded `app_mention` delivery. */
function mention(input: { id: string; ts: string; threadTs?: string }) {
  return {
    token: "deprecated-verification-token",
    team_id: "T0SLACK",
    api_app_id: "A0SLACK",
    event: {
      type: "app_mention",
      user: "U0ADA",
      text: "<@U0WORK> what is blocking the release?",
      ts: input.ts,
      ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
      channel: "C1",
      event_ts: input.ts,
    },
    type: "event_callback",
    event_id: input.id,
    event_time: 1_790_000_000,
    authorizations: [{ team_id: "T0SLACK", user_id: "U0WORK", is_bot: true }],
    is_ext_shared_channel: false,
  };
}

async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 60_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      // Say where the chain stopped: the delivery, the run, or the chat.
      const db = server.catamorphic.core.db;
      const state = {
        deliveries: await db
          .selectFrom("project_event_deliveries")
          .select(["status", "error"])
          .execute(),
        runs: await db
          .selectFrom("workflow_runs")
          .select(["workflow_name", "status", "error"])
          .where("project_id", "=", projectId)
          .execute(),
        chats: await threadChats(),
      };
      throw new Error(
        `Timed out waiting for ${what}: ${JSON.stringify(state)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

const posts = () =>
  slackCalls.filter((call) => call.path === "/api/chat.postMessage");

async function threadChats() {
  return server.catamorphic.core.db
    .selectFrom("agent_sessions")
    .select(["id", "chat_key"])
    .where("project_id", "=", projectId)
    .where("chat_key", "like", "slack:%")
    .execute();
}

beforeAll(async () => {
  if (!LIBRARY || !WORKFLOWS || !AGENT)
    throw new Error("Missing Slack skill sources");
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-slack-"));
  await new Promise<void>((resolve) =>
    fakeSlack.listen(0, "127.0.0.1", resolve),
  );
  const address = fakeSlack.address();
  if (!address || typeof address === "string") throw new Error("No address");
  const gatewayFile = path.join(root, "gateway.json");
  const action = (name: string, method: "get" | "post") => ({
    name,
    method,
    path: `/${name}`,
  });
  fs.writeFileSync(
    gatewayFile,
    JSON.stringify({
      connections: [
        {
          type: "http",
          kind: "slack",
          displayName: "Slack",
          baseUrl: `http://127.0.0.1:${address.port}/api`,
          actions: [
            action("conversations.history", "get"),
            action("conversations.replies", "get"),
            action("chat.postMessage", "post"),
            action("chat.getPermalink", "get"),
            action("users.info", "get"),
            action("search.messages", "get"),
          ],
        },
      ],
    }),
  );
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "server"),
      publicBases: ["http://work.local:4700"],
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_GATEWAY_CONFIG: gatewayFile,
        PATH: process.env.PATH,
      },
    }),
  );
  const core = server.catamorphic.core;

  // An administrator connects the bot token once, as the `slack` service
  // connection; it goes straight to the vault.
  expect(
    (
      await operator("/_work/operator/users", {
        username: "admin",
        name: "Admin",
        password: "admin-test-password",
        administrator: true,
      })
    ).statusCode,
  ).toBe(201);
  const admin = await oauthAccessToken({
    app: server.app,
    username: "admin",
    password: "admin-test-password",
  });
  const created = await api("POST", "/api/service-connections", admin, {
    name: "slack",
    providerKind: "slack",
    principalKind: "tenant_service",
  });
  expect(created.statusCode).toBe(201);
  const started = await api(
    "POST",
    `/api/service-connections/${created.json().id}/authorize`,
    admin,
  );
  expect(started.json().challenge).toMatchObject({ kind: "form" });
  const authorized = await api(
    "POST",
    "/api/connection-authorizations/complete",
    admin,
    {
      state: started.json().authorizationId,
      callback: { apiKey: BOT_TOKEN },
    },
  );
  expect(authorized.statusCode).toBe(200);
  expect(authorized.json().capabilities).toEqual([
    "conversations.history",
    "conversations.replies",
    "chat.postMessage",
    "chat.getPermalink",
    "users.info",
    "search.messages",
  ]);

  // The project: the skill's library and workflows, verbatim, and a
  // committed binding for the Environment its automations run in.
  const project = await core.projects.create(setup, { name: "Slack brain" });
  projectId = project.id;
  const deployed = await core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    setup.externalUserId,
    {
      message: "Answer Slack mentions",
      files: {
        ".work/project.json": JSON.stringify({
          environments: {
            default: {
              workloads: ["agent", "workflow"],
              connections: {
                slack: {
                  provider: "slack",
                  principal: "service",
                  service: "slack",
                  capabilities: [
                    "conversations.history",
                    "conversations.replies",
                    "users.info",
                    "chat.getPermalink",
                    "chat.postMessage",
                  ],
                },
              },
            },
          },
          defaultEnvironment: "default",
        }),
        ".work/package.json": JSON.stringify({
          name: "slack-brain",
          private: true,
          workspaces: ["workflows"],
        }),
        ".work/workflows/package.json": JSON.stringify({
          name: "@project/workflows",
          private: true,
          type: "module",
          dependencies: { "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION },
        }),
        ".work/agents/slack.json": AGENT,
        ".work/triggers/slack.ts": LIBRARY,
        ".work/workflows/src/slack.ts": WORKFLOWS,
      },
    },
  );
  expect(deployed.status, JSON.stringify(deployed)).toBe("deployed");
  const secrets = core.secrets;
  if (!secrets) throw new Error("Project secrets are unavailable");
  await secrets.upsert({
    identity: setup,
    projectId,
    name: "SLACK_SIGNING_SECRET",
    value: SIGNING_SECRET,
  });
  for (const workflowName of ["answerSlackMentions", "postSlackReplies"]) {
    const request = {
      identity: setup,
      projectId,
      workflowName,
      owner: { type: "project" as const },
    };
    const preview = await core.workflowEnablements.preview(request);
    await core.workflowEnablements.create({
      ...request,
      consentDigest: preview.consentDigest,
    });
  }
  const [endpoint] = await core.webhooks.list({ identity: setup, projectId });
  expect(endpoint).toMatchObject({
    name: "slack",
    listening: true,
    verified: true,
  });
  hookUrl = `/api${endpoint?.path ?? ""}`;
}, 180_000);

afterAll(async () => {
  await server?.shutdown();
  await new Promise<void>((resolve) => fakeSlack.close(() => resolve()));
  if (root) {
    // Deployment snapshots in the workflow sandbox are read-only.
    const writable = (dir: string) => {
      fs.chmodSync(dir, 0o700);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
        if (entry.isDirectory()) writable(path.join(dir, entry.name));
    };
    writable(root);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("Slack from project code (#117)", () => {
  it("answers Slack's URL verification synchronously and refuses unsigned requests", async () => {
    const handshake = await fromSlack({
      token: "deprecated-verification-token",
      challenge: "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
      type: "url_verification",
    });
    expect(handshake.statusCode).toBe(200);
    expect(handshake.body).toBe(
      "3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P",
    );
    const forged = await server.app.inject({
      method: "POST",
      url: hookUrl,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(Math.floor(Date.now() / 1000)),
        "x-slack-signature": "v0=deadbeef",
      },
      payload: JSON.stringify(mention({ id: "EvFORGED", ts: "1.1" })),
    });
    expect(forged.statusCode).toBe(401);
  });

  it("a mention starts the thread's chat and the settled reply is posted to the thread", async () => {
    const first = await fromSlack(
      mention({ id: "Ev0001", ts: "1790000000.000100" }),
    );
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ duplicate: false });

    // Slack did not hear back in time and retries the same event.
    const retry = await fromSlack(
      mention({ id: "Ev0001", ts: "1790000000.000100" }),
      { "x-slack-retry-num": "1", "x-slack-retry-reason": "http_timeout" },
    );
    expect(retry.statusCode).toBe(202);
    expect(retry.json()).toEqual({ id: first.json().id, duplicate: true });

    const posted = await waitFor("the reply in the thread", () =>
      posts().length > 0 ? posts() : undefined,
    );
    expect(posted[0]).toMatchObject({
      method: "POST",
      authorization: `Bearer ${BOT_TOKEN}`,
      body: { channel: "C1", thread_ts: "1790000000.000100" },
    });
    expect(String(posted[0]?.body.markdown_text)).toContain(
      "what is blocking the release?",
    );
    const chats = await threadChats();
    expect(chats).toEqual([
      expect.objectContaining({ chat_key: "slack:C1:1790000000.000100" }),
    ]);
  }, 120_000);

  it("a later mention in the same thread continues its chat, once per event", async () => {
    const [chat] = await threadChats();
    const reply = mention({
      id: "Ev0002",
      ts: "1790000100.000200",
      threadTs: "1790000000.000100",
    });
    expect((await fromSlack(reply)).statusCode).toBe(202);
    await waitFor("the second reply", () =>
      posts().length >= 2 ? true : undefined,
    );
    expect(await threadChats()).toEqual([chat]);
    expect(posts()[1]?.body).toMatchObject({
      channel: "C1",
      thread_ts: "1790000000.000100",
    });
    // Each event reached the chat once: the retry of Ev0001 added nothing.
    const delivered = await server.catamorphic.core.db
      .selectFrom("agent_messages")
      .select("content")
      .where("session_id", "=", chat?.id ?? "")
      .where("role", "=", "user")
      .execute();
    expect(delivered).toHaveLength(2);
    // Nothing more arrives later.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(posts()).toHaveLength(2);
  }, 120_000);

  it("the thread's agent reads Slack through the gateway and cannot post itself", async () => {
    const core = server.catamorphic.core;
    const [chat] = await threadChats();
    const session = await core.db
      .selectFrom("agent_sessions")
      .select(["id", "allocation_id"])
      .where("id", "=", chat?.id ?? "")
      .executeTakeFirstOrThrow();
    const principal = projectPrincipalIdentity({
      tenantId: SERVER_TENANT_ID,
      projectId,
      environment: "default",
      connections: [{ alias: "slack" }],
    });
    const grants = core.connectionGrants;
    if (!grants || !session.allocation_id) throw new Error("No chat grant");
    console.error(
      "ALLOC",
      JSON.stringify(
        await core.db
          .selectFrom("execution_allocations")
          .selectAll()
          .where("id", "=", session.allocation_id)
          .execute(),
      ),
    );
    // What the chat's harness holds: a short-lived grant for its alias.
    const grant = await grants.issue({
      identity: principal,
      allocationId: session.allocation_id,
      agentSessionId: session.id,
      alias: "slack",
    });
    const mcp = async (method: string, params: unknown = {}) =>
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
      ).json();
    const tools = await mcp("tools/list");
    expect(
      tools.result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual([
      "conversations.history",
      "conversations.replies",
      "chat.getPermalink",
      "users.info",
    ]);
    const thread = await mcp("tools/call", {
      name: "conversations.replies",
      arguments: { query: { channel: "C1", ts: "1790000000.000100" } },
    });
    expect(thread.result.structuredContent).toMatchObject({
      status: 200,
      body: {
        ok: true,
        messages: [{ text: "The release waits on the billing migration." }],
      },
    });
    expect(JSON.stringify(thread)).not.toContain(BOT_TOKEN);
    const post = await mcp("tools/call", {
      name: "chat.postMessage",
      arguments: { body: { channel: "C1", text: "hi" } },
    });
    expect(post.error.message).toContain("outside the connection grant");
    expect(posts()).toHaveLength(2);
  });

  it("the bot token never reaches a workflow, a run, or a file on disk", async () => {
    const runs = await server.catamorphic.core.db
      .selectFrom("workflow_runs")
      .selectAll()
      .where("project_id", "=", projectId)
      .execute();
    expect(runs.length).toBeGreaterThan(0);
    expect(JSON.stringify(runs)).not.toContain(BOT_TOKEN);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) files.push(full);
      }
    };
    walk(root);
    for (const file of files) {
      expect(
        fs.readFileSync(file).includes(BOT_TOKEN),
        `${file} holds the bot token`,
      ).toBe(false);
    }
  });
});
