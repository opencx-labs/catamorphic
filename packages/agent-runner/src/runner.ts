import type {
  JsonValue,
  RuntimeRequestResponse,
} from "@catamorphic/agent-protocol";
import {
  type AttemptControl,
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessEvent,
  type HostCall,
  type HostToolResult,
  RequestClosedError,
  type RequestDraft,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommandFrame,
  type RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { ToolGate } from "@catamorphic/sandbox";

/** A frame before the runner numbers it. */
type UnsequencedFrame = RunnerFrame extends infer F
  ? F extends RunnerFrame
    ? Omit<F, "seq">
    : never
  : never;

export interface AttemptRunnerOptions {
  adapters: Readonly<Record<string, HarnessAdapter>>;
  /** Receives every frame, in order, numbered from 1. */
  write: (frame: RunnerFrame) => void;
  version: string;
  /** Host objects for in-process adapters (never serialized). */
  local?: Record<string, unknown>;
}

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/**
 * Runs one attempt of a turn on a harness adapter (ADR 0197). Transport
 * free: feed it command frames, and it writes numbered frames. A command
 * id it has seen is acknowledged again and otherwise ignored, so a host
 * that took over may resend whatever it cannot prove arrived.
 */
export class AttemptRunner {
  private seq = 0;
  private readonly seen = new Map<string, string | undefined>();
  /** Commands taken whose acknowledgement waits on the harness. */
  private readonly inFlight = new Set<string>();
  private readonly calls = new Map<string, Pending<JsonValue | undefined>>();
  private readonly requests = new Map<
    string,
    Pending<RuntimeRequestResponse>
  >();
  private readonly abort = new AbortController();
  private control?: AttemptControl;
  private completed = false;
  private exited = false;
  private callCounter = 0;
  private resolveDone!: () => void;
  /** Settles after the `exit` frame was written. */
  readonly done = new Promise<void>((resolve) => {
    this.resolveDone = resolve;
  });

  constructor(private readonly options: AttemptRunnerOptions) {}

  private emitFrame(frame: UnsequencedFrame): void {
    if (this.exited) return;
    this.seq += 1;
    this.options.write(boundFrame({ ...frame, seq: this.seq } as RunnerFrame));
  }

  private emitEvent(event: HarnessEvent): void {
    if (this.completed) return;
    if (event.type === "turn.completed") this.completed = true;
    // A harness that resolved a request itself withdraws it: whoever waits
    // on it stops waiting.
    if (event.type === "request.closed") {
      const pending = this.requests.get(event.key);
      this.requests.delete(event.key);
      pending?.reject(new RequestClosedError(event.reason));
    }
    this.emitFrame({ type: "event", event });
  }

  /** Close one open request, when it is still open. */
  private withdrawRequest(key: string, reason: string): void {
    if (this.requests.has(key))
      this.emitEvent({ type: "request.closed", key, reason });
  }

  private ack(commandId: string, error?: string): void {
    this.seen.set(commandId, error);
    this.emitFrame({
      type: "ack",
      commandId,
      ...(error === undefined ? {} : { error }),
    });
  }

  /** Take one command. Never throws: a failure is acknowledged with its reason. */
  handle(frame: RunnerCommandFrame): void {
    if (this.inFlight.has(frame.id)) return;
    if (this.seen.has(frame.id)) {
      const error = this.seen.get(frame.id);
      this.emitFrame({
        type: "ack",
        commandId: frame.id,
        ...(error === undefined ? {} : { error }),
      });
      return;
    }
    const command = frame.command;
    try {
      switch (command.kind) {
        case "start":
          this.start(command.attempt);
          this.ack(frame.id);
          return;
        case "steer": {
          const control = this.control;
          if (!control || this.completed) {
            this.ack(frame.id, "not_running");
            return;
          }
          // The acknowledgement waits for the harness's answer: a steer it
          // cannot take now is refused so the host restarts the attempt.
          this.inFlight.add(frame.id);
          void control
            .steer(command.input)
            .then(
              (accepted) => (accepted ? undefined : "not_accepted"),
              (error: unknown) => errorMessage(error),
            )
            .then((error) => {
              this.inFlight.delete(frame.id);
              this.ack(frame.id, error);
            });
          return;
        }
        case "interrupt":
          // Whatever the harness waits on ends with it: an interrupted
          // turn's question or approval has nobody left to answer it.
          this.closeRequests(
            "The turn was interrupted before it was answered.",
          );
          this.control?.interrupt(command.reason);
          this.ack(frame.id);
          return;
        case "respond": {
          const pending = this.requests.get(command.requestKey);
          if (!pending) {
            this.ack(frame.id, "unknown_request");
            return;
          }
          this.requests.delete(command.requestKey);
          pending.resolve(command.response);
          this.ack(frame.id);
          return;
        }
        case "release": {
          // No request.closed: the request stays open in Work.
          const pending = this.requests.get(command.requestKey);
          this.requests.delete(command.requestKey);
          pending?.reject(new RequestClosedError(command.reason));
          this.ack(frame.id, pending ? undefined : "unknown_request");
          return;
        }
        case "host_result": {
          const pending = this.calls.get(command.callId);
          this.calls.delete(command.callId);
          if (pending) {
            if (command.error) pending.reject(new Error(command.error.message));
            else pending.resolve(command.result);
          }
          this.ack(frame.id);
          return;
        }
        case "stop":
          this.ack(frame.id);
          this.stop();
          return;
      }
    } catch (error) {
      this.ack(frame.id, errorMessage(error));
    }
  }

  private start(attempt: AttemptStart): void {
    if (this.control)
      throw new Error("This runner already started its attempt");
    if (attempt.protocol !== RUNNER_PROTOCOL_VERSION)
      throw new Error(
        `This runner speaks protocol ${RUNNER_PROTOCOL_VERSION}; the host sent ${String(attempt.protocol)}. Update the agent runner.`,
      );
    const adapter = this.options.adapters[attempt.harness];
    if (!adapter)
      throw new Error(`This runner has no '${attempt.harness}' harness`);
    this.emitFrame({
      type: "hello",
      protocol: RUNNER_PROTOCOL_VERSION,
      runner: { version: this.options.version },
      harness: { id: adapter.id, capabilities: adapter.capabilities() },
    });
    let control: AttemptControl;
    try {
      control = adapter.start(attempt, this.host(attempt), this.options.local);
    } catch (error) {
      this.emitEvent({
        type: "turn.completed",
        status: "failed",
        error: { message: errorMessage(error) },
      });
      this.exit();
      return;
    }
    this.control = control;
    void control.finished
      .catch((error: unknown) => {
        this.emitEvent({
          type: "turn.completed",
          status: "failed",
          error: { message: errorMessage(error) },
        });
      })
      .finally(() => {
        if (!this.completed)
          this.emitEvent({
            type: "turn.completed",
            status: this.abort.signal.aborted ? "interrupted" : "failed",
            error: {
              message: "The harness ended without finishing its turn.",
            },
          });
        this.exit();
      });
  }

  private stop(): void {
    if (this.abort.signal.aborted) return;
    this.abort.abort();
    this.closeRequests("The turn stopped.");
    if (this.control) this.control.interrupt("stopped");
    else this.exit();
  }

  private closeRequests(reason: string): void {
    for (const key of [...this.requests.keys()])
      this.withdrawRequest(key, reason);
  }

  private exit(): void {
    if (this.exited) return;
    for (const [callId, pending] of this.calls) {
      this.calls.delete(callId);
      pending.reject(new Error("The runner stopped"));
    }
    this.emitFrame({ type: "exit" });
    this.exited = true;
    this.resolveDone();
  }

  private call(call: HostCall): Promise<JsonValue | undefined> {
    // A call is never shortened (stored native state would be corrupted):
    // one too large to send is refused, and the adapter sends smaller ones.
    if (JSON.stringify(call).length > MAX_FRAME_CHARS)
      return Promise.reject(
        new Error(
          `This host call is larger than ${MAX_FRAME_CHARS} characters; send it in smaller parts.`,
        ),
      );
    this.callCounter += 1;
    const callId = `c${this.callCounter}`;
    return new Promise((resolve, reject) => {
      this.calls.set(callId, { resolve, reject });
      this.emitFrame({ type: "call", callId, call });
    });
  }

  private openRequest(
    key: string,
    request: RequestDraft,
    signal?: AbortSignal,
  ): Promise<RuntimeRequestResponse> {
    if (this.abort.signal.aborted)
      return Promise.reject(new RequestClosedError("The turn stopped."));
    if (signal?.aborted)
      return Promise.reject(new RequestClosedError(WITHDRAWN));
    const onAbort = () => this.withdrawRequest(key, WITHDRAWN);
    signal?.addEventListener("abort", onAbort, { once: true });
    return new Promise<RuntimeRequestResponse>((resolve, reject) => {
      this.requests.set(key, { resolve, reject });
      this.emitEvent({ type: "request.opened", key, request });
    }).finally(() => signal?.removeEventListener("abort", onAbort));
  }

  private host(attempt: AttemptStart): AttemptHost {
    let approvals = 0;
    const gate = new ToolGate(async (request, signal) => {
      approvals += 1;
      const key = `approval:${approvals}`;
      const answer = this.openRequest(
        key,
        {
          kind: "approval",
          blocking: true,
          title: `Allow ${request.tool}?`,
          origin: {
            kind: "mcp",
            id: request.server,
            displayName: request.server,
          },
          approval: {
            action: `${request.server} · ${request.tool}`,
            ...(request.description ? { details: request.description } : {}),
            tool: {
              server: request.server,
              name: request.tool,
              input: toJson(request.input),
            },
          },
        },
        signal,
      );
      const response = await answer;
      if (response.kind !== "approval") return { decision: "deny" };
      return response.decision === "approved"
        ? {
            decision: "allow",
            ...(response.remember ? { remember: response.remember } : {}),
          }
        : {
            decision: "deny",
            ...(response.reason ? { reason: response.reason } : {}),
          };
    });
    return {
      emit: (event) => this.emitEvent(event),
      callTool: async (input) => {
        const result = await this.call({
          kind: "tool",
          name: input.name,
          input: input.input,
          ...(input.itemKey ? { itemKey: input.itemKey } : {}),
        });
        return toolResult(result);
      },
      authorize: (input) =>
        gate.decide({
          server: input.server,
          tool: input.tool,
          input:
            input.input &&
            typeof input.input === "object" &&
            !Array.isArray(input.input)
              ? (input.input as Record<string, unknown>)
              : {},
          layers: attempt.toolPolicies[input.server],
          ...((input.annotations ??
          attempt.toolAnnotations[input.server]?.[input.tool])
            ? {
                annotations:
                  input.annotations ??
                  attempt.toolAnnotations[input.server]?.[input.tool],
              }
            : {}),
          ...(input.description ? { description: input.description } : {}),
          sessionId: attempt.sessionId,
          abortSignal: input.signal
            ? AbortSignal.any([this.abort.signal, input.signal])
            : this.abort.signal,
        }),
      request: (key, request, options) =>
        this.openRequest(key, request, options?.signal),
      nativeState: {
        append: async ({ thread, subpath, entries }) => {
          await this.call({
            kind: "native_state.append",
            ...(thread ? { thread } : {}),
            ...(subpath ? { subpath } : {}),
            entries,
          });
        },
        load: async ({ thread, subpath }) => {
          const result = await this.call({
            kind: "native_state.load",
            ...(thread ? { thread } : {}),
            ...(subpath ? { subpath } : {}),
          });
          return Array.isArray(result) ? result : null;
        },
        subpaths: async (input) => {
          const result = await this.call({
            kind: "native_state.subpaths",
            ...(input?.thread ? { thread: input.thread } : {}),
          });
          return Array.isArray(result)
            ? result.filter(
                (value): value is string => typeof value === "string",
              )
            : [];
        },
      },
      signal: this.abort.signal,
    };
  }
}

const WITHDRAWN = "The harness withdrew the request.";

/** Largest frame, in characters: a host reads frames in 1 MiB chunks. */
export const MAX_FRAME_CHARS = 512 * 1024;
const TRUNCATED_STRING_CHARS = 16 * 1024;

/**
 * A frame small enough to read in one chunk. A huge tool result or command
 * output is cut, string by string, rather than dropped: the item still
 * completes, and says it was shortened.
 */
export function boundFrame(frame: RunnerFrame): RunnerFrame {
  if (frame.type === "call" || JSON.stringify(frame).length <= MAX_FRAME_CHARS)
    return frame;
  const cut = (value: unknown): unknown => {
    if (typeof value === "string")
      return value.length > TRUNCATED_STRING_CHARS
        ? `${value.slice(0, TRUNCATED_STRING_CHARS)}\n[Shortened: ${value.length - TRUNCATED_STRING_CHARS} more characters]`
        : value;
    if (Array.isArray(value)) return value.slice(0, 200).map(cut);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [key, cut(inner)]),
      );
    return value;
  };
  return cut(frame) as RunnerFrame;
}

function toolResult(value: JsonValue | undefined): HostToolResult {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Array.isArray((value as { content?: unknown }).content)
  )
    return value as unknown as HostToolResult;
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value ?? null),
      },
    ],
  };
}

function toJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as JsonValue;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
