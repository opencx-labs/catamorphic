import { buildAppGuestDocument } from "@catamorphic/app";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import { mayCallTool, withheldTools } from "../mcp-scopes.js";
import { MCP_ERROR, McpError, type McpTool, serveMcp } from "../mcp-server.js";
import {
  callPollRunTool,
  POLL_RUN_TOOL,
  POLL_RUN_TOOL_DEFINITION,
  toolError,
  toolValue,
} from "../mcp-shared.js";

/**
 * MCP server for a project's published apps — the outbound half of MCP
 * Apps support. Any MCP Apps host (Claude, ChatGPT, VS Code, Cursor, …)
 * that connects to `/projects/:projectId/apps-mcp` gets:
 *
 * - one tool per app-callable workflow (the union of the published apps'
 *   frozen `allowed_workflows` sets), each carrying the standard
 *   `_meta.ui.resourceUri` linkage (extension io.modelcontextprotocol/ui);
 * - a `ui://apps/<name>` resource per published app whose HTML embeds the
 *   app's bundle — the `@catamorphic/app` guest runtime detects the MCP
 *   host and speaks `tools/call` back through it;
 * - a `catamorphic_poll_run` tool so durable runs keep their poll loop.
 *
 * Tool calls execute under the caller's identity narrowed to the owning
 * app, so the frozen-workflow-set authorization applies to MCP callers
 * exactly as it does to the in-product iframe.
 *
 * The endpoint is stateless Streamable HTTP on the dispatcher every MCP
 * endpoint shares (`mcp-server.ts`, ADR 0347): the current revision and
 * the handshake revisions on one URL. Requests are independent; no
 * sessions.
 */

const RUN_CALL_BUDGET_MS = 120_000;

interface PublishedApp {
  name: string;
  appId: string;
  versionId: string;
  code: string;
  css: string;
  allowedWorkflows: string[];
  workflowShapes: Record<
    string,
    { inputSchema: unknown; outputSchema: unknown }
  >;
}

export function registerAppsMcpRoutes(app: FastifyInstance, ctx: RouteContext) {
  app.post(
    "/projects/:projectId/apps-mcp",
    { config: { tokenScope: "work:read" } },
    async (request, reply) => {
      const core = ctx.core;
      if (!core?.apps || !core.runs) {
        return reply.status(503).send({ error: "Apps not configured" });
      }
      const { projectId } = request.params as { projectId: string };

      const identity = resolveIdentity(request);
      let loaded: Promise<PublishedApp[]> | undefined;
      const apps = () => {
        loaded ??= loadPublishedApps(core, identity, projectId);
        return loaded;
      };
      const tools = async () =>
        buildTools(await apps()).map(
          (definition): McpTool => ({
            definition,
            scope:
              definition.name === POLL_RUN_TOOL ? "work:read" : "sessions:run",
            call: (args) =>
              callTool(
                core,
                identity,
                projectId,
                String(definition.name),
                args,
              ),
          }),
        );
      return serveMcp({
        request,
        reply,
        resourceMetadataUrl: ctx.mcp?.resourceMetadataUrl,
        endpoint: {
          serverInfo: {
            name: "catamorphic-apps",
            title: "Catamorphic apps",
            version: "1.0.0",
          },
          tools: async () =>
            (await tools()).filter((tool) => mayCallTool(identity, tool)),
          withheld: async () => withheldTools(identity, await tools()),
          resources: {
            list: async () =>
              (await apps()).map((published) => ({
                uri: appResourceUri(published.name),
                name: `${published.name} app`,
                mimeType: MCP_APP_MIME_TYPE,
              })),
            templates: async () => [],
            read: async (uri) => {
              const published = (await apps()).find(
                (candidate) => appResourceUri(candidate.name) === uri,
              );
              if (!published)
                throw new McpError(
                  MCP_ERROR.invalidParams,
                  `Unknown resource ${uri}`,
                );
              return [
                {
                  uri,
                  mimeType: MCP_APP_MIME_TYPE,
                  text: buildAppDocument(published),
                  _meta: {
                    ui: {
                      // Catamorphic apps have no network of their own:
                      // every effect is a workflow call through the host.
                      csp: { connectDomains: [], resourceDomains: [] },
                      prefersBorder: true,
                    },
                  },
                },
              ];
            },
          },
        },
      });
    },
  );
}

const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

const appResourceUri = (appName: string) => `ui://apps/${appName}`;

type Core = NonNullable<RouteContext["core"]>;
type Identity = Parameters<NonNullable<Core["apps"]>["list"]>[0]["identity"];

async function loadPublishedApps(
  core: Core,
  identity: Identity,
  projectId: string,
): Promise<PublishedApp[]> {
  const apps = core.apps;
  if (!apps) return [];
  const summaries = await apps.list({ identity, projectId });
  const published: PublishedApp[] = [];
  for (const summary of summaries) {
    if (!summary.activeVersionId) continue;
    const view = await apps.viewState({
      identity,
      projectId,
      appName: summary.name,
    });
    if (view.state !== "ready") continue;
    published.push({
      name: summary.name,
      appId: view.appId,
      versionId: view.versionId,
      code: view.code,
      css: view.css,
      allowedWorkflows: view.allowedWorkflows,
      workflowShapes: view.workflowShapes,
    });
  }
  return published;
}

function buildTools(apps: PublishedApp[]) {
  const tools: Array<Record<string, unknown>> = [];
  const owners = workflowOwners(apps);
  for (const [workflowName, owner] of owners) {
    tools.push({
      name: workflowName,
      description:
        `Run the "${workflowName}" workflow of the "${owner.name}" app. ` +
        `Pass {"input": ...}. Default mode waits for the result; ` +
        `{"mode": "start"} returns {"runId"} for long-running workflows — ` +
        `poll it with ${POLL_RUN_TOOL}.`,
      inputSchema: {
        type: "object",
        properties: {
          input: {
            description: "The workflow's input (JSON)",
            // The workflow's real input schema, frozen at app build from
            // the extracted TS types.
            ...((owner.workflowShapes?.[workflowName]?.inputSchema ??
              {}) as object),
          },
          mode: { type: "string", enum: ["invoke", "start"] },
        },
        required: ["input"],
      },
      _meta: {
        ui: {
          resourceUri: appResourceUri(owner.name),
          visibility: ["model", "app"],
        },
      },
    });
  }
  tools.push(POLL_RUN_TOOL_DEFINITION);
  return tools;
}

/** Workflow → the first published app whose frozen set allows it. */
function workflowOwners(apps: PublishedApp[]): Map<string, PublishedApp> {
  const owners = new Map<string, PublishedApp>();
  for (const published of apps) {
    for (const workflowName of published.allowedWorkflows) {
      if (!owners.has(workflowName)) owners.set(workflowName, published);
    }
  }
  return owners;
}

async function callTool(
  core: Core,
  identity: Identity,
  projectId: string,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (name === POLL_RUN_TOOL) {
    return callPollRunTool(core, identity, args);
  }

  const apps = await loadPublishedApps(core, identity, projectId);
  const owner = workflowOwners(apps).get(name);
  if (!owner || !core.apps) {
    return toolError(`Unknown tool: ${name}`);
  }
  // The owning app's identity puts MCP callers on the exact authorization
  // path the in-product iframe uses: the run is re-authorized against the
  // app's active version's frozen workflow set server-side (ADR 0053), it
  // keeps the caller's execution reach, and it carries the version's
  // declared session access (ADR 0148).
  const scoped = await core.apps.identityForApp({
    identity,
    projectId,
    appName: owner.name,
  });

  if (args.mode === "start") {
    let run: { id: string };
    try {
      run = await core.runs.triggerProduction({
        identity: scoped,
        projectId,
        workflowName: name,
        input: (args.input ?? null) as never,
      });
    } catch (error) {
      return toolError(
        error instanceof Error ? error.message : "Workflow trigger failed",
      );
    }
    return toolValue({ runId: run.id });
  }

  // Sync call: settles inline unless the workflow reaches a durable wait or
  // the budget, in which case the caller polls the run.
  let outcome: Awaited<ReturnType<Core["runs"]["call"]>>;
  try {
    outcome = await core.runs.call({
      identity: scoped,
      projectId,
      workflowName: name,
      input: (args.input ?? null) as never,
      budgetMs: RUN_CALL_BUDGET_MS,
    });
  } catch (error) {
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
      return toolError(
        `Workflow still running (${outcome.suspendedOn}); ` +
          `poll run ${outcome.runId} with ${POLL_RUN_TOOL}.`,
      );
  }
}

/**
 * The app document: same construction and CSP as the in-product mount
 * (including the `process` shim the bundle needs to boot), minus a theme —
 * an MCP host has no shared token vocabulary to seed, so the base layer's
 * neutral defaults apply.
 */
function buildAppDocument(app: PublishedApp): string {
  return buildAppGuestDocument({ code: app.code, css: app.css });
}
