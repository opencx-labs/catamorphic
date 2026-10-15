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

  it("skips subagent threads and Work's own", () => {
    for (const extra of [
      { source: { subagent: { thread_spawn: { parent_thread_id: "x" } } } },
      { originator: CODEX_CLIENT_NAME },
    ])
      expect(
        readCodexRollout({
          content: [meta(extra), ...current.slice(1)].join("\n"),
        }),
      ).toBeUndefined();
  });
});
