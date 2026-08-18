import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const MCP_URL = `/api/projects/${PROJECT_ID}/mcp`;

const HEADERS = {
  "x-catamorphic-tenant-id": "tenant-1",
  "x-external-user-id": "user-1",
  "content-type": "application/json",
};

const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const WEATHER_BINDING = {
  workflowName: "lookupWeather",
  kind: "ai.tool-call",
  config: { description: "Look up the current weather for a city" },
  canSuspend: false,
  inputParameters: [],
  inputSchema: {
    type: "object",
    properties: { city: { type: "string" } },
    required: ["city"],
  },
  outputSchema: {
    type: "object",
    properties: { temperature: { type: "number" } },
  },
};

const DIGEST_BINDING = {
  workflowName: "buildDigest",
  kind: "ai.tool-call",
  config: { description: "Build the daily digest", name: "daily_digest" },
  canSuspend: true,
  inputParameters: [],
  // Non-object input: the tool must wrap it as {"input": ...}.
  inputSchema: { type: "string" },
  outputSchema: { type: "string" },
};

/** Core stub with two ai.tool-call bindings at the production commit. */
function fakeCore(overrides?: {
  bindings?: unknown[];
  fireOutcome?: Record<string, unknown>;
}) {
  const bindings = overrides?.bindings ?? [WEATHER_BINDING, DIGEST_BINDING];
  return {
    mcpToolKinds: [
      {
        kind: "ai.tool-call",
        tool: (config: { description: string; name?: string }) => ({
          description: config.description,
          ...(config.name ? { name: config.name } : {}),
        }),
      },
    ],
    triggers: {
      list: vi.fn(async () => bindings),
      kindInfo: vi.fn(() => ({
        name: "ai.tool-call",
        modes: ["sync", "async"],
        payloadJsonSchema: {},
        configJsonSchema: {},
      })),
      fire: vi.fn(async (args: { workflows: string[] }) => ({
        kind: "ai.tool-call",
        mode: "sync",
        commitSha: "abc123",
        runs: [
          overrides?.fireOutcome ?? {
            workflowName: args.workflows[0],
            runId: "run-1",
            status: "completed",
            output: { temperature: 21 },
          },
        ],
      })),
    },
    runs: {
      get: vi.fn(async (args: { runId: string }) => ({
        id: args.runId,
        status: "completed",
        result: { done: true },
      })),
    },
  };
}

async function rpc(
  app: ReturnType<typeof createTestApp>,
  method: string,
  params?: Record<string, unknown>,
) {
  const response = await app.inject({
    method: "POST",
    url: MCP_URL,
    headers: HEADERS,
    payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
  });
  return response.json() as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

describe("project workflow-tools MCP endpoint", () => {
  it("answers initialize as the project server", async () => {
    const app = createTestApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(result?.protocolVersion).toBe("2025-06-18");
    expect(result?.serverInfo).toMatchObject({ name: "catamorphic" });
    expect(result?.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("serves without tool kinds: no workflow tools, no poll tool, the surface only", async () => {
    // A host with no tool kinds still has a project surface (ADR 0055);
    // this stub has none of documents/skills/agents either, so: nothing.
    const core = { ...fakeCore(), mcpToolKinds: [] };
    const app = createTestApp({ core: core as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/list");
    expect(result?.tools).toEqual([]);
  });

  it("serves one tool per binding plus the poll tool", async () => {
    const app = createTestApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/list");
    const tools = result?.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      "lookupWeather",
      "daily_digest",
      "catamorphic_poll_run",
    ]);

    const weather = tools.find(
      (tool) => tool.name === "lookupWeather",
    ) as Record<string, unknown>;
    // Object-typed workflow input rides as the tool schema verbatim. The
    // output schema stays in _meta: advertising it as `outputSchema` would
    // make clients reject the detach answer ({status, runId, …}).
    expect(weather.inputSchema).toEqual(WEATHER_BINDING.inputSchema);
    expect(weather.outputSchema).toBeUndefined();
    expect(weather.description).toContain("current weather");
    expect(weather._meta).toEqual({
      catamorphic: {
        canSuspend: false,
        outputSchema: WEATHER_BINDING.outputSchema,
      },
    });

    const digest = tools.find((tool) => tool.name === "daily_digest") as Record<
      string,
      unknown
    >;
    // Non-object input is wrapped; suspendable tools document the poll flow.
    expect(digest.inputSchema).toMatchObject({
      type: "object",
      required: ["input"],
    });
    expect(digest.description).toContain('{"input": ...}');
    expect(digest.description).toContain("catamorphic_poll_run");
    expect(digest.outputSchema).toBeUndefined();
    expect(digest._meta).toEqual({
      catamorphic: {
        canSuspend: true,
        outputSchema: DIGEST_BINDING.outputSchema,
      },
    });
  });

  it("fires the bound workflow sync and returns the settled output", async () => {
    const core = fakeCore();
    const app = createTestApp({ core: core as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/call", {
      name: "lookupWeather",
      arguments: { city: "Amman" },
    });
    expect(result?.structuredContent).toEqual({ temperature: 21 });
    expect(core.triggers.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "ai.tool-call",
        mode: "sync",
        payload: { city: "Amman" },
        workflows: ["lookupWeather"],
      }),
    );
  });

  it("unwraps {'input': ...} for wrapped tools and resolves name overrides", async () => {
    const core = fakeCore();
    const app = createTestApp({ core: core as never });
    apps.push(app);
    await rpc(app, "tools/call", {
      name: "daily_digest",
      arguments: { input: "for today" },
    });
    expect(core.triggers.fire).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: "for today",
        workflows: ["buildDigest"],
      }),
    );
  });

  it("returns runId + poll guidance when the run detaches", async () => {
    const core = fakeCore({
      fireOutcome: {
        workflowName: "buildDigest",
        runId: "run-9",
        status: "suspended",
        suspendedOn: "pause",
      },
    });
    const app = createTestApp({ core: core as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/call", {
      name: "daily_digest",
      arguments: { input: "x" },
    });
    expect(result?.structuredContent).toMatchObject({
      status: "running",
      runId: "run-9",
      suspendedOn: "pause",
    });
  });

  it("surfaces trigger failures as tool errors, not JSON-RPC errors", async () => {
    const core = fakeCore();
    core.triggers.fire.mockRejectedValueOnce(
      new Error("Run input is invalid: city: expected string"),
    );
    const app = createTestApp({ core: core as never });
    apps.push(app);
    const { result, error } = await rpc(app, "tools/call", {
      name: "lookupWeather",
      arguments: { city: 5 },
    });
    expect(error).toBeUndefined();
    expect(result?.isError).toBe(true);
    expect(JSON.stringify(result?.content)).toContain("Run input is invalid");
  });

  it("answers the poll tool with the run snapshot", async () => {
    const app = createTestApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/call", {
      name: "catamorphic_poll_run",
      arguments: { runId: "run-1" },
    });
    expect(result?.structuredContent).toMatchObject({
      runId: "run-1",
      status: "completed",
      output: { done: true },
    });
  });

  it("rejects duplicate effective tool names loudly", async () => {
    const clash = {
      ...WEATHER_BINDING,
      workflowName: "otherWorkflow",
      config: { description: "clashes", name: "lookupWeather" },
    };
    const app = createTestApp({
      core: fakeCore({ bindings: [WEATHER_BINDING, clash] }) as never,
    });
    apps.push(app);
    const { error } = await rpc(app, "tools/list");
    expect(error?.code).toBe(-32603);
    expect(error?.message).toContain("lookupWeather");
  });

  it("answers unknown tools with a tool error", async () => {
    const app = createTestApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/call", {
      name: "nope",
      arguments: {},
    });
    expect(result?.isError).toBe(true);
  });
});

describe("project MCP surface (ADR 0055): documents, skills, ask_agent", () => {
  const admin = {
    "x-catamorphic-tenant-id": "tenant-1",
    "x-external-user-id": "admin",
    "content-type": "application/json",
  };

  function surfaceCore(overrides: Record<string, unknown> = {}) {
    const calls: Array<{ op: string; args: unknown }> = [];
    const record =
      (op: string, result: unknown) =>
      async (...args: unknown[]) => {
        calls.push({ op, args: args.length === 1 ? args[0] : args });
        return result;
      };
    const core = {
      ...fakeCore(),
      db: {},
      appPolicies: { get: async () => null },
      documents: {
        list: record("documents.list", [
          {
            path: "docs/handbook.md",
            source: "program",
            contentType: "text/markdown",
            size: -1,
          },
        ]),
        read: record("documents.read", {
          path: "docs/handbook.md",
          source: "program",
          contentType: "text/markdown",
          size: 12,
          text: "# Handbook",
          bytes: new Uint8Array(),
        }),
        search: record("documents.search", [
          {
            path: "docs/handbook.md",
            source: "program",
            lines: [{ line: 3, text: "refunds" }],
          },
        ]),
        write: record("documents.write", {
          path: "store/x.md",
          source: "store",
          version: 1,
        }),
        delete: record("documents.delete", { version: 2 }),
        history: record("documents.history", []),
      },
      skills: {
        listShared: record("skills.listShared", [
          {
            name: "writing-briefs",
            title: "Writing briefs",
            description: "How we brief",
            path: ".agents/skills/writing-briefs/SKILL.md",
            source: "project",
          },
        ]),
        readShared: record("skills.readShared", {
          skill: {
            name: "writing-briefs",
            title: "Writing briefs",
            description: "",
            path: "x",
            source: "project",
          },
          content: "# Briefs",
        }),
      },
      agentSessions: {
        create: record("sessions.create", { id: "session-1" }),
        sendMessage: record("sessions.sendMessage", {
          content: "Here is your brief.",
        }),
      },
      ...overrides,
    };
    return { core, calls };
  }

  it("lists the surface tools beside the workflow tools, with read-only annotations", async () => {
    const { core } = surfaceCore();
    const app = createTestApp({ core: core as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/list");
    const tools = result?.tools as Array<Record<string, unknown>>;
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual([
      "lookupWeather",
      "daily_digest",
      "catamorphic_poll_run",
      "documents_list",
      "documents_read",
      "documents_search",
      "documents_write",
      "documents_delete",
      "documents_history",
      "list_skills",
      "read_skill",
      "ask_agent",
    ]);
    expect(tools.find((t) => t.name === "documents_read")?.annotations).toEqual(
      { readOnlyHint: true },
    );
    expect(
      tools.find((t) => t.name === "documents_write")?.annotations,
    ).toBeUndefined();
  });

  it("routes surface calls to the core services with the request identity", async () => {
    const { core, calls } = surfaceCore();
    const app = createTestApp({ core: core as never });
    apps.push(app);
    const read = await rpc(app, "tools/call", {
      name: "documents_read",
      arguments: { path: "docs/handbook.md" },
    });
    expect(read.result?.structuredContent).toMatchObject({
      path: "docs/handbook.md",
      text: "# Handbook",
    });
    expect(
      (read.result?.structuredContent as { bytes?: unknown }).bytes,
    ).toBeUndefined();
    expect(calls.at(-1)).toMatchObject({
      op: "documents.read",
      args: {
        path: "docs/handbook.md",
        identity: { externalUserId: "user-1" },
      },
    });

    const search = await rpc(app, "tools/call", {
      name: "documents_search",
      arguments: { query: "refunds", mode: "text", prefix: "docs" },
    });
    expect(calls.at(-1)).toMatchObject({
      op: "documents.search",
      args: { query: "refunds", mode: "text", prefix: "docs" },
    });
    expect(search.result?.isError).toBeUndefined();

    await rpc(app, "tools/call", {
      name: "documents_write",
      arguments: { path: "store/x.md", text: "hi", ifVersion: 0 },
    });
    expect(calls.at(-1)).toMatchObject({
      op: "documents.write",
      args: { path: "store/x.md", content: "hi", ifVersion: 0 },
    });

    const skill = await rpc(app, "tools/call", {
      name: "read_skill",
      arguments: { name: "writing-briefs" },
    });
    expect(skill.result?.structuredContent).toMatchObject({
      name: "writing-briefs",
      content: "# Briefs",
    });

    const ask = await rpc(app, "tools/call", {
      name: "ask_agent",
      arguments: { agent: "csm-assistant", message: "brief acme" },
    });
    expect(ask.result?.structuredContent).toEqual({
      sessionId: "session-1",
      reply: "Here is your brief.",
    });
    expect(calls.at(-2)).toMatchObject({
      op: "sessions.create",
      args: expect.arrayContaining([
        expect.objectContaining({
          agentId: `project:${PROJECT_ID}:csm-assistant`,
        }),
      ]),
    });
  });

  it("scoped callers see only their workflows on the roster", async () => {
    // A viewer whose scope resolves to lookupWeather only. resolveScope reads
    // the workflow refs; no DB round trip is needed for bare workflow refs.
    const { core } = surfaceCore();
    const viewerIdentity = {
      tenantId: "tenant-1",
      externalUserId: "viewer",
      scope: [
        { kind: "workflow", projectId: PROJECT_ID, name: "lookupWeather" },
      ],
    };
    const app = createTestApp({
      core: core as never,
      identity: () => viewerIdentity as never,
    });
    apps.push(app);
    const { result } = await rpc(app, "tools/list");
    const names = (result?.tools as Array<Record<string, unknown>>).map(
      (t) => t.name,
    );
    expect(names).toContain("lookupWeather");
    expect(names).not.toContain("daily_digest");
    // Documents tools stay (the service narrows them per call); skills need
    // an agent/document/workflow ref — a workflow ref qualifies.
    expect(names).toContain("documents_read");
    expect(names).toContain("list_skills");
  });
});
