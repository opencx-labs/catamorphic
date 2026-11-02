import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CatamorphicCore, Identity } from "@catamorphic/core";
import {
  McpRequestError,
  serveForwardedTools,
  toolError,
} from "@catamorphic/fastify-plugin/mcp";
import {
  type McpToolInfo,
  mcpConnectionLost,
  mcpServerError,
} from "@catamorphic/mcp";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  assertConnectorCallUnchanged,
  assertConnectorTool,
  connectorCallSnapshot,
  liveConnectorContext,
} from "../mcp-app-view-authorization.js";
import type { McpAppsService } from "../mcp-apps.js";
import {
  connectorToolPermitted,
  decideHostToolCall,
} from "./agent-mcp-policy.js";
import type { DesktopAgentRegistry } from "./agent-registry.js";

const tracer = getTracer("@catamorphic/desktop");

const ROUTE =
  "/desktop/projects/:projectId/agent-sessions/:sessionId/connectors/:server/mcp";

/** Where a chat's harness reaches one of its connectors (ADR 0225). */
export function connectorMcpPath(input: {
  projectId: string;
  sessionId: string;
  server: string;
}): string {
  return [
    "/desktop/projects",
    encodeURIComponent(input.projectId),
    "agent-sessions",
    encodeURIComponent(input.sessionId),
    "connectors",
    encodeURIComponent(input.server),
    "mcp",
  ].join("/");
}

/**
 * One bearer per chat for this run of the desktop: the same for every turn
 * (a warm harness keeps its configuration, ADR 0222) and unguessable from
 * the session id, so knowing a chat's address reaches none of its
 * connectors. Like the rest of the loopback API, it trusts the person's own
 * programs, which can read a harness's arguments.
 */
export function connectorMcpTokens() {
  const key = randomBytes(32);
  const token = (sessionId: string) =>
    createHmac("sha256", key).update(sessionId).digest("base64url");
  return {
    token,
    matches(sessionId: string, authorization: string | undefined): boolean {
      const expected = Buffer.from(`Bearer ${token(sessionId)}`);
      const actual = Buffer.from(authorization ?? "");
      return (
        expected.length === actual.length && timingSafeEqual(expected, actual)
      );
    },
  };
}

const ParamsSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  server: z.string().min(1),
});

/**
 * Each of a chat's profile connectors as an MCP server of its own, for a
 * harness that searches its tools (ADR 0225). The host's pooled client
 * calls the connector, so its credentials stay in this process, and its
 * tools and results reach the harness as the connector declared and sent
 * them. Policy is decided here, as in the capability catalog, so no
 * harness permission mode can skip an ask: a tool any layer denies, or a
 * write for a contained agent, is neither listed nor called, and an ask
 * waits for the person inside the call.
 */
export function registerConnectorMcpRoute(
  app: FastifyInstance,
  deps: {
    core(): CatamorphicCore;
    agents: DesktopAgentRegistry;
    mcpApps: McpAppsService;
    identity: Identity;
    tokens: ReturnType<typeof connectorMcpTokens>;
  },
): void {
  // Stateless Streamable HTTP: no server-initiated stream, no session to end.
  for (const method of ["GET", "DELETE"] as const) {
    app.route({
      method,
      url: ROUTE,
      handler: async (_request, reply) =>
        reply.status(405).header("allow", "POST").send(),
    });
  }
  app.post(ROUTE, async (request, reply) => {
    const params = ParamsSchema.parse(request.params);
    if (!deps.tokens.matches(params.sessionId, request.headers.authorization))
      return reply.status(401).send({ error: "Invalid connector token" });
    const core = deps.core();
    const server = params.server;
    const context = () =>
      liveConnectorContext({
        ...deps,
        core,
        projectId: params.projectId,
        sessionId: params.sessionId,
        server,
      });
    const initial = await context().catch(() => undefined);
    if (!initial?.mounted) {
      return reply
        .status(404)
        .send({ error: "This chat has no such connector" });
    }
    const connectionIdentity = deps.mcpApps.connectionIdentity(
      initial.profileId,
      server,
      initial.connectionId,
    );
    const live = async () => {
      const current = await context();
      if (
        !current.mounted ||
        current.profileId !== initial.profileId ||
        current.connectionId !== initial.connectionId ||
        current.agentId !== initial.agentId ||
        deps.mcpApps.connectionIdentity(
          current.profileId,
          server,
          current.connectionId,
        ) !== connectionIdentity
      )
        throw new McpRequestError(-32_000, "The chat connector changed");
      return { ...current, connectionIdentity };
    };
    const tools = async (): Promise<McpToolInfo[]> => {
      try {
        await live();
        const roster = await deps.mcpApps.tools(
          initial.profileId,
          server,
          initial.connectionId,
          connectionIdentity,
        );
        const current = await live();
        return roster.filter((tool) =>
          connectorToolPermitted({
            layers: current.layers,
            // A read-only chat only reads, whatever its agent (ADR 0271).
            readOnly: current.readOnly,
            tool,
          }),
        );
      } catch (error) {
        console.warn(`[desktop] Connector ${server} is unavailable`, error);
        throw new McpRequestError(-32_000, `${server} is unavailable`);
      }
    };
    const abort = new AbortController();
    reply.raw.on("close", () => abort.abort());
    return serveForwardedTools({
      reply,
      body: request.body,
      serverName: server,
      listTools: tools,
      callTool: (call) =>
        withSpan(
          {
            tracer,
            name: "catamorphic.connector.call",
            attributes: {
              "catamorphic.project.id": params.projectId,
              "catamorphic.agent.session.id": params.sessionId,
              "catamorphic.connection.alias": server,
              "catamorphic.connection.action": call.name,
            },
          },
          async () => {
            const tool = (await tools()).find(
              (candidate) => candidate.name === call.name,
            );
            if (!tool)
              throw new McpRequestError(-32602, `Unknown tool: ${call.name}`);
            const before = await live();
            assertConnectorTool({
              context: before,
              tool,
              args: call.arguments,
            });
            const snapshot = connectorCallSnapshot(before, tool);
            const verdict = await decideHostToolCall({
              core,
              sessionId: params.sessionId,
              server,
              tool: tool.name,
              input: call.arguments,
              layers: before.layers,
              annotations: tool.annotations,
              signal: abort.signal,
            });
            if (!verdict.allowed) return toolError(verdict.message);
            try {
              const result = await deps.mcpApps.callTool(
                before.profileId,
                `${server}/${tool.name}`,
                tool.name,
                call.arguments,
                {
                  connectionId: before.connectionId,
                  connectionIdentity,
                  beforeCall: async (currentTool) => {
                    abort.signal.throwIfAborted();
                    const after = await live();
                    assertConnectorTool({
                      context: after,
                      tool: currentTool,
                      args: call.arguments,
                    });
                    assertConnectorCallUnchanged({
                      before: snapshot,
                      after,
                      currentTool,
                    });
                  },
                },
              );
              abort.signal.throwIfAborted();
              const roster = await deps.mcpApps.tools(
                before.profileId,
                server,
                before.connectionId,
                connectionIdentity,
              );
              const after = await live();
              const currentTool = roster.find(
                (entry) => entry.name === call.name,
              );
              if (!currentTool) throw new Error(`Unknown tool: ${call.name}`);
              assertConnectorTool({
                context: after,
                tool: currentTool,
                args: call.arguments,
              });
              assertConnectorCallUnchanged({
                before: snapshot,
                after,
                currentTool,
              });
              return result;
            } catch (error) {
              // The server's own error reaches the agent as it sent it, so
              // the agent can correct its arguments; a lost connection reads
              // generically; anything else (a timeout, an invalid result)
              // is the call's failed result.
              const sent = mcpServerError(error);
              if (sent) throw new McpRequestError(sent.code, sent.message);
              if (mcpConnectionLost(error)) {
                console.warn(
                  `[desktop] Connector ${server} call failed`,
                  error,
                );
                throw new McpRequestError(-32_000, `${server} is unavailable`);
              }
              return toolError(
                error instanceof Error
                  ? error.message
                  : `${server} call failed`,
              );
            }
          },
        ),
    });
  });
}
