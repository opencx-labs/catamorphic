import {
  type AttemptStart,
  type HarnessEvent,
  RUNNER_PROTOCOL_VERSION,
  type RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { EchoAdapter } from "../echo-adapter.js";
import { InProcessRunner } from "../in-process.js";

/*
 * The attempt runner's protocol (ADR 0197): sequenced frames out, commands
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
    modelAccess: { kind: "host", env: {} },
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
