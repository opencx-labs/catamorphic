import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import {
  ConnectionActionDeniedError,
  ConnectionActionRefusedError,
  type ConnectionBroker,
} from "./connection-broker.js";
import {
  isHttpMethodCapability,
  type ResolvedConnectionBinding,
} from "./connection-types.js";
import {
  ConnectionUnavailableError,
  hashBearer,
} from "./connections-service.js";
import {
  downstreamResponseHeaders,
  modelRequestPath,
  upstreamRequestHeaders,
} from "./model-gateway.js";

const tracer = getTracer("@catamorphic/core");
const encoder = new TextEncoder();

/** Largest request body the gateway forwards to an HTTP API. */
export const HTTP_REQUEST_MAX_BYTES = 32 * 1024 * 1024;
/** How long a resolved alias (binding, endpoint, key headers) is reused. */
const ACCESS_TTL_MS = 30_000;
/** Most resolved aliases kept at once; the oldest goes first. */
const ACCESS_CACHE_SIZE = 1024;
/** A credential this close to expiry is resolved again, so it refreshes. */
const ACCESS_EXPIRY_MARGIN_MS = 60_000;

/**
 * A header that carries the session's grant, for clients that must keep
 * `Authorization` for something else. The gateway never forwards it.
 */
export const GRANT_HEADER = "x-work-grant";

/** The methods the gateway forwards, as a 405's `Allow` names them. */
const FORWARDED_METHODS = "GET, HEAD, POST, PUT, PATCH, DELETE";

/** One request code in a sandbox sent to `/gateway/http/<alias>…`. */
export interface HttpGatewayRequest {
  alias: string;
  /**
   * What follows the alias in the request's path, still percent-encoded:
   * empty for the alias itself, else from its slash (`/v1/events`).
   */
  path: string;
  /** The raw query string, without `?`. */
  query?: string;
  method: string;
  headers: Readonly<Record<string, string | undefined>>;
  body?: Uint8Array;
}

export interface HttpGatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | Uint8Array;
}

/** A refusal, with its status and a message a person can act on. */
export class HttpGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpGatewayError";
  }
}

/**
 * A grant while it, its Allocation, its session (if any) and its
 * connection are live, read in one indexed query per request.
 */
export interface LiveHttpGrant {
  id: string;
  tenantId: string;
  allocationId: string;
  agentSessionId: string | null;
  alias: string;
  /** Only grants written into a sandbox serve this route (ADR 0175). */
  channel: string;
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

/** What the HTTP gateway reads (ADR 0211). */
export interface HttpGatewayStore {
  /** The live grant a bearer names, or undefined. */
  liveGrant(args: { token: string }): Promise<LiveHttpGrant | undefined>;
}

/** The HTTP gateway's store in the host's database. */
export function dbHttpGatewayStore(db: Kysely<DB>): HttpGatewayStore {
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
          "grant.channel as channel",
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
        channel: row.channel,
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
  };
}

/**
 * The capability an HTTP method needs (ADR 0211): its lowercase name, and
 * `get` for HEAD. Undefined for a method the gateway does not forward.
 */
export function httpMethodCapability(method: string): string | undefined {
  const lower = method.toLowerCase();
  if (lower === "head") return "get";
  return isHttpMethodCapability(lower) ? lower : undefined;
}

/**
 * Where a request below an HTTP API alias goes, or why it may not: the
 * path must stay below the base URL (no dot segments, encoded slashes or
 * empty segments, plain or percent-encoded) and, when the provider names
 * `paths`, inside one of them by whole segments. `below` is the path under
 * the base URL as guards see it, from its slash (`/v1/events`, or `/`).
 */
export function httpUpstreamTarget(args: {
  alias: string;
  baseUrl: string;
  paths?: readonly string[];
  path: string;
  query?: string;
}): { url: string; below: string } | { refused: HttpGatewayError } {
  const leaves = {
    refused: new HttpGatewayError(
      404,
      `The gateway serves only paths below '${args.alias}''s base URL`,
    ),
  };
  const root = args.baseUrl.replace(/\/+$/, "");
  const rest = args.path.replace(/^\//, "");
  const checked = rest ? modelRequestPath(rest) : "";
  if (checked === null) return leaves;
  // The alias itself is the base URL; its trailing slash stays one.
  const url = `${root}${args.path ? `/${checked}` : ""}${args.query ? `?${args.query}` : ""}`;
  const parsed = parseUrl(url);
  const base = parseUrl(`${root}/`);
  if (!parsed || !base) return leaves;
  const basePath = base.pathname.replace(/\/+$/, "");
  const within = (prefix: string) =>
    parsed.pathname === prefix || parsed.pathname.startsWith(`${prefix}/`);
  if (parsed.origin !== base.origin || !within(basePath)) return leaves;
  const below = parsed.pathname.slice(basePath.length) || "/";
  if (
    args.paths &&
    !args.paths.some((prefix) =>
      within(`${basePath}${prefix}`.replace(/\/+$/, "")),
    )
  )
    return {
      refused: new HttpGatewayError(
        403,
        `'${below}' is outside the paths '${args.alias}' allows: ${args.paths.join(", ")}`,
      ),
    };
  return { url, below };
}

function parseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

/**
 * A query string as guards see it: each name with its value, or with all
 * of its values when it repeats.
 */
export function httpQueryInput(query: string | undefined): JsonObject {
  const input: Record<string, string | string[]> = {};
  for (const [name, value] of new URLSearchParams(query ?? "")) {
    const seen = input[name];
    input[name] =
      seen === undefined
        ? value
        : Array.isArray(seen)
          ? [...seen, value]
          : [seen, value];
  }
  return input;
}

/** A grant resolved to its alias's upstream: reused for a few seconds. */
interface HttpAccess {
  identity: Identity;
  projectId: string;
  allocationId: string;
  sessionId: string | null;
  binding: Pick<
    ResolvedConnectionBinding,
    "connectionId" | "alias" | "providerKind" | "capabilities"
  >;
  baseUrl: string;
  paths: readonly string[] | undefined;
  /** The binding's methods that only read. */
  reads: readonly string[];
  /** The session's agent is contained (ADR 0182): it may only read. */
  contained: boolean;
  /** The stored key's headers: they never leave the control plane. */
  headers: Readonly<Record<string, string>>;
}

/**
 * A request `admit` let in, handed to `handle` so it is not checked twice.
 * Only this gateway's own admissions count.
 */
export interface HttpGatewayAdmission {
  readonly access: HttpAccess;
}

/** What `admit` decided: a refusal to send, or an admission. */
export type HttpGatewayAdmitResult =
  | { refused: HttpGatewayResponse }
  | { admitted: HttpGatewayAdmission };

/**
 * HTTP APIs through the gateway (ADR 0211). Code in a sandbox (a dev
 * server, a CLI, an SDK, a test suite) sends an API's own requests to
 * `/gateway/http/<alias>/…` with its session's grant as a bearer, as the
 * Basic password, or in `x-work-grant`. The gateway checks the grant, the
 * binding's methods, the session's sandboxing and the guards, then
 * forwards the request below the connection's base URL with the stored
 * key in place of whatever authorization the caller sent: the body byte
 * for byte, the answer streamed back unchanged. Each request is audited as
 * `connection.http`.
 *
 * One indexed read checks the grant on each request; the resolved alias
 * and its key are reused for 30 seconds per grant and connection revision.
 */
export class HttpGatewayService {
  private readonly fetch: typeof fetch;
  /**
   * Replica memory (b): a grant's resolved alias, keyed by the grant and
   * its connection's revision, and bounded by the key's expiry.
   */
  private readonly access = new Map<
    string,
    { revision: number; until: number; access: HttpAccess }
  >();
  /** Replica memory (a): admissions of requests this process is serving. */
  private readonly admissions = new WeakSet<HttpGatewayAdmission>();

  constructor(
    private readonly deps: {
      store: HttpGatewayStore;
      broker: Pick<ConnectionBroker, "httpEndpoint" | "reviewHttpCall">;
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
    request: Pick<HttpGatewayRequest, "alias" | "headers">,
  ): Promise<HttpGatewayAdmitResult> {
    try {
      const admission: HttpGatewayAdmission = {
        access: await this.authorize(request),
      };
      this.admissions.add(admission);
      return { admitted: admission };
    } catch (error) {
      return { refused: refusalResponse(error) };
    }
  }

  async handle(
    request: HttpGatewayRequest & { admitted?: HttpGatewayAdmission },
  ): Promise<HttpGatewayResponse> {
    try {
      return await withSpan(
        {
          tracer,
          name: "gateway.http",
          attributes: {
            "catamorphic.connection.alias": request.alias,
            "catamorphic.connection.action": request.method.toLowerCase(),
          },
        },
        () => this.handleUninstrumented(request),
      );
    } catch (error) {
      return refusalResponse(error);
    }
  }

  private async handleUninstrumented(
    request: HttpGatewayRequest & { admitted?: HttpGatewayAdmission },
  ): Promise<HttpGatewayResponse> {
    const access =
      request.admitted && this.admissions.has(request.admitted)
        ? request.admitted.access
        : await this.authorize(request);
    const method = request.method.toUpperCase();
    const capability = httpMethodCapability(method);
    if (!capability)
      throw new HttpGatewayError(
        405,
        `The gateway forwards ${FORWARDED_METHODS}, not ${method}`,
      );
    const target = httpUpstreamTarget({
      alias: request.alias,
      baseUrl: access.baseUrl,
      ...(access.paths ? { paths: access.paths } : {}),
      path: request.path,
      ...(request.query ? { query: request.query } : {}),
    });
    if ("refused" in target) throw target.refused;
    const auditCall = await this.deps.broker.reviewHttpCall({
      identity: access.identity,
      projectId: access.projectId,
      allocationId: access.allocationId,
      binding: access.binding,
      action: method.toLowerCase(),
      capability,
      reads: access.reads,
      contained: access.contained,
      input: { path: target.below, query: httpQueryInput(request.query) },
      ...(access.sessionId ? { agentSessionId: access.sessionId } : {}),
    });
    const audit = (outcome: "allowed" | "error", metadata: Json) => {
      auditCall(outcome, metadata).catch((error: unknown) =>
        console.warn("[catamorphic] Could not audit an HTTP API call", error),
      );
    };
    const body =
      request.body && method !== "GET" && method !== "HEAD"
        ? request.body
        : undefined;
    const upstream = await this.fetch(target.url, {
      method,
      headers: upstreamRequestHeaders(
        withoutGrant(request.headers),
        access.headers,
      ),
      // A redirect could carry the key elsewhere; the caller sees it instead.
      redirect: "manual",
      ...(body ? { body } : {}),
    }).catch((error: unknown) => {
      audit("error", { error: "upstream unreachable" });
      throw new HttpGatewayError(
        502,
        `'${request.alias}' could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    const headers = downstreamResponseHeaders(upstream.headers);
    // The API's own answers, errors included, travel unchanged.
    const outcome = upstream.ok ? "allowed" : "error";
    if (!upstream.body) {
      audit(outcome, { status: upstream.status });
      return { status: upstream.status, headers, body: new Uint8Array() };
    }
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

  /** The grant, checked on every call, and its alias, resolved at most every 30 seconds. */
  private async authorize(
    request: Pick<HttpGatewayRequest, "alias" | "headers">,
  ): Promise<HttpAccess> {
    const token = grantFrom(request.headers);
    if (!token)
      throw new HttpGatewayError(
        401,
        `Send this session's grant for '${request.alias}' as a bearer, as the Basic password, or in ${GRANT_HEADER}`,
      );
    const grant = await this.deps.store.liveGrant({ token });
    if (!grant || grant.alias !== request.alias || grant.channel !== "sandbox")
      throw new HttpGatewayError(
        401,
        "This grant has expired, was revoked, or is not this alias's: read the grant file again",
      );
    if (grant.agentSessionId && !grant.session?.active)
      throw new HttpGatewayError(401, "This session is closed");
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
    const resolved = await this.deps.broker.httpEndpoint({
      identity,
      allocationId: grant.allocationId,
      alias: grant.alias,
      ...(grant.agentSessionId ? { agentSessionId: grant.agentSessionId } : {}),
    });
    const access: HttpAccess = {
      identity,
      projectId: resolved.projectId,
      allocationId: grant.allocationId,
      sessionId: grant.agentSessionId,
      binding: resolved.binding,
      baseUrl: resolved.endpoint.baseUrl,
      paths: resolved.endpoint.paths,
      reads: resolved.reads,
      contained: resolved.contained,
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

/** The caller's headers without the grant header, which stays here. */
function withoutGrant(
  headers: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).filter(
      ([name]) => name.toLowerCase() !== GRANT_HEADER,
    ),
  );
}

/**
 * The grant a caller sent: `x-work-grant`, else a bearer, else the
 * password of HTTP Basic, whatever the user name.
 */
function grantFrom(
  headers: Readonly<Record<string, string | undefined>>,
): string | null {
  const explicit = headers[GRANT_HEADER]?.trim();
  if (explicit) return explicit;
  const authorization = (headers.authorization ?? "").trim();
  const bearer = /^bearer\s+(\S+)$/i.exec(authorization)?.[1];
  if (bearer) return bearer;
  const basic = /^basic\s+(\S+)$/i.exec(authorization)?.[1];
  if (!basic) return null;
  const decoded = Buffer.from(basic, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  return separator < 0 ? null : decoded.slice(separator + 1).trim() || null;
}

/**
 * Pass an answer through unchanged; `onEnd` hears once, when it ended
 * (`finished`) or the caller stopped reading, and is never awaited.
 */
async function* relay(args: {
  source: ReadableStream<Uint8Array>;
  onEnd: (finished: boolean) => void;
}): AsyncIterable<Uint8Array> {
  const reader = args.source.getReader();
  let finished = false;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) {
        finished = true;
        break;
      }
      yield next.value;
    }
  } finally {
    if (!finished) reader.cancel().catch(() => {});
    reader.releaseLock();
    try {
      args.onEnd(finished);
    } catch (error) {
      console.warn("[catamorphic] Could not settle an HTTP API call", error);
    }
  }
}

function refusalResponse(error: unknown): HttpGatewayResponse {
  const refusal =
    error instanceof HttpGatewayError
      ? error
      : error instanceof ConnectionActionDeniedError
        ? new HttpGatewayError(403, `Refused: ${error.reason}`)
        : error instanceof ConnectionActionRefusedError
          ? new HttpGatewayError(403, error.message)
          : error instanceof ConnectionUnavailableError
            ? new HttpGatewayError(
                403,
                `The connection behind this alias is unavailable until an administrator reconnects it: ${error.message}`,
              )
            : undefined;
  if (!refusal)
    console.warn("[catamorphic] HTTP gateway request failed", error);
  // Refusals never carry a retryable status: a client would only retry
  // into the same answer. Only an unreachable API is 502.
  const status = refusal?.status ?? 403;
  const message =
    refusal?.message ?? "The gateway could not complete this request";
  return {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-cache",
      ...(status === 401
        ? { "www-authenticate": 'Basic realm="Work gateway"' }
        : {}),
      ...(status === 405 ? { allow: FORWARDED_METHODS } : {}),
    },
    body: encoder.encode(JSON.stringify({ error: { status, message } })),
  };
}
