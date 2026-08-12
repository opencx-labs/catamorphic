import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const MCP_URL = `/api/projects/${PROJECT_ID}/mcp`;

const HEADERS = {
  "x-catamorphic-tenant-id": "tenant-1",
  "x-external-user-id": "user-1",
  "content-type": "application/json",
};

const apps: ReturnType<typeof createApp>[] = [];

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
  app: ReturnType<typeof createApp>,
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
  it("answers initialize as the workflow-tools server", async () => {
    const app = createApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(result?.protocolVersion).toBe("2025-06-18");
    expect(result?.serverInfo).toMatchObject({ name: "catamorphic-workflows" });
    expect(result?.capabilities).toEqual({ tools: { listChanged: false } });
  });

  it("returns 503 when the host registered no tool kinds", async () => {
    const core = { ...fakeCore(), mcpToolKinds: [] };
    const app = createApp({ core: core as never });
    apps.push(app);
    const response = await app.inject({
      method: "POST",
      url: MCP_URL,
      headers: HEADERS,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(response.statusCode).toBe(503);
  });

  it("serves one tool per binding plus the poll tool", async () => {
    const app = createApp({ core: fakeCore() as never });
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
    const app = createApp({ core: core as never });
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
    const app = createApp({ core: core as never });
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
    const app = createApp({ core: core as never });
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
    const app = createApp({ core: core as never });
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
    const app = createApp({ core: fakeCore() as never });
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
    const app = createApp({
      core: fakeCore({ bindings: [WEATHER_BINDING, clash] }) as never,
    });
    apps.push(app);
    const { error } = await rpc(app, "tools/list");
    expect(error?.code).toBe(-32603);
    expect(error?.message).toContain("lookupWeather");
  });

  it("answers unknown tools with a tool error", async () => {
    const app = createApp({ core: fakeCore() as never });
    apps.push(app);
    const { result } = await rpc(app, "tools/call", {
      name: "nope",
      arguments: {},
    });
    expect(result?.isError).toBe(true);
  });
});
