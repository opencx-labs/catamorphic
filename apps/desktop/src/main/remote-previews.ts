import { createHash } from "node:crypto";
import fs from "node:fs";
import http, { type IncomingHttpHeaders } from "node:http";
import path from "node:path";
import { PREVIEW_REFUSAL_HEADER } from "@catamorphic/fastify-plugin";
import {
  type RemoteProjectProfiles,
  remoteProjectFetch,
} from "./remote-api.js";
import {
  DESKTOP_API_TOKEN_HEADER,
  previewRequestRefusal,
} from "./server/local-api-guard.js";

/*
 * Previews of servers running in a remote chat's workspace (ADR 0208). The
 * project's server forwards each request into the sandbox; the desktop adds
 * the member's credentials. Each preview gets a loopback host of its own
 * here (`p-<id>.localhost`, which Chromium resolves to loopback), so a
 * page's root-relative URLs (`/assets/app.js`, `/@vite/client`) and its
 * cookies stay its own, as on the developer's own machine: cookies ignore
 * ports, and a host-only cookie of one preview never reaches another, nor
 * do the person's own `127.0.0.1` cookies reach a sandbox.
 */

/** Largest request body a preview carries, as the server accepts. */
const PREVIEW_BODY_LIMIT = 16 * 1024 * 1024;

/**
 * Headers that belong to one connection, that this side sets, or that
 * carry this computer's own credentials: the member's bearer reaches the
 * server only as the authorization this side adds.
 */
const REQUEST_HEADERS_DROPPED = [
  "connection",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "authorization",
  "content-length",
  "forwarded",
  "x-real-ip",
  DESKTOP_API_TOKEN_HEADER,
  // The server's answer is decoded here; the page gets it plain.
  "accept-encoding",
];

/** Header families the host uses for itself, never a page's. */
const REQUEST_HEADER_PREFIXES_DROPPED = [
  "x-catamorphic-",
  "x-work-",
  "x-forwarded-",
];

function droppedRequestHeader(name: string): boolean {
  return (
    REQUEST_HEADERS_DROPPED.includes(name) ||
    REQUEST_HEADER_PREFIXES_DROPPED.some((prefix) => name.startsWith(prefix))
  );
}
const RESPONSE_HEADERS_DROPPED = [
  "connection",
  "keep-alive",
  "transfer-encoding",
  "content-length",
  "content-encoding",
  PREVIEW_REFUSAL_HEADER,
];

/** One preview: a port in one chat's workspace of one linked project. */
export interface PreviewAddress {
  /** The desktop's own id of the linked project. */
  projectId: string;
  sessionId: string;
  port: number;
}

export interface PreviewAnswer {
  status: number;
  headers: Array<[string, string]>;
  body: Buffer;
}

/**
 * The preview's own host: one per project, chat and port, the same across
 * restarts, so a restored tab's address still names it.
 */
export function previewHost(address: PreviewAddress): string {
  const id = createHash("sha256")
    .update(key(address))
    .digest("hex")
    .slice(0, 20);
  return `p-${id}.localhost`;
}

/** Where the page goes for a redirect the server pointed below its preview. */
export function localPreviewLocation(input: {
  location: string;
  sessionId: string;
  port: number;
}): string {
  const marker = `/agent/sessions/${input.sessionId}/previews/${input.port}`;
  const at = input.location.indexOf(marker);
  if (at < 0) return input.location;
  const rest = input.location.slice(at + marker.length);
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/**
 * One request to a preview through the project's server as its member.
 * Undefined when the project has no server.
 */
export async function forwardPreview(input: {
  profiles: RemoteProjectProfiles;
  address: PreviewAddress;
  /** Path and query below the port, starting with `/`. */
  path: string;
  method: string;
  headers: Array<[string, string]>;
  body?: Buffer;
  signal?: AbortSignal;
}): Promise<PreviewAnswer | undefined> {
  const { address } = input;
  const headers: Record<string, string> = {};
  for (const [name, value] of input.headers) {
    const key = name.toLowerCase();
    if (droppedRequestHeader(key)) continue;
    headers[key] =
      key in headers
        ? `${headers[key]}${key === "cookie" ? "; " : ", "}${value}`
        : value;
  }
  const sent = await remoteProjectFetch({
    profiles: input.profiles,
    projectId: address.projectId,
    apiPath: `/projects/${address.projectId}/agent/sessions/${address.sessionId}/previews/${address.port}${input.path.startsWith("/") ? input.path : `/${input.path}`}`,
    method: input.method,
    headers,
    ...(input.body && input.body.byteLength > 0 ? { body: input.body } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  if (!sent) return undefined;
  const { response } = sent;
  const body = Buffer.from(await response.arrayBuffer());
  if (response.headers.get(PREVIEW_REFUSAL_HEADER))
    return refusalPage({ status: response.status, body });
  const pairs: Array<[string, string]> = [];
  response.headers.forEach((value, name) => {
    // A preview is its tab's alone: no other site may read it, whatever
    // the dev server allows.
    if (
      name === "set-cookie" ||
      name.startsWith("access-control-") ||
      RESPONSE_HEADERS_DROPPED.includes(name)
    )
      return;
    pairs.push([
      name,
      name === "location"
        ? localPreviewLocation({
            location: value,
            sessionId: address.sessionId,
            port: address.port,
          })
        : value,
    ]);
  });
  for (const cookie of response.headers.getSetCookie())
    pairs.push(["set-cookie", cookie]);
  return { status: response.status, headers: pairs, body };
}

/**
 * The route's own refusal (the workspace is not running, nothing listens
 * on the port) as a small page a person reads in the tab.
 */
function refusalPage(input: { status: number; body: Buffer }): PreviewAnswer {
  let message = "This preview is not available.";
  try {
    const parsed: unknown = JSON.parse(input.body.toString("utf8"));
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "error" in parsed &&
      typeof parsed.error === "string"
    )
      message = parsed.error;
  } catch {
    // Not JSON: the generic message stands.
  }
  return {
    status: input.status,
    headers: [
      ["content-type", "text/html; charset=utf-8"],
      ["cache-control", "no-store"],
    ],
    body: Buffer.from(previewNotice(message)),
  };
}

/** A plain page with one message, in the system's own look. */
export function previewNotice(message: string): string {
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>Preview</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;color:CanvasText;background:Canvas}p{max-width:32rem;margin:1rem;text-align:center;opacity:.8}</style></head><body><p>${escaped} Reload when it is ready.</p></body></html>`;
}

interface StoredPreview extends PreviewAddress {
  listenPort: number;
}

/** Previews kept listening across restarts; older ones are forgotten. */
const KEPT_PREVIEWS = 20;

/**
 * Each preview's own loopback origin: its own host, and a port it keeps
 * across restarts (remembered in `file`), so a restored browser tab still
 * opens.
 */
export class RemotePreviewOrigins {
  private readonly servers = new Map<
    string,
    Promise<{ server: http.Server; listenPort: number }>
  >();

  constructor(
    private readonly deps: {
      file: string;
      profiles: RemoteProjectProfiles;
      /** The loopback host previews listen on; tests pass their own. */
      host?: string;
    },
  ) {}

  /** The preview's address in a browser tab, listening from now on. */
  async open(address: PreviewAddress): Promise<string> {
    const stored = this.load().find((entry) => key(entry) === key(address));
    const { listenPort } = await this.listen(address, stored?.listenPort);
    this.remember({ ...address, listenPort });
    return `http://${previewHost(address)}:${listenPort}/`;
  }

  /** Listen again for the previews open tabs may still show. */
  async restore(): Promise<void> {
    await Promise.all(
      this.load().map((entry) =>
        this.listen(entry, entry.listenPort).catch(() => undefined),
      ),
    );
  }

  async close(): Promise<void> {
    const servers = await Promise.all(
      [...this.servers.values()].map((pending) =>
        pending.catch(() => undefined),
      ),
    );
    this.servers.clear();
    await Promise.all(
      servers.map(
        (entry) =>
          new Promise<void>((resolve) => {
            if (!entry) return resolve();
            entry.server.closeAllConnections();
            entry.server.close(() => resolve());
          }),
      ),
    );
  }

  /** The loopback address previews listen on. */
  private get host(): string {
    return this.deps.host ?? "127.0.0.1";
  }

  private listen(
    address: PreviewAddress,
    preferredPort: number | undefined,
  ): Promise<{ server: http.Server; listenPort: number }> {
    const id = key(address);
    const existing = this.servers.get(id);
    if (existing) return existing;
    const started = this.startServer(address, preferredPort);
    this.servers.set(id, started);
    started.catch(() => this.servers.delete(id));
    return started;
  }

  private async startServer(
    address: PreviewAddress,
    preferredPort: number | undefined,
  ): Promise<{ server: http.Server; listenPort: number }> {
    const server = http.createServer((request, response) => {
      void this.serve({ address, request, response }).catch((error) => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response
          .writeHead(502, { "content-type": "text/html; charset=utf-8" })
          .end(
            previewNotice(
              error instanceof Error
                ? `The project's server did not answer: ${error.message}.`
                : "The project's server did not answer.",
            ),
          );
      });
    });
    const bind = (port: number) =>
      new Promise<number>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, this.host, () => {
          server.off("error", reject);
          const bound = server.address();
          resolve(typeof bound === "object" && bound ? bound.port : port);
        });
      });
    // The port a restored tab still points at, when it is free.
    const listenPort = await bind(preferredPort ?? 0).catch(() => bind(0));
    return { server, listenPort };
  }

  private async serve(input: {
    address: PreviewAddress;
    request: http.IncomingMessage;
    response: http.ServerResponse;
  }): Promise<void> {
    const { request, response } = input;
    const ownOrigin = `http://${previewHost(input.address)}:${request.socket.localPort ?? 0}`;
    const refusal = previewRequestRefusal({
      headers: request.headers,
      origin: ownOrigin,
    });
    if (refusal) {
      response
        .writeHead(403, { "content-type": "text/plain; charset=utf-8" })
        .end(refusal);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > PREVIEW_BODY_LIMIT) {
        response
          .writeHead(413, { "content-type": "text/html; charset=utf-8" })
          .end(previewNotice("A preview request carries at most 16 MiB."));
        return;
      }
      chunks.push(bytes);
    }
    const controller = new AbortController();
    response.once("close", () => {
      if (!response.writableEnded) controller.abort();
    });
    const answer = await forwardPreview({
      profiles: this.deps.profiles,
      address: input.address,
      path: request.url ?? "/",
      method: request.method ?? "GET",
      headers: headerPairs(request.headers, {
        ownOrigin,
        sandboxOrigin: `http://127.0.0.1:${input.address.port}`,
      }),
      ...(chunks.length > 0 ? { body: Buffer.concat(chunks) } : {}),
      signal: controller.signal,
    });
    if (!answer) {
      response
        .writeHead(404, { "content-type": "text/html; charset=utf-8" })
        .end(previewNotice("This project is no longer linked to its server."));
      return;
    }
    const headers: Record<string, string | string[]> = {};
    for (const [name, value] of answer.headers) {
      const current = headers[name];
      headers[name] =
        current === undefined
          ? value
          : Array.isArray(current)
            ? [...current, value]
            : [current, value];
    }
    response.writeHead(answer.status, headers).end(answer.body);
  }

  private load(): StoredPreview[] {
    try {
      const parsed: unknown = JSON.parse(
        fs.readFileSync(this.deps.file, "utf8"),
      );
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        !("previews" in parsed) ||
        !Array.isArray(parsed.previews)
      )
        return [];
      return parsed.previews.flatMap((entry: unknown): StoredPreview[] =>
        typeof entry === "object" &&
        entry !== null &&
        "projectId" in entry &&
        typeof entry.projectId === "string" &&
        "sessionId" in entry &&
        typeof entry.sessionId === "string" &&
        "port" in entry &&
        typeof entry.port === "number" &&
        "listenPort" in entry &&
        typeof entry.listenPort === "number"
          ? [
              {
                projectId: entry.projectId,
                sessionId: entry.sessionId,
                port: entry.port,
                listenPort: entry.listenPort,
              },
            ]
          : [],
      );
    } catch {
      return [];
    }
  }

  private remember(entry: StoredPreview): void {
    const kept = [
      ...this.load().filter((stored) => key(stored) !== key(entry)),
      entry,
    ].slice(-KEPT_PREVIEWS);
    fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
    fs.writeFileSync(
      this.deps.file,
      `${JSON.stringify({ version: 1, previews: kept }, null, 2)}\n`,
    );
  }
}

function key(address: PreviewAddress): string {
  return `${address.projectId}\0${address.sessionId}\0${address.port}`;
}

/**
 * A request's headers as pairs. The page's own origin becomes the one the
 * server in the sandbox knows itself by, so its same-origin checks hold.
 * Cookies go only with a request to the preview's own host from itself (or
 * a typed address): none of another site's, nor the person's own.
 */
function headerPairs(
  headers: IncomingHttpHeaders,
  origins: { ownOrigin: string; sandboxOrigin: string },
): Array<[string, string]> {
  const own = new URL(origins.ownOrigin);
  const host = headers.host?.toLowerCase();
  const origin = headers.origin;
  const ownRequest =
    host === own.host && (origin === undefined || origin === own.origin);
  const pairs: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "cookie" && !ownRequest) continue;
    for (const one of Array.isArray(value) ? value : [value])
      pairs.push([
        name,
        name === "origin" && one === origins.ownOrigin
          ? origins.sandboxOrigin
          : name === "referer" && one.startsWith(`${origins.ownOrigin}/`)
            ? `${origins.sandboxOrigin}${one.slice(origins.ownOrigin.length)}`
            : one,
      ]);
  }
  return pairs;
}
