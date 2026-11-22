import type {
  CatamorphicCore,
  Identity,
  McpToolMetadata,
  TriggerBindingInfo,
  TriggerFireOutcome,
} from "@catamorphic/core";
import { agentCapabilityTools } from "@catamorphic/sandbox";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { mayCallTool, mcpStateSecret, withheldTools } from "../mcp-scopes.js";
import { type McpTool, serveMcp } from "../mcp-server.js";
import {
  callPollRunTool,
  POLL_RUN_TOOL,
  POLL_RUN_TOOL_DEFINITION,
  toolError,
  toolValue,
} from "../mcp-shared.js";
import { programTools, projectInstructions } from "../project-mcp-program.js";
import {
  allowedWorkflowNames,
  mayUseProject,
  surfaceTools,
} from "../project-mcp-surface.js";
import { sessionMcp } from "../session-mcp.js";

/**
 * MCP server for a project (ADR 0042, ADR 0055): a project's own door for
 * a member's agent. Serves the project's AI-callable workflows (one tool
 * per trigger binding of every kind the host registered under
 * `mcpToolKinds`) beside the documents surface, skills and the session
 * operations (`project-mcp-surface.ts`), everything narrowed to the
 * caller's scope by the core services themselves, and to the scopes of the
 * caller's token (ADR 0347). Workflow tools:
 * the tool's input schema is the binding's frozen per-workflow schema (a
 * hole instantiated by the workflow's own input type), its metadata comes
 * from the binding's constant config, and calling it fires the trigger
 * sync-until-first-wait — a settled run returns its output inline, a run
 * that needs to wait detaches and hands back `{runId}` for the shared
 * `catamorphic_poll_run` tool.
 *
 * Unlike `/apps-mcp` (which serves published apps and their UI resources),
 * this endpoint needs no app: binding a tool kind in workflow code is the
 * whole opt-in. Stateless Streamable HTTP in both protocol eras
 * (`mcp-server.ts`), with the identity model of the rest of the plugin.
 *
 * The workflow's output schema deliberately rides `_meta`, NOT the tool's
 * `outputSchema`: MCP clients validate `structuredContent` against an
 * advertised `outputSchema`, and the detach answer (`{status, runId, …}`)
 * must remain a valid result for every tool.
 */

/**
 * Wall-clock budget a tool call may hold the request before detaching.
 * Deliberately half the MCP SDK's default 60s request timeout, so a
 * budget-detach answer (with its pollable runId) always beats the
 * client-side abort that would lose it.
 */
const TOOL_SYNC_BUDGET_MS = 30_000;

interface ProjectTool {
  name: string;
  kind: string;
  metadata: McpToolMetadata;
  binding: TriggerBindingInfo;
  /**
   * Non-object workflow inputs cannot be MCP tool arguments directly; the
   * tool then takes `{"input": ...}` and unwraps it before firing.
   */
  wrapped: boolean;
}

export function registerProjectMcpRoutes(
  app: FastifyInstance,
  ctx: RouteContext,
) {
  // Stateless Streamable HTTP: no server-initiated stream, no session to end.
  const notAllowed = async (
    _request: unknown,
    reply: import("fastify").FastifyReply,
  ) => reply.status(405).header("allow", "POST").send();
  app.get("/projects/:projectId/mcp", notAllowed);
  app.delete(
    "/projects/:projectId/mcp",
    { config: { tokenScope: "work:read" } },
    notAllowed,
  );

  app.post(
    "/projects/:projectId/mcp",
    { config: { tokenScope: "work:read" } },
    async (request, reply) => {
      const core = ctx.core;
      if (!core) {
        return reply.status(503).send({ error: "Service not configured" });
      }
      if (!ctx.features.mcp) {
        return reply
          .status(404)
          .send({ error: "MCP is turned off on this server" });
      }
      const { projectId } = request.params as { projectId: string };
      const { sessionId, allocationId } = request.query as {
        sessionId?: string;
        allocationId?: string;
      };
      const identity = resolveIdentity(request);
      // Someone the project grants nothing sees no project here at all.
      if (!mayUseProject(identity, projectId)) {
        return reply.status(404).send({ error: "Project not found" });
      }
      const abort = new AbortController();
      reply.raw.once("close", () => abort.abort());
      const gatewayTools = sessionId
        ? agentCapabilityTools(
            core.agentCapabilities.forSession({
              identity,
              projectId,
              sessionId,
              allocationId,
            }),
            abort.signal,
          )
        : [];
      // What the current protocol adds to the chat tools: tasks, questions
      // asked of the client's person, and chats as resources (ADR 0347).
      const chats = sessionMcp({
        core,
        identity,
        projectId,
        ...(sessionId ? { currentSessionId: sessionId } : {}),
        stateSecret: mcpStateSecret(ctx),
      });
      const surface: McpTool[] = [
        ...surfaceTools(core, identity, projectId, ctx.features, sessionId).map(
          (tool) =>
            chats?.tools.find(
              (chat) => chat.definition.name === tool.definition.name,
            ) ?? tool,
        ),
        ...programTools(core, identity, projectId),
        ...(ctx.projectMcp?.tools?.({ identity, projectId }) ?? []).map(
          (tool): McpTool => ({
            definition: tool.definition,
            call: async (args) => {
              try {
                return toolValue(await tool.call(args));
              } catch (error) {
                return toolError(
                  error instanceof Error ? error.message : String(error),
                );
              }
            },
          }),
        ),
      ];
      /** Every tool the caller's roles reach, before its token narrows them. */
      let roster: Promise<McpTool[]> | undefined;
      const allTools = () => {
        roster ??= (async () => {
          const workflows = await loadProjectTools(core, identity, projectId);
          // A workflow tool that claims a surface name wins the name (the
          // project chose it); the surface tool steps aside for this project.
          const taken = new Set(workflows.map((tool) => tool.name));
          return [
            ...gatewayTools.map(
              (tool): McpTool => ({
                definition: {
                  name: tool.name,
                  description: tool.description,
                  inputSchema: z.toJSONSchema(z.object(tool.parameters)),
                },
                call: async (input) => {
                  try {
                    return toolValue(
                      await tool.execute(input, {
                        projectId,
                        sessionId,
                        // An MCP call hears nothing of its turn: it waits
                        // while asked (ADR 0264).
                        stopWaiting: abort.signal,
                      }),
                    );
                  } catch (error) {
                    return toolError(
                      error instanceof Error
                        ? error.message
                        : "Capability failed",
                    );
                  }
                },
              }),
            ),
            ...workflows
              .filter(
                (tool) =>
                  !gatewayTools.some((gateway) => gateway.name === tool.name),
              )
              .map(
                (tool): McpTool => ({
                  definition: toolDefinition(tool),
                  scope: "sessions:run",
                  call: (input) =>
                    callTool(core, identity, projectId, tool.name, input),
                }),
              ),
            ...(workflows.length > 0 || core.mcpToolKinds.length > 0
              ? [
                  {
                    definition: POLL_RUN_TOOL_DEFINITION,
                    call: (input: Record<string, unknown>) =>
                      callPollRunTool(core, identity, input),
                  },
                ]
              : []),
            ...surface.filter(
              (tool) => !taken.has(String(tool.definition.name)),
            ),
          ];
        })();
        return roster;
      };
      const tools = async () =>
        (await allTools()).filter((tool) => mayCallTool(identity, tool));

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
              title: "Catamorphic project",
            }),
          },
          instructions: async () =>
            projectInstructions({
              core,
              identity,
              projectId,
              toolNames: new Set(
                (await tools()).map((tool) => String(tool.definition.name)),
              ),
              ...(ctx.projectMcp?.instructions
                ? { host: ctx.projectMcp.instructions }
                : {}),
            }),
          tools,
          withheld: async () => withheldTools(identity, await allTools()),
          ...(chats ? { resources: chats.resources, tasks: chats.tasks } : {}),
        },
      });
    },
  );
}

/**
 * The project's tool roster at its production commit: every binding of
 * every registered tool kind, from one scan. Name uniqueness is enforced
 * at deploy scan; the throw here is a backstop for pre-validation commits.
 */
export async function loadProjectTools(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
): Promise<ProjectTool[]> {
  const specs = new Map(core.mcpToolKinds.map((spec) => [spec.kind, spec]));
  if (specs.size === 0) return [];
  const bindings = await core.triggers.list({ identity, projectId });
  // A scoped caller sees only the workflows its scope resolves to (calls are
  // re-checked at trigger time; this keeps the roster from enumerating).
  const allowed = await allowedWorkflowNames(core, identity, projectId);
  const tools = new Map<string, ProjectTool>();
  for (const binding of bindings) {
    const spec = specs.get(binding.kind);
    if (!spec) continue;
    if (allowed && !allowed.has(binding.workflowName)) continue;
    const metadata = spec.tool(binding.config);
    const name = metadata.name ?? binding.workflowName;
    const existing = tools.get(name);
    if (existing || name === POLL_RUN_TOOL) {
      throw new Error(
        `MCP tool name '${name}' is ${existing ? `claimed by both workflow '${existing.binding.workflowName}' and '${binding.workflowName}'` : "reserved"}; redeploy to surface the scan error`,
      );
    }
    tools.set(name, {
      name,
      kind: binding.kind,
      metadata,
      binding,
      wrapped: !isObjectSchema(binding.inputSchema),
    });
  }
  return [...tools.values()];
}

export function toolDefinition(tool: ProjectTool): Record<string, unknown> {
  const notes: string[] = [];
  if (tool.wrapped) notes.push('Pass the workflow input as {"input": ...}.');
  if (tool.binding.canSuspend) {
    notes.push(
      `May detach if the workflow needs to wait; you then get {"runId"} — poll it with ${POLL_RUN_TOOL}.`,
    );
  }
  return {
    name: tool.name,
    description: [tool.metadata.description, ...notes].join(" "),
    inputSchema: tool.wrapped
      ? {
          type: "object",
          properties: {
            input: {
              description: "The workflow's input (JSON)",
              ...(asObject(tool.binding.inputSchema) ?? {}),
            },
          },
          required: ["input"],
        }
      : tool.binding.inputSchema,
    ...(tool.metadata.annotations
      ? { annotations: tool.metadata.annotations }
      : {}),
    _meta: {
      catamorphic: {
        canSuspend: tool.binding.canSuspend,
        // Introspection only — see the module doc for why this is not the
        // tool's `outputSchema`.
        outputSchema: tool.binding.outputSchema,
      },
    },
  };
}

export async function callTool(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === POLL_RUN_TOOL) {
    return callPollRunTool(core, identity, args);
  }

  const tools = await loadProjectTools(core, identity, projectId);
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) return toolError(`Unknown tool: ${name}`);

  const payload = tool.wrapped ? (args.input ?? null) : args;
  let outcome: TriggerFireOutcome;
  try {
    const result = await core.triggers.fire({
      identity,
      projectId,
      kind: tool.kind,
      payload: payload as never,
      // Always sync: a tool call wants its answer inline. A kind that
      // disallows sync fails loudly here rather than silently degrading.
      mode: "sync",
      interactive: true,
      workflows: [tool.binding.workflowName],
      budgetMs: TOOL_SYNC_BUDGET_MS,
    });
    const first = result.runs[0];
    if (!first) {
      return toolError(
        `Workflow '${tool.binding.workflowName}' is not bound at the current production commit`,
      );
    }
    outcome = first;
  } catch (error) {
    // Run-input validation failures, binding-scan failures, enrollment
    // conflicts — all model-actionable, so they ride the tool-error
    // channel instead of failing the JSON-RPC request.
    return toolError(
      error instanceof Error ? error.message : "Workflow trigger failed",
    );
  }

  switch (outcome.status) {
    case "completed":
      return toolValue(outcome.output);
    case "failed":
      return toolError(outcome.error);
    case "suspended":
      return toolValue({
        status: "running",
        runId: outcome.runId,
        suspendedOn: outcome.suspendedOn,
        note: `Still running; poll with ${POLL_RUN_TOOL}.`,
      });
    case "started":
      return toolValue({
        status: "running",
        runId: outcome.runId,
        note: `Started asynchronously; poll with ${POLL_RUN_TOOL}.`,
      });
  }
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isObjectSchema(schema: unknown): boolean {
  return asObject(schema)?.type === "object";
}
