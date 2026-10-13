import type { CatamorphicCore, Identity } from "@catamorphic/core";
import {
  forwardedTool,
  forwardedToolResult,
  handleMcpPost,
  McpRequestError,
  negotiateProtocolVersion,
} from "@catamorphic/fastify-plugin";
import type { McpToolInfo } from "@catamorphic/mcp";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { McpAppsService } from "../mcp-apps.js";
import { connectorToolPermitted } from "./agent-mcp-policy.js";
import type { DesktopAgentRegistry } from "./agent-registry.js";

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

const ParamsSchema = z.object({
  projectId: z.string().min(1),
  sessionId: z.string().min(1),
  server: z.string().min(1),
});

const CallSchema = z.object({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

/**
 * Each of a chat's profile connectors as an MCP server of its own, for a
 * harness that searches its tools (ADR 0225). The host's pooled client
 * calls the connector, so its credentials stay in this process, and its
 * tools and results reach the harness as the connector declared and sent
 * them. A tool any layer denies, or a write for a contained agent, is
 * neither listed nor called; asks are the runner's, as for every MCP
 * server (ADR 0054).
 */
export function registerConnectorMcpRoute(
  app: FastifyInstance,
  deps: {
    core(): CatamorphicCore;
    agents: DesktopAgentRegistry;
    mcpApps: McpAppsService;
    identity: Identity;
  },
): void {
  app.post(
    "/desktop/projects/:projectId/agent-sessions/:sessionId/connectors/:server/mcp",
    async (request, reply) => {
      const params = ParamsSchema.parse(request.params);
      const session = await deps
        .core()
        .agentSessions?.toolContextForSession({
          identity: deps.identity,
          projectId: params.projectId,
          sessionId: params.sessionId,
        })
        .catch(() => undefined);
      const agentId =
        session?.agentId ?? deps.agents.defaultAgentId(params.projectId);
      const surface =
        session && agentId ? deps.agents.capabilitySurface(agentId) : undefined;
      if (
        !surface?.connectorsMounted ||
        !surface.mcp.connectionIds[params.server] ||
        surface.mcp.nativeServers?.[params.server]
      ) {
        return reply
          .status(404)
          .send({ error: "This chat has no such connector" });
      }
      const layers = [
        ...(surface.mcp.policies[params.server] ?? []),
        ...(session?.toolPolicies?.[params.server] ?? []),
      ];
      const permitted = (tool: McpToolInfo) =>
        connectorToolPermitted({
          layers: layers.length > 0 ? layers : undefined,
          readOnly: surface.readOnly,
          tool,
        });
      const tools = async () =>
        (await deps.mcpApps.tools(surface.profileId, params.server)).filter(
          permitted,
        );
      return handleMcpPost(reply, request.body, async (method, rpc) => {
        switch (method) {
          case "initialize":
            return {
              protocolVersion: negotiateProtocolVersion(rpc.protocolVersion),
              capabilities: { tools: {} },
              serverInfo: { name: params.server, version: "1" },
            };
          case "ping":
            return {};
          case "tools/list":
            return { tools: (await tools()).map(forwardedTool) };
          case "tools/call": {
            const call = CallSchema.safeParse(rpc);
            if (!call.success)
              throw new McpRequestError(-32602, "Invalid tool call");
            const { name, arguments: args } = call.data;
            if (!(await tools()).some((tool) => tool.name === name))
              throw new McpRequestError(-32602, `Unknown tool: ${name}`);
            return forwardedToolResult(
              await deps.mcpApps.callTool(
                surface.profileId,
                `${params.server}/${name}`,
                name,
                args,
              ),
            );
          }
          default:
            throw new McpRequestError(-32601, "Method not found");
        }
      });
    },
  );
}
