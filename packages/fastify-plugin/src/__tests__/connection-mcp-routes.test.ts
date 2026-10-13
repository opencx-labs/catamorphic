import { ConnectionActionDeniedError } from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const ALLOCATION_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** What an MCP server sent for one call, kept as it was. */
const MCP_RESULT = {
  content: [
    { type: "text", text: "Ada Lovelace" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ],
  structuredContent: { name: "Ada Lovelace" },
  isError: true,
  _meta: { trace: "t-1" },
};

function appWithBroker(
  args: {
    listFailure?: Error;
    provider?: "mcp" | "json";
    actions?: Record<string, unknown>[];
    output?: unknown;
  } = {},
) {
  const invoke = vi.fn(async (input: { action: string }) => {
    if (input.action === "explode") throw new Error("raw provider secret");
    if (input.action === "scan") {
      throw new ConnectionActionDeniedError("the query reads every row");
    }
    return args.output ?? { ok: true };
  });
  const app = createTestApp({
    core: {
      connectionGrants: {
        validate: async ({ token }: { token: string }) =>
          token === "valid"
            ? {
                tenantId: "test-tenant",
                projectId: "project",
                allocationId: ALLOCATION_ID,
                agentSessionId: "session",
                alias: "workspace",
              }
            : null,
      },
      executionAllocations: {
        get: async () => ({
          id: ALLOCATION_ID,
          status: "active",
          policy: {
            connections: [
              {
                alias: "workspace",
                providerKind: args.provider === "mcp" ? "remote-mcp" : "http",
                capabilities: ["lookup", "explode", "scan"],
              },
            ],
          },
        }),
      },
      connectionBroker: {
        listActions: async () => {
          if (args.listFailure) throw args.listFailure;
          return (
            args.actions ?? [
              { name: "lookup", inputSchema: { type: "object" } },
            ]
          );
        },
        servesMcp: (kind: string) => kind === "remote-mcp",
        invoke,
      },
    } as never,
  });
  apps.push(app);
  return { app, invoke };
}

async function rpc(args: {
  app: ReturnType<typeof createTestApp>;
  token?: string;
  payload: Record<string, unknown>;
}) {
  return await args.app.inject({
    method: "POST",
    url: "/api/connection-mcp",
    headers: args.token ? { authorization: `Bearer ${args.token}` } : undefined,
    payload: args.payload,
  });
}

describe("connection capability MCP gateway", () => {
  it("requires a live bearer grant and validates JSON-RPC envelopes", async () => {
    const { app } = appWithBroker();
    expect(
      (await rpc({ app, payload: { jsonrpc: "2.0", method: "initialize" } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await rpc({
          app,
          token: "stale",
          payload: { jsonrpc: "2.0", method: "initialize" },
        })
      ).statusCode,
    ).toBe(401);

    const malformed = await rpc({
      app,
      token: "valid",
      payload: { jsonrpc: "2.0", id: 4, method: 3 },
    });
    expect(malformed.json()).toEqual({
      jsonrpc: "2.0",
      id: 4,
      error: { code: -32600, message: "Missing method" },
    });

    const initialized = await rpc({
      app,
      token: "valid",
      payload: {
        jsonrpc: "2.0",
        id: 5,
        method: "initialize",
        params: { protocolVersion: "2025-11-25" },
      },
    });
    expect(initialized.json()).toMatchObject({
      result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
    });
  });

  it("lists and invokes only actions in the immutable grant snapshot", async () => {
    const { app, invoke } = appWithBroker();
    const listed = await rpc({
      app,
      token: "valid",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(listed.json()).toMatchObject({
      result: { tools: [{ name: "lookup" }] },
    });

    const denied = await rpc({
      app,
      token: "valid",
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "admin", arguments: {} },
      },
    });
    expect(denied.json()).toMatchObject({ error: { code: -32602 } });
    expect(invoke).not.toHaveBeenCalled();

    const called = await rpc({
      app,
      token: "valid",
      payload: {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "lookup", arguments: { query: "Ada" } },
      },
    });
    expect(called.json()).toMatchObject({
      result: { structuredContent: { ok: true } },
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        allocationId: ALLOCATION_ID,
        alias: "workspace",
        action: "lookup",
        input: { query: "Ada" },
      }),
    );
  });

  it("tells the agent why the gateway refused an action", async () => {
    const { app, invoke } = appWithBroker();
    const refused = await rpc({
      app,
      token: "valid",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "scan", arguments: { sql: "select * from orders" } },
      },
    });
    expect(refused.json()).toMatchObject({
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "Connection action denied: the query reads every row",
          },
        ],
      },
    });
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({ caller: "agent", agentSessionId: "session" }),
    );
  });

  it("sanitizes provider failures at the protocol boundary", async () => {
    const { app } = appWithBroker({
      listFailure: new Error("raw list secret"),
    });
    const listed = await rpc({
      app,
      token: "valid",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(JSON.stringify(listed.json())).not.toContain("secret");
    expect(listed.json()).toMatchObject({
      error: { code: -32_000, message: "Connection action failed" },
    });

    const called = await rpc({
      app,
      token: "valid",
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "explode", arguments: {} },
      },
    });
    expect(JSON.stringify(called.json())).not.toContain("secret");
    expect(called.json()).toMatchObject({
      error: { code: -32_000, message: "Connection action failed" },
    });
  });

  it("passes an MCP connection's tools and results through as its server sent them", async () => {
    const { app } = appWithBroker({
      provider: "mcp",
      output: MCP_RESULT,
      actions: [
        {
          name: "lookup",
          title: "Look up a person",
          description: "Find one person",
          inputSchema: { type: "object" },
          outputSchema: {
            type: "object",
            properties: { name: { type: "string" } },
          },
          annotations: { readOnlyHint: true },
        },
        {
          name: "scan",
          inputSchema: { type: "object" },
          // Legal on newer revisions only: never advertised here.
          outputSchema: { type: "array" },
        },
      ],
    });
    const listed = await rpc({
      app,
      token: "valid",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(listed.json().result.tools).toEqual([
      {
        name: "lookup",
        title: "Look up a person",
        description: "Find one person",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
        },
        annotations: { readOnlyHint: true },
      },
      { name: "scan", inputSchema: { type: "object" } },
    ]);

    const called = await rpc({
      app,
      token: "valid",
      payload: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "lookup", arguments: {} },
      },
    });
    expect(called.json().result).toEqual(MCP_RESULT);
  });

  it("forwards structured content that is not an object as text", async () => {
    const rows = [{ id: 1 }, { id: 2 }];
    const { app } = appWithBroker({
      provider: "mcp",
      output: { content: [], structuredContent: rows },
    });
    const called = await rpc({
      app,
      token: "valid",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "lookup", arguments: {} },
      },
    });
    expect(called.json().result).toEqual({
      content: [{ type: "text", text: JSON.stringify(rows) }],
    });
  });

  it("answers another connection's JSON as a tool result", async () => {
    const rows = [{ id: 1 }];
    const { app } = appWithBroker({ output: rows });
    const called = await rpc({
      app,
      token: "valid",
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "lookup", arguments: {} },
      },
    });
    // Arrays ride the text alone: structured content must be an object.
    expect(called.json().result).toEqual({
      content: [{ type: "text", text: JSON.stringify(rows) }],
    });
  });

  it("answers the protocol's own requests like the plugin's other MCP endpoints", async () => {
    const { app } = appWithBroker();
    const initialized = await rpc({
      app,
      token: "valid",
      payload: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    });
    expect(initialized.json().result.protocolVersion).toBe("2025-06-18");
    const pinged = await rpc({
      app,
      token: "valid",
      payload: { jsonrpc: "2.0", id: 2, method: "ping" },
    });
    expect(pinged.json().result).toEqual({});
    const notified = await rpc({
      app,
      token: "valid",
      payload: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    expect(notified.statusCode).toBe(202);
    // No server-initiated stream: clients that open one move on.
    const stream = await app.inject({
      method: "GET",
      url: "/api/connection-mcp",
    });
    expect(stream.statusCode).toBe(405);
  });

  it("advertises output schemas only for an MCP server's own tools", async () => {
    const { app } = appWithBroker({
      actions: [
        {
          name: "lookup",
          inputSchema: { type: "object" },
          outputSchema: { type: "object" },
        },
      ],
    });
    const listed = await rpc({
      app,
      token: "valid",
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(listed.json().result.tools).toEqual([
      { name: "lookup", inputSchema: { type: "object" } },
    ]);
  });
});
