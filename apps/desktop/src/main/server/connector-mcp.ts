import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { CatamorphicCore, Identity } from "@catamorphic/core";
import {
  McpRequestError,
  serveForwardedTools,
  toolError,
} from "@catamorphic/fastify-plugin/mcp";
import type { McpToolInfo } from "@catamorphic/mcp";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
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
 * (a warm harness keeps its configuration, ADR 0222), unguessable from the
 * session id, so one chat's harness, or any other program, cannot reach
 * another chat's connectors.
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
    const session = await core.agentSessions
      ?.toolContextForSession({
        identity: deps.identity,
        projectId: params.projectId,
        sessionId: params.sessionId,
      })
      .catch(() => undefined);
    const agentId =
      session?.agentId ?? deps.agents.defaultAgentId(params.projectId);
    const surface =
      session && agentId ? deps.agents.capabilitySurface(agentId) : undefined;
    const server = params.server;
    if (
      !surface?.connectorsMounted ||
      !surface.mcp.connectionIds[server] ||
      surface.mcp.nativeServers?.[server]
    ) {
      return reply
        .status(404)
        .send({ error: "This chat has no such connector" });
    }
    const merged = [
      ...(surface.mcp.policies[server] ?? []),
      ...(session?.toolPolicies?.[server] ?? []),
    ];
    const layers = merged.length > 0 ? merged : undefined;
    const tools = async (): Promise<McpToolInfo[]> => {
      try {
        return (await deps.mcpApps.tools(surface.profileId, server)).filter(
          (tool) =>
            connectorToolPermitted({
              layers,
              readOnly: surface.readOnly,
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
            const verdict = await decideHostToolCall({
              core,
              sessionId: params.sessionId,
              server,
              tool: tool.name,
              input: call.arguments,
              layers,
              annotations: tool.annotations,
              signal: abort.signal,
            });
            if (!verdict.allowed) return toolError(verdict.message);
            try {
              return await deps.mcpApps.callTool(
                surface.profileId,
                `${server}/${tool.name}`,
                tool.name,
                call.arguments,
              );
            } catch (error) {
              console.warn(`[desktop] Connector ${server} call failed`, error);
              throw new McpRequestError(-32_000, `${server} call failed`);
            }
          },
        ),
    });
  });
}
