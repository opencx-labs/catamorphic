import type { JsonObject, JsonValue } from "@catamorphic/agent-protocol";
import {
  type CodexExit,
  type CodexSpawn,
  type CodexTransport,
  type CodexTransportFactory,
  processTransport,
} from "./transport.js";

export type JsonRpcId = number | string;

/** A request the app server sent the client (an approval, a tool call). */
export interface CodexServerRequest {
  id: JsonRpcId;
  method: string;
  params: JsonObject;
}

/** A JSON-RPC error the app server answered a request with. */
export class CodexRequestError extends Error {
  constructor(
    readonly method: string,
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "CodexRequestError";
  }
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * A client of the pinned `codex app-server` JSON-RPC protocol (generated
 * types: `codex app-server generate-ts --experimental`). It owns one
 * process: requests time out, server requests are answered once, and a
 * request the server resolved itself (`serverRequest/resolved`) is never
 * answered late.
 */
export class CodexAppServer {
  private readonly transport: CodexTransport;
  private readonly pending = new Map<
    JsonRpcId,
    {
      method: string;
      resolve: (value: JsonValue) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  /** Server requests not answered yet, and whether Codex withdrew them. */
  private readonly open = new Map<JsonRpcId, { withdrawn: boolean }>();
  private sequence = 0;
  private failure?: Error;
  private resolveExit!: (exit: CodexExit) => void;
  /** Settles when the process is gone, however it ended. */
  readonly exited = new Promise<CodexExit>((resolve) => {
    this.resolveExit = resolve;
  });

  constructor(input: {
    spawn: CodexSpawn;
    transport?: CodexTransportFactory;
    onNotification?: (method: string, params: JsonObject) => void;
    /** Answers a server request; a throw answers with a JSON-RPC error. */
    onRequest?: (request: CodexServerRequest) => Promise<JsonValue>;
    /** Codex resolved a request before the client answered it. */
    onWithdrawn?: (id: JsonRpcId) => void;
  }) {
    const factory = input.transport ?? processTransport;
    this.transport = factory({
      ...input.spawn,
      onMessage: (message) => {
        if (typeof message.method === "string") {
          const params = isObject(message.params) ? message.params : {};
          const id = message.id;
          if (typeof id === "number" || typeof id === "string") {
            this.serve({ id, method: message.method, params }, input.onRequest);
            return;
          }
          if (message.method === "serverRequest/resolved") {
            const requestId = params.requestId;
            if (
              typeof requestId === "number" ||
              typeof requestId === "string"
            ) {
              const entry = this.open.get(requestId);
              if (entry && !entry.withdrawn) {
                entry.withdrawn = true;
                input.onWithdrawn?.(requestId);
              }
            }
          }
          input.onNotification?.(message.method, params);
          return;
        }
        const id = message.id;
        if (typeof id !== "number" && typeof id !== "string") return;
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        if (message.error !== undefined && message.error !== null) {
          const error = isObject(message.error) ? message.error : {};
          request.reject(
            new CodexRequestError(
              request.method,
              typeof error.message === "string"
                ? error.message
                : `Codex ${request.method} failed`,
              typeof error.code === "number" ? error.code : undefined,
            ),
          );
        } else request.resolve(message.result ?? null);
      },
      onExit: (exit) => {
        this.fail(
          new Error(
            exit.code === 0
              ? "The Codex app server stopped."
              : `The Codex app server stopped (${exit.signal ?? `exit ${String(exit.code)}`}).`,
          ),
        );
        this.resolveExit(exit);
      },
    });
  }

  /** The handshake every connection starts with. */
  async initialize(): Promise<JsonObject> {
    const result = await this.request("initialize", {
      clientInfo: { name: "catamorphic", version: "0.0.1" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");
    return isObject(result) ? result : {};
  }

  request(
    method: string,
    params: JsonValue,
    options: { timeoutMs?: number } = {},
  ): Promise<JsonValue> {
    if (this.failure) return Promise.reject(this.failure);
    this.sequence += 1;
    const id = this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexRequestError(method, `Codex ${method} timed out.`));
      }, options.timeoutMs ?? 30_000);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      this.transport.send({ id, method, params });
    });
  }

  notify(method: string, params?: JsonValue): void {
    if (this.failure) return;
    this.transport.send(params === undefined ? { method } : { method, params });
  }

  /** End the process; resolves once it is gone. */
  close(): Promise<CodexExit> {
    this.transport.close();
    return this.exited;
  }

  private serve(
    request: CodexServerRequest,
    handler: ((request: CodexServerRequest) => Promise<JsonValue>) | undefined,
  ): void {
    const entry = { withdrawn: false };
    this.open.set(request.id, entry);
    const answer = (message: JsonObject) => {
      this.open.delete(request.id);
      if (entry.withdrawn || this.failure) return;
      this.transport.send({ id: request.id, ...message });
    };
    if (!handler) {
      answer({
        error: {
          code: -32601,
          message: `Unsupported client request: ${request.method}`,
        },
      });
      return;
    }
    void handler(request).then(
      (result) => answer({ result }),
      (error: unknown) =>
        answer({
          error: {
            code: -32603,
            message:
              error instanceof Error
                ? error.message
                : "The client could not answer this request.",
          },
        }),
    );
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

/**
 * Codex `-c key=value` overrides for a config object. The CLI parses each
 * value as TOML, so objects become inline tables, never JSON.
 */
export function codexConfigArgs(config: JsonObject): string[] {
  const toml = (value: JsonValue): string => {
    if (Array.isArray(value)) return `[${value.map(toml).join(",")}]`;
    if (isObject(value))
      return `{${Object.entries(value)
        .map(([key, child]) => `${JSON.stringify(key)}=${toml(child)}`)
        .join(",")}}`;
    if (value === null) throw new Error("Codex config values cannot be null");
    return JSON.stringify(value);
  };
  return Object.entries(config).flatMap(([key, value]) => [
    "-c",
    `${key}=${toml(value)}`,
  ]);
}
