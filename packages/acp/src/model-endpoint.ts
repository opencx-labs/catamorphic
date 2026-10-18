import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { Readable } from "node:stream";
import type { ModelAccess } from "@catamorphic/agent-protocol/runner";

/** Largest request body the endpoint takes, as the gateway does. */
const MAX_REQUEST_BYTES = 32 * 1024 * 1024;

/**
 * Request headers that stay here: the agent's key (the grant replaces it),
 * its host, and what the transport recomputes. Hop-by-hop headers (RFC
 * 9110 7.6.1) describe this connection only.
 */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "host",
  "content-length",
  "accept-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "expect",
]);

/** Response headers `fetch` already undid (encoding, length) or that describe this hop. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "content-length",
  "content-encoding",
  "connection",
  "keep-alive",
  "transfer-encoding",
]);

/** The gateway's model API, served to an ACP agent on this sandbox's loopback. */
export interface LoopbackModel {
  /** The API family behind it. */
  api: "anthropic" | "openai";
  /** Where the agent sends the API's paths, e.g. `http://127.0.0.1:41234`. */
  baseUrl: string;
  /** The key the agent sends; it opens only this endpoint, for this attempt. */
  apiKey: string;
  close(): void;
}

/**
 * The gateway's model API for one attempt on this sandbox's loopback (ADR
 * 0255). An ACP agent holds its key for its lifetime, while the session's
 * grant is renewed every 20 minutes: so the agent gets a key of its own for
 * this endpoint, and every request goes on to the gateway with the grant
 * read from its file just before, once more after a refusal in case it was
 * renewed in between. Paths and answers pass unchanged, answers streamed;
 * a request body is read whole first, so the retry can send it again. An
 * agent that stops waiting stops the call, and closing the endpoint ends
 * every call still running.
 */
export async function serveLoopbackModel(input: {
  access: Extract<ModelAccess, { kind: "gateway" }>;
  fetch?: typeof fetch;
}): Promise<LoopbackModel> {
  const { access } = input;
  const send = input.fetch ?? ((url, init) => fetch(url, init));
  const apiKey = `work-${randomBytes(24).toString("hex")}`;
  const upstream = access.baseUrl.replace(/\/+$/, "");
  /** Calls still running, so closing the endpoint ends them. */
  const running = new Set<AbortController>();
  const grant = async () => {
    try {
      return (await readFile(access.keyFile, "utf8")).trim();
    } catch (error) {
      throw new UnreadableGrantError(error);
    }
  };

  const forward = async (
    request: IncomingMessage,
    response: ServerResponse,
    signal: AbortSignal,
  ) => {
    if (!authorized(request, apiKey)) {
      refuse({
        response,
        api: access.api,
        status: 401,
        message: "This endpoint takes the key Work gave this agent",
      });
      return;
    }
    const body = await readBody(request);
    if (body === "too large") {
      refuse({
        response,
        api: access.api,
        status: 413,
        message: "The request is larger than the gateway takes",
      });
      return;
    }
    const url = `${upstream}${request.url ?? "/"}`;
    const call = async (key: string) =>
      send(url, {
        method: request.method ?? "GET",
        headers: upstreamHeaders({ request, api: access.api, key }),
        redirect: "manual",
        signal,
        ...(body.length > 0 ? { body } : {}),
      });
    let key = await grant();
    let answer = await call(key);
    // A grant renewed between reading it and the gateway checking it.
    if (answer.status === 401) {
      const renewed = await grant();
      if (renewed !== key) {
        await answer.body?.cancel();
        key = renewed;
        answer = await call(key);
      }
    }
    if (response.destroyed) {
      await answer.body?.cancel();
      return;
    }
    const headers: Record<string, string> = {};
    answer.headers.forEach((value, name) => {
      if (!DROPPED_RESPONSE_HEADERS.has(name.toLowerCase()))
        headers[name] = value;
    });
    response.writeHead(answer.status, headers);
    if (!answer.body) {
      response.end();
      return;
    }
    const stream = Readable.fromWeb(answer.body);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  };

  const server: Server = createServer((request, response) => {
    const call = new AbortController();
    running.add(call);
    // Registered before the call starts: an agent that stops waiting, even
    // before the answer's headers, stops the call upstream.
    response.once("close", () => {
      call.abort();
      running.delete(call);
    });
    forward(request, response, call.signal).catch((error: unknown) => {
      if (response.headersSent || response.destroyed) response.destroy();
      else
        refuse({
          response,
          api: access.api,
          status: error instanceof UnreadableGrantError ? 500 : 502,
          message:
            error instanceof UnreadableGrantError
              ? error.message
              : `The gateway could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    api: access.api,
    baseUrl: `http://127.0.0.1:${port}`,
    apiKey,
    close: () => {
      for (const call of running) call.abort();
      running.clear();
      server.close();
      server.closeAllConnections();
    },
  };
}

/** The session's grant file could not be read. */
class UnreadableGrantError extends Error {
  constructor(cause: unknown) {
    super(
      `The session's model grant could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "UnreadableGrantError";
  }
}

/**
 * The environment an agent finds its model in: Work's own names, which an
 * agent's configuration can point at (`{env:WORK_MODEL_BASE_URL}`), and
 * the API family's conventional ones, which most agents read unasked.
 */
export function loopbackModelEnv(input: {
  model: LoopbackModel;
  modelId?: string;
}): Record<string, string> {
  const { model } = input;
  return {
    WORK_MODEL_API: model.api,
    WORK_MODEL_BASE_URL: model.baseUrl,
    WORK_MODEL_API_KEY: model.apiKey,
    ...(input.modelId ? { WORK_MODEL: input.modelId } : {}),
    ...(model.api === "anthropic"
      ? { ANTHROPIC_BASE_URL: model.baseUrl, ANTHROPIC_API_KEY: model.apiKey }
      : { OPENAI_BASE_URL: model.baseUrl, OPENAI_API_KEY: model.apiKey }),
  };
}

/** The headers an agent sends its key in: either API family's. */
export function loopbackModelHeaders(
  model: LoopbackModel,
): Record<string, string> {
  return model.api === "anthropic"
    ? { "x-api-key": model.apiKey }
    : { authorization: `Bearer ${model.apiKey}` };
}

function authorized(request: IncomingMessage, apiKey: string): boolean {
  const key = request.headers["x-api-key"];
  if (typeof key === "string" && key.trim() === apiKey) return true;
  const match = /^bearer\s+(\S+)$/i.exec(
    (request.headers.authorization ?? "").trim(),
  );
  return match?.[1] === apiKey;
}

function upstreamHeaders(input: {
  request: IncomingMessage;
  api: "anthropic" | "openai";
  key: string;
}): Headers {
  const named = new Set(
    String(input.request.headers.connection ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
  const headers = new Headers();
  for (const [raw, value] of Object.entries(input.request.headers)) {
    const name = raw.toLowerCase();
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(name)) continue;
    if (named.has(name) || name.startsWith("proxy-")) continue;
    headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  }
  if (input.api === "anthropic") headers.set("x-api-key", input.key);
  else headers.set("authorization", `Bearer ${input.key}`);
  return headers;
}

async function readBody(
  request: IncomingMessage,
): Promise<Uint8Array | "too large"> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) return "too large";
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

/** A refusal in the calling API's own error shape, as the gateway's are. */
function refuse(input: {
  response: ServerResponse;
  api: "anthropic" | "openai";
  status: number;
  message: string;
}): void {
  const type = input.status === 401 ? "authentication_error" : "api_error";
  input.response.writeHead(input.status, {
    "content-type": "application/json",
  });
  input.response.end(
    JSON.stringify(
      input.api === "anthropic"
        ? { type: "error", error: { type, message: input.message } }
        : { error: { message: input.message, type } },
    ),
  );
}
