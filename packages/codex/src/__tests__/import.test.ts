import { describe, expect, it } from "vitest";
import { CODEX_CLIENT_NAME } from "../app-server.js";
import { CodexRolloutReader, readCodexRollout } from "../import.js";

/*
 * Codex rollouts (`~/.codex/sessions/…/rollout-*.jsonl`) as imported
 * sessions (ADR 0233). Records are shaped like current Codex's
 * (`item_completed`) and an older one's (messages and calls only).
 */

const THREAD = "01a0d5ac-8636-7032-b6a9-267d2bd70d1b";
const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 15, 12, 0, second)).toISOString();
const line = (second: number, type: string, payload: object) =>
  JSON.stringify({ timestamp: at(second), type, payload });
const meta = (extra: object = {}) =>
  line(0, "session_meta", {
    id: THREAD,
    session_id: THREAD,
    timestamp: at(0),
    cwd: "/work/web",
    originator: "codex_cli_rs",
    source: "cli",
    ...extra,
  });
const completed = (second: number, turnId: string, item: object) =>
  line(second, "event_msg", {
    type: "item_completed",
    thread_id: THREAD,
    turn_id: turnId,
    item,
  });

const current = [
  meta(),
  line(1, "event_msg", { type: "task_started", turn_id: "turn-1" }),
  line(1, "turn_context", { turn_id: "turn-1", model: "gpt-6-astra" }),
  // The model's view of the prompt carries injected context: not read.
  line(1, "response_item", {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "<environment_context>…" }],
  }),
  completed(1, "turn-1", {
    type: "UserMessage",
    id: "user-1",
    content: [{ type: "text", text: "Why does the build fail?" }],
  }),
  completed(2, "turn-1", {
    type: "Reasoning",
    id: "rs-1",
    summary_text: ["Checking the build"],
    raw_content: [],
  }),
  completed(3, "turn-1", {
    type: "CommandExecution",
    id: "exec-1",
    command: ["/bin/zsh", "-lc", "bun run build"],
    status: "completed",
    aggregated_output: "error TS2345",
    exit_code: 1,
  }),
  completed(4, "turn-1", {
    type: "McpToolCall",
    id: "call-1",
    server: "github",
    tool: "get_issue",
    arguments: { number: 240 },
    status: "completed",
    result: { content: [{ type: "text", text: "Issue 240" }] },
  }),
  completed(5, "turn-1", {
    type: "FileChange",
    id: "exec-2",
    changes: {
      "/work/web/a.ts": { type: "update" },
      "/work/web/b.ts": { type: "add", content: "x" },
    },
    status: "completed",
  }),
  completed(6, "turn-1", {
    type: "AgentMessage",
    id: "msg-1",
    content: [{ type: "Text", text: "Fixed the type error." }],
    phase: "final",
  }),
  completed(6, "turn-1", { type: "ContextCompaction", id: "cc-1" }),
  line(7, "event_msg", { type: "task_complete", turn_id: "turn-1" }),
  line(10, "event_msg", { type: "task_started", turn_id: "turn-2" }),
  completed(10, "turn-2", {
    type: "UserMessage",
    id: "user-2",
    content: [{ type: "text", text: "Run the tests" }],
  }),
  completed(11, "turn-2", {
    type: "CommandExecution",
    id: "exec-3",
    command: ["/bin/zsh", "-lc", "bun test"],
    status: "completed",
    aggregated_output: "ok",
    exit_code: 0,
  }),
  line(12, "event_msg", {
    type: "turn_aborted",
    turn_id: "turn-2",
    reason: "interrupted",
  }),
];

describe("readCodexRollout", () => {
  it("reads a current rollout's finished items", () => {
    const transcript = readCodexRollout({
      content: current.join("\n"),
      now: new Date(at(20)),
    });
    expect(transcript).toMatchObject({
      harness: "codex",
      nativeSessionId: THREAD,
      cwd: "/work/web",
      model: "gpt-6-astra",
      startedAt: at(0),
    });
    const [first, second] = transcript?.turns ?? [];
    expect(first).toMatchObject({
      key: "user-1",
      input: { text: "Why does the build fail?" },
      status: "completed",
      completedAt: at(7),
    });
    expect(first?.items.map((item) => [item.item.kind, item.status])).toEqual([
      ["reasoning", "completed"],
      ["command", "failed"],
      ["tool_call", "completed"],
      ["file_change", "completed"],
      ["file_change", "completed"],
      ["assistant_message", "completed"],
    ]);
    expect(first?.items[1]?.item).toMatchObject({
      command: "bun run build",
      output: "error TS2345",
      exitCode: 1,
    });
    expect(first?.items[2]?.item).toMatchObject({
      tool: "mcp__github__get_issue",
      server: "github",
      result: "Issue 240",
    });
    expect(first?.items[4]?.item).toMatchObject({
      path: "/work/web/b.ts",
      change: "created",
    });
    expect(second).toMatchObject({
      input: { text: "Run the tests" },
      status: "interrupted",
      completedAt: at(12),
    });
  });

  it("reads an older Codex's messages and calls", () => {
    const transcript = readCodexRollout({
      content: [
        meta(),
        line(1, "event_msg", { type: "task_started", turn_id: "t1" }),
        line(1, "event_msg", { type: "user_message", message: "List files" }),
        line(2, "response_item", {
          type: "function_call",
          name: "shell",
          arguments: JSON.stringify({ command: ["bash", "-lc", "ls"] }),
          call_id: "call_1",
        }),
        line(3, "response_item", {
          type: "function_call_output",
          call_id: "call_1",
          output: "README.md",
        }),
        line(4, "event_msg", { type: "agent_message", message: "One file." }),
        line(5, "event_msg", { type: "task_complete", turn_id: "t1" }),
      ].join("\n"),
      now: new Date(at(10)),
    });
    expect(transcript?.turns).toHaveLength(1);
    expect(
      transcript?.turns[0]?.items.map((item) => [item.item.kind, item.status]),
    ).toEqual([
      ["command", "completed"],
      ["assistant_message", "completed"],
    ]);
    expect(transcript?.turns[0]?.items[0]?.item).toMatchObject({
      command: "ls",
      output: "README.md",
    });
  });

  it("keeps a running turn open until Codex ends it or goes quiet", () => {
    const reader = new CodexRolloutReader();
    for (const record of current.slice(0, 15)) reader.push(record);
    const open = reader.read({ now: new Date(at(12)) });
    expect(open?.turns.at(-1)?.completedAt).toBeNull();
    const quiet = reader.read({ now: new Date(at(11 + 11 * 60)) });
    expect(quiet?.turns.at(-1)?.completedAt).toBe(at(11));
    // Reading never closes it: more records still land in the same turn.
    for (const record of current.slice(15)) reader.push(record);
    expect(reader.read({ now: new Date(at(13)) })?.turns.at(-1)).toMatchObject({
      status: "interrupted",
      completedAt: at(12),
    });
  });

  it("skips subagent threads and Work's own, known from the first line", () => {
    for (const extra of [
      { source: { subagent: { thread_spawn: { parent_thread_id: "x" } } } },
      { originator: CODEX_CLIENT_NAME },
    ]) {
      expect(
        readCodexRollout({
          content: [meta(extra), ...current.slice(1)].join("\n"),
        }),
      ).toBeUndefined();
      const reader = new CodexRolloutReader();
      expect(reader.skipped()).toBe(false);
      reader.push(meta(extra));
      expect(reader.skipped()).toBe(true);
    }
    const reader = new CodexRolloutReader();
    reader.push(meta());
    expect(reader.skipped()).toBe(false);
  });
});

const userMessage = (second: number, turnId: string, text: string) =>
  completed(second, turnId, {
    type: "UserMessage",
    id: `user-${turnId}`,
    content: [{ type: "text", text }],
  });
const agentMessage = (second: number, turnId: string, text: string) =>
  completed(second, turnId, {
    type: "AgentMessage",
    id: `msg-${turnId}-${second}`,
    content: [{ type: "Text", text }],
    phase: "final",
  });
const taskComplete = (second: number, turnId: string) =>
  line(second, "event_msg", { type: "task_complete", turn_id: turnId });

describe("what Codex Desktop adds to messages", () => {
  const read = (...texts: string[]) =>
    readCodexRollout({
      content: [
        meta({ originator: "Codex Desktop", source: "vscode" }),
        ...texts.flatMap((text, index) => [
          userMessage(index * 10 + 1, `turn-${index}`, text),
          agentMessage(index * 10 + 2, `turn-${index}`, "Done."),
          taskComplete(index * 10 + 3, `turn-${index}`),
        ]),
      ].join("\n"),
      now: new Date(at(100)),
    })?.turns.map((turn) => turn.input?.text ?? null);

  it("reads an automation's heartbeat and a task's notification as turns nobody typed", () => {
    expect(
      read(
        "Triage the inbox",
        [
          "<heartbeat>",
          "<automation_id>daily-triage</automation_id>",
          "<current_time_iso>2026-10-15T12:00:00.000Z</current_time_iso>",
          "<instructions>Check new issues.</instructions>",
          "</heartbeat>",
          "",
        ].join("\n"),
        [
          "<task-notification>",
          "<task-id>bg_17</task-id>",
          "<summary>Background terminal finished</summary>",
          "<event>bun test exited with code 0</event>",
          "</task-notification>",
        ].join("\n"),
      ),
    ).toEqual(["Triage the inbox", null, null]);
  });

  it("leaves out the in-app browser's context and a question reply's wrapper", () => {
    expect(
      read(
        '\n<in-app-browser-context source="tab">\nPage: Pricing (https://example.com/pricing)\n</in-app-browser-context>\nWhy is this button grey?\n',
        `<send_user_message_question_reply>\n${JSON.stringify([
          {
            questionItemId: '["request_user_input_async","call_1"]',
            question: "Did the deploy finish?",
            answer: "Yes, it is live",
          },
        ])}\n</send_user_message_question_reply>`,
      ),
    ).toEqual(["Why is this button grey?", "Yes, it is live"]);
  });
});

describe("MCP calls", () => {
  const items = (item: object) =>
    readCodexRollout({
      content: [
        meta(),
        userMessage(1, "turn-1", "Look it up"),
        completed(2, "turn-1", {
          type: "McpToolCall",
          id: "call-1",
          server: "linear",
          tool: "get_issue",
          arguments: { id: "ENG-1" },
          ...item,
        }),
        taskComplete(3, "turn-1"),
      ].join("\n"),
      now: new Date(at(10)),
    })?.turns[0]?.items;

  it("keeps a failed call's error, as Codex records it", () => {
    expect(
      items({ status: "failed", error: { message: "Issue not found" } })?.[0],
    ).toMatchObject({
      status: "failed",
      item: { error: "Issue not found", result: null },
    });
    expect(
      items({
        status: "failed",
        result: {
          content: [{ type: "text", text: "Rate limited" }],
          isError: true,
        },
      })?.[0],
    ).toMatchObject({
      status: "failed",
      item: { error: "Rate limited", result: null },
    });
  });

  it("leaves an image result's bytes out", () => {
    const [item] =
      items({
        status: "completed",
        result: {
          content: [
            {
              type: "image",
              data: "iVBORw0KGgo".repeat(10_000),
              mimeType: "image/png",
            },
          ],
          isError: false,
          _meta: {
            "codex/toolSurface": {
              screenshot: {
                url: `data:image/png;base64,${"A".repeat(60_000)}`,
              },
            },
          },
        },
      }) ?? [];
    expect(item?.item).toMatchObject({
      result: {
        content: [{ type: "image", mimeType: "image/png" }],
        isError: false,
      },
    });
    expect(JSON.stringify(item).length).toBeLessThan(1_000);
  });
});

describe("turn boundaries", () => {
  it("files a result that arrives after its turn ended under that turn", () => {
    const late = (second: number) =>
      completed(second, "turn-1", {
        type: "CommandExecution",
        id: `exec-late-${second}`,
        command: ["/bin/zsh", "-lc", "bun run dev"],
        status: "completed",
        aggregated_output: "stopped",
        exit_code: 0,
      });
    const transcript = readCodexRollout({
      content: [
        meta(),
        userMessage(1, "turn-1", "Start the server"),
        agentMessage(2, "turn-1", "Started."),
        taskComplete(3, "turn-1"),
        late(5),
        userMessage(10, "turn-2", "Now stop it"),
        late(11),
        agentMessage(12, "turn-2", "Stopped."),
        taskComplete(13, "turn-2"),
      ].join("\n"),
      now: new Date(at(20)),
    });
    expect(transcript?.turns.map((turn) => turn.input?.text)).toEqual([
      "Start the server",
      "Now stop it",
    ]);
    const [first, second] = transcript?.turns ?? [];
    expect(first?.completedAt).toBe(at(3));
    expect(first?.items.map((item) => item.key)).toEqual([
      "msg-turn-1-2",
      "exec-late-5",
      "exec-late-11",
    ]);
    expect(second?.items.map((item) => item.key)).toEqual(["msg-turn-2-12"]);
  });

  it("ends a turn Codex never ended at its own last record, not at the next message", () => {
    const transcript = readCodexRollout({
      content: [
        meta(),
        userMessage(1, "turn-1", "Explain the cache"),
        agentMessage(3, "turn-1", "The cache keeps"),
        userMessage(30, "turn-2", "Go on"),
      ].join("\n"),
      now: new Date(at(40)),
    });
    expect(transcript?.turns[0]?.completedAt).toBe(at(3));
  });
});
