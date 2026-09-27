import type { DB, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { AgentTurnUsage } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import type { Identity } from "../identity.js";
import {
  ConnectionActionDeniedError,
  ConnectionActionRefusedError,
  type ConnectionBroker,
} from "./connection-broker.js";
import type { ConnectionCapabilityGrantsService } from "./connection-capability-grants.js";
import type {
  ConnectionProviderRegistry,
  ModelApi,
} from "./connection-providers.js";
import type { ConnectionModelPolicy } from "./connection-types.js";
import { ConnectionUnavailableError } from "./connections-service.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";

const tracer = getTracer("@catamorphic/core");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Largest request body the gateway reads (it must read the model id). */
export const MODEL_REQUEST_MAX_BYTES = 32 * 1024 * 1024;
/** Largest non-streamed answer the gateway reads for its usage. */
const USAGE_SCAN_MAX_BYTES = 8 * 1024 * 1024;

/** One HTTP request a sandbox harness sent to `/gateway/model/<alias>/…`. */
export interface ModelGatewayRequest {
  alias: string;
  /** Path below the connection's base URL, e.g. `v1/messages`. */
  path: string;
  /** The raw query string, without `?`. */
  query?: string;
  method: "GET" | "POST";
  headers: Readonly<Record<string, string | undefined>>;
  body?: Uint8Array;
}

export interface ModelGatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | Uint8Array;
}

/**
 * The endpoints each API family serves through the gateway, and the action
 * name guards and roles see for them.
 */
const ENDPOINTS: Record<
  ModelApi,
  ReadonlyArray<{ method: "GET" | "POST"; path: string; action: string }>
> = {
  anthropic: [
    { method: "POST", path: "v1/messages", action: "messages" },
    {
      method: "POST",
      path: "v1/messages/count_tokens",
      action: "count_tokens",
    },
    { method: "GET", path: "v1/models", action: "models" },
  ],
  openai: [
    { method: "POST", path: "responses", action: "responses" },
    { method: "POST", path: "chat/completions", action: "chat.completions" },
    { method: "GET", path: "models", action: "models" },
  ],
};

/** The gateway action a request names, or undefined for anything else. */
export function modelEndpointAction(input: {
  api: ModelApi;
  method: "GET" | "POST";
  path: string;
}): string | undefined {
  const path = input.path.replace(/^\/+|\/+$/g, "");
  return ENDPOINTS[input.api].find(
    (endpoint) => endpoint.method === input.method && endpoint.path === path,
  )?.action;
}

/** Whether `model` matches one of the binding's patterns (`claude-*`). */
export function modelAllowed(
  model: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns) return true;
  return patterns.some((pattern) =>
    new RegExp(
      `^${pattern
        .split("*")
        .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*")}$`,
    ).test(model),
  );
}

// --- usage ---

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

/** Token counts in ADR 0057's shape; `inputTokens` excludes the cached part. */
export interface ModelCallUsage {
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  reasoningTokens: number;
}

function emptyUsage(): ModelCallUsage {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  };
}

/** Anthropic `usage` objects (message, message_start, message_delta). */
function mergeAnthropicUsage(
  usage: ModelCallUsage,
  raw: Record<string, unknown>,
): void {
  if ("input_tokens" in raw) usage.inputTokens = count(raw.input_tokens);
  if ("cache_read_input_tokens" in raw)
    usage.cachedInputTokens = count(raw.cache_read_input_tokens);
  if ("cache_creation_input_tokens" in raw)
    usage.cacheCreationTokens = count(raw.cache_creation_input_tokens);
  // message_delta carries the cumulative output count.
  if ("output_tokens" in raw) usage.outputTokens = count(raw.output_tokens);
}

/** OpenAI Responses (`input_tokens`) and Chat Completions (`prompt_tokens`). */
function openAiUsage(raw: Record<string, unknown>): ModelCallUsage {
  const usage = emptyUsage();
  const responses = "input_tokens" in raw || "output_tokens" in raw;
  const input = count(responses ? raw.input_tokens : raw.prompt_tokens);
  const cached = count(
    record(responses ? raw.input_tokens_details : raw.prompt_tokens_details)
      .cached_tokens,
  );
  usage.cachedInputTokens = cached;
  usage.inputTokens = Math.max(0, input - cached);
  usage.outputTokens = count(
    responses ? raw.output_tokens : raw.completion_tokens,
  );
  usage.reasoningTokens = count(
    record(
      responses ? raw.output_tokens_details : raw.completion_tokens_details,
    ).reasoning_tokens,
  );
  return usage;
}

/** Usage of a complete (non-streamed) JSON answer. */
export function usageFromJson(api: ModelApi, body: unknown): ModelCallUsage {
  const answer = record(body);
  const model = typeof answer.model === "string" ? answer.model : undefined;
  if (api === "anthropic") {
    const usage = emptyUsage();
    mergeAnthropicUsage(usage, record(answer.usage));
    return { ...usage, ...(model ? { model } : {}) };
  }
  return { ...openAiUsage(record(answer.usage)), ...(model ? { model } : {}) };
}

/**
 * Follows a streamed answer's server-sent events for its usage: Anthropic's
 * `message_start` and `message_delta`, OpenAI Responses' `response.completed`
 * and Chat Completions' final `usage` chunk. Reads only what it needs.
 */
export class SseUsageReader {
  readonly usage: ModelCallUsage = emptyUsage();
  private pending = "";

  constructor(private readonly api: ModelApi) {}

  push(chunk: Uint8Array): void {
    this.pending += decoder.decode(chunk, { stream: true });
    const lines = this.pending.split("\n");
    this.pending = lines.pop() ?? "";
    for (const line of lines) this.line(line.replace(/\r$/, ""));
  }

  end(): void {
    if (this.pending) this.line(this.pending);
    this.pending = "";
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
      event = record(JSON.parse(data));
    } catch {
      return;
    }
    if (this.api === "anthropic") {
      if (event.type === "message_start") {
        const message = record(event.message);
        if (typeof message.model === "string") this.usage.model = message.model;
        mergeAnthropicUsage(this.usage, record(message.usage));
      } else if (event.type === "message_delta") {
        mergeAnthropicUsage(this.usage, record(event.usage));
      }
      return;
    }
    const response = record(event.response);
    const usage =
      event.type === "response.completed" ||
      event.type === "response.incomplete"
        ? record(response.usage)
        : event.usage
          ? record(event.usage)
          : undefined;
    const model =
      typeof response.model === "string"
        ? response.model
        : typeof event.model === "string"
          ? event.model
          : undefined;
    if (model) this.usage.model = model;
    if (usage && Object.keys(usage).length > 0)
      Object.assign(this.usage, openAiUsage(usage), model ? { model } : {});
  }
}

// --- the gateway ---

/** A refusal in the calling API's own error shape. */
export class ModelGatewayError extends Error {
  constructor(
    readonly status: number,
    readonly kind:
      | "authentication_error"
      | "permission_error"
      | "not_found_error"
      | "invalid_request_error"
      | "api_error"
      | "overloaded_error",
    message: string,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

/** Request headers forwarded upstream; identity and routing stay here. */
const FORWARDED_REQUEST_HEADERS = [
  "content-type",
  "accept",
  "anthropic-version",
  "anthropic-beta",
  "openai-beta",
  "user-agent",
  "x-stainless-helper-method",
];

function forwardedResponseHeader(name: string): boolean {
  return (
    name === "content-type" ||
    name === "retry-after" ||
    name === "request-id" ||
    name === "x-request-id" ||
    name.startsWith("anthropic-ratelimit-") ||
    name.startsWith("x-ratelimit-")
  );
}

/** One model call's usage as the gateway records it. */
export interface ModelUsageRecord {
  tenantId: string;
  projectId: string;
  sessionId: string | null;
  turnId: string | null;
  allocationId: string;
  connectionId: string;
  alias: string;
  endpoint: string;
  usage: ModelCallUsage;
}

/** What the model gateway reads and writes beside grants (ADR 0180). */
export interface ModelGatewayStore {
  /** A session's owner, whether it is open, and the turn running now. */
  session(
    sessionId: string,
  ): Promise<
    | { ownerId: string; active: boolean; runningTurnId: string | undefined }
    | undefined
  >;
  recordUsage(record: ModelUsageRecord): Promise<void>;
  /** Token totals of a session's calls, or of one of its turns. */
  usage(args: {
    sessionId: string;
    turnId?: string;
  }): Promise<AgentTurnUsage | undefined>;
}

/** The gateway's store in the host's database (`model_usage`). */
export function dbModelGatewayStore(db: Kysely<DB>): ModelGatewayStore {
  return {
    session: async (sessionId) => {
      const row = await db
        .selectFrom("agent_sessions")
        .select(["external_user_id", "status"])
        .where("id", "=", sessionId)
        .executeTakeFirst();
      if (!row) return undefined;
      const turn = await db
        .selectFrom("agent_turns")
        .select("id")
        .where("session_id", "=", sessionId)
        .where("status", "=", "running")
        .orderBy("started_at", "desc")
        .executeTakeFirst();
      return {
        ownerId: row.external_user_id,
        active: row.status === "active",
        runningTurnId: turn?.id,
      };
    },
    recordUsage: async (record) => {
      await db
        .insertInto("model_usage")
        .values({
          tenant_id: record.tenantId,
          project_id: record.projectId,
          agent_session_id: record.sessionId,
          turn_id: record.turnId,
          allocation_id: record.allocationId,
          connection_id: record.connectionId,
          alias: record.alias,
          endpoint: record.endpoint,
          model: record.usage.model ?? null,
          input_tokens: record.usage.inputTokens,
          cached_input_tokens: record.usage.cachedInputTokens,
          cache_creation_tokens: record.usage.cacheCreationTokens,
          output_tokens: record.usage.outputTokens,
          reasoning_tokens: record.usage.reasoningTokens,
        })
        .execute();
    },
    usage: async (args) => {
      let query = db
        .selectFrom("model_usage")
        .where("agent_session_id", "=", args.sessionId);
      if (args.turnId) query = query.where("turn_id", "=", args.turnId);
      const row = await query
        .select([
          sql<string>`count(*)`.as("calls"),
          sql<string>`coalesce(sum(input_tokens), 0)`.as("input"),
          sql<string>`coalesce(sum(cached_input_tokens), 0)`.as("cached"),
          sql<string>`coalesce(sum(cache_creation_tokens), 0)`.as("creation"),
          sql<string>`coalesce(sum(output_tokens), 0)`.as("output"),
          sql<string>`coalesce(sum(reasoning_tokens), 0)`.as("reasoning"),
          sql<string | null>`max(model)`.as("model"),
        ])
        .executeTakeFirst();
      if (!row || Number(row.calls) === 0) return undefined;
      return {
        ...(row.model ? { model: row.model } : {}),
        inputTokens: Number(row.input),
        cachedInputTokens: Number(row.cached),
        cacheCreationTokens: Number(row.creation),
        outputTokens: Number(row.output),
        reasoningTokens: Number(row.reasoning),
      };
    },
  };
}

interface AuthorizedModelRequest {
  identity: Identity;
  projectId: string;
  sessionId: string | null;
  turnId: string | undefined;
  allocationId: string;
  api: ModelApi;
  providerKind: string;
  policy: ConnectionModelPolicy | undefined;
}

/**
 * Models through the gateway (ADR 0180). A harness in a sandbox sends its
 * provider's HTTP API to `/gateway/model/<alias>/…` with its session grant
 * as the API key; the gateway checks the grant, the binding's model
 * allowlist and turn budget, and the guards, then forwards with the stored
 * key, streaming the answer back and reading its usage on the way.
 */
export class ModelGatewayService {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly deps: {
      store: ModelGatewayStore;
      grants: Pick<ConnectionCapabilityGrantsService, "validate">;
      allocations: Pick<ExecutionAllocationsService, "get">;
      broker: Pick<ConnectionBroker, "modelAccess">;
      providers: Pick<ConnectionProviderRegistry, "get">;
      fetch?: typeof fetch;
    },
  ) {
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  async handle(request: ModelGatewayRequest): Promise<ModelGatewayResponse> {
    const api: ModelApi =
      request.path.replace(/^\/+/, "").startsWith("v1/") ||
      request.headers["x-api-key"]
        ? "anthropic"
        : "openai";
    try {
      return await withSpan(
        {
          tracer,
          name: "gateway.model",
          attributes: {
            "catamorphic.connection.alias": request.alias,
            "catamorphic.model.path": request.path,
          },
        },
        () => this.handleUninstrumented(request),
      );
    } catch (error) {
      return refusalResponse(api, error);
    }
  }

  /** Token totals of a session's model calls, or of one of its turns. */
  sessionUsage(args: {
    sessionId: string;
    turnId?: string;
  }): Promise<AgentTurnUsage | undefined> {
    return this.deps.store.usage(args);
  }

  private async handleUninstrumented(
    request: ModelGatewayRequest,
  ): Promise<ModelGatewayResponse> {
    const authorized = await this.authorize(request);
    const action = modelEndpointAction({
      api: authorized.api,
      method: request.method,
      path: request.path,
    });
    if (!action)
      throw new ModelGatewayError(
        404,
        "not_found_error",
        `The gateway does not serve ${request.method} /${request.path.replace(/^\/+/, "")} for '${request.alias}'`,
      );
    let body: Record<string, unknown> | undefined;
    if (request.method === "POST") {
      try {
        body = record(
          JSON.parse(decoder.decode(request.body ?? new Uint8Array())),
        );
      } catch {
        throw new ModelGatewayError(
          400,
          "invalid_request_error",
          "The request body must be JSON",
        );
      }
    }
    const model = typeof body?.model === "string" ? body.model : undefined;
    if (model && !modelAllowed(model, authorized.policy?.allow))
      throw new ModelGatewayError(
        403,
        "permission_error",
        `'${request.alias}' serves only ${authorized.policy?.allow?.join(", ")}; '${model}' is not allowed`,
      );
    const stream = body?.stream === true;
    const turnId = authorized.turnId;
    const budget = authorized.policy?.maxOutputTokensPerTurn;
    if (budget && authorized.sessionId && turnId && action !== "count_tokens") {
      const used = await this.sessionUsage({
        sessionId: authorized.sessionId,
        turnId,
      });
      if ((used?.outputTokens ?? 0) >= budget)
        throw new ModelGatewayError(
          403,
          "permission_error",
          `This turn has used its model budget of ${budget} output tokens through '${request.alias}'; finish the turn with what you have`,
        );
    }
    const maxTokens =
      body?.max_tokens ??
      body?.max_output_tokens ??
      body?.max_completion_tokens;
    const input: JsonObject = {
      provider: authorized.providerKind,
      endpoint: action,
      ...(model ? { model } : {}),
      stream,
      ...(typeof maxTokens === "number" ? { maxOutputTokens: maxTokens } : {}),
    };
    const access = await this.deps.broker.modelAccess({
      identity: authorized.identity,
      allocationId: authorized.allocationId,
      alias: request.alias,
      action,
      input,
      ...(authorized.sessionId ? { agentSessionId: authorized.sessionId } : {}),
    });
    // Chat Completions streams report usage only when asked to.
    if (
      body &&
      stream &&
      action === "chat.completions" &&
      record(body.stream_options).include_usage === undefined
    )
      body.stream_options = {
        ...record(body.stream_options),
        include_usage: true,
      };
    const headers = new Headers();
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = request.headers[name];
      if (value) headers.set(name, value);
    }
    for (const [name, value] of Object.entries(access.headers))
      headers.set(name, value);
    const base = access.endpoint.baseUrl.replace(/\/+$/, "");
    const url = `${base}/${request.path.replace(/^\/+/, "")}${request.query ? `?${request.query}` : ""}`;
    const upstream = await this.fetch(url, {
      method: request.method,
      headers,
      redirect: "manual",
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(async (error: unknown) => {
      await access.audit("error", { error: "upstream unreachable" });
      throw new ModelGatewayError(
        502,
        "api_error",
        `The model provider could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const out: Record<string, string> = { "cache-control": "no-cache" };
    upstream.headers.forEach((value, name) => {
      if (forwardedResponseHeader(name.toLowerCase())) out[name] = value;
    });
    if (!upstream.ok || !upstream.body) {
      await access.audit("error", { status: upstream.status });
      // The provider's own error travels: clients know how to read it.
      return {
        status: upstream.status,
        headers: out,
        body: new Uint8Array(await upstream.arrayBuffer()),
      };
    }
    const settle = async (usage: ModelCallUsage) => {
      await this.deps.store.recordUsage({
        tenantId: authorized.identity.tenantId,
        projectId: authorized.projectId,
        sessionId: authorized.sessionId,
        turnId: turnId ?? null,
        allocationId: authorized.allocationId,
        connectionId: access.binding.connectionId,
        alias: request.alias,
        endpoint: action,
        usage: { ...usage, ...(usage.model || !model ? {} : { model }) },
      });
      await access.audit("allowed", {
        status: upstream.status,
        usage: { ...usage },
      });
    };
    const sse = (upstream.headers.get("content-type") ?? "").includes(
      "text/event-stream",
    );
    return {
      status: upstream.status,
      headers: out,
      body: tapUsage({
        api: authorized.api,
        sse,
        source: upstream.body,
        settle,
      }),
    };
  }

  /** The grant, its session and binding. */
  private async authorize(
    request: ModelGatewayRequest,
  ): Promise<AuthorizedModelRequest> {
    const token = grantFrom(request.headers);
    if (!token)
      throw new ModelGatewayError(
        401,
        "authentication_error",
        "Send this session's grant as the API key",
      );
    const grant = await this.deps.grants.validate({ token });
    if (!grant || grant.alias !== request.alias)
      throw new ModelGatewayError(
        401,
        "authentication_error",
        "This session's grant has expired or was revoked",
      );
    const session = grant.agentSessionId
      ? await this.deps.store.session(grant.agentSessionId)
      : undefined;
    if (grant.agentSessionId && !session?.active)
      throw new ModelGatewayError(
        401,
        "authentication_error",
        "This session is closed",
      );
    const identity: Identity = {
      tenantId: grant.tenantId,
      externalUserId:
        session?.ownerId ?? `connection-grant:${grant.allocationId}`,
    };
    const allocation = await this.deps.allocations.get({
      identity,
      allocationId: grant.allocationId,
    });
    const binding = allocation?.policy.connections?.find(
      (candidate) => candidate.alias === grant.alias,
    );
    if (allocation?.status !== "active" || !binding)
      throw new ModelGatewayError(
        401,
        "authentication_error",
        "This session's grant is no longer valid",
      );
    const endpoint = this.deps.providers.get(binding.providerKind)?.model;
    if (!endpoint)
      throw new ModelGatewayError(
        404,
        "not_found_error",
        `Connection '${request.alias}' is not a model API`,
      );
    return {
      identity,
      projectId: allocation.projectId,
      sessionId: grant.agentSessionId,
      turnId: session?.runningTurnId,
      allocationId: allocation.id,
      api: endpoint.api,
      providerKind: binding.providerKind,
      policy: binding.model,
    };
  }
}

/**
 * Pass an answer through unchanged while reading its usage; settles once,
 * when the answer ends or the caller stops reading.
 */
async function* tapUsage(args: {
  api: ModelApi;
  sse: boolean;
  source: ReadableStream<Uint8Array>;
  settle: (usage: ModelCallUsage) => Promise<void>;
}): AsyncIterable<Uint8Array> {
  const reader = args.source.getReader();
  const events = args.sse ? new SseUsageReader(args.api) : undefined;
  const whole: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      if (events) events.push(next.value);
      else if (size < USAGE_SCAN_MAX_BYTES) {
        whole.push(next.value);
        size += next.value.length;
      }
      yield next.value;
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    let usage: ModelCallUsage;
    if (events) {
      events.end();
      usage = events.usage;
    } else {
      try {
        usage = usageFromJson(
          args.api,
          JSON.parse(decoder.decode(Buffer.concat(whole))),
        );
      } catch {
        usage = emptyUsage();
      }
    }
    await args
      .settle(usage)
      .catch((error: unknown) =>
        console.warn("[catamorphic] Could not record model usage", error),
      );
  }
}

/** The grant a harness sends as its API key. */
function grantFrom(
  headers: Readonly<Record<string, string | undefined>>,
): string | null {
  const key = headers["x-api-key"]?.trim();
  if (key) return key;
  const authorization = headers.authorization ?? "";
  const match = /^bearer\s+(\S+)$/i.exec(authorization.trim());
  return match?.[1] ?? null;
}

function refusalResponse(api: ModelApi, error: unknown): ModelGatewayResponse {
  const refusal =
    error instanceof ModelGatewayError
      ? error
      : error instanceof ConnectionActionDeniedError
        ? new ModelGatewayError(
            403,
            "permission_error",
            `Refused: ${error.reason}`,
          )
        : error instanceof ConnectionActionRefusedError
          ? new ModelGatewayError(403, "permission_error", error.message)
          : error instanceof ConnectionUnavailableError
            ? new ModelGatewayError(
                503,
                "overloaded_error",
                `The connection behind this alias is unavailable: ${error.message}`,
              )
            : undefined;
  if (!refusal)
    console.warn("[catamorphic] Model gateway request failed", error);
  const status = refusal?.status ?? 502;
  const kind = refusal?.kind ?? "api_error";
  const message =
    refusal?.message ?? "The model gateway could not complete this request";
  const body =
    api === "anthropic"
      ? { type: "error", error: { type: kind, message } }
      : {
          error: {
            message,
            type: kind === "api_error" ? "server_error" : kind,
            code: kind === "authentication_error" ? "invalid_api_key" : kind,
          },
        };
  return {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-cache",
    },
    body: encoder.encode(JSON.stringify(body)),
  };
}
