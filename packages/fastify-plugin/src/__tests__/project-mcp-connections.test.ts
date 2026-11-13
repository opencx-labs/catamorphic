import {
  AuthenticationRequiredError,
  ConnectionActionDeniedError,
} from "@catamorphic/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTestApp } from "./test-app.js";

const PROJECT_ID = "a1b2c3d4-e5f6-4890-abcd-ef1234567890";
const HEADERS = {
  "x-catamorphic-tenant-id": "tenant-1",
  "x-external-user-id": "member-1",
  "content-type": "application/json",
};
const apps: ReturnType<typeof createTestApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

/** What an upstream MCP server sent for one call, kept as it was. */
const MCP_RESULT = {
  content: [{ type: "text", text: "3 open issues" }],
  structuredContent: { open: 3 },
};

function fakeCore(
  args: { memberReady?: boolean; invokeError?: Error; listError?: Error } = {},
) {
  const invoke = vi.fn(async () => {
    if (args.invokeError) throw args.invokeError;
    return MCP_RESULT;
  });
  const listActions = vi.fn(async () => {
    if (args.listError) throw args.listError;
    return [
      {
        name: "issues.list",
        description: "List issues",
        inputSchema: { type: "object" },
        annotations: { readOnlyHint: true },
      },
    ];
  });
  const offerConnection = vi.fn(async () => ({
    token: "offer-token",
    expiresAt: new Date("2026-11-14T00:15:00Z"),
  }));
  const core = {
    mcpToolKinds: [],
    triggers: { list: async () => [] },
    projectEnvironments: {
      list: async () => ({ defaultEnvironment: "company" }),
    },
    connections: {
      listBindings: vi.fn(async () => [
        {
          environment: "company",
          alias: "tracker",
          provider: "tracker-mcp",
          principal: "member",
          service: null,
          capabilities: null,
          memberConnection:
            args.memberReady === false
              ? null
              : { connectionId: "c-1", status: "ready" },
          serviceConnection: null,
        },
        {
          environment: "company",
          alias: "billing",
          provider: "billing-api",
          principal: "service",
          service: null,
          capabilities: null,
          memberConnection: null,
          // Not yet authorized by an administrator: nothing to offer.
          serviceConnection: { connectionId: null, status: "pending" },
        },
      ]),
      offerConnection,
    },
    connectionBroker: {
      servesMcp: (kind: string) => kind === "tracker-mcp",
      listActions,
      invoke,
    },
  };
  return { core, invoke, listActions, offerConnection };
}

async function rpc(
  app: ReturnType<typeof createTestApp>,
  method: string,
  params?: Record<string, unknown>,
  query = "",
) {
  const response = await app.inject({
    method: "POST",
    url: `/api/projects/${PROJECT_ID}/mcp${query}`,
    headers: HEADERS,
    payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) },
  });
  return response.json() as {
    result?: Record<string, unknown>;
    error?: { code: number; message: string };
  };
}

function app(core: unknown, connectLink = true) {
  const created = createTestApp({
    core: core as never,
    ...(connectLink
      ? {
          projectMcp: {
            connectLink: ({ token }: { token: string }) =>
              `https://work.test/connect/${token}`,
          },
        }
      : {}),
  });
  apps.push(created);
  return created;
}

describe("connections on the project MCP for a member's own agent (ADR 0316)", () => {
  it("lists each usable alias's actions as native tools, in the default Environment", async () => {
    const { core, listActions } = fakeCore();
    const { result } = await rpc(app(core), "tools/list");
    const tools = result?.tools as Array<Record<string, unknown>>;
    const tool = tools.find(
      (candidate) => candidate.name === "tracker__issues_list",
    );
    expect(tool).toMatchObject({
      description: "tracker: List issues",
      inputSchema: { type: "object" },
      annotations: { readOnlyHint: true },
    });
    expect(
      tools.some((candidate) => String(candidate.name).startsWith("billing__")),
    ).toBe(false);
    expect(listActions).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: PROJECT_ID,
        environment: "company",
        alias: "tracker",
      }),
    );
  });

  it("calls through the broker as the member and returns an MCP result unchanged", async () => {
    const { core, invoke } = fakeCore();
    const { result } = await rpc(
      app(core),
      "tools/call",
      { name: "tracker__issues_list", arguments: { state: "open" } },
      "?environment=company",
    );
    expect(result).toEqual(MCP_RESULT);
    expect(invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: expect.objectContaining({ externalUserId: "member-1" }),
        projectId: PROJECT_ID,
        environment: "company",
        alias: "tracker",
        action: "issues.list",
        input: { state: "open" },
        caller: "member",
      }),
    );
    expect(JSON.stringify(invoke.mock.calls)).not.toContain("allocationId");
  });

  it("offers a connect tool and link when the member has not connected", async () => {
    const { core, offerConnection } = fakeCore({ memberReady: false });
    const served = app(core);
    const listed = await rpc(served, "tools/list");
    const names = ((listed.result?.tools ?? []) as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(names).toContain("tracker__connect");
    const { result } = await rpc(served, "tools/call", {
      name: "tracker__connect",
      arguments: {},
    });
    expect(JSON.stringify(result)).toContain(
      "https://work.test/connect/offer-token",
    );
    expect(offerConnection).toHaveBeenCalledWith(
      expect.objectContaining({ environment: "company", alias: "tracker" }),
    );
  });

  it("answers a call whose account went away with a connect link", async () => {
    const { core } = fakeCore({
      invokeError: new AuthenticationRequiredError("company", [
        {
          alias: "tracker",
          providerKind: "tracker-mcp",
          principalKinds: ["member"],
        },
      ]),
    });
    const { result } = await rpc(app(core), "tools/call", {
      name: "tracker__issues_list",
      arguments: {},
    });
    expect(JSON.stringify(result)).toContain("connect/offer-token");
  });

  it("returns a refusal as a readable tool error and hides other failures", async () => {
    const denied = fakeCore({
      invokeError: new ConnectionActionDeniedError("the query reads every row"),
    });
    const refused = await rpc(app(denied.core), "tools/call", {
      name: "tracker__issues_list",
      arguments: {},
    });
    expect(refused.result).toMatchObject({ isError: true });
    expect(JSON.stringify(refused.result)).toContain("reads every row");

    const failed = fakeCore({ invokeError: new Error("upstream token abc") });
    const opaque = await rpc(app(failed.core), "tools/call", {
      name: "tracker__issues_list",
      arguments: {},
    });
    expect(JSON.stringify(opaque.result)).not.toContain("token abc");
  });

  it("serves a role that grants only connections its connections and nothing else", async () => {
    const { core } = fakeCore();
    const served = createTestApp({
      core: core as never,
      identity: () => ({
        tenantId: "tenant-1",
        externalUserId: "member-1",
        scope: [],
        connectionScope: [
          { projectId: PROJECT_ID, environment: "company", alias: "tracker" },
        ],
      }),
    });
    apps.push(served);
    const { result } = await rpc(served, "tools/list");
    const names = ((result?.tools ?? []) as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(names).toEqual(["tracker__issues_list"]);
    const init = await rpc(served, "initialize", {
      protocolVersion: "2025-06-18",
    });
    expect(String(init.result?.instructions)).toContain("<alias>__connect");
    expect(String(init.result?.instructions)).not.toContain("project_overview");
    const outsider = createTestApp({
      core: core as never,
      identity: () => ({
        tenantId: "tenant-1",
        externalUserId: "x",
        scope: [],
      }),
    });
    apps.push(outsider);
    const refused = await outsider.inject({
      method: "POST",
      url: `/api/projects/${PROJECT_ID}/mcp`,
      headers: HEADERS,
      payload: { jsonrpc: "2.0", id: 1, method: "tools/list" },
    });
    expect(refused.statusCode).toBe(404);
  });

  it("names colliding tools by their own alias and action, never by listing order", async () => {
    const { core } = fakeCore();
    const colliding = {
      ...core,
      connections: {
        ...core.connections,
        listBindings: async () =>
          ["a", "a__x"].map((alias) => ({
            environment: "company",
            alias,
            provider: "tracker-mcp",
            principal: "member",
            service: null,
            capabilities: null,
            memberConnection: { connectionId: alias, status: "ready" },
            serviceConnection: null,
          })),
      },
      connectionBroker: {
        ...core.connectionBroker,
        listActions: async (input: { alias: string }) => [
          {
            name: input.alias === "a" ? "x__y" : "y",
            inputSchema: { type: "object" },
          },
        ],
      },
    };
    const { result } = await rpc(app(colliding), "tools/list");
    const names = ((result?.tools ?? []) as Array<{ name: string }>)
      .map((tool) => tool.name)
      .filter((name) => name.startsWith("a__"));
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2);
    expect(names.every((name) => /^a__x__y_[0-9a-f]{8}$/.test(name))).toBe(
      true,
    );
  });

  it("serves no connection tools to a Work session, which holds its own grants", async () => {
    const { core, listActions } = fakeCore();
    const { result } = await rpc(
      app(core),
      "tools/list",
      undefined,
      "?sessionId=session-1",
    );
    const names = ((result?.tools ?? []) as Array<{ name: string }>).map(
      (tool) => tool.name,
    );
    expect(names.some((name) => name.startsWith("tracker__"))).toBe(false);
    expect(listActions).not.toHaveBeenCalled();
  });
});
