import {
  ConnectionActionDeniedError,
  ConnectionActionRefusedError,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import {
  forwardedTool,
  forwardedToolResult,
  handleMcpPost,
  McpRequestError,
  negotiateProtocolVersion,
  toolError,
  toolValue,
} from "../mcp-shared.js";

/**
 * One brokered connection as an agent's MCP server (`connection_<alias>`).
 * An MCP connection's tools and results pass through as its server sent
 * them; other connections' actions answer as JSON tool results (ADR 0225).
 */
export function registerConnectionMcpRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  app.post(
    "/connection-mcp",
    { config: { public: true } },
    async (request, reply) => {
      const grants = ctx.core?.connectionGrants;
      const broker = ctx.core?.connectionBroker;
      if (!grants || !broker || !ctx.core) {
        return reply
          .status(503)
          .send({ error: "Connection broker not configured" });
      }
      const token = bearer(request.headers.authorization);
      const grant = token ? await grants.validate({ token }) : null;
      if (!grant)
        return reply.status(401).send({ error: "Invalid connection grant" });
      const identity = {
        tenantId: grant.tenantId,
        externalUserId: `connection-grant:${grant.agentSessionId ?? grant.allocationId}`,
      };
      const allocation = await ctx.core.executionAllocations.get({
        identity,
        allocationId: grant.allocationId,
      });
      const binding = allocation?.policy.connections?.find(
        (candidate) => candidate.alias === grant.alias,
      );
      if (allocation?.status !== "active" || !binding) {
        return reply
          .status(401)
          .send({ error: "Connection grant is no longer active" });
      }
      return handleMcpPost(reply, request.body, async (method, params) => {
        switch (method) {
          case "initialize":
            return {
              protocolVersion: negotiateProtocolVersion(params.protocolVersion),
              capabilities: { tools: {} },
              serverInfo: {
                name: "catamorphic-connection-broker",
                version: "1",
              },
            };
          case "ping":
            return {};
          case "tools/list": {
            try {
              const actions = await broker.listActions({
                identity,
                allocationId: allocation.id,
                alias: binding.alias,
              });
              return { tools: actions.map(forwardedTool) };
            } catch {
              throw new McpRequestError(-32_000, "Connection action failed");
            }
          }
          case "tools/call": {
            const name = typeof params.name === "string" ? params.name : "";
            if (!binding.capabilities.includes(name)) {
              throw new McpRequestError(
                -32602,
                "Tool is outside the connection grant",
              );
            }
            try {
              const output = await broker.invoke({
                identity,
                allocationId: allocation.id,
                alias: binding.alias,
                action: name,
                input: toJson(params.arguments),
                caller: "agent",
                ...(grant.agentSessionId
                  ? { agentSessionId: grant.agentSessionId }
                  : {}),
              });
              return broker.servesMcp(binding.providerKind)
                ? forwardedToolResult(output)
                : toolValue(output);
            } catch (error) {
              // A policy refusal is information the agent can act on (narrow
              // the query, ask differently); other failures stay opaque.
              if (
                error instanceof ConnectionActionDeniedError ||
                error instanceof ConnectionActionRefusedError
              ) {
                return toolError(error.message);
              }
              throw new McpRequestError(-32_000, "Connection action failed");
            }
          }
          default:
            throw new McpRequestError(-32601, "Method not found");
        }
      });
    },
  );
}

function bearer(value: string | undefined): string | undefined {
  return value?.match(/^Bearer\s+(.+)$/i)?.[1];
}

function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}
