import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  connectorMcpPath,
  connectorMcpTokens,
  registerConnectorMcpRoute,
} from "./connector-mcp.js";

vi.mock("electron", () => ({ safeStorage: {} }));
vi.mock("@catamorphic/mcp", () => ({
  // A server-sent error carries a numeric code; a lost connection says so.
  mcpServerError: (error: unknown) =>
    error instanceof Error && "code" in error && typeof error.code === "number"
      ? { code: error.code, message: error.message }
      : undefined,
  mcpConnectionLost: (error: unknown) =>
    error instanceof Error && error.message === "connection lost",
}));

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

function serve(
  surface: {
    readOnly?: boolean;
    mounted?: boolean;
    /** The connection's own policy, e.g. rename asks. */
    policy?: Record<string, unknown>;
    approval?: "allow" | "deny";
    session?: "missing";
    /** What the connector's call throws instead of answering. */
    failure?: Error;
  } = {},
) {
  const callTool = vi.fn(async () => {
    if (surface.failure) throw surface.failure;
    return RESULT;
  });
  const askApproval = vi.fn(async () => surface.approval ?? "allow");
  const tokens = connectorMcpTokens();
  const app = Fastify();
  registerConnectorMcpRoute(app, {
    core: () =>
      ({
        agentSessions: {
          askApproval,
          toolContextForSession: async () => {
            if (surface.session === "missing")
              throw new Error("Agent session not found");
            // The caller's role denies purge.
            return {
              agentId: "agent",
              toolPolicies: { probe: [{ tools: { purge: "deny" } }] },
            };
          },
        },
      }) as never,
    agents: {
      defaultAgentId: () => "agent",
      capabilitySurface: () => ({
        connectorsMounted: surface.mounted ?? true,
        readOnly: surface.readOnly ?? false,
        profileId: "profile",
        mcp: {
          connectionIds: { probe: "probe-id", computer: "computer-id" },
          policies: {
            probe: [{ default: "allow", ...surface.policy }],
          },
          nativeServers: { computer: { transport: "stdio", command: "cu" } },
        },
      }),
    } as never,
    mcpApps: {
      tools: async () => [LOOKUP, RENAME, PURGE],
      callTool,
    } as never,
    identity: { tenantId: "tenant", externalUserId: "person" },
    tokens,
  });
  apps.push(app);
  const rpc = async (
    method: string,
    params: Record<string, unknown> = {},
    options: { server?: string; token?: string; id?: number | null } = {},
  ) =>
    app.inject({
      method: "POST",
      url: connectorMcpPath({
        projectId: "p",
        sessionId: "s",
        server: options.server ?? "probe",
      }),
      headers: {
        authorization: `Bearer ${options.token ?? tokens.token("s")}`,
      },
      payload: {
        jsonrpc: "2.0",
        ...(options.id === null ? {} : { id: options.id ?? 1 }),
        method,
        params,
      },
    });
  return { app, rpc, callTool, askApproval };
}

describe("a chat's connector as an MCP server of its own (ADR 0225)", () => {
  it("lists the tools this chat may reach, as the connector declared them", async () => {
    const { rpc } = serve();
    const listed = await rpc("tools/list");
    expect(listed.json().result.tools).toEqual([LOOKUP, RENAME]);
  });

  it("lists only reads for a contained agent and refuses its writes", async () => {
    const { rpc, callTool } = serve({ readOnly: true });
    expect((await rpc("tools/list")).json().result.tools).toEqual([LOOKUP]);
    const called = await rpc("tools/call", { name: "rename", arguments: {} });
    expect(called.json()).toMatchObject({ error: { code: -32602 } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("forwards a call through the host's client and its result unchanged", async () => {
    const { rpc, callTool, askApproval } = serve();
    const called = await rpc("tools/call", {
      name: "lookup",
      arguments: { name: "Ada" },
    });
    expect(called.json().result).toEqual(RESULT);
    expect(callTool).toHaveBeenCalledWith("profile", "probe/lookup", "lookup", {
      name: "Ada",
    });
    expect(askApproval).not.toHaveBeenCalled();
  });

  it("asks the person inside the call, whatever the harness's mode", async () => {
    const { rpc, callTool, askApproval } = serve({
      policy: { tools: { rename: "ask" } },
    });
    expect(
      (
        await rpc("tools/call", { name: "rename", arguments: { to: "Ada" } })
      ).json().result,
    ).toEqual(RESULT);
    expect(askApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "s",
        title: "Allow rename?",
        origin: { kind: "mcp", id: "probe", displayName: "probe" },
      }),
    );
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("answers a declined ask as a tool error, never calling the connector", async () => {
    const { rpc, callTool } = serve({
      policy: { tools: { rename: "ask" } },
      approval: "deny",
    });
    const called = await rpc("tools/call", { name: "rename", arguments: {} });
    expect(called.json().result).toMatchObject({ isError: true });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("never calls a denied tool", async () => {
    const { rpc, callTool } = serve();
    const called = await rpc("tools/call", { name: "purge", arguments: {} });
    expect(called.json()).toMatchObject({ error: { code: -32602 } });
    expect(callTool).not.toHaveBeenCalled();
  });

  it("answers the protocol's own requests", async () => {
    const { app, rpc } = serve();
    expect(
      (await rpc("initialize", { protocolVersion: "2025-03-26" })).json()
        .result,
    ).toEqual({
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "probe", version: "1" },
    });
    expect((await rpc("ping")).json().result).toEqual({});
    expect(
      (await rpc("notifications/initialized", {}, { id: null })).statusCode,
    ).toBe(202);
    // No server-initiated stream: clients that open one move on.
    const stream = await app.inject({
      method: "GET",
      url: connectorMcpPath({
        projectId: "p",
        sessionId: "s",
        server: "probe",
      }),
    });
    expect(stream.statusCode).toBe(405);
  });

  it("serves only the chat that holds its bearer", async () => {
    const { rpc, callTool } = serve();
    expect((await rpc("tools/list", {}, { token: "guess" })).statusCode).toBe(
      401,
    );
    expect(
      (await rpc("tools/list", {}, { token: connectorMcpTokens().token("s") }))
        .statusCode,
    ).toBe(401);
    expect(callTool).not.toHaveBeenCalled();
  });

  it("serves no connector the chat does not mount", async () => {
    expect((await serve({ mounted: false }).rpc("tools/list")).statusCode).toBe(
      404,
    );
    expect(
      (await serve().rpc("tools/list", {}, { server: "other" })).statusCode,
    ).toBe(404);
    // Native computer use stays with its Codex process.
    expect(
      (await serve().rpc("tools/list", {}, { server: "computer" })).statusCode,
    ).toBe(404);
    expect(
      (await serve({ session: "missing" }).rpc("tools/list")).statusCode,
    ).toBe(404);
  });

  it("passes on the server's own error, and a lost connection generically", async () => {
    const sent = Object.assign(new Error("Invalid arguments: name"), {
      code: -32602,
    });
    expect(
      (
        await serve({ failure: sent }).rpc("tools/call", {
          name: "lookup",
          arguments: {},
        })
      ).json().error,
    ).toEqual({ code: -32602, message: "Invalid arguments: name" });
    expect(
      (
        await serve({ failure: new Error("connection lost") }).rpc(
          "tools/call",
          { name: "lookup", arguments: {} },
        )
      ).json().error,
    ).toEqual({ code: -32000, message: "probe is unavailable" });
  });
});
