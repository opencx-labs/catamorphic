import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { z } from "zod";
import {
  type AgentCapabilityGateway,
  agentCapabilityTools,
} from "./agent-capabilities.js";
import { extraToolResult } from "./coding-agent/tool-result.js";

/** Same bootstrap tools over MCP, for subprocess harnesses and host mounts. */
export async function capabilityMcpResponse(args: {
  gateway: AgentCapabilityGateway;
  body: unknown;
  signal?: AbortSignal;
}): Promise<unknown> {
  const call = z
    .object({
      jsonrpc: z.literal("2.0"),
      id: z.union([z.string(), z.number()]).optional(),
      method: z.string(),
      params: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(args.body);
  if (call.id === undefined) return undefined;
  const result = async () => {
    switch (call.method) {
      case "initialize":
        return {
          protocolVersion: "2025-03-26",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "catamorphic-capabilities", version: "1.0.0" },
        };
      case "ping":
        return {};
      case "tools/list":
        return {
          tools: agentCapabilityTools(args.gateway).map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: z.toJSONSchema(z.object(tool.parameters)),
          })),
        };
      case "tools/call": {
        const input = z
          .object({
            name: z.string(),
            arguments: z.record(z.string(), z.unknown()).default({}),
          })
          .parse(call.params);
        const tool = agentCapabilityTools(args.gateway, args.signal).find(
          (item) => item.name === input.name,
        );
        if (!tool) throw new Error("Unknown capability gateway tool");
        try {
          const value = await tool.execute(input.arguments, { projectId: "" });
          return extraToolResult(value);
        } catch (error) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text:
                  error instanceof Error ? error.message : "Capability failed",
              },
            ],
          };
        }
      }
      default:
        throw new Error("Unsupported capability MCP method");
    }
  };
  try {
    return { jsonrpc: "2.0", id: call.id, result: await result() };
  } catch (error) {
    return {
      jsonrpc: "2.0",
      id: call.id,
      error: {
        code: -32602,
        message: error instanceof Error ? error.message : "Invalid request",
      },
    };
  }
}

/** Ephemeral authenticated loopback bridge, closed with the subprocess turn. */
export async function listenAgentCapabilityGateway(
  gateway: AgentCapabilityGateway,
) {
  const token = randomUUID();
  const server = createServer(async (request, response) => {
    if (
      request.headers.authorization !== `Bearer ${token}` ||
      request.headers.origin
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405).end();
      return;
    }
    const abort = new AbortController();
    response.on("close", () => abort.abort());
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > 6 * 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(buffer);
      }
      const value = await capabilityMcpResponse({
        gateway,
        signal: abort.signal,
        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      });
      response
        .writeHead(value === undefined ? 202 : 200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(value === undefined ? undefined : JSON.stringify(value));
    } catch {
      response.writeHead(400).end();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Gateway listener has no TCP address");
  return {
    config: {
      transport: "http" as const,
      url: `http://127.0.0.1:${address.port}/`,
      headers: { authorization: `Bearer ${token}` },
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
