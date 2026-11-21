import { type TokenScope, TokenScopeRequiredError } from "@catamorphic/core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  type ForwardedToolDefinition,
  forwardedTool,
  forwardedToolResult,
} from "./mcp-shared.js";

/**
 * One MCP endpoint for both protocol eras (ADR 0345). A request carrying
 * the per-request `_meta` envelope, or a modern `MCP-Protocol-Version`
 * header, is served by the current revision: stateless, validated against
 * its mirrored headers, with `server/discover`, result types, caching
 * hints, `subscriptions/listen` and the tasks extension. Anything else is
 * a 2025-era client and gets the stateless `initialize` shell with plain
 * tools. Neither path keeps a session: every request stands alone, and
 * whatever must outlive one is in Postgres.
 */

/** The revisions served with per-request metadata, newest first. */
export const MODERN_PROTOCOL_VERSIONS = ["2026-07-28"] as const;

/** The handshake revisions a 2025-era client may negotiate. */
export const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2024-11-05",
  "2025-03-26",
  "2025-06-18",
  "2025-11-25",
]);
export const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export const MCP_META = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  subscriptionId: "io.modelcontextprotocol/subscriptionId",
} as const;

/** The tasks extension (SEP-2663): a durable handle for a long call. */
export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";

export const MCP_ERROR = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  headerMismatch: -32020,
  missingClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

/** How long a keep-alive comment keeps a quiet listen stream open. */
export const MCP_KEEP_ALIVE_MS = 15_000;

/** A failure that answers with a specific JSON-RPC error and HTTP status. */
export class McpError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly options: { status?: number; data?: unknown } = {},
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** The token lacks a scope the call needs: answered as a step-up (403). */
export class McpScopeError extends Error {
  constructor(readonly scope: string) {
    super(`This call needs the ${scope} scope`);
    this.name = "McpScopeError";
  }
}

/** What a handler is told about the request it serves. */
export interface McpCallContext {
  era: "modern" | "legacy";
  protocolVersion: string;
  /** What the client declared for this request; empty for a legacy one. */
  clientCapabilities: Record<string, unknown>;
  /** Aborted when the caller went away. */
  signal: AbortSignal;
  /** A retried call's answers to what the server asked (MRTR). */
  inputResponses?: Record<string, unknown>;
  /** The state the server handed out with what it asked. */
  requestState?: string;
}

/** A tool's answer in MCP's shape. */
export type McpToolResult = Record<string, unknown>;

/**
 * One tool an MCP endpoint serves: what clients list, the OAuth scope a
 * token needs for it, and how it runs. A result may carry its own
 * `resultType` (`input_required`, `task`) for a modern caller.
 */
export interface McpTool {
  definition: Record<string, unknown>;
  /** The OAuth scope a token must carry to list or call it; none: any. */
  scope?: TokenScope;
  call: (
    args: Record<string, unknown>,
    context?: McpCallContext,
  ) => Promise<McpToolResult>;
}

/** What a listen stream is told changed; `stop` ends the watching. */
export interface McpWatch {
  /** The subset of what was asked for that is watched. */
  accepted: string[];
  stop(): void;
}

export interface McpResources {
  list(): Promise<Array<Record<string, unknown>>>;
  templates(): Promise<Array<Record<string, unknown>>>;
  /** The resource's contents; an unknown URI throws {@link McpError}. */
  read(uri: string): Promise<Array<Record<string, unknown>>>;
  /** Tell `changed` when one of these resources changes; none: no listening. */
  watch?(
    uris: readonly string[],
    changed: (uri: string) => void,
    ended: () => void,
  ): Promise<McpWatch>;
}

export interface McpTasks {
  /** The task's state; an unknown id throws {@link McpError}. */
  get(taskId: string): Promise<Record<string, unknown>>;
  update(
    taskId: string,
    inputResponses: Record<string, unknown>,
  ): Promise<void>;
  cancel(taskId: string): Promise<void>;
  /** Tell `changed` with the task's state whenever its status changes. */
  watch(
    taskIds: readonly string[],
    changed: (task: Record<string, unknown>) => void,
  ): Promise<McpWatch>;
}

/** Everything one endpoint serves to one caller. */
export interface McpEndpoint {
  serverInfo: { name: string; title?: string; version: string };
  /** What every client is told first; none: nothing to say. */
  instructions?(): Promise<string>;
  /** The tools this caller may list and call. */
  tools(): Promise<McpTool[]>;
  /**
   * Runs a call itself instead of the listed tool: for an endpoint that
   * forwards another server's tools and need not list them to call one.
   */
  callTool?(
    call: { name: string; arguments: Record<string, unknown> },
    context: McpCallContext,
  ): Promise<McpToolResult>;
  /** Tools this caller would see with a scope its token lacks. */
  withheld?(): Promise<ReadonlyMap<string, string>>;
  resources?: McpResources;
  tasks?: McpTasks;
}

const Message = z.looseObject({
  jsonrpc: z.string().optional(),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.unknown(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const CallParams = z.looseObject({
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()).default({}),
  inputResponses: z.record(z.string(), z.unknown()).optional(),
  requestState: z.string().optional(),
});

function isModernVersion(version: string): boolean {
  const [newest] = MODERN_PROTOCOL_VERSIONS;
  return /^\d{4}-\d{2}-\d{2}$/.test(version) && version >= newest;
}

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

/** A mirrored header's value, decoded from the Base64 sentinel form. */
function mirrored(value: string): string {
  const encoded = /^=\?base64\?(.*)\?=$/.exec(value);
  return encoded?.[1] !== undefined
    ? Buffer.from(encoded[1], "base64").toString("utf8")
    : value;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Whether the client declared the tasks extension on this request. */
export function declaresTasks(context: McpCallContext | undefined): boolean {
  return (
    context?.era === "modern" &&
    TASKS_EXTENSION in record(context.clientCapabilities.extensions)
  );
}

/** Whether the client can ask its person a form elicitation. */
export function declaresElicitation(
  context: McpCallContext | undefined,
): boolean {
  if (context?.era !== "modern") return false;
  const elicitation = context.clientCapabilities.elicitation;
  if (typeof elicitation !== "object" || elicitation === null) return false;
  // An empty object means form mode, as before modes were named.
  const modes = record(elicitation);
  return Object.keys(modes).length === 0 || "form" in modes;
}

/** Results clients may keep for a while, and for whom. */
const CACHEABLE: Readonly<Record<string, number>> = {
  "server/discover": 300_000,
  "tools/list": 60_000,
  "prompts/list": 300_000,
  "resources/list": 0,
  "resources/templates/list": 300_000,
  "resources/read": 0,
};

function send(
  reply: FastifyReply,
  status: number,
  body: Record<string, unknown>,
): FastifyReply {
  return reply
    .status(status)
    .header("content-type", "application/json")
    .send({ jsonrpc: "2.0", ...body });
}

function fail(
  reply: FastifyReply,
  id: string | number | null,
  error: McpError,
): FastifyReply {
  return send(reply, error.options.status ?? 200, {
    id,
    error: {
      code: error.code,
      message: error.message,
      ...(error.options.data !== undefined ? { data: error.options.data } : {}),
    },
  });
}

/** Serve one POST to an MCP endpoint, in whichever era the client speaks. */
export async function serveMcp(args: {
  request: FastifyRequest;
  reply: FastifyReply;
  endpoint: McpEndpoint;
  /** Named in a step-up challenge, when the host publishes one. */
  resourceMetadataUrl?: string;
}): Promise<FastifyReply> {
  const { request, reply, endpoint } = args;
  const parsed = Message.safeParse(request.body);
  if (!parsed.success || Array.isArray(request.body))
    return fail(
      reply,
      null,
      new McpError(
        MCP_ERROR.invalidRequest,
        "Expected a single JSON-RPC message",
        { status: 400 },
      ),
    );
  const message = parsed.data;
  const params = message.params ?? {};
  const meta = record(params._meta);
  const claimed = meta[MCP_META.protocolVersion];
  const versionHeader = header(request, "mcp-protocol-version");
  const modern =
    claimed !== undefined ||
    (versionHeader !== undefined && isModernVersion(versionHeader));
  // Notifications (initialized, cancelled) need no body in return.
  if (message.id === undefined || message.id === null)
    return reply.status(202).send();
  const id = message.id;
  if (typeof message.method !== "string")
    return fail(
      reply,
      id,
      new McpError(MCP_ERROR.invalidRequest, "Missing method", { status: 400 }),
    );
  const method = message.method;
  const abort = new AbortController();
  reply.raw.once("close", () => {
    if (!reply.raw.writableFinished) abort.abort();
  });
  try {
    if (!modern)
      return send(reply, 200, {
        id,
        result: await legacy({
          endpoint,
          method,
          params,
          context: {
            era: "legacy",
            protocolVersion: versionHeader ?? DEFAULT_PROTOCOL_VERSION,
            clientCapabilities: {},
            signal: abort.signal,
          },
        }),
      });
    const context = validateModern({
      request,
      method,
      params,
      meta,
      signal: abort.signal,
    });
    if (method === "subscriptions/listen")
      return await listen({
        reply,
        endpoint,
        id,
        params,
        signal: abort.signal,
      });
    const result = await modernResult({ endpoint, method, params, context });
    const complete = (result.resultType ?? "complete") === "complete";
    const ttlMs = CACHEABLE[method];
    return send(reply, 200, {
      id,
      result: {
        resultType: "complete",
        ...(complete && ttlMs !== undefined
          ? { ttlMs, cacheScope: "private" }
          : {}),
        ...result,
        _meta: {
          ...record(result._meta),
          [MCP_META.serverInfo]: {
            name: endpoint.serverInfo.name,
            version: endpoint.serverInfo.version,
          },
        },
      },
    });
  } catch (error) {
    // The grant lacks the scope: a step-up challenge, as on every route.
    if (
      error instanceof McpScopeError ||
      error instanceof TokenScopeRequiredError
    )
      return reply
        .status(403)
        .header(
          "www-authenticate",
          `Bearer error="insufficient_scope", scope="${error.scope}"${
            args.resourceMetadataUrl
              ? `, resource_metadata="${args.resourceMetadataUrl}"`
              : ""
          }`,
        )
        .header("content-type", "application/json")
        .send({
          jsonrpc: "2.0",
          id,
          error: { code: MCP_ERROR.invalidRequest, message: error.message },
        });
    if (error instanceof McpError) return fail(reply, id, error);
    return fail(
      reply,
      id,
      new McpError(
        MCP_ERROR.internal,
        error instanceof Error ? error.message : "Internal error",
      ),
    );
  }
}

/** The request's own claims, checked as the current revision requires. */
function validateModern(input: {
  request: FastifyRequest;
  method: string;
  params: Record<string, unknown>;
  meta: Record<string, unknown>;
  signal: AbortSignal;
}): McpCallContext {
  const { request, method, params, meta } = input;
  const mismatch = (text: string) =>
    new McpError(MCP_ERROR.headerMismatch, `Header mismatch: ${text}`, {
      status: 400,
    });
  const versionHeader = header(request, "mcp-protocol-version");
  if (versionHeader === undefined)
    throw mismatch("the MCP-Protocol-Version header is missing");
  const version = meta[MCP_META.protocolVersion];
  if (typeof version !== "string")
    throw new McpError(
      MCP_ERROR.invalidParams,
      `Missing _meta["${MCP_META.protocolVersion}"]`,
      { status: 400 },
    );
  if (versionHeader !== version)
    throw mismatch(
      `MCP-Protocol-Version header value '${versionHeader}' does not match body value '${version}'`,
    );
  if (!MODERN_PROTOCOL_VERSIONS.some((supported) => supported === version))
    throw new McpError(
      MCP_ERROR.unsupportedProtocolVersion,
      "Unsupported protocol version",
      {
        status: 400,
        data: {
          supported: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_VERSIONS],
          requested: version,
        },
      },
    );
  const methodHeader = header(request, "mcp-method");
  if (methodHeader === undefined)
    throw mismatch("the Mcp-Method header is missing");
  if (methodHeader !== method)
    throw mismatch(
      `Mcp-Method header value '${methodHeader}' does not match body value '${method}'`,
    );
  const named =
    method === "tools/call" || method === "prompts/get"
      ? params.name
      : method === "resources/read"
        ? params.uri
        : undefined;
  if (typeof named === "string") {
    const nameHeader = header(request, "mcp-name");
    if (nameHeader === undefined)
      throw mismatch("the Mcp-Name header is missing");
    if (mirrored(nameHeader) !== named)
      throw mismatch(
        `Mcp-Name header value '${mirrored(nameHeader)}' does not match body value '${named}'`,
      );
  }
  const capabilities = meta[MCP_META.clientCapabilities];
  if (
    typeof capabilities !== "object" ||
    capabilities === null ||
    Array.isArray(capabilities)
  )
    throw new McpError(
      MCP_ERROR.invalidParams,
      `Missing _meta["${MCP_META.clientCapabilities}"]`,
      { status: 400 },
    );
  return {
    era: "modern",
    protocolVersion: version,
    clientCapabilities: record(capabilities),
    signal: input.signal,
  };
}

const LEGACY_VERSIONS = [...SUPPORTED_PROTOCOL_VERSIONS].sort().reverse();

async function callTool(input: {
  endpoint: McpEndpoint;
  params: Record<string, unknown>;
  context: McpCallContext;
}): Promise<McpToolResult> {
  const call = CallParams.safeParse(input.params);
  if (!call.success)
    throw new McpError(MCP_ERROR.invalidParams, "Invalid tool call");
  if (input.endpoint.callTool)
    return input.endpoint.callTool(
      { name: call.data.name, arguments: call.data.arguments },
      input.context,
    );
  const tool = (await input.endpoint.tools()).find(
    (candidate) => candidate.definition.name === call.data.name,
  );
  if (!tool) {
    const scope = (await input.endpoint.withheld?.())?.get(call.data.name);
    if (scope) throw new McpScopeError(scope);
    throw new McpError(
      MCP_ERROR.invalidParams,
      `Unknown tool: ${call.data.name}`,
    );
  }
  return tool.call(call.data.arguments, {
    ...input.context,
    ...(call.data.inputResponses
      ? { inputResponses: call.data.inputResponses }
      : {}),
    ...(call.data.requestState !== undefined
      ? { requestState: call.data.requestState }
      : {}),
  });
}

function capabilities(endpoint: McpEndpoint): Record<string, unknown> {
  return {
    tools: {},
    ...(endpoint.resources ? { resources: {} } : {}),
    ...(endpoint.tasks ? { extensions: { [TASKS_EXTENSION]: {} } } : {}),
  };
}

function textParam(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value === "")
    throw new McpError(MCP_ERROR.invalidParams, `Missing ${name}`);
  return value;
}

async function modernResult(input: {
  endpoint: McpEndpoint;
  method: string;
  params: Record<string, unknown>;
  context: McpCallContext;
}): Promise<Record<string, unknown>> {
  const { endpoint, method, params, context } = input;
  const notFound = () =>
    new McpError(MCP_ERROR.methodNotFound, `Method not found: ${method}`, {
      status: 404,
    });
  switch (method) {
    case "server/discover":
      return {
        supportedVersions: [...MODERN_PROTOCOL_VERSIONS, ...LEGACY_VERSIONS],
        capabilities: capabilities(endpoint),
        ...(endpoint.instructions
          ? { instructions: await endpoint.instructions() }
          : {}),
        _meta: {
          [MCP_META.serverInfo]: {
            name: endpoint.serverInfo.name,
            ...(endpoint.serverInfo.title
              ? { title: endpoint.serverInfo.title }
              : {}),
            version: endpoint.serverInfo.version,
          },
        },
      };
    case "tools/list":
      return {
        tools: (await endpoint.tools()).map((tool) => tool.definition),
      };
    case "tools/call":
      return callTool({ endpoint, params, context });
    case "resources/list":
      return { resources: (await endpoint.resources?.list()) ?? [] };
    case "resources/templates/list":
      return {
        resourceTemplates: (await endpoint.resources?.templates()) ?? [],
      };
    case "resources/read": {
      if (!endpoint.resources) throw notFound();
      return {
        contents: await endpoint.resources.read(textParam(params, "uri")),
      };
    }
    case "prompts/list":
      return { prompts: [] };
    case "tasks/get": {
      if (!endpoint.tasks) throw notFound();
      return endpoint.tasks.get(textParam(params, "taskId"));
    }
    case "tasks/update": {
      if (!endpoint.tasks) throw notFound();
      await endpoint.tasks.update(
        textParam(params, "taskId"),
        record(params.inputResponses),
      );
      return {};
    }
    case "tasks/cancel": {
      if (!endpoint.tasks) throw notFound();
      await endpoint.tasks.cancel(textParam(params, "taskId"));
      return {};
    }
    default:
      throw notFound();
  }
}

/** What only later revisions define, taken out of a legacy answer. */
function legacyToolResult(
  result: McpToolResult,
  version: string,
): McpToolResult {
  if (version >= "2025-06-18" || !Array.isArray(result.content)) return result;
  return {
    ...result,
    content: result.content.filter(
      (part) => record(part).type !== "resource_link",
    ),
  };
}

/**
 * The 2025-era shell: the `initialize` handshake answered statelessly,
 * plain tools, and resources to read. A long turn is waited on with
 * `session_wait`, as on every surface; there is no task, no stream and
 * nothing asked of the client.
 */
async function legacy(input: {
  endpoint: McpEndpoint;
  method: string;
  params: Record<string, unknown>;
  context: McpCallContext;
}): Promise<Record<string, unknown>> {
  const { endpoint, method, params, context } = input;
  switch (method) {
    case "initialize": {
      const requested = params.protocolVersion;
      return {
        protocolVersion:
          typeof requested === "string" &&
          SUPPORTED_PROTOCOL_VERSIONS.has(requested)
            ? requested
            : DEFAULT_PROTOCOL_VERSION,
        capabilities: {
          tools: { listChanged: false },
          ...(endpoint.resources ? { resources: {} } : {}),
        },
        serverInfo: endpoint.serverInfo,
        ...(endpoint.instructions
          ? { instructions: await endpoint.instructions() }
          : {}),
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return {
        tools: (await endpoint.tools()).map((tool) => tool.definition),
      };
    case "resources/list":
      return { resources: (await endpoint.resources?.list()) ?? [] };
    case "resources/templates/list":
      return {
        resourceTemplates: (await endpoint.resources?.templates()) ?? [],
      };
    case "resources/read": {
      if (!endpoint.resources)
        throw new McpError(
          MCP_ERROR.methodNotFound,
          `Method not found: ${method}`,
        );
      return {
        contents: await endpoint.resources.read(textParam(params, "uri")),
      };
    }
    case "prompts/list":
      return { prompts: [] };
    case "tools/call":
      return legacyToolResult(
        await callTool({ endpoint, params, context }),
        context.protocolVersion,
      );
    default:
      throw new McpError(
        MCP_ERROR.methodNotFound,
        `Method not found: ${method}`,
      );
  }
}

const ListenFilter = z.looseObject({
  resourceSubscriptions: z.array(z.string()).max(200).optional(),
  taskIds: z.array(z.string()).max(200).optional(),
});

/**
 * `subscriptions/listen`: one long-lived response stream. The
 * acknowledgement comes first, naming what is watched; then a notification
 * for each change, each stamped with the subscription's id; a comment
 * keeps a quiet stream open. Closing the stream ends the subscription.
 */
async function listen(input: {
  reply: FastifyReply;
  endpoint: McpEndpoint;
  id: string | number;
  params: Record<string, unknown>;
  signal: AbortSignal;
}): Promise<FastifyReply> {
  const { reply, endpoint, id } = input;
  const filter = ListenFilter.safeParse(record(input.params.notifications));
  if (!filter.success)
    throw new McpError(MCP_ERROR.invalidParams, "Invalid notification filter");
  const raw = reply.raw;
  let open = false;
  let ended = false;
  const pending: string[] = [];
  const write = (frame: string) => {
    if (ended) return;
    if (open) raw.write(frame);
    else pending.push(frame);
  };
  const notify = (method: string, params: Record<string, unknown>) =>
    write(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        method,
        params: {
          ...params,
          _meta: { ...record(params._meta), [MCP_META.subscriptionId]: id },
        },
      })}\n\n`,
    );
  const watches: McpWatch[] = [];
  const end = (graceful: boolean) => {
    if (ended) return;
    if (graceful && open)
      raw.write(
        `event: message\ndata: ${JSON.stringify({
          jsonrpc: "2.0",
          id,
          result: {
            resultType: "complete",
            _meta: { [MCP_META.subscriptionId]: id },
          },
        })}\n\n`,
      );
    ended = true;
    clearInterval(keepAlive);
    for (const watch of watches) watch.stop();
    if (open) raw.end();
  };
  const keepAlive = setInterval(() => write(":\n\n"), MCP_KEEP_ALIVE_MS);
  keepAlive.unref?.();
  input.signal.addEventListener("abort", () => end(false), { once: true });
  try {
    // Watching starts before the acknowledgement is written, so a refusal
    // is still an ordinary error; what it reports waits behind the ack.
    const resources =
      endpoint.resources?.watch && filter.data.resourceSubscriptions?.length
        ? await endpoint.resources.watch(
            filter.data.resourceSubscriptions,
            (uri) => notify("notifications/resources/updated", { uri }),
            () => end(true),
          )
        : undefined;
    if (resources) watches.push(resources);
    const tasks =
      endpoint.tasks && filter.data.taskIds?.length
        ? await endpoint.tasks.watch(filter.data.taskIds, (task) =>
            notify("notifications/tasks", task),
          )
        : undefined;
    if (tasks) watches.push(tasks);
    reply.hijack();
    const own: Record<string, string | string[]> = {};
    for (const [name, value] of Object.entries(reply.getHeaders()))
      if (value !== undefined)
        own[name] = typeof value === "number" ? String(value) : value;
    raw.writeHead(200, {
      ...own,
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Proxies that buffer responses (nginx) would hold the stream back.
      "x-accel-buffering": "no",
    });
    open = true;
    raw.write(
      `event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: {
          _meta: { [MCP_META.subscriptionId]: id },
          notifications: {
            ...(resources ? { resourceSubscriptions: resources.accepted } : {}),
            ...(tasks ? { taskIds: tasks.accepted } : {}),
          },
        },
      })}\n\n`,
    );
    for (const frame of pending.splice(0)) raw.write(frame);
    if (input.signal.aborted) end(false);
    return reply;
  } catch (error) {
    end(false);
    throw error;
  }
}

/**
 * An MCP endpoint serving another server's tools: tools listed and results
 * returned as that server declared and sent them (ADR 0225), in whichever
 * era the client speaks. `callTool` answers with the server's own result
 * (any tool result passes through), or throws {@link McpError} for a
 * refusal at the protocol boundary.
 */
export function serveForwardedTools(args: {
  request: FastifyRequest;
  reply: FastifyReply;
  serverName: string;
  listTools(): Promise<readonly ForwardedToolDefinition[]>;
  callTool(call: {
    name: string;
    arguments: Record<string, unknown>;
  }): Promise<unknown>;
}): Promise<FastifyReply> {
  return serveMcp({
    request: args.request,
    reply: args.reply,
    endpoint: {
      serverInfo: { name: args.serverName, version: "1" },
      tools: async () =>
        (await args.listTools()).map((tool) => ({
          definition: forwardedTool(tool),
          call: async (input) =>
            forwardedToolResult(
              await args.callTool({ name: tool.name, arguments: input }),
            ),
        })),
      // The server refuses a name it does not have: no list is read first.
      callTool: async (call) => forwardedToolResult(await args.callTool(call)),
    },
  });
}
