import {
  ConnectionActionDeniedError,
  ConnectionActionRefusedError,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import {
  McpRequestError,
  serveForwardedTools,
  toolError,
  toolValue,
} from "../mcp-shared.js";

/**
 * One brokered connection as an agent's MCP server (`connection_<alias>`).
 * An MCP connection's tools and results pass through as its server
 * declared and sent them; other connections' actions answer as JSON tool
 * results and declare no output schema (ADR 0225).
 */
export function registerConnectionMcpRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
): void {
  // Stateless Streamable HTTP: no server-initiated stream, no session to end.
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: "/connection-mcp",
      config: { public: true },
      handler: async (_request, reply) =>
        reply.status(405).header("allow", "POST").send(),
    });
  }
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
      if (grant?.channel !== "mcp")
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
      const mcp = broker.servesMcp(binding.providerKind);
      return serveForwardedTools({
        reply,
        body: request.body,
        serverName: "catamorphic-connection-broker",
        listTools: async () => {
          try {
            const actions = await broker.listActions({
              identity,
              allocationId: allocation.id,
              alias: binding.alias,
              ...(grant.agentSessionId
                ? { agentSessionId: grant.agentSessionId }
                : {}),
            });
            // Only an MCP server's own results match its output schema.
            return mcp
              ? actions
              : actions.map((action) => ({
                  ...action,
                  outputSchema: undefined,
                }));
          } catch {
            throw new McpRequestError(-32_000, "Connection action failed");
          }
        },
        callTool: async (call) => {
          if (!binding.capabilities.includes(call.name)) {
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
              action: call.name,
              input: toJson(call.arguments),
              caller: "agent",
              ...(grant.agentSessionId
                ? { agentSessionId: grant.agentSessionId }
                : {}),
            });
            return mcp ? output : toolValue(output);
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
        },
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
