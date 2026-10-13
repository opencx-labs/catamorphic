import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectorMcpPath,
  registerConnectorMcpRoute,
} from "./connector-mcp.js";

vi.mock("electron", () => ({ safeStorage: {} }));

const LOOKUP = {
  name: "lookup",
  title: "Look up a person",
  description: "Find one person",
  inputSchema: { type: "object" },
  outputSchema: { type: "object", properties: { name: { type: "string" } } },
  annotations: { readOnlyHint: true },
};
const RENAME = {
  name: "rename",
  description: "Rename a person",
  inputSchema: { type: "object" },
};
const PURGE = {
  name: "purge",
  description: "Delete everyone",
  inputSchema: { type: "object" },
};
/** What the connector sent: forwarded as it is. */
const RESULT = {
  content: [
    { type: "text", text: "no such person" },
    { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
  ],
  structuredContent: { name: "" },
  isError: true,
};

const apps: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function serve(surface: { readOnly?: boolean; mounted?: boolean } = {}) {
  const callTool = vi.fn(async () => RESULT);
  const app = Fastify();
  registerConnectorMcpRoute(app, {
    core: () =>
      ({
        agentSessions: {
          toolContextForSession: async () => ({
            agentId: "agent",
            // The caller's role denies purge.
            toolPolicies: { probe: [{ tools: { purge: "deny" } }] },
          }),
        },
      }) as never,
    agents: {
      defaultAgentId: () => "agent",
      capabilitySurface: () => ({
        connectorsMounted: surface.mounted ?? true,
        readOnly: surface.readOnly ?? false,
        profileId: "profile",
        mcp: {
          connectionIds: { probe: "probe-id" },
          policies: { probe: [{ default: "allow" }] },
          nativeServers: {},
        },
      }),
    } as never,
    mcpApps: {
      tools: async () => [LOOKUP, RENAME, PURGE],
      callTool,
    } as never,
    identity: { tenantId: "tenant", externalUserId: "person" },
  });
  apps.push(app);
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
    server = "probe",
  ) =>
    app.inject({
      method: "POST",
      url: connectorMcpPath({ projectId: "p", sessionId: "s", server }),
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
  return { rpc, callTool };
}

describe("a chat's connector as an MCP server of its own (ADR 0225)", () => {
  it("lists the tools this chat may reach, as the connector declared them", async () => {
    const { rpc } = serve();
    const listed = await rpc("tools/list");
    expect(listed.json().result.tools).toEqual([LOOKUP, RENAME]);
  });

  it("lists only reads for a contained agent", async () => {
    const { rpc } = serve({ readOnly: true });
    const listed = await rpc("tools/list");
    expect(listed.json().result.tools).toEqual([LOOKUP]);
  });

  it("forwards a call through the host's client and its result unchanged", async () => {
    const { rpc, callTool } = serve();
    const called = await rpc("tools/call", {
      name: "lookup",
      arguments: { name: "Ada" },
    });
    expect(called.json().result).toEqual(RESULT);
    expect(callTool).toHaveBeenCalledWith("profile", "probe/lookup", "lookup", {
      name: "Ada",
    });
  });

  it("never calls a denied tool", async () => {
    const { rpc, callTool } = serve();
    const called = await rpc("tools/call", { name: "purge", arguments: {} });
    expect(called.json()).toMatchObject({ error: { code: -32602 } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("serves no connector to a chat whose harness does not mount them", async () => {
    expect((await serve({ mounted: false }).rpc("tools/list")).statusCode).toBe(
      404,
    );
    expect((await serve().rpc("tools/list", {}, "other")).statusCode).toBe(404);
  });
});
