import type {
  JsonValue,
  RuntimeRequestResponse,
} from "@catamorphic/agent-protocol";
import {
  type AttemptStart,
  type HarnessAdapter,
  type HarnessEvent,
  type HostCall,
  type HostToolResult,
  type RequestDraft,
  RUNNER_PROTOCOL_VERSION,
  type RunnerCommand,
  type RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { InProcessRunner } from "@catamorphic/agent-runner";

/** A stored native state, shared across attempts like the host's database. */
export type ThreadStore = Map<string, JsonValue[]>;

export function attemptStart(
  overrides: Partial<AttemptStart> & Pick<AttemptStart, "thread">,
): AttemptStart {
  const attemptId = overrides.attemptId ?? `attempt-${crypto.randomUUID()}`;
  return {
    protocol: RUNNER_PROTOCOL_VERSION,
    sessionId: "session-1",
    projectId: "project-1",
    turnId: `turn-${attemptId}`,
    attemptId,
    reason: "initial",
    harness: "ai-sdk",
    workingDirectory: "/workspace",
    stateDirectory: "/state",
    input: { itemId: "item-1", text: "Hello", attachments: [] },
    systemPrompt: "",
    context: "",
    permissions: {},
    modelAccess: { kind: "host" },
    toolPolicies: {},
    toolAnnotations: {},
    mcpServers: {},
    hostTools: [],
    plugins: [],
    env: {},
    options: {},
    ...overrides,
  };
}

/**
 * The host side of the runner protocol, in memory: it reads the real
 * InProcessRunner's frames, answers host calls (tools, native state) and
 * runtime requests, and records everything for assertions.
 */
export class FakeHost {
  readonly frames: RunnerFrame[] = [];
  readonly events: HarnessEvent[] = [];
  readonly calls: HostCall[] = [];
  readonly store: ThreadStore;
  readonly done: Promise<void>;
  private readonly runner: InProcessRunner;
  private commands = 0;
  private readonly waiters = new Set<() => void>();
  private readonly ownThread: string;

  constructor(
    private readonly input: {
      adapter: HarnessAdapter;
      attempt: AttemptStart;
      local?: Record<string, unknown>;
      store?: ThreadStore;
      tools?: Record<
        string,
        (input: JsonValue) => HostToolResult | Promise<HostToolResult>
      >;
      /** Answer a request; undefined leaves it pending. */
      answer?: (
        key: string,
        request: RequestDraft,
      ) =>
        | RuntimeRequestResponse
        | undefined
        | Promise<RuntimeRequestResponse | undefined>;
      /** Runs on every event, before waiters wake. */
      onEvent?: (event: HarnessEvent, host: FakeHost) => void;
    },
  ) {
    this.store = input.store ?? new Map();
    const thread = input.attempt.thread;
    this.ownThread =
      thread.mode === "resume" || thread.mode === "restore"
        ? thread.nativeRef.id
        : thread.providerThreadId;
    this.runner = new InProcessRunner({
      adapters: { [input.adapter.id]: input.adapter },
      version: "test",
      ...(input.local ? { local: input.local } : {}),
    });
    this.send({ kind: "start", attempt: input.attempt });
    this.done = this.pump();
  }

  send(command: RunnerCommand): string {
    this.commands += 1;
    const id = `cmd-${this.commands}`;
    this.runner.send({ id, command });
    return id;
  }

  /** The first event matching, waiting for it to arrive. */
  async waitFor<T extends HarnessEvent>(
    predicate: (event: HarnessEvent) => event is T,
    timeoutMs?: number,
  ): Promise<T>;
  async waitFor(
    predicate: (event: HarnessEvent) => boolean,
    timeoutMs?: number,
  ): Promise<HarnessEvent>;
  async waitFor(
    predicate: (event: HarnessEvent) => boolean,
    timeoutMs = 5_000,
  ): Promise<HarnessEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.events.find(predicate);
      if (found) return found;
      if (Date.now() > deadline)
        throw new Error(
          `No matching event; saw ${this.events.map((event) => event.type).join(", ")}`,
        );
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        this.waiters.add(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  /** Acknowledgement frames for a command id. */
  acks(commandId: string): Array<Extract<RunnerFrame, { type: "ack" }>> {
    return this.frames.filter(
      (frame): frame is Extract<RunnerFrame, { type: "ack" }> =>
        frame.type === "ack" && frame.commandId === commandId,
    );
  }

  /** Events of one type, narrowed. */
  of<K extends HarnessEvent["type"]>(
    type: K,
  ): Array<Extract<HarnessEvent, { type: K }>> {
    return this.events.filter(
      (event): event is Extract<HarnessEvent, { type: K }> =>
        event.type === type,
    );
  }

  /** The text each assistant message item ended with, in order. */
  assistantTexts(): string[] {
    return this.textsOf("assistant_message");
  }

  textsOf(kind: "assistant_message" | "reasoning"): string[] {
    const keys = this.of("item.started")
      .filter((event) => event.item.kind === kind)
      .map((event) => event.key);
    return keys.map((key) =>
      this.of("item.delta")
        .filter((event) => event.key === key)
        .map((event) => event.text)
        .join(""),
    );
  }

  private async pump(): Promise<void> {
    let seq = 0;
    for (;;) {
      const frames = await this.runner.read({ afterSeq: seq, waitMs: 25 });
      for (const frame of frames) {
        seq = frame.seq;
        this.frames.push(frame);
        if (frame.type === "event") {
          this.events.push(frame.event);
          this.input.onEvent?.(frame.event, this);
          if (frame.event.type === "request.opened")
            void this.answerRequest(frame.event.key, frame.event.request);
        } else if (frame.type === "call") void this.serve(frame);
      }
      for (const wake of this.waiters) wake();
      this.waiters.clear();
      if (this.frames.at(-1)?.type === "exit") break;
    }
    await this.runner.done;
  }

  private async answerRequest(key: string, request: RequestDraft) {
    const response = await this.input.answer?.(key, request);
    if (response) this.send({ kind: "respond", requestKey: key, response });
  }

  private async serve(frame: Extract<RunnerFrame, { type: "call" }>) {
    this.calls.push(frame.call);
    try {
      const result = await this.handle(frame.call);
      this.send({
        kind: "host_result",
        callId: frame.callId,
        ...(result === undefined ? {} : { result }),
      });
    } catch (error) {
      this.send({
        kind: "host_result",
        callId: frame.callId,
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  private async handle(call: HostCall): Promise<JsonValue | undefined> {
    switch (call.kind) {
      case "tool": {
        const tool = this.input.tools?.[call.name];
        if (!tool) throw new Error(`No host tool ${call.name}`);
        return JSON.parse(JSON.stringify(await tool(call.input)));
      }
      case "native_state.append": {
        const thread = call.thread ?? this.ownThread;
        const entries = this.store.get(thread) ?? [];
        entries.push(...JSON.parse(JSON.stringify(call.entries)));
        this.store.set(thread, entries);
        return null;
      }
      case "native_state.load": {
        const entries = this.store.get(call.thread ?? this.ownThread);
        return entries ? JSON.parse(JSON.stringify(entries)) : null;
      }
      case "native_state.subpaths":
        return [];
    }
  }
}
