import http from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectMcpServer } from "../client.js";
import {
  defineMcpConnectionProvider,
  mcpToolActions,
} from "../connection-provider.js";

const LOOKUP = {
  name: "lookup",
  title: "Look up a person",
  description: "Find one person by name",
  inputSchema: {
    type: "object",
    properties: { name: { type: "string" } },
    required: ["name"],
  },
  outputSchema: {
    type: "object",
    properties: { name: { type: "string" }, born: { type: "number" } },
    required: ["name", "born"],
  },
  annotations: { readOnlyHint: true },
};

let server: http.Server;
let url = "";

beforeAll(async () => {
  server = http.createServer(async (request, response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    const mcp = new Server(
      { name: "people", version: "0.0.1" },
      { capabilities: { tools: {} } },
    );
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [LOOKUP],
    }));
    mcp.setRequestHandler(CallToolRequestSchema, async () => ({
      content: [{ type: "text", text: '{"name":"Ada","born":1815}' }],
      structuredContent: { name: "Ada", born: 1815 },
    }));
    response.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    let body = "";
    for await (const chunk of request) body += chunk;
    await transport.handleRequest(
      request,
      response,
      body ? JSON.parse(body) : undefined,
    );
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});

afterAll(() => {
  server.close();
  server.closeAllConnections();
});

describe("MCP tools as their server declared them (ADR 0225)", () => {
  it("keeps each tool's title and output schema", async () => {
    const connected = await connectMcpServer({ transport: "http", url });
    try {
      expect(connected.tools).toEqual([
        {
          name: LOOKUP.name,
          title: LOOKUP.title,
          description: LOOKUP.description,
          inputSchema: LOOKUP.inputSchema,
          outputSchema: LOOKUP.outputSchema,
          annotations: LOOKUP.annotations,
        },
      ]);
      await expect(
        connected.callToolRaw("lookup", { name: "Ada" }),
      ).resolves.toMatchObject({
        structuredContent: { name: "Ada", born: 1815 },
      });
    } finally {
      await connected.close();
    }
  });

  it("lists only granted tools as connection actions, schemas included", async () => {
    const connected = await connectMcpServer({ transport: "http", url });
    try {
      expect(mcpToolActions(connected.tools, ["lookup"])).toEqual([
        {
          name: LOOKUP.name,
          title: LOOKUP.title,
          description: LOOKUP.description,
          inputSchema: LOOKUP.inputSchema,
          outputSchema: LOOKUP.outputSchema,
          annotations: LOOKUP.annotations,
        },
      ]);
      expect(mcpToolActions(connected.tools, [])).toEqual([]);
    } finally {
      await connected.close();
    }
  });

  it("marks MCP connection providers, whose results agents get unchanged", () => {
    const provider = defineMcpConnectionProvider({
      kind: "people",
      displayName: "People",
      server: { transport: "http", url },
    });
    expect(provider.mcp).toBe(true);
  });
});
