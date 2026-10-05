import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type AttemptStart,
  formatEnvFile,
  type HarnessEvent,
  parseEnvFile,
  RUNNER_PROTOCOL_VERSION,
  type RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { EchoAdapter } from "../echo-adapter.js";
import { InProcessRunner } from "../in-process.js";
import {
  APPEND_BATCH_BYTES,
  AttemptRunner,
  appendBatches,
  boundFrame,
  lineBytes,
  MAX_FRAME_BYTES,
} from "../runner.js";
import { readEnvFile } from "../stdio.js";

/*
 * The attempt runner's protocol (ADR 0198): sequenced frames out, commands
 * in and deduplicated by id, requests answered or closed, native state
 * through host calls.
 */

function attempt(
  text: string,
  overrides: Partial<AttemptStart> = {},
): AttemptStart {
  return {
    protocol: RUNNER_PROTOCOL_VERSION,
    sessionId: "session",
    projectId: "project",
    turnId: "turn",
    attemptId: "attempt",
    reason: "initial",
    harness: "echo",
    workingDirectory: "/tmp",
    stateDirectory: "/tmp",
    thread: { mode: "fresh", providerThreadId: "thread" },
    input: { itemId: "input", text, attachments: [] },
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

/** A runner with the echo harness, and a reader of everything it said. */
function harness() {
  const runner = new InProcessRunner({
    adapters: { echo: new EchoAdapter() },
    version: "test",
  });
  const frames: RunnerFrame[] = [];
  let cursor = 0;
  const pump = async (waitMs = 50) => {
    const read = await runner.read({ afterSeq: cursor, waitMs });
    for (const frame of read) frames.push(frame);
    cursor = read.at(-1)?.seq ?? cursor;
  };
  const until = async (predicate: () => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline)
        throw new Error("Timed out waiting on the runner");
      await pump();
    }
  };
  const events = () =>
    frames.flatMap((frame): HarnessEvent[] =>
      frame.type === "event" ? [frame.event] : [],
    );
  const calls = () =>
    frames.flatMap((frame) => (frame.type === "call" ? [frame] : []));
  // The echo harness's native state calls: answer as an empty store.
  const answerCalls = () => {
    for (const call of calls())
      runner.send({
        id: `result:${call.callId}`,
        command: {
          kind: "host_result",
          callId: call.callId,
          result: call.call.kind === "native_state.load" ? [] : null,
        },
      });
  };
  return { runner, frames, pump, until, events, calls, answerCalls };
}

describe("attempt runner", () => {
  it("says hello, runs the attempt and numbers every frame from 1", async () => {
    const { runner, frames, until, events, answerCalls } = harness();
    runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("hello") },
    });
    await until(() => {
      answerCalls();
      return events().some((event) => event.type === "turn.completed");
    });
    expect(frames[0]).toMatchObject({
      type: "hello",
      protocol: RUNNER_PROTOCOL_VERSION,
      harness: { id: "echo" },
    });
    expect(frames.map((frame) => frame.seq)).toEqual(
      frames.map((_, index) => index + 1),
    );
    expect(
      events().find((event) => event.type === "turn.completed"),
    ).toMatchObject({ status: "completed" });
  });

  it("acknowledges a repeated command without running it again", async () => {
    const { runner, frames, until } = harness();
    const start = {
      id: "start",
      command: { kind: "start" as const, attempt: attempt("[[hang]]") },
    };
    runner.send(start);
    runner.send(start);
    await until(
      () =>
        frames.filter(
          (frame) => frame.type === "ack" && frame.commandId === "start",
        ).length === 2,
    );
    expect(frames.filter((frame) => frame.type === "hello")).toHaveLength(1);
    runner.send({ id: "stop", command: { kind: "stop" } });
  });

  it("refuses an attempt of another protocol", async () => {
    const { runner, frames, until } = harness();
    runner.send({
      id: "start",
      command: {
        kind: "start",
        attempt: {
          ...attempt("x"),
          protocol: 999 as typeof RUNNER_PROTOCOL_VERSION,
        },
      },
    });
    await until(() =>
      frames.some((frame) => frame.type === "ack" || frame.type === "exit"),
    );
    const ack = frames.find((frame) => frame.type === "ack");
    expect(ack?.type === "ack" && ack.error).toBeTruthy();
  });

  it("answers a question, and closes it when the turn is interrupted", async () => {
    const first = harness();
    first.runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("[[ask Ship it?]]") },
    });
    await first.until(() => {
      first.answerCalls();
      return first.events().some((event) => event.type === "request.opened");
    });
    const opened = first
      .events()
      .find((event) => event.type === "request.opened");
    if (opened?.type !== "request.opened") throw new Error("No question");
    first.runner.send({
      id: "answer",
      command: {
        kind: "respond",
        requestKey: opened.key,
        response: { kind: "question", answers: ["Yes"] },
      },
    });
    await first.until(() => {
      first.answerCalls();
      return first.events().some((event) => event.type === "turn.completed");
    });
    expect(JSON.stringify(first.events())).toContain("You answered: Yes");

    const second = harness();
    second.runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("[[ask Ship it?]]") },
    });
    await second.until(() => {
      second.answerCalls();
      return second.events().some((event) => event.type === "request.opened");
    });
    second.runner.send({ id: "interrupt", command: { kind: "interrupt" } });
    await second.until(() => {
      second.answerCalls();
      return second.events().some((event) => event.type === "turn.completed");
    });
    expect(
      second.events().some((event) => event.type === "request.closed"),
    ).toBe(true);
    expect(
      second.events().find((event) => event.type === "turn.completed"),
    ).toMatchObject({
      status: "interrupted",
    });
  });

  it("releases a waiting question without closing it, and the harness goes on", async () => {
    const { runner, until, events, answerCalls } = harness();
    runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("[[ask Which theme?]]") },
    });
    await until(() => {
      answerCalls();
      return events().some((event) => event.type === "request.opened");
    });
    const opened = events().find((event) => event.type === "request.opened");
    if (opened?.type !== "request.opened") throw new Error("No question");
    runner.send({
      id: "release",
      command: {
        kind: "release",
        requestKey: opened.key,
        reason: "The person replied in the chat.",
      },
    });
    await until(() => {
      answerCalls();
      return events().some((event) => event.type === "turn.completed");
    });
    // The request stays open in Work: the runner says nothing about it.
    expect(events().some((event) => event.type === "request.closed")).toBe(
      false,
    );
    expect(
      events().find((event) => event.type === "turn.completed"),
    ).toMatchObject({ status: "completed" });
  });

  it("steers input into a running turn and acknowledges once the harness took it", async () => {
    const { runner, frames, until, events, answerCalls } = harness();
    runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("[[wait 300]]") },
    });
    await until(() => {
      answerCalls();
      return events().some((event) => event.type === "status");
    });
    runner.send({
      id: "steer:1",
      command: {
        kind: "steer",
        input: { itemId: "steered", text: "also this", attachments: [] },
      },
    });
    await until(() => {
      answerCalls();
      return events().some((event) => event.type === "turn.completed");
    });
    const ack = frames.find(
      (frame) => frame.type === "ack" && frame.commandId === "steer:1",
    );
    expect(ack?.type === "ack" && ack.error).toBeFalsy();
    expect(events().some((event) => event.type === "input.consumed")).toBe(
      true,
    );
    expect(JSON.stringify(events())).toContain("Steered: also this");
  });

  it("refuses a steer when no turn is running", async () => {
    const { runner, frames, until } = harness();
    runner.send({
      id: "steer:1",
      command: {
        kind: "steer",
        input: { itemId: "x", text: "late", attachments: [] },
      },
    });
    await until(() => frames.some((frame) => frame.type === "ack"));
    const ack = frames.find((frame) => frame.type === "ack");
    expect(ack?.type === "ack" && ack.error).toBe("not_running");
  });

  it("bounds frames by their UTF-8 bytes, not their characters", () => {
    const frame = (text: string): RunnerFrame => ({
      seq: 1,
      type: "event",
      event: {
        type: "item.started",
        key: "reply",
        item: { kind: "assistant_message", text, agentId: null },
      },
    });
    // 300 000 characters is under the old character limit, but 900 KB.
    const wide = boundFrame(frame("界".repeat(300_000)));
    expect(lineBytes(wide)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
    expect(JSON.stringify(wide)).toContain("[Shortened: ");
    // As many ASCII characters fit, and are left alone.
    const narrow = frame("a".repeat(300_000));
    expect(boundFrame(narrow)).toBe(narrow);
    // Ever harsher cuts until it fits, whatever its shape.
    const many = boundFrame({
      seq: 1,
      type: "event",
      event: {
        type: "item.started",
        key: "tool",
        item: {
          kind: "tool_call",
          tool: "t",
          server: "s",
          description: null,
          input: Array.from({ length: 150 }, () => "界".repeat(16_000)),
          result: null,
          error: null,
        },
      },
    });
    expect(lineBytes(many)).toBeLessThanOrEqual(MAX_FRAME_BYTES);
  });

  it("stores a large entry whole, in its own call, and shortens what it says", async () => {
    const { runner, until, events, calls, answerCalls } = harness();
    runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("[[big 400000]]") },
    });
    await until(() => {
      answerCalls();
      return events().some((event) => event.type === "turn.completed");
    });
    const stored = calls().filter(
      (frame) =>
        frame.call.kind === "native_state.append" &&
        frame.call.subpath === "big",
    );
    expect(stored).toHaveLength(1);
    expect(lineBytes(stored[0] as RunnerFrame)).toBeGreaterThan(
      MAX_FRAME_BYTES,
    );
    expect(JSON.stringify(stored[0])).toContain("界".repeat(400_000));
    expect(JSON.stringify(events())).toContain("[Shortened: ");
    expect(
      events().find((event) => event.type === "turn.completed"),
    ).toMatchObject({ status: "completed" });
  });

  it("splits an append into bounded calls, in order", () => {
    const entries = Array.from({ length: 9 }, (_, index) => ({
      index,
      text: "界".repeat(30_000),
    }));
    const batches = [...appendBatches(entries)];
    expect(batches.length).toBeGreaterThan(1);
    for (const batch of batches)
      expect(
        Buffer.byteLength(JSON.stringify(batch), "utf8"),
      ).toBeLessThanOrEqual(APPEND_BATCH_BYTES);
    expect(batches.flat()).toEqual(entries);
    expect([...appendBatches([])]).toEqual([[]]);
  });

  it("fails the attempt, saying why, when an entry is too large to send", async () => {
    const { runner, frames, until, events, calls, answerCalls } = harness();
    runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("[[big 3000000]]") },
    });
    await until(() => {
      answerCalls();
      return frames.some((frame) => frame.type === "exit");
    });
    expect(
      calls().some(
        (frame) =>
          frame.call.kind === "native_state.append" &&
          frame.call.subpath === "big",
      ),
    ).toBe(false);
    const completed = events().filter(
      (event) => event.type === "turn.completed",
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ status: "failed" });
    expect(JSON.stringify(completed[0])).toContain(
      "The conversation could not be stored",
    );
  });

  it("lets go of frames its reader has read past, and refuses to read before them", async () => {
    const runner = new InProcessRunner({
      adapters: { echo: new EchoAdapter() },
      version: "test",
    });
    runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("[[wait 50]] hello") },
    });
    let cursor = 0;
    const seen: RunnerFrame[] = [];
    while (!runner.exited) {
      const read = await runner.read({ afterSeq: cursor, waitMs: 100 });
      seen.push(...read);
      for (const frame of read)
        if (frame.type === "call")
          runner.send({
            id: `result:${frame.callId}`,
            command: {
              kind: "host_result",
              callId: frame.callId,
              result: frame.call.kind === "native_state.load" ? [] : null,
            },
          });
      cursor = read.at(-1)?.seq ?? cursor;
    }
    // Reading the same cursor again is fine: nothing past it was released.
    const again = await runner.read({ afterSeq: cursor, waitMs: 0 });
    seen.push(...again);
    cursor = again.at(-1)?.seq ?? cursor;
    expect(seen.map((frame) => frame.seq)).toEqual(
      seen.map((_, index) => index + 1),
    );
    expect(seen.at(-1)?.type).toBe("exit");
    // Read past the last frame, nothing of the attempt is held any more.
    expect(await runner.read({ afterSeq: cursor, waitMs: 0 })).toEqual([]);
    expect(runner.heldFrames).toBe(0);
    await expect(runner.read({ afterSeq: 1, waitMs: 0 })).rejects.toThrow(
      /already released/,
    );
  });

  it("a killed runner falls silent, like a process that died", async () => {
    const { runner, until, events, pump, answerCalls } = harness();
    runner.send({
      id: "start",
      command: { kind: "start", attempt: attempt("[[hang]]") },
    });
    await until(() => {
      answerCalls();
      return events().some((event) => event.type === "status");
    });
    runner.kill();
    await pump(100);
    expect(runner.exited).toBe(true);
    expect(events().some((event) => event.type === "turn.completed")).toBe(
      false,
    );
  });
});

/** Everything the echo harness said: whole messages and streamed text. */
function spoken(frames: readonly RunnerFrame[]): string {
  return frames
    .flatMap((frame) => {
      if (frame.type !== "event") return [];
      const { event } = frame;
      if (event.type === "item.delta") return [event.text];
      if (
        event.type === "item.started" &&
        event.item.kind === "assistant_message"
      )
        return [event.item.text];
      return [];
    })
    .join("");
}

describe("the session's environment file (ADR 0205)", () => {
  /** A runner whose environment file reader serves `files`, and its frames. */
  function withFiles(files: Record<string, string>) {
    const frames: RunnerFrame[] = [];
    const runner = new AttemptRunner({
      adapters: { echo: new EchoAdapter() },
      version: "test",
      write: (frame) => frames.push(frame),
      envFile: (file) =>
        files[file] === undefined ? undefined : parseEnvFile(files[file]),
    });
    const said = () => spoken(frames);
    // The echo harness's native state calls: answer as an empty store.
    const answer = () => {
      for (const frame of frames)
        if (frame.type === "call")
          runner.handle({
            id: `result:${frame.callId}`,
            command: {
              kind: "host_result",
              callId: frame.callId,
              result: frame.call.kind === "native_state.load" ? [] : null,
            },
          });
    };
    return { runner, frames, said, answer };
  }

  it("adds the file's variables and BASH_ENV to the harness's environment", async () => {
    const file = "/workspace/.work-session/env/secrets.sh";
    const { runner, frames, said, answer } = withFiles({
      [file]: formatEnvFile({ CLICKHOUSE_API_KEY: "ch-key-123", OWN: "x" }),
    });
    runner.handle({
      id: "start",
      command: {
        kind: "start",
        attempt: attempt(
          "[[env CLICKHOUSE_API_KEY]] [[env BASH_ENV]] [[env OWN]]",
          { envFile: file, env: { OWN: "the host's" } },
        ),
      },
    });
    const deadline = Date.now() + 5_000;
    while (!frames.some((frame) => frame.type === "exit")) {
      if (Date.now() > deadline) throw new Error("The attempt never finished");
      answer();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(said()).toContain("CLICKHOUSE_API_KEY=ch-key-123");
    expect(said()).toContain(`BASH_ENV=${file}`);
    // The attempt's own variables win over the file's.
    expect(said()).toContain("OWN=the host's");
  });

  it("adds nothing when the file is missing, or the runner reads none", async () => {
    for (const files of [{}, undefined]) {
      const frames: RunnerFrame[] = [];
      const runner = new AttemptRunner({
        adapters: { echo: new EchoAdapter() },
        version: "test",
        write: (frame) => frames.push(frame),
        ...(files ? { envFile: () => undefined } : {}),
      });
      runner.handle({
        id: "start",
        command: {
          kind: "start",
          attempt: attempt("[[env BASH_ENV]]", {
            envFile: "/workspace/.work-session/env/secrets.sh",
          }),
        },
      });
      const deadline = Date.now() + 5_000;
      const text = () => spoken(frames);
      while (!frames.some((frame) => frame.type === "exit")) {
        if (Date.now() > deadline)
          throw new Error("The attempt never finished");
        for (const frame of frames)
          if (frame.type === "call")
            runner.handle({
              id: `result:${frame.callId}`,
              command: {
                kind: "host_result",
                callId: frame.callId,
                result: frame.call.kind === "native_state.load" ? [] : null,
              },
            });
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(text()).toContain("BASH_ENV is not set");
    }
  });

  it("reads a file on this machine, and none when it is missing", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "runner-env-"));
    try {
      const file = path.join(directory, "secrets.sh");
      expect(readEnvFile(file)).toBeUndefined();
      expect(readEnvFile(path.join(file, "below-a-file"))).toBeUndefined();
      await fs.writeFile(file, formatEnvFile({ A: "1", B: "two words" }));
      expect(readEnvFile(file)).toEqual({ A: "1", B: "two words" });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
