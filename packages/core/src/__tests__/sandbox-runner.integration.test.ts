import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AttemptStart,
  type HarnessEvent,
  RUNNER_PROTOCOL_VERSION,
  type RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type RunnerChannel,
  sandboxChannel,
  startSandboxRunner,
} from "../services/sessions/runner-channels.js";

/*
 * The runner bundle in a sandbox (ADR 0197): uploaded by hash, run as a
 * process with standard input, read by byte cursor, and read on by another
 * holder from the stored cursor.
 */

function attempt(text: string): AttemptStart {
  return {
    protocol: RUNNER_PROTOCOL_VERSION,
    sessionId: "session",
    projectId: "project",
    turnId: "turn",
    attemptId: "attempt",
    reason: "initial",
    harness: "echo",
    workingDirectory: "/workspace",
    stateDirectory: "/workspace/.work-session",
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
  };
}

/** Read a channel until `done`, answering the echo harness's state calls. */
async function readUntil(input: {
  channel: RunnerChannel;
  cursor: number;
  frames: RunnerFrame[];
  done: (frames: RunnerFrame[]) => boolean;
}): Promise<number> {
  let cursor = input.cursor;
  const answered = new Set<string>();
  const deadline = Date.now() + 30_000;
  while (!input.done(input.frames)) {
    if (Date.now() > deadline)
      throw new Error("The sandbox runner never finished");
    const read = await input.channel.read({ cursor, waitMs: 500 });
    input.frames.push(...read.frames);
    cursor = read.cursor;
    for (const frame of read.frames)
      if (frame.type === "call" && !answered.has(frame.callId)) {
        answered.add(frame.callId);
        await input.channel.send([
          {
            id: `result:${frame.callId}`,
            command: {
              kind: "host_result",
              callId: frame.callId,
              result: frame.call.kind === "native_state.load" ? [] : null,
            },
          },
        ]);
      }
  }
  return cursor;
}

const events = (frames: RunnerFrame[]) =>
  frames.flatMap((frame): HarnessEvent[] =>
    frame.type === "event" ? [frame.event] : [],
  );
/** The reply's text, from its streamed deltas. */
const replyText = (frames: RunnerFrame[]) =>
  events(frames)
    .map((event) =>
      event.type === "item.delta" && event.field === "text" ? event.text : "",
    )
    .join("");
const completed = (frames: RunnerFrame[]) =>
  events(frames).some((event) => event.type === "turn.completed");

describe("sandbox runner", () => {
  let root: string;
  let provider: LocalProcessSandboxProvider;

  beforeAll(() => {
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-sandbox-runner-"),
    );
    provider = new LocalProcessSandboxProvider({ root });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs an attempt from the bundle and answers over standard input", async () => {
    const sandbox = await provider.createSandbox({});
    const channel = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory: "/workspace/.work-session",
    });
    await channel.send([
      { id: "start", command: { kind: "start", attempt: attempt("hello") } },
    ]);
    const frames: RunnerFrame[] = [];
    await readUntil({ channel, cursor: 0, frames, done: completed });
    expect(frames[0]).toMatchObject({ type: "hello", harness: { id: "echo" } });
    expect(replyText(frames)).toContain("Echo: hello");
    expect(frames.map((frame) => frame.seq)).toEqual(
      frames.map((_, index) => index + 1),
    );
    await channel.kill();
  }, 60_000);

  it("is read on by another holder from the stored cursor, and reuses the uploaded bundle", async () => {
    const sandbox = await provider.createSandbox({});
    const first = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory: "/workspace/.work-session",
    });
    await first.send([
      {
        id: "start",
        command: { kind: "start", attempt: attempt("[[wait 1500]] later") },
      },
    ]);
    const seen: RunnerFrame[] = [];
    const cursor = await readUntil({
      channel: first,
      cursor: 0,
      frames: seen,
      done: (frames) => events(frames).some((event) => event.type === "status"),
    });
    if (first.location.kind !== "sandbox_process")
      throw new Error("Expected a sandbox runner");
    // The first holder is gone; another reattaches by location and cursor.
    const second = sandboxChannel({ provider, location: first.location });
    const rest: RunnerFrame[] = [];
    await readUntil({ channel: second, cursor, frames: rest, done: completed });
    expect(rest[0]?.seq).toBe((seen.at(-1)?.seq ?? 0) + 1);
    expect(replyText(rest)).toContain("Echo: later");
    // A second runner in the same sandbox finds the bundle already there.
    const again = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory: "/workspace/.work-session",
    });
    const listing = await provider.executeCommand(sandbox.id, "ls runner", {
      cwd: "/workspace/.work-session",
    });
    expect(listing.result.trim().split("\n")).toHaveLength(1);
    await again.kill();
  }, 60_000);
});
