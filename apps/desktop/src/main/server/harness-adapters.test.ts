import {
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessEvent,
  NO_CAPABILITIES,
  RUNNER_PROTOCOL_VERSION,
} from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { desktopAdapter } from "./harness-adapters.js";

function recordingHost(): { host: AttemptHost; events: HarnessEvent[] } {
  const events: HarnessEvent[] = [];
  const host: AttemptHost = {
    emit: (event) => {
      events.push(event);
    },
    callTool: async () => {
      throw new Error("No tools here");
    },
    authorize: async () => ({ allowed: false, message: "No tools here" }),
    request: async () => {
      throw new Error("No requests here");
    },
    nativeState: {
      append: async () => {},
      load: async () => null,
      subpaths: async () => [],
    },
    signal: new AbortController().signal,
  };
  return { host, events };
}

const attempt: AttemptStart = {
  protocol: RUNNER_PROTOCOL_VERSION,
  sessionId: "session-1",
  projectId: "project-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  reason: "initial",
  harness: "claude-code",
  workingDirectory: "/workspace",
  stateDirectory: "/state",
  thread: { mode: "fresh", providerThreadId: "thread-1" },
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
};
const errors = { agentName: "Claude", providerLabel: "Claude Code" };

/** An adapter that finishes at once, recording that it started. */
function finishingAdapter(started: string[]): HarnessAdapter {
  return {
    id: "inner",
    capabilities: () => NO_CAPABILITIES,
    start: (_attempt, host) => {
      started.push("inner");
      host.emit({ type: "turn.completed", status: "completed" });
      return {
        steer: async () => false,
        interrupt: () => {},
        finished: Promise.resolve(),
      };
    },
  };
}

describe("desktopAdapter", () => {
  it("says what getting ready waits for on the activity line", async () => {
    const started: string[] = [];
    const adapter = desktopAdapter({
      id: "claude-code",
      capabilities: () => NO_CAPABILITIES,
      prepare: async (start, report) => {
        report("Downloading Claude Code: 22 of 221 MB");
        report("Downloading Claude Code: 132 of 221 MB");
        return { adapter: finishingAdapter(started), attempt: start };
      },
      errors,
    });
    const { host, events } = recordingHost();
    await adapter.start(attempt, host).finished;
    expect(events).toEqual([
      {
        type: "status",
        text: "Downloading Claude Code: 22 of 221 MB",
      },
      {
        type: "status",
        text: "Downloading Claude Code: 132 of 221 MB",
      },
      { type: "turn.completed", status: "completed" },
    ]);
    expect(started).toEqual(["inner"]);
  });

  // Stop used to wait for the whole download before the turn ended.
  it("ends a turn stopped while getting ready at once, and never starts it", async () => {
    const started: string[] = [];
    let release = () => {};
    let progress = (_activity: string) => {};
    const adapter = desktopAdapter({
      id: "claude-code",
      capabilities: () => NO_CAPABILITIES,
      prepare: (start, report) =>
        new Promise((resolve) => {
          report("Downloading Claude Code: 2 of 221 MB");
          progress = report;
          release = () =>
            resolve({ adapter: finishingAdapter(started), attempt: start });
        }),
      errors,
    });
    const { host, events } = recordingHost();
    const control = adapter.start(attempt, host);
    await Promise.resolve();
    control.interrupt("Stopped");
    await control.finished;
    expect(events.at(-1)).toEqual({
      type: "turn.completed",
      status: "interrupted",
    });
    // The shared download goes on, and says nothing to the ended turn.
    progress("Downloading Claude Code: 90 of 221 MB");
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(started).toEqual([]);
    expect(
      events.flatMap((event) => (event.type === "status" ? [event.text] : [])),
    ).toEqual(["Downloading Claude Code: 2 of 221 MB"]);
    expect(
      events.filter((event) => event.type === "turn.completed"),
    ).toHaveLength(1);
  });

  it("reports a failure to get ready in its own words, not as the provider's", async () => {
    const adapter = desktopAdapter({
      id: "claude-code",
      capabilities: () => NO_CAPABILITIES,
      prepare: async () => {
        throw new Error(
          "Claude Code needs a one-time component download. fetch failed. Check your internet connection and try again.",
        );
      },
      errors,
    });
    const { host, events } = recordingHost();
    await adapter.start(attempt, host).finished;
    expect(events).toEqual([
      {
        type: "turn.completed",
        status: "failed",
        error: {
          message:
            "Claude Code needs a one-time component download. fetch failed. Check your internet connection and try again.",
        },
      },
    ]);
  });
});
