import { createHmac, timingSafeEqual } from "node:crypto";
import type { ExtraTool, ExtraToolContext } from "@catamorphic/sandbox";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

export function workspaceMcpCapability(input: {
  secret: Uint8Array;
  projectId: string;
  sessionId: string;
  agentId: string;
}): string {
  const hmac = createHmac("sha256", input.secret);
  hmac.update("catamorphic-workspace-mcp-v1");
  for (const value of [input.projectId, input.sessionId, input.agentId]) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(Buffer.byteLength(value));
    hmac.update(length);
    hmac.update(value);
  }
  return hmac.digest("base64url");
}

export function workspaceMcpAuthorizationMatches(input: {
  secret: Uint8Array;
  projectId: string;
  sessionId: string;
  agentId: string;
  authorization: string | undefined;
}): boolean {
  const presented = input.authorization?.match(
    /^Bearer ([A-Za-z0-9_-]+)$/,
  )?.[1];
  if (!presented) return false;
  const expectedBytes = Buffer.from(workspaceMcpCapability(input));
  const presentedBytes = Buffer.from(presented);
  return (
    expectedBytes.length === presentedBytes.length &&
    timingSafeEqual(expectedBytes, presentedBytes)
  );
}

export function createWorkspaceMcpServer(
  tools: ExtraTool[],
  context: ExtraToolContext,
): Server {
  const server = new Server(
    { name: "catamorphic-workspace", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: z.toJSONSchema(z.object(tool.parameters as z.ZodRawShape), {
        io: "input",
      }),
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name);
    if (!tool) {
      return {
        content: [{ type: "text", text: "Unknown workspace tool" }],
        isError: true,
      };
    }
    try {
      const result = await tool.execute(
        request.params.arguments ?? {},
        context,
      );
      return {
        content: [{ type: "text", text: stringifyResult(result) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: error instanceof Error ? error.message : String(error),
          },
        ],
        isError: true,
      };
    }
  });
  return server;
}

export function registerWorkspaceMcpRoute(
  app: FastifyInstance,
  resolve: (input: {
    projectId: string;
    sessionId: string;
    agentId: string;
    authorization: string | undefined;
  }) => Promise<{ tools: ExtraTool[]; context: ExtraToolContext } | null>,
): void {
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/desktop/workspace-mcp/:projectId/:sessionId/:agentId",
    handler: async (request, reply) => {
      const params = request.params as {
        projectId: string;
        sessionId: string;
        agentId: string;
      };
      const resolved = await resolve({
        ...params,
        authorization: request.headers.authorization,
      });
      if (!resolved) return reply.status(404).send({ error: "Not found" });

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      const server = createWorkspaceMcpServer(resolved.tools, resolved.context);
      reply.hijack();
      reply.raw.on("close", () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  });
}

function stringifyResult(result: unknown): string {
  if (typeof result === "string") return result;
  return JSON.stringify(result, null, 2) ?? String(result);
}
