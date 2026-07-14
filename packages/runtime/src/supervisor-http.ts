import { timingSafeEqual } from "node:crypto";
import {
  RuntimeInvocationConflictError,
  type RuntimeInvocationDispatcher,
} from "./supervisor-dispatcher.js";
import {
  parseRuntimeInvocationRequest,
  toProtocolJson,
} from "./supervisor-protocol.js";

export interface SupervisorRequestHandlerOptions {
  authToken: string;
  dispatcher: RuntimeInvocationDispatcher;
}

export type SupervisorRequestHandler = (request: Request) => Promise<Response>;

export function createSupervisorRequestHandler(
  options: SupervisorRequestHandlerOptions,
): SupervisorRequestHandler {
  if (options.authToken === "") {
    throw new Error("Supervisor authToken must not be empty");
  }

  return async (request) => {
    const url = new URL(request.url);
    if (!isAuthorized({ request, authToken: options.authToken })) {
      return protocolError({
        status: 401,
        code: "unauthorized",
        message: "A valid bearer token is required",
      });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse({ status: 200, body: options.dispatcher.health() });
    }
    if (request.method === "POST" && url.pathname === "/v1/invocations") {
      try {
        const body: unknown = await request.json();
        const invocation = parseRuntimeInvocationRequest(body);
        const response = await options.dispatcher.invoke(invocation);
        return jsonResponse({ status: 200, body: response });
      } catch (error) {
        if (error instanceof RuntimeInvocationConflictError) {
          return protocolError({
            status: 409,
            code: "conflict",
            message: error.message,
          });
        }
        return protocolError({
          status: 400,
          code: "bad_request",
          message: error instanceof Error ? error.message : "Invalid request",
        });
      }
    }

    const eventsMatch = url.pathname.match(
      /^\/v1\/invocations\/([^/]+)\/events$/,
    );
    if (request.method === "GET" && eventsMatch?.[1]) {
      const invocationId = decodeURIComponent(eventsMatch[1]);
      const afterSequence = parseAfterSequence(
        url.searchParams.get("afterSequence"),
      );
      if (afterSequence === null) {
        return protocolError({
          status: 400,
          code: "bad_request",
          message: "afterSequence must be a non-negative integer",
        });
      }
      const events = options.dispatcher.events({
        invocationId,
        afterSequence,
      });
      if (!events) {
        return protocolError({
          status: 404,
          code: "not_found",
          message: `Invocation '${invocationId}' was not found`,
        });
      }
      return jsonResponse({ status: 200, body: events });
    }

    const cancelMatch = url.pathname.match(
      /^\/v1\/invocations\/([^/]+)\/cancel$/,
    );
    if (request.method === "POST" && cancelMatch?.[1]) {
      const invocationId = decodeURIComponent(cancelMatch[1]);
      const canceled = await options.dispatcher.cancel({ invocationId });
      if (!canceled) {
        return protocolError({
          status: 404,
          code: "not_found",
          message: `Invocation '${invocationId}' is not active`,
        });
      }
      return jsonResponse({
        status: 202,
        body: { invocationId, cancellationRequested: true },
      });
    }

    return protocolError({
      status: 404,
      code: "not_found",
      message: "Supervisor endpoint not found",
    });
  };
}

function parseAfterSequence(value: string | null): number | null {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

export interface SupervisorServer {
  stop(closeActiveConnections?: boolean): void;
}

export interface SupervisorServeOptions {
  hostname?: string;
  port: number;
  fetch: SupervisorRequestHandler;
}

export type SupervisorServe = (
  options: SupervisorServeOptions,
) => SupervisorServer;

export interface StartBunSupervisorOptions {
  handler: SupervisorRequestHandler;
  port: number;
  hostname?: string;
  serve?: SupervisorServe;
}

export function startBunSupervisor(
  options: StartBunSupervisorOptions,
): SupervisorServer {
  const serve = options.serve ?? resolveBunServe();
  return serve({
    hostname: options.hostname ?? "127.0.0.1",
    port: options.port,
    fetch: options.handler,
  });
}

function resolveBunServe(): SupervisorServe {
  const bun = Reflect.get(globalThis, "Bun");
  if (!isRecord(bun)) {
    throw new Error("Bun.serve is unavailable outside Bun");
  }
  const serve = Reflect.get(bun, "serve");
  if (typeof serve !== "function") {
    throw new Error("Bun.serve is unavailable");
  }
  return (options) => {
    const server: unknown = Reflect.apply(serve, bun, [options]);
    if (!isRecord(server) || typeof server.stop !== "function") {
      throw new Error("Bun.serve returned an invalid server");
    }
    const stop = server.stop;
    return {
      stop: (closeActiveConnections) => {
        Reflect.apply(stop, server, [closeActiveConnections]);
      },
    };
  };
}

function isAuthorized(args: { request: Request; authToken: string }): boolean {
  const authorization = args.request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(authorization.slice("Bearer ".length));
  const expected = Buffer.from(args.authToken);
  return (
    supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
  );
}

function jsonResponse(args: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(toProtocolJson(args.body)), {
    status: args.status,
    headers: { "Content-Type": "application/json" },
  });
}

function protocolError(args: {
  status: number;
  code:
    | "bad_request"
    | "unauthorized"
    | "not_found"
    | "conflict"
    | "internal_error";
  message: string;
}): Response {
  return jsonResponse({
    status: args.status,
    body: { error: { code: args.code, message: args.message } },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
