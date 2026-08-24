import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const ALLOCATION_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const BINDING_ID = "b1b2c3d4-e5f6-4890-abcd-ef1234567890";
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function appWithBroker(args: { listFailure?: Error } = {}) {
  const invoke = vi.fn(async (input: { action: string }) => {
    if (input.action === "explode") throw new Error("raw provider secret");
    return { ok: true };
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
                bindingId: BINDING_ID,
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
                bindingId: BINDING_ID,
                alias: "workspace",
                capabilities: ["lookup", "explode"],
              },
            ],
          },
        }),
      },
      connectionBroker: {
        listActions: async () => {
          if (args.listFailure) throw args.listFailure;
          return [{ name: "lookup", inputSchema: { type: "object" } }];
        },
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
      payload: { jsonrpc: "1.0", method: 3 },
    });
    expect(malformed.json()).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: "Invalid Request" },
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
});
