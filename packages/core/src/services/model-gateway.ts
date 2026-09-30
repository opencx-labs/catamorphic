import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { AgentTurnUsage } from "@catamorphic/sandbox";
import { type Kysely, sql } from "kysely";
import type { Identity } from "../identity.js";
import {
  ConnectionActionDeniedError,
  ConnectionActionRefusedError,
  type ConnectionBroker,
} from "./connection-broker.js";
import type { ModelApi } from "./connection-providers.js";
import {
  type ConnectionModelPolicy,
  MODEL_CAPABILITY,
} from "./connection-types.js";
import {
  ConnectionUnavailableError,
  hashBearer,
} from "./connections-service.js";

const tracer = getTracer("@catamorphic/core");
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Largest request body the gateway reads (it may read the model id). */
export const MODEL_REQUEST_MAX_BYTES = 32 * 1024 * 1024;
/** Largest non-streamed answer the gateway reads for its usage. */
const USAGE_SCAN_MAX_BYTES = 8 * 1024 * 1024;
/** How long a resolved alias (binding, endpoint, key headers) is reused. */
const ACCESS_TTL_MS = 30_000;
/** Most resolved aliases kept at once; the oldest goes first. */
const ACCESS_CACHE_SIZE = 1024;
/** A credential this close to expiry is resolved again, so it refreshes. */
const ACCESS_EXPIRY_MARGIN_MS = 60_000;

/** One HTTP request a sandbox harness sent to `/gateway/model/<alias>/…`. */
export interface ModelGatewayRequest {
  alias: string;
  /** Path below the connection's base URL as sent, e.g. `v1/messages`. */
  path: string;
  /** The raw query string, without `?`. */
  query?: string;
  method: string;
  headers: Readonly<Record<string, string | undefined>>;
  body?: Uint8Array;
}

export interface ModelGatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | Uint8Array;
}

/**
 * A request path below a model API's base URL, unchanged, or null when it
 * could leave the base: dot segments (plain or percent-encoded), encoded
 * slashes or backslashes, empty segments, or characters a path never holds.
 */
export function modelRequestPath(value: string): string | null {
  const path = value.replace(/^\/+/, "");
  if (!path) return null;
  const segments = path.split("/");
  for (const [index, segment] of segments.entries()) {
    // A trailing slash is the provider's business; an empty segment elsewhere is not.
    if (!segment && index < segments.length - 1) return null;
    if (!/^[A-Za-z0-9._~!$&'()*+,;=:@%-]*$/.test(segment)) return null;
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return null;
    }
    if (
      decoded === "." ||
      decoded === ".." ||
      /[/\\]/.test(decoded) ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing them
      /[\u0000-\u001f\u007f]/.test(decoded)
    )
      return null;
  }
  return path;
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

// --- headers ---

/**
 * Hop-by-hop headers (RFC 9110 7.6.1): they describe one connection.
 * Replica memory (c): a constant.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Request headers that stay here: the caller's grant (the stored key
 * replaces it), its host and cookies, and what the transport recomputes
 * (length, and the encodings `fetch` itself negotiates and decodes).
 * Replica memory (c): a constant.
 */
const DENIED_REQUEST_HEADERS = new Set([
  "x-api-key",
  "authorization",
  "host",
  "cookie",
  "content-length",
  "accept-encoding",
  "expect",
  "forwarded",
]);

/**
 * Response headers that stay upstream: cookies, and what no longer holds
 * once `fetch` decoded the body (its encoding and length) or names the
 * provider's own origin (`alt-svc`). Replica memory (c): a constant.
 */
const DENIED_RESPONSE_HEADERS = new Set([
  "set-cookie",
  "content-length",
  "content-encoding",
  "alt-svc",
  "forwarded",
]);

/** Headers a `Connection` header names are hop-by-hop too. */
function connectionTokens(value: string | null | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function hopByHop(name: string, named: ReadonlySet<string>): boolean {
  return (
    HOP_BY_HOP.has(name) ||
    named.has(name) ||
    name.startsWith("proxy-") ||
    name.startsWith("x-forwarded-")
  );
}

/** Every request header but the denied ones, then the stored key's. */
export function upstreamRequestHeaders(
  incoming: Readonly<Record<string, string | undefined>>,
  key: Readonly<Record<string, string>>,
): Headers {
  const named = connectionTokens(incoming.connection);
  const headers = new Headers();
  for (const [raw, value] of Object.entries(incoming)) {
    const name = raw.toLowerCase();
    if (value === undefined || DENIED_REQUEST_HEADERS.has(name)) continue;
    if (hopByHop(name, named)) continue;
    headers.set(name, value);
  }
  for (const [name, value] of Object.entries(key)) headers.set(name, value);
  return headers;
}

/** Every response header but the denied ones. */
export function downstreamResponseHeaders(
  upstream: Headers,
): Record<string, string> {
  const named = connectionTokens(upstream.get("connection"));
  const out: Record<string, string> = {};
  upstream.forEach((value, raw) => {
    const name = raw.toLowerCase();
    if (DENIED_RESPONSE_HEADERS.has(name) || hopByHop(name, named)) return;
    out[name] = value;
  });
  return out;
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

/** Usage of a complete (non-streamed) JSON answer; zero when it has none. */
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

/** Reads an answer's usage from its bytes as they pass, never changing them. */
interface UsageTap {
  push(chunk: Uint8Array): void;
  /** The usage read so far; zero when the answer's format was not recognized. */
  finish(): ModelCallUsage;
}

/**
 * Follows a streamed answer's server-sent events for its usage: Anthropic's
 * `message_start` and `message_delta`, OpenAI Responses' `response.completed`
 * and Chat Completions' final `usage` chunk (sent only when the caller asked
 * for it with `stream_options.include_usage`). Parses only events that can
 * carry usage.
 */
export class SseUsageReader implements UsageTap {
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

  finish(): ModelCallUsage {
    this.end();
    return this.usage;
  }

  private line(line: string): void {
    if (!line.startsWith("data:")) return;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") return;
    // Most events are deltas: skip them without parsing.
    if (
      this.api === "anthropic"
        ? !data.includes("message_start") && !data.includes("message_delta")
        : !data.includes('"usage"')
    )
      return;
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
    if (usage && Object.keys(usage).length > 0)
      Object.assign(this.usage, openAiUsage(usage), model ? { model } : {});
  }
}

/** Keeps a JSON answer (up to a bound) to read its usage once it ends. */
class JsonUsageReader implements UsageTap {
  private chunks: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly api: ModelApi) {}

  push(chunk: Uint8Array): void {
    if (this.size > USAGE_SCAN_MAX_BYTES) return;
    this.size += chunk.length;
    if (this.size > USAGE_SCAN_MAX_BYTES) this.chunks = [];
    else this.chunks.push(chunk);
  }

  finish(): ModelCallUsage {
    if (this.size > USAGE_SCAN_MAX_BYTES) return emptyUsage();
    try {
      return usageFromJson(
        this.api,
        JSON.parse(decoder.decode(Buffer.concat(this.chunks))),
      );
    } catch {
      return emptyUsage();
    } finally {
      this.chunks = [];
    }
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
      | "api_error",
    message: string,
  ) {
    super(message);
    this.name = "ModelGatewayError";
  }
}

/** The model call a usage row belongs to. */
export interface ModelUsageRecord {
  tenantId: string;
  projectId: string;
  sessionId: string | null;
  turnId: string | null;
  allocationId: string;
  connectionId: string;
  alias: string;
  /** The path called below the base URL, e.g. `v1/messages`. */
  endpoint: string;
  model?: string;
}

/**
 * A grant while it, its Allocation, its session (if any) and its
 * connection are live, read in one indexed query per call.
 */
export interface LiveModelGrant {
  id: string;
  tenantId: string;
  allocationId: string;
  agentSessionId: string | null;
  alias: string;
  /** The grant's session: its owner and whether it is open. */
  session?: { ownerId: string; active: boolean };
  /** The connection behind the alias: a new revision means a new key. */
  connection: {
    id: string;
    revision: number;
    status: string;
    expiresAt: Date | null;
  };
}

/**
 * The longest a model call's answer streams. A usage row still open after
 * this belongs to a call whose replica died mid-stream (ADR 0193).
 */
export const MAX_OPEN_CALL_MINUTES = 30;

/** What the model gateway reads and writes (ADR 0180). */
export interface ModelGatewayStore {
  /** The live grant a bearer names, or undefined. */
  liveGrant(args: { token: string }): Promise<LiveModelGrant | undefined>;
  /** The turn a session is running now, if any. */
  runningTurn(args: { sessionId: string }): Promise<string | undefined>;
  /**
   * Open a session's call before its answer ends (ADR 0193): its usage
   * row, settled by `recordUsage`, so totals read on any replica wait for
   * it. Returns the row's id.
   */
  openUsage(args: { record: ModelUsageRecord }): Promise<string>;
  /** One call's usage, once its answer ended: settles `openId` if given. */
  recordUsage(args: {
    record: ModelUsageRecord;
    usage: ModelCallUsage;
    openId?: string;
  }): Promise<void>;
  /**
   * How many of a session's (or turn's) calls are still open, leaving out
   * those open longer than {@link MAX_OPEN_CALL_MINUTES}.
   */
  openCalls(args: { sessionId: string; turnId?: string }): Promise<number>;
  /** Token totals of a session's settled calls, or of one of its turns. */
  usage(args: {
    sessionId: string;
    turnId?: string;
  }): Promise<AgentTurnUsage | undefined>;
}

/** The gateway's store in the host's database (`model_usage`). */
export function dbModelGatewayStore(db: Kysely<DB>): ModelGatewayStore {
  return {
    liveGrant: async ({ token }) => {
      // A grant is only as live as its Allocation: a released one ends
      // every grant bound to it, even one issued in a race with the release.
      const row = await db
        .selectFrom("connection_capability_grants as grant")
        .innerJoin(
          "execution_allocations as allocation",
          "allocation.id",
          "grant.allocation_id",
        )
        .innerJoin("connections as connection", (join) =>
          join
            .onRef("connection.id", "=", "grant.connection_id")
            .onRef("connection.tenant_id", "=", "grant.tenant_id"),
        )
        .leftJoin(
          "agent_sessions as session",
          "session.id",
          "grant.agent_session_id",
        )
        .where("grant.token_hash", "=", hashBearer(token))
        .where("grant.revoked_at", "is", null)
        .where("grant.expires_at", ">", new Date())
        .where("allocation.status", "=", "active")
        .select([
          "grant.id as id",
          "grant.tenant_id as tenantId",
          "grant.allocation_id as allocationId",
          "grant.agent_session_id as agentSessionId",
          "grant.alias as alias",
          "connection.id as connectionId",
          "connection.revision as revision",
          "connection.status as connectionStatus",
          "connection.expires_at as connectionExpiresAt",
          "session.external_user_id as sessionOwnerId",
          "session.status as sessionStatus",
        ])
        .executeTakeFirst();
      if (!row?.alias) return undefined;
      return {
        id: row.id,
        tenantId: row.tenantId,
        allocationId: row.allocationId,
        agentSessionId: row.agentSessionId,
        alias: row.alias,
        ...(row.sessionOwnerId
          ? {
              session: {
                ownerId: row.sessionOwnerId,
                active: row.sessionStatus === "active",
              },
            }
          : {}),
        connection: {
          id: row.connectionId,
          revision: row.revision,
          status: row.connectionStatus,
          expiresAt: row.connectionExpiresAt,
        },
      };
    },
    runningTurn: async ({ sessionId }) =>
      (
        await db
          .selectFrom("agent_turns")
          .select("id")
          .where("session_id", "=", sessionId)
          .where("status", "=", "running")
          .executeTakeFirst()
      )?.id,
    openUsage: async ({ record }) =>
      (
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
            model: record.model ?? null,
            settled_at: null,
          })
          .returning("id")
          .executeTakeFirstOrThrow()
      ).id,
    recordUsage: async ({ record, usage, openId }) => {
      if (openId) {
        await db
          .updateTable("model_usage")
          .set({
            model: usage.model ?? record.model ?? null,
            input_tokens: usage.inputTokens,
            cached_input_tokens: usage.cachedInputTokens,
            cache_creation_tokens: usage.cacheCreationTokens,
            output_tokens: usage.outputTokens,
            reasoning_tokens: usage.reasoningTokens,
            settled_at: sql<Date>`now()`,
          })
          .where("id", "=", openId)
          .execute();
        return;
      }
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
          model: usage.model ?? record.model ?? null,
          input_tokens: usage.inputTokens,
          cached_input_tokens: usage.cachedInputTokens,
          cache_creation_tokens: usage.cacheCreationTokens,
          output_tokens: usage.outputTokens,
          reasoning_tokens: usage.reasoningTokens,
          settled_at: sql<Date>`now()`,
        })
        .execute();
    },
    openCalls: async (args) => {
      const row = await db
        .selectFrom("model_usage")
        .select(sql<string>`count(*)`.as("open"))
        .where("agent_session_id", "=", args.sessionId)
        .$if(args.turnId !== undefined, (query) =>
          query.where("turn_id", "=", args.turnId ?? ""),
        )
        .where("settled_at", "is", null)
        // A call open longer than any call streams was lost with its
        // replica: it never settles, and nothing waits for it.
        .where(
          "created_at",
          ">",
          sql<Date>`now() - (${MAX_OPEN_CALL_MINUTES} * interval '1 minute')`,
        )
        .executeTakeFirst();
      return Number(row?.open ?? 0);
    },
    usage: async (args) => {
      let query = db
        .selectFrom("model_usage")
        .where("agent_session_id", "=", args.sessionId)
        .where("settled_at", "is not", null);
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

/** A grant resolved to its alias's upstream: reused for a few seconds. */
interface ModelAccess {
  identity: Identity;
  projectId: string;
  allocationId: string;
  sessionId: string | null;
  alias: string;
  connectionId: string;
  api: ModelApi;
  providerKind: string;
  policy: ConnectionModelPolicy | undefined;
  baseUrl: string;
  /** The stored key's headers: they never leave the control plane. */
  headers: Readonly<Record<string, string>>;
}

/**
 * A request `admit` let in, handed to `handle` so it is not checked twice.
 * Only this gateway's own admissions count.
 */
export interface ModelGatewayAdmission {
  readonly access: ModelAccess;
}

/** What `admit` decided: a refusal to send, or an admission. */
export type ModelGatewayAdmitResult =
  | { refused: ModelGatewayResponse }
  | { admitted: ModelGatewayAdmission };

/**
 * Models through the gateway (ADR 0180). A harness in a sandbox sends its
 * provider's HTTP API to `/gateway/model/<alias>/…` with its session grant
 * as the API key. The gateway checks the grant, the binding's model
 * allowlist and the guards, then forwards any method and path below the
 * connection's base URL with the stored key: the body byte for byte, the
 * answer streamed back unchanged, its usage read on the way.
 *
 * Built for time to first token: one indexed read checks the grant on each
 * call; the resolved alias and its key are reused for 30 seconds per grant
 * and connection revision; audit and usage writes happen off the response.
 */
export class ModelGatewayService {
  private readonly fetch: typeof fetch;
  /**
   * Replica memory (b): a grant's resolved alias, keyed by the grant and
   * its connection's revision, and bounded by the key's expiry.
   */
  private readonly access = new Map<
    string,
    { revision: number; until: number; access: ModelAccess }
  >();
  /** Replica memory (a): admissions of requests this process is serving. */
  private readonly admissions = new WeakSet<ModelGatewayAdmission>();

  constructor(
    private readonly deps: {
      store: ModelGatewayStore;
      broker: Pick<
        ConnectionBroker,
        "modelEndpoint" | "reviewModelCall" | "reviews"
      >;
      fetch?: typeof fetch;
      /** Clock for the access cache (tests). */
      now?: () => number;
    },
  ) {
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  /**
   * Check a request's grant before its body is read, so an unauthenticated
   * caller cannot make the host buffer a large body. Pass the admission to
   * `handle`.
   */
  async admit(
    request: Pick<ModelGatewayRequest, "alias" | "path" | "headers">,
  ): Promise<ModelGatewayAdmitResult> {
    try {
      const admission: ModelGatewayAdmission = {
        access: await this.authorize(request),
      };
      this.admissions.add(admission);
      return { admitted: admission };
    } catch (error) {
      return { refused: refusalResponse(requestApi(request), error) };
    }
  }

  async handle(
    request: ModelGatewayRequest & { admitted?: ModelGatewayAdmission },
  ): Promise<ModelGatewayResponse> {
    const api = requestApi(request);
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

  /**
   * Token totals of a session's model calls, or of one of its turns, once
   * every call already answered has settled, through whichever replica it
   * streamed (ADR 0193). A call whose replica died stops being waited for
   * after `waitMs` (default 10 seconds).
   */
  async sessionUsage(args: {
    sessionId: string;
    turnId?: string;
    waitMs?: number;
  }): Promise<AgentTurnUsage | undefined> {
    const { waitMs, ...scope } = args;
    const deadline = Date.now() + (waitMs ?? 10_000);
    while (
      Date.now() < deadline &&
      (await this.deps.store.openCalls(scope)) > 0
    )
      await new Promise((resolve) => setTimeout(resolve, 50));
    return this.deps.store.usage(scope);
  }

  private async handleUninstrumented(
    request: ModelGatewayRequest & { admitted?: ModelGatewayAdmission },
  ): Promise<ModelGatewayResponse> {
    const access =
      request.admitted && this.admissions.has(request.admitted)
        ? request.admitted.access
        : await this.authorize(request);
    const path = modelRequestPath(request.path);
    const url = path ? upstreamUrl(access.baseUrl, path, request.query) : null;
    if (!path || !url)
      throw new ModelGatewayError(
        404,
        "not_found_error",
        `The gateway serves only paths below '${request.alias}''s base URL`,
      );
    const method = request.method.toUpperCase();
    // A POST may generate: it names its model when the binding has an
    // allowlist. The body is only read, never rewritten.
    const post = method === "POST";
    const allow = access.policy?.allow;
    const fields =
      post && (allow || this.deps.broker.reviews(MODEL_CAPABILITY))
        ? requestFields(request.body)
        : {};
    if (allow && post) {
      if (!fields.model)
        throw new ModelGatewayError(
          400,
          "invalid_request_error",
          `'${request.alias}' serves only ${allow.join(", ")}; name the model`,
        );
      if (!modelAllowed(fields.model, allow))
        throw new ModelGatewayError(
          403,
          "permission_error",
          `'${request.alias}' serves only ${allow.join(", ")}; '${fields.model}' is not allowed`,
        );
    }
    const action = `${method} ${path}`;
    const input: JsonObject = {
      provider: access.providerKind,
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields.stream !== undefined ? { stream: fields.stream } : {}),
    };
    const auditCall = await this.deps.broker.reviewModelCall({
      identity: access.identity,
      projectId: access.projectId,
      allocationId: access.allocationId,
      connectionId: access.connectionId,
      alias: request.alias,
      action,
      input,
      ...(access.sessionId ? { agentSessionId: access.sessionId } : {}),
    });
    const audit = (outcome: "allowed" | "error", metadata: Json) => {
      auditCall(outcome, metadata).catch((error: unknown) =>
        console.warn("[catamorphic] Could not audit a model call", error),
      );
    };
    // The turn a call belongs to is the one running when it starts; read
    // beside the call, never before it.
    const turn =
      post && access.sessionId
        ? this.deps.store
            .runningTurn({ sessionId: access.sessionId })
            .catch(() => undefined)
        : undefined;
    const body =
      request.body && method !== "GET" && method !== "HEAD"
        ? request.body
        : undefined;
    let upstream: Response;
    try {
      upstream = await this.fetch(url, {
        method,
        headers: upstreamRequestHeaders(request.headers, access.headers),
        redirect: "manual",
        ...(body ? { body } : {}),
      });
    } catch (error) {
      audit("error", { error: "upstream unreachable" });
      throw new ModelGatewayError(
        502,
        "api_error",
        `The model provider could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const headers = downstreamResponseHeaders(upstream.headers);
    if (!upstream.body) {
      audit(upstream.ok ? "allowed" : "error", { status: upstream.status });
      return { status: upstream.status, headers, body: new Uint8Array() };
    }
    if (!upstream.ok || !post) {
      // The provider's own errors travel unchanged: clients know them.
      const outcome = upstream.ok ? "allowed" : "error";
      return {
        status: upstream.status,
        headers,
        body: relay({
          source: upstream.body,
          onEnd: (finished) =>
            audit(outcome, {
              status: upstream.status,
              ...(finished ? {} : { interrupted: true }),
            }),
        }),
      };
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    const tap: UsageTap | undefined = contentType.includes("text/event-stream")
      ? new SseUsageReader(access.api)
      : contentType.includes("json")
        ? new JsonUsageReader(access.api)
        : undefined;
    // A session's call is open in the database before its answer ends, so
    // the turn's totals, read on any replica, wait for it.
    const opened = access.sessionId
      ? this.openUsage({ access, path, fields, turn })
      : undefined;
    return {
      status: upstream.status,
      headers,
      body: relay({
        source: upstream.body,
        ...(tap ? { tap } : {}),
        ...(opened ? { beforeEnd: opened } : {}),
        // After the answer ended, off its critical path.
        onEnd: (finished) =>
          setImmediate(() => {
            const usage = tap?.finish() ?? emptyUsage();
            this.recordUsage({ access, path, fields, usage, turn, opened });
            audit("allowed", {
              status: upstream.status,
              usage: { ...usage },
              ...(finished ? {} : { interrupted: true }),
            });
          }),
      }),
    };
  }

  /** The row a call's usage lands in, opened while it streams. */
  private openUsage(args: {
    access: ModelAccess;
    path: string;
    fields: RequestFields;
    turn: Promise<string | undefined> | undefined;
  }): Promise<string | undefined> {
    return (async () =>
      this.deps.store.openUsage({
        record: await usageRecord(args),
      }))().catch((error: unknown) => {
      console.warn("[catamorphic] Could not open model usage", error);
      return undefined;
    });
  }

  /** Write a call's usage without anyone waiting on it. */
  private recordUsage(args: {
    access: ModelAccess;
    path: string;
    fields: RequestFields;
    usage: ModelCallUsage;
    turn: Promise<string | undefined> | undefined;
    opened?: Promise<string | undefined>;
  }): void {
    void (async () => {
      const openId = await args.opened;
      await this.deps.store.recordUsage({
        record: await usageRecord(args),
        usage: args.usage,
        ...(openId ? { openId } : {}),
      });
    })().catch((error: unknown) =>
      console.warn("[catamorphic] Could not record model usage", error),
    );
  }

  /** The grant, checked on every call, and its alias, resolved at most every 30 seconds. */
  private async authorize(
    request: Pick<ModelGatewayRequest, "alias" | "headers">,
  ): Promise<ModelAccess> {
    const token = grantFrom(request.headers);
    if (!token)
      throw new ModelGatewayError(
        401,
        "authentication_error",
        "Send this session's grant as the API key",
      );
    const grant = await this.deps.store.liveGrant({ token });
    if (!grant || grant.alias !== request.alias)
      throw new ModelGatewayError(
        401,
        "authentication_error",
        "This session's grant has expired or was revoked",
      );
    if (grant.agentSessionId && !grant.session?.active)
      throw new ModelGatewayError(
        401,
        "authentication_error",
        "This session is closed",
      );
    const now = this.deps.now?.() ?? Date.now();
    const cached = this.access.get(grant.id);
    if (
      cached &&
      cached.revision === grant.connection.revision &&
      cached.until > now &&
      grant.connection.status === "ready"
    )
      return cached.access;
    this.access.delete(grant.id);
    const identity: Identity = {
      tenantId: grant.tenantId,
      externalUserId:
        grant.session?.ownerId ?? `connection-grant:${grant.allocationId}`,
    };
    const resolved = await this.deps.broker.modelEndpoint({
      identity,
      allocationId: grant.allocationId,
      alias: grant.alias,
      ...(grant.agentSessionId ? { agentSessionId: grant.agentSessionId } : {}),
    });
    const access: ModelAccess = {
      identity,
      projectId: resolved.projectId,
      allocationId: grant.allocationId,
      sessionId: grant.agentSessionId,
      alias: grant.alias,
      connectionId: resolved.binding.connectionId,
      api: resolved.endpoint.api,
      providerKind: resolved.binding.providerKind,
      policy: resolved.binding.model,
      baseUrl: resolved.endpoint.baseUrl,
      headers: resolved.headers,
    };
    const until = Math.min(
      now + ACCESS_TTL_MS,
      grant.connection.expiresAt
        ? grant.connection.expiresAt.getTime() - ACCESS_EXPIRY_MARGIN_MS
        : Number.POSITIVE_INFINITY,
    );
    if (until > now) {
      // Renewed grants leave their entries behind: drop what has lapsed.
      for (const [id, entry] of this.access)
        if (entry.until <= now) this.access.delete(id);
      if (this.access.size >= ACCESS_CACHE_SIZE) {
        const oldest = this.access.keys().next().value;
        if (oldest !== undefined) this.access.delete(oldest);
      }
      this.access.set(grant.id, {
        revision: grant.connection.revision,
        until,
        access,
      });
    }
    return access;
  }
}

/** `base` joined with a checked path; null if the result left the base. */
function upstreamUrl(
  base: string,
  path: string,
  query: string | undefined,
): string | null {
  const root = base.replace(/\/+$/, "");
  const url = `${root}/${path}${query ? `?${query}` : ""}`;
  try {
    const parsed = new URL(url);
    const prefix = new URL(`${root}/`);
    return parsed.origin === prefix.origin &&
      parsed.pathname.startsWith(prefix.pathname)
      ? url
      : null;
  } catch {
    return null;
  }
}

/** What the gateway reads from a request body: never more than this. */
interface RequestFields {
  model?: string;
  stream?: boolean;
}

function requestFields(body: Uint8Array | undefined): RequestFields {
  if (!body || body.length === 0) return {};
  let parsed: Record<string, unknown>;
  try {
    parsed = record(JSON.parse(decoder.decode(body)));
  } catch {
    return {};
  }
  return {
    ...(typeof parsed.model === "string" && parsed.model
      ? { model: parsed.model }
      : {}),
    ...(typeof parsed.stream === "boolean" ? { stream: parsed.stream } : {}),
  };
}

/** A call's usage row: its session, and the turn running when it began. */
async function usageRecord(args: {
  access: ModelAccess;
  path: string;
  fields: RequestFields;
  turn: Promise<string | undefined> | undefined;
}): Promise<ModelUsageRecord> {
  const { access } = args;
  return {
    tenantId: access.identity.tenantId,
    projectId: access.projectId,
    sessionId: access.sessionId,
    turnId: (await args.turn) ?? null,
    allocationId: access.allocationId,
    connectionId: access.connectionId,
    alias: access.alias,
    endpoint: args.path,
    ...(args.fields.model ? { model: args.fields.model } : {}),
  };
}

/**
 * Pass an answer through unchanged, feeding `tap`; `onEnd` hears once,
 * when it ended (`finished`) or the caller stopped reading, and is never
 * awaited. The answer does not end before `beforeEnd` settles.
 */
async function* relay(args: {
  source: ReadableStream<Uint8Array>;
  tap?: UsageTap;
  beforeEnd?: Promise<unknown>;
  onEnd: (finished: boolean) => void;
}): AsyncIterable<Uint8Array> {
  const reader = args.source.getReader();
  let finished = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        await args.beforeEnd;
        finished = true;
        break;
      }
      args.tap?.push(next.value);
      yield next.value;
    }
  } finally {
    if (!finished) reader.cancel().catch(() => {});
    reader.releaseLock();
    try {
      args.onEnd(finished);
    } catch (error) {
      console.warn("[catamorphic] Could not settle a model call", error);
    }
  }
}

/** The API family a request speaks, for the shape of its refusals. */
function requestApi(
  request: Pick<ModelGatewayRequest, "path" | "headers">,
): ModelApi {
  return request.path.replace(/^\/+/, "").startsWith("v1/") ||
    request.headers["x-api-key"]
    ? "anthropic"
    : "openai";
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
                403,
                "permission_error",
                `The connection behind this alias is unavailable until an administrator reconnects it: ${error.message}`,
              )
            : undefined;
  if (!refusal)
    console.warn("[catamorphic] Model gateway request failed", error);
  // Refusals never carry a retryable status: a harness would only retry
  // into the same answer (ADR 0180). Only an unreachable provider is 502.
  const status = refusal?.status ?? 403;
  const kind = refusal?.kind ?? "permission_error";
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
