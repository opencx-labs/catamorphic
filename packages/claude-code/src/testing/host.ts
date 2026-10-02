import type {
  AgentAttachment,
  JsonValue,
  NativeRef,
  RuntimeRequestResponse,
} from "@catamorphic/agent-protocol";
import type {
  AttemptStart,
  HarnessEvent,
  HostCall,
  HostToolResult,
  RequestDraft,
  RunnerCommand,
  RunnerCommandFrame,
  RunnerFrame,
} from "@catamorphic/agent-protocol/runner";

/** What a host needs of a runner: `InProcessRunner` and a stdio client both fit. */
export interface RunnerLike {
  send(frame: RunnerCommandFrame): void;
  read(input: { afterSeq: number; waitMs: number }): Promise<RunnerFrame[]>;
}

/**
 * Native thread state the way a host keeps it (ADR 0197): entries per
 * provider thread and subpath. A call that names a native thread reads
 * that thread (a fork reading its source); one that names none is the
 * attempt's own.
 */
export class ScriptedNativeState {
  private readonly threads = new Map<string, Map<string, JsonValue[]>>();
  private readonly natives = new Map<string, string>();

  /** The native id a provider thread reported in its `thread` event. */
  bind(input: { nativeId: string; providerThreadId: string }): void {
    this.natives.set(input.nativeId, input.providerThreadId);
  }

  private threadOf(attempt: AttemptStart, thread?: string): string {
    if (!thread) return attempt.thread.providerThreadId;
    return this.natives.get(thread) ?? thread;
  }

  entries(input: { providerThreadId: string; subpath?: string }): JsonValue[] {
    return (
      this.threads.get(input.providerThreadId)?.get(input.subpath ?? "") ?? []
    );
  }

  call(attempt: AttemptStart, call: HostCall): JsonValue {
    if (call.kind === "tool") throw new Error("Not a native state call");
    const thread = this.threadOf(attempt, call.thread);
    const paths = this.threads.get(thread) ?? new Map<string, JsonValue[]>();
    this.threads.set(thread, paths);
    switch (call.kind) {
      case "native_state.append": {
        const key = call.subpath ?? "";
        paths.set(key, [...(paths.get(key) ?? []), ...call.entries]);
        return null;
      }
      case "native_state.load":
        return paths.get(call.subpath ?? "") ?? null;
      case "native_state.subpaths":
        return [...paths.keys()].filter((key) => key !== "");
    }
  }
}

/** Steer and interrupt the running attempt from a scripted host. */
export interface HostControl {
  steer(input: {
    itemId: string;
    text: string;
    attachments?: AgentAttachment[];
  }): void;
  interrupt(reason?: string): void;
}

/** How a scripted host answers an attempt. */
export interface ScriptedHostBehavior {
  /** Answers a request; undefined leaves it open. */
  answer?: (input: {
    key: string;
    request: RequestDraft;
  }) => RuntimeRequestResponse | undefined;
  /** Runs a host tool. */
  tool?: (call: {
    name: string;
    input: JsonValue;
    itemKey?: string;
  }) => HostToolResult;
  /** Sees every event in order, and may steer or interrupt. */
  onEvent?: (event: HarnessEvent, control: HostControl) => void;
}

export interface AttemptOutcome {
  attempt: AttemptStart;
  frames: RunnerFrame[];
  events: HarnessEvent[];
  calls: HostCall[];
  /** Acknowledged commands by id, with the runner's refusal when it refused. */
  acks: Map<string, string | undefined>;
  thread?: NativeRef;
  completed?: Extract<HarnessEvent, { type: "turn.completed" }>;
}

/**
 * Drive one attempt on a runner as a host would: start it, answer its host
 * calls (tools, native state) and requests, deliver the behavior's steers
 * and interrupts as commands, and collect every frame until it exits.
 */
export async function driveAttempt(input: {
  runner: RunnerLike;
  attempt: AttemptStart;
  host: ScriptedHostBehavior;
  nativeState: ScriptedNativeState;
  timeoutMs?: number;
}): Promise<AttemptOutcome> {
  const { runner, attempt, host, nativeState } = input;
  let commands = 0;
  const send = (command: RunnerCommand) => {
    commands += 1;
    const id = `cmd-${commands}`;
    runner.send({ id, command });
    return id;
  };
  const control: HostControl = {
    steer: ({ itemId, text, attachments }) => {
      send({
        kind: "steer",
        input: { itemId, text, attachments: attachments ?? [] },
      });
    },
    interrupt: (reason) => {
      send({ kind: "interrupt", ...(reason ? { reason } : {}) });
    },
  };
  const outcome: AttemptOutcome = {
    attempt,
    frames: [],
    events: [],
    calls: [],
    acks: new Map(),
  };
  send({ kind: "start", attempt });
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  let seq = 0;
  for (;;) {
    if (Date.now() > deadline)
      throw new Error(
        `The attempt did not exit in time. Last events: ${JSON.stringify(outcome.events.slice(-5))}`,
      );
    const frames = await runner.read({ afterSeq: seq, waitMs: 1_000 });
    for (const frame of frames) {
      seq = frame.seq;
      outcome.frames.push(frame);
      switch (frame.type) {
        case "ack":
          outcome.acks.set(frame.commandId, frame.error);
          break;
        case "call": {
          outcome.calls.push(frame.call);
          const call = frame.call;
          try {
            const result: JsonValue =
              call.kind === "tool"
                ? toJson(
                    (
                      host.tool ??
                      (() => {
                        throw new Error(`No host tool ${call.name}`);
                      })
                    )({
                      name: call.name,
                      input: call.input,
                      ...(call.itemKey ? { itemKey: call.itemKey } : {}),
                    }),
                  )
                : nativeState.call(attempt, call);
            send({ kind: "host_result", callId: frame.callId, result });
          } catch (error) {
            send({
              kind: "host_result",
              callId: frame.callId,
              error: {
                message: error instanceof Error ? error.message : String(error),
              },
            });
          }
          break;
        }
        case "event": {
          const event = frame.event;
          outcome.events.push(event);
          if (event.type === "thread") {
            outcome.thread = event.ref;
            nativeState.bind({
              nativeId: event.ref.id,
              providerThreadId: attempt.thread.providerThreadId,
            });
          }
          if (event.type === "turn.completed") outcome.completed = event;
          if (event.type === "request.opened") {
            const response = host.answer?.({
              key: event.key,
              request: event.request,
            });
            if (response)
              send({ kind: "respond", requestKey: event.key, response });
          }
          host.onEvent?.(event, control);
          break;
        }
        case "exit":
          return outcome;
        default:
          break;
      }
    }
  }
}

function toJson(value: unknown): JsonValue {
  const parsed: JsonValue = JSON.parse(JSON.stringify(value ?? null));
  return parsed;
}
