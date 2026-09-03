import type {
  CatamorphicCore,
  Identity,
  McpToolMetadata,
  TriggerBindingInfo,
  TriggerFireOutcome,
} from "@catamorphic/core";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  callPollRunTool,
  handleMcpPost,
  McpRequestError,
  negotiateProtocolVersion,
  POLL_RUN_TOOL,
  POLL_RUN_TOOL_DEFINITION,
  toolError,
  toolValue,
} from "../mcp-shared.js";
import { allowedWorkflowNames, surfaceTools } from "../project-mcp-surface.js";

/**
 * MCP server for a project (ADR 0042, ADR 0055): the single "bring your own
 * agent" door. Serves the project's AI-callable workflows — one tool per
 * trigger binding of every kind the host registered under `mcpToolKinds` —
 * beside the documents surface, skills and `ask_agent`
 * (`project-mcp-surface.ts`), everything narrowed to the caller's scope by
 * the core services themselves. Workflow tools:
 * the tool's input schema is the binding's frozen per-workflow schema (a
 * hole instantiated by the workflow's own input type), its metadata comes
 * from the binding's constant config, and calling it fires the trigger
 * sync-until-first-wait — a settled run returns its output inline, a run
 * that needs to wait detaches and hands back `{runId}` for the shared
 * `catamorphic_poll_run` tool.
 *
 * Unlike `/apps-mcp` (which serves published apps and their UI resources),
 * this endpoint needs no app: binding a tool kind in workflow code is the
 * whole opt-in. Stateless Streamable-HTTP JSON-RPC, same era and identity
 * model as the rest of the plugin.
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
  app.post("/projects/:projectId/mcp", async (request, reply) => {
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
    const { sessionId } = request.query as { sessionId?: string };
    const identity = resolveIdentity(request);
    const surface = surfaceTools(
      core,
      identity,
      projectId,
      ctx.features,
      sessionId,
    );

    return handleMcpPost(reply, request.body, async (method, params) => {
      switch (method) {
        case "initialize":
          return {
            protocolVersion: negotiateProtocolVersion(params.protocolVersion),
            capabilities: { tools: { listChanged: false } },
            serverInfo: {
              name: "catamorphic",
              title: "Catamorphic project",
              version: "1.0.0",
            },
          };
        case "ping":
          return {};
        case "tools/list": {
          const tools = await loadProjectTools(core, identity, projectId);
          // A workflow tool that claims a surface name wins the name (the
          // project chose it); the surface tool steps aside for this project.
          const taken = new Set(tools.map((tool) => tool.name));
          return {
            tools: [
              ...tools.map(toolDefinition),
              ...(tools.length > 0 || core.mcpToolKinds.length > 0
                ? [POLL_RUN_TOOL_DEFINITION]
                : []),
              ...surface
                .filter((tool) => !taken.has(String(tool.definition.name)))
                .map((tool) => tool.definition),
            ],
          };
        }
        case "resources/list":
          return { resources: [] };
        case "resources/templates/list":
          return { resourceTemplates: [] };
        case "prompts/list":
          return { prompts: [] };
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args =
            typeof params.arguments === "object" && params.arguments !== null
              ? (params.arguments as Record<string, unknown>)
              : {};
          const workflowTools = await loadProjectTools(
            core,
            identity,
            projectId,
          );
          const surfaced = workflowTools.some((tool) => tool.name === name)
            ? undefined
            : surface.find((tool) => tool.definition.name === name);
          if (surfaced) return surfaced.call(args);
          return callTool(core, identity, projectId, name, args);
        }
        default:
          throw new McpRequestError(-32601, `Method not found: ${method}`);
      }
    });
  });
}

/**
 * The project's tool roster at its production commit: every binding of
 * every registered tool kind, from one scan. Name uniqueness is enforced
 * at deploy scan; the throw here is a backstop for pre-validation commits.
 */
async function loadProjectTools(
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

function toolDefinition(tool: ProjectTool): Record<string, unknown> {
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

async function callTool(
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
