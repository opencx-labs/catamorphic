import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { afterEach, describe, expect, it } from "vitest";
import { readRollout } from "../rollout.js";
import { loadCodexFixture } from "../testing/index.js";
import type { CodexTranscriptEntry } from "../testing/transcript.js";
import {
  cleanup,
  completionOf,
  eventsOf,
  itemText,
  type ReplayRun,
  replayScenario,
} from "./replay/harness.js";

const runs: ReplayRun[] = [];
afterEach(async () => {
  await Promise.all(runs.splice(0).map(cleanup));
});
async function replay(
  ...args: Parameters<typeof replayScenario>
): Promise<ReplayRun> {
  const run = await replayScenario(...args);
  runs.push(run);
  return run;
}

type Of<T extends HarnessEvent["type"]> = Extract<HarnessEvent, { type: T }>;
function all<T extends HarnessEvent["type"]>(
  events: HarnessEvent[],
  type: T,
): Of<T>[] {
  return events.filter((event): event is Of<T> => event.type === type);
}
function one<T extends HarnessEvent["type"]>(
  events: HarnessEvent[],
  type: T,
): Of<T> {
  const found = all(events, type);
  expect(found, `exactly one ${type}`).toHaveLength(1);
  const [event] = found;
  if (!event) throw new Error(`No ${type}`);
  return event;
}

/** The thread's rollout in a home, as stored entries. */
async function homeRollout(
  run: ReplayRun,
  state: string,
  statePath: string | undefined,
) {
  if (!statePath) throw new Error("No state path");
  return readRollout(path.join(run.root, state, "codex-home", statePath));
}

describe("Codex adapter, replayed from the pinned app-server", () => {
  it("streams a fresh thread's reasoning, status and reply, then settles with usage", async () => {
    const run = await replay("simple-reply");
    const events = eventsOf(run);
    const thread = one(events, "thread");
    expect(events[0]).toBe(thread);
    expect(thread.ref.strength).toBe("strong");
    expect(thread.statePath).toMatch(/^sessions\/.+\.jsonl$/);
    const started = one(events, "turn.started");
    const completed = one(events, "turn.completed");
    expect(completed).toEqual({
      type: "turn.completed",
      status: "completed",
      ref: started.ref,
    });
    expect(events.at(-1)).toBe(completed);

    const reasoning = all(events, "item.started").find(
      (event) => event.item.kind === "reasoning",
    );
    expect(reasoning?.ref).toEqual({ id: reasoning?.key, strength: "strong" });
    expect(itemText(events, reasoning?.key ?? "")).toBe(
      "**Greeting the person**\n\nThey said hello.\n\nReply briefly.",
    );
    expect(all(events, "status")).toEqual([
      { type: "status", text: "Greeting the person" },
    ]);
    const reply = all(events, "item.started").find(
      (event) => event.item.kind === "assistant_message",
    );
    expect(
      all(events, "item.delta").filter((e) => e.key === reply?.key),
    ).toHaveLength(2);
    expect(itemText(events, reply?.key ?? "")).toBe(
      "Hello! How can I help today?",
    );
    expect(
      all(events, "item.completed").find((e) => e.key === reply?.key),
    ).toEqual({
      type: "item.completed",
      key: reply?.key,
      status: "completed",
      item: { text: "Hello! How can I help today?" },
    });
    // Usage lands before the turn settles: input excludes the cached part.
    const usage = one(events, "usage");
    expect(events.indexOf(usage)).toBeLessThan(events.indexOf(completed));
    expect(usage.usage).toEqual({
      model: "gpt-5.3-codex",
      inputTokens: 80,
      cachedInputTokens: 40,
      outputTokens: 30,
      reasoningTokens: 8,
      contextTokens: 150,
      contextWindow: 258400,
    });

    // The rollout mirrored line for line, every line stored before exit.
    const stored = run.store.load(thread.ref.id, "rollout");
    expect(stored).toEqual(await homeRollout(run, "state", thread.statePath));
    expect(run.results[0]?.frames.at(-1)?.type).toBe("exit");
  });

  it("resumes the same thread in a second attempt, stages an image, and keeps its host tools", async () => {
    const run = await replay("multi-turn-resume");
    const [first, second] = [eventsOf(run, 0), eventsOf(run, 1)];
    expect(one(second, "thread").ref).toEqual(one(first, "thread").ref);
    // Codex keeps the dynamic tools a thread started with across a resume.
    expect(
      run.results[1]?.calls.filter((call) => call.kind === "tool"),
    ).toEqual([
      { kind: "tool", name: "read_notes", input: {}, itemKey: "call_2_0" },
    ]);
    expect(one(second, "turn.started").ref?.id).not.toBe(
      one(first, "turn.started").ref?.id,
    );
    expect(completionOf(run, 1)?.status).toBe("completed");
    // Staged attachment bytes are gone once the attempt ends.
    await expect(
      stat(path.join(run.root, "state", "codex-input")),
    ).resolves.toBeTruthy();
    expect(await readdir(path.join(run.root, "state", "codex-input"))).toEqual(
      [],
    );
    // The second attempt mirrored only what the resume appended.
    const thread = one(first, "thread");
    expect(run.store.load(thread.ref.id, "rollout")).toEqual(
      await homeRollout(run, "state", thread.statePath),
    );
  });

  it("asks before a command runs outside the sandbox and runs it when approved", async () => {
    const run = await replay("command-approved");
    const events = eventsOf(run);
    const request = one(events, "request.opened");
    expect(request).toMatchObject({
      key: "approval:call_1_0",
      request: {
        kind: "approval",
        blocking: true,
        description: "Print a marker outside the sandbox",
        origin: { kind: "provider", id: "codex" },
        approval: {
          action: "Run a command",
          details: "/bin/zsh -lc 'echo approved-run'",
          tool: { server: null, name: "shell" },
        },
      },
    });
    const command = all(events, "item.started").find(
      (event) => event.item.kind === "command",
    );
    expect(command?.key).toBe("call_1_0");
    expect(
      all(events, "item.completed").find((e) => e.key === "call_1_0"),
    ).toEqual({
      type: "item.completed",
      key: "call_1_0",
      status: "completed",
      item: { output: "approved-run\n", exitCode: 0 },
    });
    expect(completionOf(run)?.status).toBe("completed");
  });

  it("declines a denied command and lets the agent continue", async () => {
    const run = await replay("command-denied");
    const events = eventsOf(run);
    expect(one(events, "request.opened").key).toBe("approval:call_1_0");
    expect(
      all(events, "item.completed").find((e) => e.key === "call_1_0")?.status,
    ).toBe("cancelled");
    expect(itemText(events, "msg_2_0")).toBe(
      "The command was not allowed, so I stopped.",
    );
    expect(completionOf(run)?.status).toBe("completed");
  });

  it("reports one file change per changed path, relative to the workspace", async () => {
    const run = await replay("file-change");
    const changes = all(eventsOf(run), "item.started").filter(
      (event) => event.item.kind === "file_change",
    );
    expect(changes.map((event) => event.item)).toEqual([
      {
        kind: "file_change",
        path: "README.md",
        change: "modified",
        previousPath: null,
      },
      {
        kind: "file_change",
        path: "notes.txt",
        change: "created",
        previousPath: null,
      },
    ]);
    expect(changes.map((event) => event.ref)).toEqual([
      { id: "call_1_0", strength: "strong" },
      { id: "call_1_0", strength: "strong" },
    ]);
    const completed = all(eventsOf(run), "item.completed").filter((event) =>
      changes.some((change) => change.key === event.key),
    );
    expect(completed.map((event) => event.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("runs a host tool as a Codex dynamic tool, and decides an MCP tool by policy", async () => {
    const run = await replay("host-and-mcp-tools");
    const result = run.results[0];
    const events = eventsOf(run);
    // The host tool is a host call keyed by Codex's own call id.
    expect(result?.calls.filter((call) => call.kind === "tool")).toEqual([
      {
        kind: "tool",
        name: "search_docs",
        input: { query: "rollout" },
        itemKey: "call_1_0",
      },
    ]);
    const tools = all(events, "item.started").filter(
      (event) => event.item.kind === "tool_call",
    );
    expect(tools.map((event) => event.item)).toEqual([
      expect.objectContaining({
        tool: "search_docs",
        server: "workspace",
        input: { query: "rollout" },
      }),
      expect.objectContaining({
        tool: "mcp__computer__inspect_window",
        server: "computer",
      }),
    ]);
    expect(
      all(events, "item.completed").find((e) => e.key === "call_1_0")?.item,
    ).toEqual({
      result: [
        { type: "inputText", text: "search_docs: rollouts are JSONL files" },
      ],
    });
    // `ask` policy: the runner opened the approval; then the server elicited.
    const requests = all(events, "request.opened");
    expect(requests.map((event) => event.request.kind)).toEqual([
      "approval",
      "elicitation",
    ]);
    expect(requests[0]?.request.approval?.tool).toEqual({
      server: "computer",
      name: "inspect_window",
      input: {},
    });
    expect(requests[1]?.request.elicitation).toEqual({
      server: "computer",
      message: "Allow fixture window access?",
      schema: { type: "object", properties: {} },
    });
    const mcp = all(events, "item.completed").find((e) => e.key === "call_2_0");
    expect(mcp?.status).toBe("completed");
    expect(JSON.stringify(mcp?.item)).toContain("Window approved; call 1");
    expect(completionOf(run)?.status).toBe("completed");
  });

  it("passes Codex's structured question to the person and answers with their choice", async () => {
    const run = await replay("user-question");
    const request = one(eventsOf(run), "request.opened");
    expect(request).toEqual({
      type: "request.opened",
      key: "question:call_1_0",
      request: {
        kind: "question",
        blocking: false,
        title: "Theme",
        origin: { kind: "provider", id: "codex", displayName: "Codex" },
        questions: [
          {
            question: "Which theme should the site use?",
            header: "Theme",
            multiSelect: false,
            options: [
              { label: "Orange", description: "Warm and bright" },
              { label: "Blue", description: "Calm and cool" },
            ],
          },
        ],
      },
    });
    // The recorded `{ answers: { theme: { answers: ["Orange"] } } }` matched.
    expect(completionOf(run)?.status).toBe("completed");
  });

  it("steers a running turn natively and reports the input as consumed", async () => {
    const run = await replay("steer-mid-turn");
    const events = eventsOf(run);
    const steer = run.results[0]?.commands.find((c) => c.kind === "steer");
    // The runner acknowledges a steer only once the harness took it.
    expect(
      run.results[0]?.acks.find((ack) => ack.commandId === steer?.id),
    ).toEqual({ commandId: steer?.id });
    expect(one(events, "input.consumed")).toEqual({
      type: "input.consumed",
      itemIds: ["steer-1"],
    });
    expect(itemText(events, "msg_2_0")).toBe(
      "Summary done, and the weather is sunny.",
    );
    expect(all(events, "turn.started")).toHaveLength(1);
    expect(completionOf(run)?.status).toBe("completed");
  });

  it("refuses a steer once the turn is finishing, so the host restarts it", async () => {
    let steered = false;
    const run = await replay("simple-reply", {
      scripts: {
        0: {
          onEvent: (event, act) => {
            if (event.type !== "usage" || steered) return;
            steered = true;
            act.steer("Too late");
          },
        },
      },
    });
    const refusal = run.results[0]?.acks.find((ack) => ack.error);
    expect(refusal?.error).toMatch(/not_accepted|not_running/);
    expect(all(eventsOf(run), "input.consumed")).toEqual([]);
    expect(completionOf(run)?.status).toBe("completed");
  });

  it("interrupts a streaming turn and still settles it, closing the open reply", async () => {
    const run = await replay("interrupt-mid-turn");
    const events = eventsOf(run);
    const reply = all(events, "item.started").find(
      (event) => event.item.kind === "assistant_message",
    );
    expect(
      all(events, "item.completed").find((e) => e.key === reply?.key)?.status,
    ).toBe("cancelled");
    expect(completionOf(run)).toEqual({
      type: "turn.completed",
      status: "interrupted",
      ref: one(events, "turn.started").ref,
    });
  });

  it("classifies an auth failure before any work as safe to retry", async () => {
    const run = await replay("error-auth");
    expect(completionOf(run)).toMatchObject({
      status: "failed",
      error: {
        message: expect.stringContaining("401 Unauthorized"),
        kind: "auth",
        retrySafe: true,
      },
    });
  });

  it("classifies a rate limit", async () => {
    const run = await replay("error-rate-limit");
    expect(completionOf(run)).toMatchObject({
      status: "failed",
      error: {
        message: "exceeded retry limit, last status: 429 Too Many Requests",
        kind: "rate_limit",
        retrySafe: true,
      },
    });
  });

  it("restores a mirrored rollout into a fresh Codex home and resumes from it", async () => {
    const run = await replay("restore-rollout");
    const thread = one(eventsOf(run, 0), "thread");
    const stored = run.store.load(thread.ref.id, "rollout") ?? [];
    expect(one(eventsOf(run, 1), "thread")).toEqual(thread);
    // The new home starts with exactly what the first attempt mirrored.
    const restored = await homeRollout(run, "state-b", thread.statePath);
    const firstAttempt = await homeRollout(run, "state-a", thread.statePath);
    expect(restored.slice(0, firstAttempt.length)).toEqual(firstAttempt);
    // And the second attempt's lines were mirrored on top.
    expect(stored).toEqual(restored);
    expect(itemText(eventsOf(run, 1), "msg_2_0")).toBe(
      "The codename is Heron.",
    );
    // The resume named the restored file.
    const transcript = await loadCodexFixture("restore-rollout");
    const resume = transcript.entries.find(
      (
        entry,
      ): entry is Extract<CodexTranscriptEntry, { expect_outbound: unknown }> =>
        "expect_outbound" in entry &&
        entry.expect_outbound.method === "thread/resume",
    );
    expect(JSON.stringify(resume)).toContain(
      `"path":"{{root}}/state-b/codex-home/${thread.statePath}"`,
    );
  });

  it("forks through a turn from stored state, keeps the source as an ancestor, and restores the fork elsewhere", async () => {
    const run = await replay("fork-through-turn");
    const source = one(eventsOf(run, 0), "thread");
    const firstTurn = completionOf(run, 0)?.ref;
    const fork = one(eventsOf(run, 2), "thread");
    expect(fork.ref.id).not.toBe(source.ref.id);
    // The fork loaded the source thread's rollout by its native id.
    expect(run.results[2]?.calls).toContainEqual({
      kind: "native_state.load",
      thread: source.ref.id,
      subpath: "rollout",
    });
    const transcript = await loadCodexFixture("fork-through-turn");
    const request = transcript.entries.find(
      (
        entry,
      ): entry is Extract<CodexTranscriptEntry, { expect_outbound: unknown }> =>
        "expect_outbound" in entry &&
        entry.expect_outbound.method === "thread/fork",
    );
    expect(request?.expect_outbound.params).toMatchObject({
      threadId: source.ref.id,
      lastTurnId: firstTurn?.id,
      path: `{{root}}/state-fork/codex-home/${source.statePath}`,
    });
    // The fork stores its source's rollout as an ancestor beside its own.
    const ancestor = `ancestor:${source.statePath}`;
    expect([...run.store.subpaths(fork.ref.id)].sort()).toEqual(
      [ancestor, "rollout"].sort(),
    );
    expect(run.store.load(fork.ref.id, ancestor)).toEqual(
      run.store.load(source.ref.id, "rollout"),
    );
    // Restoring the fork in a third home writes the ancestor first.
    expect(one(eventsOf(run, 3), "thread").ref).toEqual(fork.ref);
    expect(
      await homeRollout(run, "state-fork-restored", source.statePath),
    ).toEqual(run.store.load(source.ref.id, "rollout"));
    expect(itemText(eventsOf(run, 3), "msg_4_0")).toBe(
      "Still green in the restored fork.",
    );
  });

  it("fails the turn when the app server stops mid-turn", async () => {
    const recorded = await loadCodexFixture("simple-reply");
    const cut = recorded.entries.findIndex(
      (entry) =>
        "emit_inbound" in entry &&
        entry.emit_inbound.method === "item/agentMessage/delta",
    );
    const run = await replay("simple-reply", {
      transcript: {
        ...recorded,
        entries: [
          ...recorded.entries.slice(0, cut + 1),
          { runtime_exit: { code: 1, signal: null } },
        ],
      },
    });
    const events = eventsOf(run);
    const reply = all(events, "item.started").find(
      (event) => event.item.kind === "assistant_message",
    );
    expect(
      all(events, "item.completed").find((e) => e.key === reply?.key)?.status,
    ).toBe("failed");
    expect(completionOf(run)).toEqual({
      type: "turn.completed",
      status: "failed",
      error: {
        message: "Codex stopped before it finished the turn. Retry the turn.",
      },
    });
  });

  it("reports a frame the adapter sent out of turn as a replay mismatch", async () => {
    const recorded = await loadCodexFixture("simple-reply");
    const tampered = {
      ...recorded,
      entries: recorded.entries.map((entry) =>
        "expect_outbound" in entry &&
        entry.expect_outbound.method === "turn/start"
          ? {
              expect_outbound: {
                ...entry.expect_outbound,
                params: { different: true },
              },
            }
          : entry,
      ),
    };
    await expect(
      replay("simple-reply", { transcript: tampered }),
    ).rejects.toThrow(/outbound frame differs/);
  });
});
