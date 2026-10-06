import {
  type ConnectionActionDefinition,
  type ConnectionProvider,
  dotPathSegment,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
export type HttpMethod = (typeof METHODS)[number];

/** A named action's name: often the API's own, e.g. `chat.postMessage`. */
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;

/**
 * One operation of an API as its own action (ADR 0179): a fixed method and
 * path the caller cannot change, so a capability names exactly what may be
 * called (`chat.postMessage`, not every POST).
 */
export interface HttpApiAction {
  name: string;
  method: HttpMethod;
  /** Exact path below `baseUrl`, e.g. `/chat.postMessage`. */
  path: string;
  description?: string;
}

/** Headers a caller may never set: the gateway owns identity and routing. */
const RESERVED_HEADERS =
  /^(authorization|cookie|host|proxy-.*|x-forwarded-.*|forwarded|content-length|transfer-encoding|connection)$/i;

/**
 * How the stored key goes upstream: in `header` (after `scheme` and a
 * space, when given), or, with `basic`, as HTTP Basic credentials, the key
 * being `user:password` (as ClickHouse's HTTP interface takes them).
 */
export type HttpApiAuth = { header: string; scheme?: string } | { basic: true };

export interface HttpApiConnectionOptions {
  kind: string;
  displayName: string;
  /** HTTPS origin plus optional base path, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** How the stored key is sent. Defaults to `Authorization: Bearer <key>`. */
  auth?: HttpApiAuth;
  /** Path prefixes (below `baseUrl`) callers may reach; default everything. */
  paths?: readonly string[];
  /**
   * Named operations. When given they are the connection's only actions:
   * each has a fixed method and path, and capabilities name them. The
   * generic `get`, `post`, ... actions (and `paths`) are not offered.
   */
  actions?: readonly HttpApiAction[];
  /**
   * Largest part of a response body returned by one call. Default 1 MiB.
   * A larger GET body is read in byte ranges across calls (`range`).
   */
  maxResponseBytes?: number;
  /**
   * How much of one upstream body the gateway reads while locating a range
   * and counting its size. Default 64 MiB.
   */
  maxBodyBytes?: number;
  timeoutMs?: number;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const DEFAULT_MAX_BODY_BYTES = 64 * 1024 * 1024;

/**
 * A brokered HTTP API (ADR 0162). An operator or member pastes an API key
 * once; it lives in the credential vault and the gateway adds it to requests
 * for this one origin. Agents and workflows call `get`, `post`, ... with a
 * path and body and never see the key, and code in sandboxes sends the
 * API's own requests through the gateway's HTTP route (ADR 0212). Roles
 * narrow methods through the connection's capabilities. With `actions`,
 * each action is instead one fixed operation of the API, so capabilities
 * can name single operations (ADR 0179), and the connection has no route
 * for code: any method and path would reach past them.
 */
export function defineHttpApiConnectionProvider(
  options: HttpApiConnectionOptions,
): ConnectionProvider {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && !isLoopback(base.hostname)) {
    throw new Error(`${options.kind}: baseUrl must use HTTPS`);
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const auth = keyAuth(options.auth);
  const header = auth.header;
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxBodyBytes = Math.max(
    maxBytes,
    options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
  );
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  const named = namedActions(options);
  const origin = `${base.origin}${basePath}`;
  const ranges = `Bodies larger than ${maxBytes} bytes come back in parts: the result's range.nextOffset is where the next call's range.offset starts, and range.totalBytes is the whole size. Write large parts to files rather than reading them into the conversation.`;
  const actions: ConnectionActionDefinition[] = named
    ? named.map((action) => ({
        name: action.name,
        description: `${action.description ?? action.name} (${options.displayName}: ${action.method.toUpperCase()} ${origin}${action.path}).${action.method === "get" ? ` ${ranges}` : ""}`,
        inputSchema: requestSchema({ method: action.method, maxBytes }),
        annotations: { readOnlyHint: action.method === "get" },
      }))
    : METHODS.map((method) => ({
        name: method,
        description:
          method === "get"
            ? `GET a path on ${options.displayName} (${origin}). ${ranges}`
            : `${method.toUpperCase()} a path on ${options.displayName} (${origin})`,
        inputSchema: requestSchema({ method, maxBytes, basePath }),
        annotations: { readOnlyHint: method === "get" },
      }));

  const keyHeaders = (material: Uint8Array): Record<string, string> => ({
    [header]: auth.value(new TextDecoder().decode(material)),
  });

  return {
    kind: options.kind,
    displayName: options.displayName,
    // Code in sandboxes reaches the generic API, never named operations.
    ...(named
      ? {}
      : {
          http: {
            baseUrl: origin,
            ...(options.paths ? { paths: options.paths } : {}),
            headers: ({ material }) => keyHeaders(material),
          },
        }),
    beginAuthorization: async () => ({
      challenge: {
        kind: "form",
        fields: [
          {
            name: "apiKey",
            label: auth.basic
              ? "User and password, as user:password"
              : "API key",
            secret: true,
            required: true,
          },
        ],
      },
    }),
    completeAuthorization: async ({ callback }) => {
      const apiKey = callback.apiKey?.trim();
      if (!apiKey) throw new Error("An API key is required");
      if (auth.basic && apiKey.indexOf(":") <= 0)
        throw new Error("Enter the user and password as user:password");
      return {
        material: new TextEncoder().encode(apiKey),
        capabilities: actions.map((action) => action.name),
      };
    },
    listActions: async ({ capabilities }) =>
      actions.filter((action) => capabilities.includes(action.name)),
    // Contained agents may GET, nothing else (ADR 0182). A named action
    // reads when its declared method is GET, whatever it is called.
    readOnly: (action) =>
      (named
        ? named.find((candidate) => candidate.name === action)?.method
        : methodNamed(action)) === "get",
    invoke: async ({ material, action, input }) => {
      const operation = named?.find((candidate) => candidate.name === action);
      const method = named ? operation?.method : methodNamed(action);
      if (!method) throw new Error(`Unknown action '${action}'`);
      const request = parseRequest({
        input,
        ...(operation ? { fixedPath: operation.path } : {}),
      });
      if (request.range && method !== "get") {
        throw new Error("Only GET reads a response in ranges");
      }
      const target = resolveTarget({
        base,
        basePath,
        path: request.path,
        query: request.query,
        allowed: operation ? [operation.path] : options.paths,
        exact: operation !== undefined,
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (RESERVED_HEADERS.test(name) || name.toLowerCase() === header) {
          throw new Error(`Header '${name}' is set by the gateway`);
        }
        headers.set(name, value);
      }
      for (const [name, value] of Object.entries(keyHeaders(material)))
        headers.set(name, value);
      const hasBody = request.body !== undefined && method !== "get";
      if (hasBody && !headers.has("content-type")) {
        headers.set("content-type", "application/json; charset=utf-8");
      }
      const response = await doFetch(target, {
        method: method.toUpperCase(),
        headers,
        // A redirect could carry the key elsewhere; the caller sees it instead.
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      });
      return readResponse({
        response,
        maxBytes,
        maxBodyBytes,
        range: request.range,
        rangeable: method === "get",
      });
    },
  };
}

/** The header the stored key goes in, and its value there. */
function keyAuth(auth: HttpApiAuth | undefined): {
  header: string;
  basic: boolean;
  value: (key: string) => string;
} {
  if (!auth)
    return {
      header: "authorization",
      basic: false,
      value: (key) => `Bearer ${key}`,
    };
  if ("basic" in auth)
    return {
      header: "authorization",
      basic: true,
      value: (key) => `Basic ${Buffer.from(key, "utf8").toString("base64")}`,
    };
  const scheme = auth.scheme;
  return {
    header: auth.header.toLowerCase(),
    basic: false,
    value: (key) => (scheme ? `${scheme} ${key}` : key),
  };
}

function methodNamed(value: string): HttpMethod | undefined {
  return METHODS.find((method) => method === value);
}

/** Validated named actions, or undefined for the generic method actions. */
function namedActions(
  options: HttpApiConnectionOptions,
): readonly HttpApiAction[] | undefined {
  const { actions, paths, kind } = options;
  if (!actions) return undefined;
  if (paths) {
    throw new Error(`${kind}: declare either actions or paths, not both`);
  }
  if (actions.length === 0) throw new Error(`${kind}: actions is empty`);
  const seen = new Set<string>();
  for (const action of actions) {
    if (!ACTION_NAME.test(action.name)) {
      throw new Error(`${kind}: invalid action name '${action.name}'`);
    }
    if (seen.has(action.name)) {
      throw new Error(`${kind}: duplicate action '${action.name}'`);
    }
    seen.add(action.name);
    if (!methodNamed(action.method)) {
      throw new Error(`${kind}: action '${action.name}' has no HTTP method`);
    }
    if (
      !action.path.startsWith("/") ||
      action.path.includes("..") ||
      /[?#%\\]/.test(action.path)
    ) {
      throw new Error(
        `${kind}: action '${action.name}' needs a plain path starting with '/'`,
      );
    }
  }
  return actions;
}

/**
 * A request's input: `path` for the generic method actions (a named
 * action's path is fixed), `query`, `headers`, a `body` for methods that
 * send one, and a byte `range` for GET.
 */
function requestSchema(args: {
  method: HttpMethod;
  maxBytes: number;
  /** Present for the generic method actions, which take a path. */
  basePath?: string;
}): Json {
  const { method, maxBytes, basePath } = args;
  return {
    type: "object",
    properties: {
      ...(basePath !== undefined
        ? {
            path: {
              type: "string",
              description: `Path below ${basePath || "/"}`,
            },
          }
        : {}),
      query: { type: "object", additionalProperties: { type: "string" } },
      headers: { type: "object", additionalProperties: { type: "string" } },
      ...(method === "get"
        ? {
            range: {
              type: "object",
              description: `A byte range of the response body, at most ${maxBytes} bytes. Absent reads from the start.`,
              properties: {
                offset: { type: "integer", minimum: 0 },
                length: { type: "integer", minimum: 1, maximum: maxBytes },
              },
              required: ["offset"],
              additionalProperties: false,
            },
          }
        : {}),
      ...(method === "get" || method === "delete" ? {} : { body: {} }),
    },
    ...(basePath !== undefined ? { required: ["path"] } : {}),
    additionalProperties: false,
  };
}

function parseRequest(args: { input: Json; fixedPath?: string }): {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: Json;
  range?: { offset: number; length?: number };
} {
  const { input } = args;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Request input must be an object");
  }
  if (args.fixedPath !== undefined && input.path !== undefined) {
    throw new Error("This action's path is fixed; leave path out");
  }
  const path = args.fixedPath ?? input.path;
  if (typeof path !== "string") throw new Error("A request path is required");
  const range = parseRange(input.range);
  return {
    path,
    query: stringRecord(input.query, "query"),
    headers: stringRecord(input.headers, "headers"),
    ...(input.body !== undefined ? { body: input.body } : {}),
    ...(range ? { range } : {}),
  };
}

function parseRange(
  value: Json | undefined,
): { offset: number; length?: number } | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("range must be an object with offset and length");
  }
  const { offset, length } = value;
  if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
    throw new Error("range.offset must be a non-negative integer");
  }
  if (
    length !== undefined &&
    (typeof length !== "number" || !Number.isInteger(length) || length < 1)
  ) {
    throw new Error("range.length must be a positive integer");
  }
  return { offset, ...(typeof length === "number" ? { length } : {}) };
}

function stringRecord(
  value: Json | undefined,
  what: string,
): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Request ${what} must be an object of strings`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      if (typeof entry !== "string") {
        throw new Error(`Request ${what} must be an object of strings`);
      }
      return [key, entry];
    }),
  );
}

function resolveTarget(args: {
  base: URL;
  basePath: string;
  path: string;
  query: Record<string, string>;
  allowed?: readonly string[];
  /** The path must equal an allowed entry, not merely sit below one. */
  exact?: boolean;
}): string {
  const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
  if (
    path.includes("..") ||
    path.includes("\\") ||
    /[?#]/.test(path) ||
    /%(2e|2f|5c)/i.test(path) ||
    // `.;x` is `.` to a server that strips path parameters.
    path.split("/").some(dotPathSegment)
  ) {
    throw new Error(
      "Paths may not contain '..', '?', '#', backslashes, dot segments, or encoded dots and slashes",
    );
  }
  const target = new URL(`${args.basePath}${path}`, args.base.origin);
  if (target.origin !== args.base.origin) {
    throw new Error("Requests must stay on the connection's origin");
  }
  // URL parsing resolves encoded dot segments (`%2e%2e`); check the path it
  // actually produced against the base path and the allowlist.
  const resolved = target.pathname;
  const within = (prefix: string) =>
    resolved === prefix || resolved.startsWith(prefix.replace(/\/?$/, "/"));
  if (args.basePath && !within(args.basePath)) {
    throw new Error("Requests must stay under the connection's base path");
  }
  if (
    args.allowed &&
    !args.allowed.some((prefix) =>
      args.exact
        ? resolved === `${args.basePath}${prefix}`
        : within(`${args.basePath}${prefix}`),
    )
  ) {
    throw new Error(
      `Path '${path}' is outside this connection's allowed paths`,
    );
  }
  for (const [key, value] of Object.entries(args.query)) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

/** Bytes kept past a range's end so it can end on a whole character. */
const UTF8_SLACK = 3;

/**
 * Read one part of a response body: `range` (default the start) up to
 * `maxBytes`, on whole UTF-8 characters, while counting the body's size up
 * to `maxBodyBytes`. A body that fits whole in one call comes back parsed
 * as before; a larger one reports where the next part starts.
 */
async function readResponse(args: {
  response: Response;
  maxBytes: number;
  maxBodyBytes: number;
  range?: { offset: number; length?: number };
  rangeable: boolean;
}) {
  const { response } = args;
  const offset = args.range?.offset ?? 0;
  const length = Math.min(args.range?.length ?? args.maxBytes, args.maxBytes);
  const windowEnd = offset + length + UTF8_SLACK;
  const kept: Uint8Array[] = [];
  let position = 0;
  let complete = true;
  const reader = response.body?.getReader();
  while (reader) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = next.value;
    const start = Math.max(offset - position, 0);
    const end = Math.min(chunk.byteLength, windowEnd - position);
    if (end > start) kept.push(chunk.subarray(start, end));
    position += chunk.byteLength;
    if (position > args.maxBodyBytes) {
      complete = false;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const bytes = concat(kept);
  // Start and end on character boundaries (never inside a UTF-8 sequence).
  let from = 0;
  if (offset > 0) {
    while (from < bytes.byteLength && isContinuation(bytes[from])) from += 1;
  }
  let to = Math.min(bytes.byteLength, length);
  while (to > from && to < bytes.byteLength && isContinuation(bytes[to])) {
    to -= 1;
  }
  const part = bytes.subarray(from, to);
  const partEnd = offset + to;
  const more = !complete || partEnd < position;
  const whole = offset === 0 && !more;
  const text = new TextDecoder().decode(part);
  const contentType = response.headers.get("content-type") ?? "";
  let body: Json = text;
  if (whole && contentType.includes("json")) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return {
    status: response.status,
    contentType,
    ...(response.headers.get("location")
      ? { location: response.headers.get("location") }
      : {}),
    body,
    ...(whole
      ? {}
      : {
          range: {
            offset: offset + from,
            length: part.byteLength,
            // Only a GET may be repeated to read on.
            ...(more && args.rangeable ? { nextOffset: partEnd } : {}),
            ...(complete ? { totalBytes: position } : {}),
          },
        }),
    ...(more ? { truncated: true } : {}),
  };
}

function isContinuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0),
  );
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}
