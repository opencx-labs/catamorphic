import type {
  JsonValue,
  RuntimeRequestResponse,
} from "@catamorphic/agent-protocol";
import type {
  AttemptStart,
  HarnessAdapter,
  HarnessEvent,
  HostCall,
  RequestDraft,
  RunnerCommand,
  RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
// The real runner, from source: @catamorphic/agent-runner depends on this
// package, so a package dependency back would be a cycle.
import { InProcessRunner } from "@catamorphic/agent-runner";

/** Native state as the host stores it: entries per native thread and subpath. */
export class NativeStore {
  readonly entries = new Map<string, JsonValue[]>();

  private key(thread: string, subpath: string | undefined): string {
    return `${thread}/${subpath ?? ""}`;
  }

  append(thread: string, subpath: string | undefined, entries: JsonValue[]) {
    const key = this.key(thread, subpath);
    this.entries.set(key, [...(this.entries.get(key) ?? []), ...entries]);
  }

  load(thread: string, subpath: string | undefined): JsonValue[] | null {
    return this.entries.get(this.key(thread, subpath)) ?? null;
  }

  subpaths(thread: string): string[] {
    return [...this.entries.keys()]
      .filter((key) => key.startsWith(`${thread}/`))
      .map((key) => key.slice(thread.length + 1));
  }
}

/** What the fake host does while an attempt runs. */
export interface HostScript {
  /** The person's answer; `undefined` leaves the request open. */
  answer?: (
    request: RequestDraft,
    key: string,
  ) => RuntimeRequestResponse | undefined;
  /** A host tool's result. */
  tool?: (name: string, input: JsonValue) => JsonValue;
  /** React to an event, e.g. steer or interrupt mid-turn. */
  onEvent?: (
    event: HarnessEvent,
    act: {
      steer: (text: string) => void;
      interrupt: () => void;
    },
  ) => void;
}

export interface AttemptResult {
  attempt: AttemptStart;
  frames: RunnerFrame[];
  events: HarnessEvent[];
  calls: HostCall[];
  /** Command ids the runner acknowledged, with any refusal. */
  acks: Array<{ commandId: string; error?: string }>;
  /** Every command the host sent, by id. */
  commands: Array<{ id: string; kind: RunnerCommand["kind"] }>;
}

/**
 * Drive one attempt through the real in-process runner as a host would:
 * start it, answer host calls and requests, steer or interrupt when the
 * script says, and collect every frame until the runner exits.
 */
export async function driveAttempt(input: {
  adapter: HarnessAdapter;
  attempt: AttemptStart;
  store: NativeStore;
  script?: HostScript;
  timeoutMs?: number;
}): Promise<AttemptResult> {
  const { attempt, store, script = {} } = input;
  const runner = new InProcessRunner({
    adapters: { [input.adapter.id]: input.adapter },
    version: "test",
  });
  const result: AttemptResult = {
    attempt,
    frames: [],
    events: [],
    calls: [],
    acks: [],
    commands: [],
  };
  const send = (command: RunnerCommand) => {
    const id = `cmd-${result.commands.length + 1}`;
    result.commands.push({ id, kind: command.kind });
    runner.send({ id, command });
  };
  const binding = attempt.thread;
  let ownThread =
    binding.mode === "resume" || binding.mode === "restore"
      ? binding.nativeRef.id
      : "";
  let steers = 0;
  const act = {
    steer: (text: string) => {
      steers += 1;
      send({
        kind: "steer",
        input: { itemId: `steer-${steers}`, text, attachments: [] },
      });
    },
    interrupt: () => send({ kind: "interrupt" }),
  };
  send({ kind: "start", attempt });
  const deadline = Date.now() + (input.timeoutMs ?? 60_000);
  let seq = 0;
  while (!runner.exited) {
    if (Date.now() > deadline)
      throw new Error(
        `The attempt did not finish; last frames: ${JSON.stringify(result.frames.slice(-5))}`,
      );
    const frames = await runner.read({ afterSeq: seq, waitMs: 100 });
    for (const frame of frames) {
      seq = frame.seq;
      result.frames.push(frame);
      if (frame.type === "ack")
        result.acks.push({
          commandId: frame.commandId,
          ...(frame.error ? { error: frame.error } : {}),
        });
      if (frame.type === "event") {
        const event = frame.event;
        result.events.push(event);
        if (event.type === "thread") ownThread = event.ref.id;
        if (event.type === "request.opened") {
          const response = script.answer?.(event.request, event.key);
          if (response)
            send({ kind: "respond", requestKey: event.key, response });
        }
        script.onEvent?.(event, act);
      }
      if (frame.type === "call") {
        const call = frame.call;
        result.calls.push(call);
        const reply = (value: JsonValue | undefined) =>
          send({
            kind: "host_result",
            callId: frame.callId,
            ...(value === undefined ? {} : { result: value }),
          });
        if (call.kind === "tool")
          reply(script.tool?.(call.name, call.input) ?? "no result");
        else if (call.kind === "native_state.append") {
          store.append(call.thread ?? ownThread, call.subpath, call.entries);
          reply(null);
        } else if (call.kind === "native_state.load")
          reply(store.load(call.thread ?? ownThread, call.subpath));
        else reply(store.subpaths(call.thread ?? ownThread));
      }
    }
  }
  await runner.done;
  return result;
}

/** The events of a result without the noise a replay cannot reproduce. */
export function stableEvents(events: HarnessEvent[]): HarnessEvent[] {
  return events.filter((event) => event.type !== "diagnostic");
}
