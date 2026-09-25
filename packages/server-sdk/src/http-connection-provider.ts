import type {
  ConnectionActionDefinition,
  ConnectionProvider,
} from "@catamorphic/core";
import type { Json } from "@catamorphic/db";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
type Method = (typeof METHODS)[number];

/** Headers a caller may never set: the gateway owns identity and routing. */
const RESERVED_HEADERS =
  /^(authorization|cookie|host|proxy-.*|x-forwarded-.*|forwarded|content-length|transfer-encoding|connection)$/i;

export interface HttpApiConnectionOptions {
  kind: string;
  displayName: string;
  /** HTTPS origin plus optional base path, e.g. `https://api.example.com/v1`. */
  baseUrl: string;
  /** How the stored key is sent. Defaults to `Authorization: Bearer <key>`. */
  auth?: { header: string; scheme?: string };
  /** Path prefixes (below `baseUrl`) callers may reach; default everything. */
  paths?: readonly string[];
  /** Largest response body returned to the caller. Default 1 MiB. */
  maxResponseBytes?: number;
  timeoutMs?: number;
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/**
 * A brokered HTTP API (ADR 0162). An operator or member pastes an API key
 * once; it lives in the credential vault and the gateway adds it to requests
 * for this one origin. Agents and workflows call `get`, `post`, ... with a
 * path and body and never see the key. Roles narrow methods through the
 * connection's capabilities.
 */
export function defineHttpApiConnectionProvider(
  options: HttpApiConnectionOptions,
): ConnectionProvider {
  const base = new URL(options.baseUrl);
  if (base.protocol !== "https:" && !isLoopback(base.hostname)) {
    throw new Error(`${options.kind}: baseUrl must use HTTPS`);
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  const header = options.auth?.header ?? "authorization";
  const scheme =
    options.auth?.scheme ?? (options.auth?.header ? undefined : "Bearer");
  const maxBytes = options.maxResponseBytes ?? 1024 * 1024;
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));

  const actions: ConnectionActionDefinition[] = METHODS.map((method) => ({
    name: method,
    description: `${method.toUpperCase()} a path on ${options.displayName} (${base.origin}${basePath})`,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: `Path below ${basePath || "/"}` },
        query: { type: "object", additionalProperties: { type: "string" } },
        headers: { type: "object", additionalProperties: { type: "string" } },
        ...(method === "get" || method === "delete" ? {} : { body: {} }),
      },
      required: ["path"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: method === "get" },
  }));

  return {
    kind: options.kind,
    displayName: options.displayName,
    beginAuthorization: async () => ({
      challenge: {
        kind: "form",
        fields: [
          { name: "apiKey", label: "API key", secret: true, required: true },
        ],
      },
    }),
    completeAuthorization: async ({ callback }) => {
      const apiKey = callback.apiKey?.trim();
      if (!apiKey) throw new Error("An API key is required");
      return {
        material: new TextEncoder().encode(apiKey),
        capabilities: [...METHODS],
      };
    },
    listActions: async ({ capabilities }) =>
      actions.filter((action) => capabilities.includes(action.name)),
    invoke: async ({ material, action, input }) => {
      if (!isMethod(action)) throw new Error(`Unknown action '${action}'`);
      const request = parseRequest(input);
      const target = resolveTarget({
        base,
        basePath,
        path: request.path,
        query: request.query,
        allowed: options.paths,
      });
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (RESERVED_HEADERS.test(name) || name.toLowerCase() === header) {
          throw new Error(`Header '${name}' is set by the gateway`);
        }
        headers.set(name, value);
      }
      const key = new TextDecoder().decode(material);
      headers.set(header, scheme ? `${scheme} ${key}` : key);
      const hasBody = request.body !== undefined && action !== "get";
      if (hasBody && !headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
      const response = await doFetch(target, {
        method: action.toUpperCase(),
        headers,
        // A redirect could carry the key elsewhere; the caller sees it instead.
        redirect: "manual",
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
        ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      });
      return readResponse(response, maxBytes);
    },
  };
}

function isMethod(value: string): value is Method {
  return METHODS.some((method) => method === value);
}

function parseRequest(input: Json): {
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body?: Json;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Request input must be an object");
  }
  const path = input.path;
  if (typeof path !== "string") throw new Error("A request path is required");
  return {
    path,
    query: stringRecord(input.query, "query"),
    headers: stringRecord(input.headers, "headers"),
    ...(input.body !== undefined ? { body: input.body } : {}),
  };
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
}): string {
  const path = args.path.startsWith("/") ? args.path : `/${args.path}`;
  if (path.includes("..") || path.includes("\\") || /[?#]/.test(path)) {
    throw new Error("Paths may not contain '..', '?', '#', or backslashes");
  }
  if (
    args.allowed &&
    !args.allowed.some(
      (prefix) =>
        path === prefix || path.startsWith(prefix.replace(/\/?$/, "/")),
    )
  ) {
    throw new Error(
      `Path '${path}' is outside this connection's allowed paths`,
    );
  }
  const target = new URL(`${args.basePath}${path}`, args.base.origin);
  if (target.origin !== args.base.origin) {
    throw new Error("Requests must stay on the connection's origin");
  }
  for (const [key, value] of Object.entries(args.query)) {
    target.searchParams.set(key, value);
  }
  return target.toString();
}

async function readResponse(response: Response, maxBytes: number) {
  const bytes = new Uint8Array(await response.arrayBuffer());
  const truncated = bytes.byteLength > maxBytes;
  const text = new TextDecoder().decode(
    truncated ? bytes.slice(0, maxBytes) : bytes,
  );
  const contentType = response.headers.get("content-type") ?? "";
  let body: Json = text;
  if (!truncated && contentType.includes("json")) {
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
    ...(truncated ? { truncated: true } : {}),
  };
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
  );
}
