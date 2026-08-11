import { buildAppGuestDocument } from "@catamorphic/app";
import { RunNotFoundError } from "@catamorphic/core";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { RouteContext } from "../app.js";
import { resolveIdentity } from "../http-identity.js";

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

/** Shared contract with `@catamorphic/app`'s MCP-host guest adapter. */
const POLL_RUN_TOOL = "catamorphic_poll_run";

const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

const RUN_POLL_INTERVAL_MS = 500;
const RUN_POLL_TIMEOUT_MS = 120_000;
const TERMINAL_RUN_STATUSES = new Set(["completed", "failed", "canceled"]);

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

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
    const message = request.body as JsonRpcMessage | null;
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      return rpcError(
        reply,
        null,
        -32600,
        "Expected a single JSON-RPC message",
      );
    }
    // Notifications (initialized, cancelled, …) need no body in return.
    if (message.id === undefined || message.id === null) {
      return reply.status(202).send();
    }
    if (typeof message.method !== "string") {
      return rpcError(reply, message.id, -32600, "Missing method");
    }

    const identity = resolveIdentity(request);
    const params = message.params ?? {};

    try {
      switch (message.method) {
        case "initialize": {
          const requested = params.protocolVersion;
          const protocolVersion =
            typeof requested === "string" &&
            SUPPORTED_PROTOCOL_VERSIONS.has(requested)
              ? requested
              : DEFAULT_PROTOCOL_VERSION;
          return rpcResult(reply, message.id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false }, resources: {} },
            serverInfo: {
              name: "catamorphic-apps",
              title: "Catamorphic apps",
              version: "1.0.0",
            },
          });
        }
        case "ping":
          return rpcResult(reply, message.id, {});
        case "tools/list": {
          const apps = await loadPublishedApps(core, identity, projectId);
          return rpcResult(reply, message.id, { tools: buildTools(apps) });
        }
        case "resources/list": {
          const apps = await loadPublishedApps(core, identity, projectId);
          return rpcResult(reply, message.id, {
            resources: apps.map((published) => ({
              uri: appResourceUri(published.name),
              name: `${published.name} app`,
              mimeType: MCP_APP_MIME_TYPE,
            })),
          });
        }
        case "resources/templates/list":
          return rpcResult(reply, message.id, { resourceTemplates: [] });
        case "prompts/list":
          return rpcResult(reply, message.id, { prompts: [] });
        case "resources/read": {
          const uri = typeof params.uri === "string" ? params.uri : "";
          const apps = await loadPublishedApps(core, identity, projectId);
          const published = apps.find(
            (candidate) => appResourceUri(candidate.name) === uri,
          );
          if (!published) {
            return rpcError(
              reply,
              message.id,
              -32602,
              `Unknown resource ${uri}`,
            );
          }
          return rpcResult(reply, message.id, {
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
          });
        }
        case "tools/call": {
          const name = typeof params.name === "string" ? params.name : "";
          const args =
            typeof params.arguments === "object" && params.arguments !== null
              ? (params.arguments as Record<string, unknown>)
              : {};
          return rpcResult(
            reply,
            message.id,
            await callTool(core, identity, projectId, name, args),
          );
        }
        default:
          return rpcError(
            reply,
            message.id,
            -32601,
            `Method not found: ${message.method}`,
          );
      }
    } catch (error) {
      return rpcError(
        reply,
        message.id,
        -32603,
        error instanceof Error ? error.message : "Internal error",
      );
    }
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
  tools.push({
    name: POLL_RUN_TOOL,
    description:
      "Poll a workflow run started with mode 'start'. Returns the run's " +
      "status, output (once completed), and batch progress.",
    inputSchema: {
      type: "object",
      properties: { runId: { type: "string" } },
      required: ["runId"],
    },
  });
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
    const runId = typeof args.runId === "string" ? args.runId : "";
    try {
      const snapshot = await fetchRunSnapshot(core, identity, runId);
      return toolValue(snapshot);
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        return toolError("Run not found");
      }
      throw error;
    }
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

interface RunSnapshotShape {
  runId: string;
  status: string;
  output: unknown;
  error: string | null;
  progress?: {
    discovered: number;
    succeeded: number;
    failed: number;
    skipped: number;
  };
}

/** Mirrors the in-product broker's run snapshot (AppMount's shape). */
async function fetchRunSnapshot(
  core: Core,
  identity: Identity,
  runId: string,
): Promise<RunSnapshotShape> {
  const run = await core.runs.get({ identity, runId });
  const batch = (
    run as {
      batchScopes?: Array<{
        discovered: number;
        succeeded: number;
        failed: number;
        skipped: number;
      }>;
    }
  ).batchScopes?.[0];
  return {
    runId: run.id,
    status: run.status,
    output: (run as { result?: unknown }).result ?? null,
    error: (run as { error?: string | null }).error ?? null,
    ...(batch
      ? {
          progress: {
            discovered: batch.discovered,
            succeeded: batch.succeeded,
            failed: batch.failed,
            skipped: batch.skipped,
          },
        }
      : {}),
  };
}

/**
 * Tool result: JSON text for model readability plus `structuredContent`
 * for the guest adapter. Structured content stays object/array-shaped for
 * 2025-era clients (SEP-2106's any-JSON loosening is newer); primitives
 * ride the text channel, which the adapter JSON-parses.
 */
function toolValue(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: "text", text: JSON.stringify(value) ?? "null" }],
    ...(typeof value === "object" && value !== null
      ? { structuredContent: value }
      : {}),
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
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

function rpcResult(
  reply: FastifyReply,
  id: number | string,
  result: unknown,
): FastifyReply {
  return reply
    .header("content-type", "application/json")
    .send({ jsonrpc: "2.0", id, result });
}

function rpcError(
  reply: FastifyReply,
  id: number | string | null,
  code: number,
  message: string,
): FastifyReply {
  return reply
    .header("content-type", "application/json")
    .send({ jsonrpc: "2.0", id, error: { code, message } });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
