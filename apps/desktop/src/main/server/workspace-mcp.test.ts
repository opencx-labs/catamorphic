import type { ExtraTool } from "@catamorphic/sandbox";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createWorkspaceMcpServer,
  registerWorkspaceMcpRoute,
  workspaceMcpAuthorizationMatches,
  workspaceMcpCapability,
} from "./workspace-mcp.js";

describe("workspace MCP", () => {
  it("exposes filtered tools bound to the route session context", async () => {
    const tools: ExtraTool[] = [
      {
        name: "where_am_i",
        description: "Return the bound session",
        parameters: { suffix: z.string() },
        execute: async (input, context) => ({
          value: `${context.projectId}/${context.sessionId}/${input.suffix}`,
        }),
      },
    ];
    const server = createWorkspaceMcpServer(tools, {
      projectId: "project",
      sessionId: "session",
    });
    const client = new Client({ name: "test", version: "1" });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
      "where_am_i",
    ]);
    const result = await client.callTool({
      name: "where_am_i",
      arguments: { suffix: "ok" },
    });
    expect(result.content).toEqual([
      {
        type: "text",
        text: '{\n  "value": "project/session/ok"\n}',
      },
    ]);
    await client.close();
    await server.close();
  });

  it("serves tools over the stateless loopback HTTP route", async () => {
    const secret = Buffer.from("workspace-mcp-test-secret");
    const tools: ExtraTool[] = [
      {
        name: "session_identity",
        description: "Return the bound session identity",
        parameters: {},
        execute: async (_input, context) => ({
          projectId: context.projectId,
          sessionId: context.sessionId,
        }),
      },
    ];
    const app = Fastify();
    registerWorkspaceMcpRoute(
      app,
      async ({ projectId, sessionId, agentId, authorization }) =>
        agentId === "codex" &&
        workspaceMcpAuthorizationMatches({
          secret,
          projectId,
          sessionId,
          agentId,
          authorization,
        })
          ? { tools, context: { projectId, sessionId } }
          : null,
    );
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected Fastify to listen on a TCP port");
    }
    const client = new Client({ name: "http-test", version: "1" });
    const url = new URL(
      `http://127.0.0.1:${address.port}/desktop/workspace-mcp/project/session/codex`,
    );
    const unauthorized = await app.inject({ method: "GET", url: url.pathname });
    expect(unauthorized.statusCode).toBe(404);
    const capability = workspaceMcpCapability({
      secret,
      projectId: "project",
      sessionId: "session",
      agentId: "codex",
    });
    const crossSession = await app.inject({
      method: "GET",
      url: "/desktop/workspace-mcp/project/other-session/codex",
      headers: { authorization: `Bearer ${capability}` },
    });
    expect(crossSession.statusCode).toBe(404);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${capability}` } },
    });

    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ["session_identity"],
      );
      expect(
        await client.callTool({ name: "session_identity", arguments: {} }),
      ).toMatchObject({
        content: [
          {
            type: "text",
            text: '{\n  "projectId": "project",\n  "sessionId": "session"\n}',
          },
        ],
      });
    } finally {
      await client.close();
      await app.close();
    }
  });
});
