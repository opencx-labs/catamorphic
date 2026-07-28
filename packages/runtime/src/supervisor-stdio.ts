import {
  RuntimeInvocationConflictError,
  type RuntimeInvocationDispatcher,
  RuntimeInvocationInfrastructureError,
} from "./supervisor-dispatcher.js";
import type { RuntimeInvocationEvent } from "./supervisor-protocol.js";
import {
  parseRuntimeInvocationRequest,
  RUNTIME_PROTOCOL_VERSION,
  toProtocolJson,
} from "./supervisor-protocol.js";

/**
 * A JSON-lines supervisor transport for hosts that own a private duplex
 * channel into the sandbox (e.g. a microVM exec stream). Unlike the HTTP
 * transport there is no polling: events are pushed as `events` frames the
 * moment the dispatcher appends them.
 *
 * The channel is assumed private to the host (a pipe into the guest), so
 * there is no bearer token; anything able to write to the supervisor's stdin
 * already controls the sandbox.
 */

export type StdioSupervisorRequestFrame =
  | { id: number; op: "health" }
  | { id: number; op: "invoke"; request: unknown }
  | { id: number; op: "cancel"; invocationId: string };

export type StdioSupervisorErrorCode =
  | "bad_request"
  | "not_found"
  | "conflict"
  | "internal_error";

export type StdioSupervisorFrame =
  | { kind: "ready"; protocolVersion: typeof RUNTIME_PROTOCOL_VERSION }
  | { kind: "response"; id: number; ok: true; body: unknown }
  | {
      kind: "response";
      id: number;
      ok: false;
      error: { code: StdioSupervisorErrorCode; message: string };
    }
  | {
      kind: "events";
      invocationId: string;
      events: readonly RuntimeInvocationEvent[];
      done: boolean;
    };

/** In-process wait per push cycle; bounds how long stop() lingers, not latency. */
const EVENT_PUSH_WAIT_MS = 10_000;

export interface StdioSupervisorInput {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  off(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}

export interface StdioSupervisorOptions {
  dispatcher: RuntimeInvocationDispatcher;
  input?: StdioSupervisorInput;
  output?: { write(chunk: string): unknown };
}

export interface StdioSupervisor {
  stop(): void;
}

export function startStdioSupervisor(
  options: StdioSupervisorOptions,
): StdioSupervisor {
  const input: StdioSupervisorInput = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const pushing = new Set<string>();
  let stopped = false;

  const send = (frame: StdioSupervisorFrame): void => {
    if (stopped) return;
    output.write(`${JSON.stringify(toProtocolJson(frame))}\n`);
  };

  const respondError = (args: {
    id: number;
    code: StdioSupervisorErrorCode;
    message: string;
  }): void => {
    send({
      kind: "response",
      id: args.id,
      ok: false,
      error: { code: args.code, message: args.message },
    });
  };

  /**
   * Streams an invocation's events until it finishes. Runs in-process next to
   * the dispatcher, so the long-poll costs nothing across the boundary.
   */
  const pushEvents = async (invocationId: string): Promise<void> => {
    if (pushing.has(invocationId)) return;
    pushing.add(invocationId);
    try {
      let afterSequence = 0;
      while (!stopped) {
        const response = await options.dispatcher.events({
          invocationId,
          afterSequence,
          waitMs: EVENT_PUSH_WAIT_MS,
        });
        if (!response) return;
        if (response.events.length > 0) {
          afterSequence = Math.max(
            afterSequence,
            ...response.events.map((event) => event.sequence),
          );
          send({
            kind: "events",
            invocationId,
            events: response.events,
            done: response.done,
          });
        }
        if (response.done) return;
      }
    } finally {
      pushing.delete(invocationId);
    }
  };

  const handle = async (frame: StdioSupervisorRequestFrame): Promise<void> => {
    if (frame.op === "health") {
      send({
        kind: "response",
        id: frame.id,
        ok: true,
        body: options.dispatcher.health(),
      });
      return;
    }
    if (frame.op === "cancel") {
      const canceled = await options.dispatcher.cancel({
        invocationId: frame.invocationId,
      });
      if (!canceled) {
        respondError({
          id: frame.id,
          code: "not_found",
          message: `Invocation '${frame.invocationId}' is not active`,
        });
        return;
      }
      send({
        kind: "response",
        id: frame.id,
        ok: true,
        body: {
          invocationId: frame.invocationId,
          cancellationRequested: true,
        },
      });
      return;
    }
    try {
      const invocation = parseRuntimeInvocationRequest(frame.request);
      const completion = options.dispatcher.invoke(invocation);
      void pushEvents(invocation.invocationId);
      const response = await completion;
      send({ kind: "response", id: frame.id, ok: true, body: response });
    } catch (error) {
      if (error instanceof RuntimeInvocationConflictError) {
        respondError({
          id: frame.id,
          code: "conflict",
          message: error.message,
        });
        return;
      }
      if (error instanceof RuntimeInvocationInfrastructureError) {
        respondError({
          id: frame.id,
          code: "internal_error",
          message: error.message,
        });
        return;
      }
      respondError({
        id: frame.id,
        code: "bad_request",
        message: error instanceof Error ? error.message : "Invalid request",
      });
    }
  };

  let buffer = "";
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") continue;
      const frame = parseRequestFrame(line);
      if (!frame) continue;
      if (frame instanceof FrameError) {
        respondError({
          id: frame.frameId,
          code: "bad_request",
          message: frame.message,
        });
        continue;
      }
      void handle(frame);
    }
  };

  input.on("data", onData);
  send({ kind: "ready", protocolVersion: RUNTIME_PROTOCOL_VERSION });

  return {
    stop: () => {
      stopped = true;
      input.off("data", onData);
    },
  };
}

class FrameError extends Error {
  constructor(
    readonly frameId: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Returns the frame, a FrameError when the frame is malformed but carries a
 * usable id (so the host's pending request settles instead of hanging), or
 * null when there is no id to answer to.
 */
function parseRequestFrame(
  line: string,
): StdioSupervisorRequestFrame | FrameError | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Number.isInteger(value.id)) return null;
  const id = Number(value.id);
  if (value.op === "health") return { id, op: "health" };
  if (value.op === "cancel") {
    if (typeof value.invocationId !== "string" || value.invocationId === "") {
      return new FrameError(id, "cancel frame requires invocationId");
    }
    return { id, op: "cancel", invocationId: value.invocationId };
  }
  if (value.op === "invoke") {
    return { id, op: "invoke", request: value.request };
  }
  return new FrameError(id, "Unknown frame op");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
