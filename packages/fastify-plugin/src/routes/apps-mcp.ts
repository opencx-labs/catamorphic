import { buildAppGuestDocument } from "@catamorphic/app";
import type { FastifyInstance } from "fastify";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";
import {
  callPollRunTool,
  fetchRunSnapshot,
  handleMcpPost,
  McpRequestError,
  negotiateProtocolVersion,
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
 * Tool calls execute under the owning app's audience identity, so the
 * frozen-workflow-set authorization applies to MCP callers exactly as it
 * does to the in-product iframe.
 *
 * The endpoint is a stateless Streamable-HTTP JSON-RPC handler speaking
 * the `initialize`-handshake protocol era (≤2025-11-25) — what every
 * shipping client negotiates by default today (the official v2 SDK's
 * client also defaults to it). Requests are independent; no sessions.
 */

const RUN_POLL_INTERVAL_MS = 500;
const RUN_POLL_TIMEOUT_MS = 120_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "canceled"]);

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
  app.post("/projects/:projectId/apps-mcp", async (request, reply) => {
    const core = ctx.core;
    if (!core?.apps || !core.runs) {
      return reply.status(503).send({ error: "Apps not configured" });
    }
    const { projectId } = request.params as { projectId: string };

    return handleMcpPost(reply, request.body, async (method, params) => {
      const identity = resolveIdentity(request);
      switch (method) {
        case "initialize":
          return {
            protocolVersion: negotiateProtocolVersion(params.protocolVersion),
            capabilities: { tools: { listChanged: false }, resources: {} },
            serverInfo: {
              name: "catamorphic-apps",
              title: "Catamorphic apps",
              version: "1.0.0",
            },
          };
        case "ping":
          return {};
        case "tools/list": {
          const apps = await loadPublishedApps(core, identity, projectId);
          return { tools: buildTools(apps) };
        }
        case "resources/list": {
          const apps = await loadPublishedApps(core, identity, projectId);
          return {
            resources: apps.map((published) => ({
              uri: appResourceUri(published.name),
              name: `${published.name} app`,
              mimeType: MCP_APP_MIME_TYPE,
            })),
          };
        }
        case "resources/templates/list":
          return { resourceTemplates: [] };
        case "prompts/list":
          return { prompts: [] };
        case "resources/read": {
          const uri = typeof params.uri === "string" ? params.uri : "";
          const apps = await loadPublishedApps(core, identity, projectId);
          const published = apps.find(
            (candidate) => appResourceUri(candidate.name) === uri,
          );
          if (!published) {
            throw new McpRequestError(-32602, `Unknown resource ${uri}`);
          }
          return {
            contents: [
              {
                uri,
                mimeType: MCP_APP_MIME_TYPE,
                text: buildAppDocument(published),
                _meta: {
                  ui: {
                    // Catamorphic apps have no network of their own —
                    // every effect is a workflow call through the host.
                    csp: { connectDomains: [], resourceDomains: [] },
                    prefersBorder: true,
                  },
                },
              },
            ],
          };
        }
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args =
            typeof params.arguments === "object" && params.arguments !== null
              ? (params.arguments as Record<string, unknown>)
              : {};
          return callTool(core, identity, projectId, name, args);
        }
        default:
          throw new McpRequestError(-32601, `Method not found: ${method}`);
      }
    });
  });
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
  if (!owner) {
    return toolError(`Unknown tool: ${name}`);
  }
  // The audience identity puts MCP callers on the exact authorization
  // path the in-product iframe uses: the run is re-authorized against
  // the app version's frozen workflow set server-side.
  const audienceIdentity = {
    ...identity,
    appAudience: { appId: owner.appId, appVersionId: owner.versionId },
  } as Identity;

  let run: { id: string };
  try {
    run = await core.runs.triggerProduction({
      identity: audienceIdentity,
      projectId,
      workflowName: name,
      input: (args.input ?? null) as never,
    });
  } catch (error) {
    return toolError(
      error instanceof Error ? error.message : "Workflow trigger failed",
    );
  }

  if (args.mode === "start") {
    return toolValue({ runId: run.id });
  }

  const startedAt = Date.now();
  for (;;) {
    const snapshot = await fetchRunSnapshot(core, audienceIdentity, run.id);
    if (snapshot.status === "completed") {
      return toolValue(snapshot.output);
    }
    if (TERMINAL_RUN_STATUSES.has(snapshot.status)) {
      return toolError(snapshot.error ?? `Run ${snapshot.status}`);
    }
    if (Date.now() - startedAt > RUN_POLL_TIMEOUT_MS) {
      return toolError(
        `Workflow still running after ${RUN_POLL_TIMEOUT_MS / 1000}s; ` +
          `poll run ${run.id} with ${POLL_RUN_TOOL}.`,
      );
    }
    await sleep(RUN_POLL_INTERVAL_MS);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
