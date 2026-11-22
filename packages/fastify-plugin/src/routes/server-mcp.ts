import type { CatamorphicCore, Identity } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { mayCallTool, mcpStateSecret, withheldTools } from "../mcp-scopes.js";
import { type McpTool, serveMcp } from "../mcp-server.js";
import { toolError, toolValue } from "../mcp-shared.js";
import { sessionMcp } from "../session-mcp.js";

/**
 * The server's own MCP endpoint (ADR 0347): the one address a person
 * gives their agent. It serves `project_list` and the session operations
 * with the project as an argument, so one connection starts, watches and
 * answers chats in every project its person may use. A project's own
 * endpoint (`/projects/:projectId/mcp`) adds that project's documents,
 * program and workflows, with the same chat tools bound to it.
 */

/**
 * What every client is told first. The first 512 characters stand alone:
 * some clients read no further.
 */
export const SERVER_MCP_INSTRUCTIONS =
  "Work runs coding agents on this server as you. Start one with session_start (it returns a sessionId at once), keep working, then call session_wait with the returned cursor until state is idle, failed or needs_input. needs_input lists requests: answer questions with session_answer; approvals go to your person. Read replies, typed results and pull requests with session_read. Steer with session_send, stop with session_interrupt. Retry any call with the same idempotencyKey.\n\nproject_list names the projects you may use and their agents: pass a project's id as project to session_start and session_list. Every chat tool answers with the chat's state (working, needs_input, idle, failed or closed) and a cursor. A wait returns within 50 seconds; changed false means nothing happened yet, so call it again with the same cursor. A project's own endpoint, at /projects/<id>/mcp beside this one, adds its documents, program and workflows.";

const ProjectListOutput = z.object({
  projects: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      /** The agents a chat can start on, by the id session_start takes. */
      agents: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          default: z.boolean().optional(),
        }),
      ),
    }),
  ),
});

function projectListTool(core: CatamorphicCore, identity: Identity): McpTool {
  return {
    definition: {
      name: "project_list",
      title: "List projects",
      description:
        "List the projects you may use on this server, each with the agents you can start a chat on. Use it first: session_start and session_list take a project's id. Next: session_start.",
      inputSchema: { type: "object", properties: {} },
      outputSchema: z.toJSONSchema(ProjectListOutput),
      annotations: {
        title: "List projects",
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    scope: "work:read",
    call: async () => {
      try {
        const { items } = await core.projects.list(identity, { limit: 100 });
        const projects = [];
        for (const project of items) {
          // A project whose agents the caller may not see lists none.
          const catalog = await core.agentSessions
            ?.catalog({ identity, projectId: project.id })
            .catch(() => undefined);
          projects.push({
            id: project.id,
            name: project.name,
            agents: (catalog?.items ?? [])
              .filter((agent) => agent.available)
              .map((agent) => ({
                id: agent.id,
                name: agent.name,
                ...(agent.description
                  ? { description: agent.description }
                  : {}),
                ...(agent.id === catalog?.defaultAgentId
                  ? { default: true }
                  : {}),
              })),
          });
        }
        return toolValue(ProjectListOutput.parse({ projects }));
      } catch (error) {
        return toolError(
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

export function registerServerMcpRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  // Stateless Streamable HTTP: no server-initiated stream, no session to end.
  const notAllowed = async (_request: unknown, reply: FastifyReply) =>
    reply.status(405).header("allow", "POST").send();
  app.get("/mcp", notAllowed);
  app.delete("/mcp", { config: { tokenScope: "work:read" } }, notAllowed);

  app.post(
    "/mcp",
    { config: { tokenScope: "work:read" } },
    async (request, reply) => {
      const core = ctx.core;
      if (!core)
        return reply.status(503).send({ error: "Service not configured" });
      if (!ctx.features.mcp)
        return reply
          .status(404)
          .send({ error: "MCP is turned off on this server" });
      const identity = resolveIdentity(request);
      const chats = sessionMcp({
        core,
        identity,
        stateSecret: mcpStateSecret(ctx),
      });
      const all: McpTool[] = [
        projectListTool(core, identity),
        ...(chats?.tools ?? []),
      ];
      return serveMcp({
        request,
        reply,
        ...(ctx.mcp?.resourceMetadataUrl
          ? { resourceMetadataUrl: ctx.mcp.resourceMetadataUrl }
          : {}),
        endpoint: {
          serverInfo: {
            version: "1.0.0",
            ...(ctx.projectMcp?.serverInfo ?? {
              name: "catamorphic",
              title: "Catamorphic",
            }),
          },
          instructions: async () => SERVER_MCP_INSTRUCTIONS,
          tools: async () => all.filter((tool) => mayCallTool(identity, tool)),
          withheld: async () => withheldTools(identity, all),
          ...(chats ? { resources: chats.resources, tasks: chats.tasks } : {}),
        },
      });
    },
  );
}
