import { describe, expect, it } from "vitest";
import {
  ClaudeCodeTranscriptReader,
  readClaudeCodeTranscript,
} from "../import.js";

/*
 * Claude Code transcripts (`~/.claude/projects/<cwd>/<id>.jsonl`) as
 * imported sessions (ADR 0233). Records are shaped like the CLI's own:
 * one line per content block, tool results as user lines.
 */

const SESSION = "2ebf8a23-ac48-4e8a-81c8-ec5437df893a";
const CWD = "/work/web";
let counter = 0;
const uuid = () =>
  `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const at = (second: number) =>
  new Date(Date.UTC(2026, 9, 15, 12, 0, second)).toISOString();

const common = (second: number) => ({
  isSidechain: false,
  sessionId: SESSION,
  cwd: CWD,
  entrypoint: "cli",
  timestamp: at(second),
  uuid: uuid(),
});

const prompt = (second: number, content: unknown, extra = {}) =>
  JSON.stringify({
    ...common(second),
    type: "user",
    message: { role: "user", content },
    ...extra,
  });

const assistant = (
  second: number,
  input: { id: string; block: object; stop?: string | null },
  extra = {},
) =>
  JSON.stringify({
    ...common(second),
    type: "assistant",
    message: {
      model: "claude-opus-5-5",
      id: input.id,
      type: "message",
      role: "assistant",
      content: [input.block],
      stop_reason: input.stop ?? null,
      usage: { input_tokens: 2, output_tokens: 10 },
    },
    ...extra,
  });

const toolResult = (
  second: number,
  input: { id: string; content: string; error?: boolean },
) =>
  JSON.stringify({
    ...common(second),
    type: "user",
    message: {
      role: "user",
      content: [
        {
          tool_use_id: input.id,
          type: "tool_result",
          content: input.content,
          is_error: input.error ?? false,
        },
      ],
    },
    toolUseResult: { stdout: input.content, stderr: "", interrupted: false },
  });

const session = [
  JSON.stringify({ type: "queue-operation", operation: "enqueue" }),
  prompt(0, "Why does the build fail?"),
  prompt(0, "<local-command-caveat>Caveat</local-command-caveat>", {
    isMeta: true,
  }),
  assistant(1, {
    id: "msg_1",
    block: { type: "thinking", thinking: "", signature: "abc" },
  }),
  assistant(2, {
    id: "msg_1",
    block: {
      type: "tool_use",
      id: "toolu_1",
      name: "Bash",
      input: { command: "bun run build", description: "Build" },
    },
    stop: "tool_use",
  }),
  toolResult(3, { id: "toolu_1", content: "error TS2345", error: true }),
  // A subagent's own lines live in their side chain.
  assistant(
    3,
    { id: "msg_side", block: { type: "text", text: "Side chain words" } },
    { isSidechain: true },
  ),
  assistant(4, {
    id: "msg_2",
    block: { type: "text", text: "A type error in schemas.ts." },
    stop: "end_turn",
  }),
  JSON.stringify({
    type: "ai-title",
    aiTitle: "Build failure",
    sessionId: SESSION,
  }),
  prompt(10, [
    {
      type: "text",
      text: "<system-reminder>You are in a worktree.</system-reminder>",
    },
    { type: "text", text: "Fix it" },
  ]),
  assistant(11, {
    id: "msg_3",
    block: {
      type: "tool_use",
      id: "toolu_2",
      name: "Edit",
      input: {
        file_path: "/work/web/schemas.ts",
        old_string: "a",
        new_string: "b",
      },
    },
  }),
  prompt(12, [
    { type: "text", text: "[Request interrupted by user for tool use]" },
  ]),
  prompt(
    20,
    "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>main</command-args>",
  ),
  assistant(21, {
    id: "msg_4",
    block: {
      type: "tool_use",
      id: "toolu_3",
      name: "Bash",
      input: { command: "git diff main" },
    },
  }),
];

describe("readClaudeCodeTranscript", () => {
  it("reads prompts as turns and the CLI's blocks as Work's items", () => {
    const transcript = readClaudeCodeTranscript({
      content: session.join("\n"),
      now: new Date(at(30)),
    });
    expect(transcript).toMatchObject({
      harness: "claude-code",
      nativeSessionId: SESSION,
      cwd: CWD,
      title: "Build failure",
      model: "claude-opus-5-5",
      startedAt: at(0),
    });
    const turns = transcript?.turns ?? [];
    expect(turns.map((turn) => turn.input?.text)).toEqual([
      "Why does the build fail?",
      "Fix it",
      "/review main",
    ]);
    expect(turns.map((turn) => turn.status)).toEqual([
      "completed",
      "interrupted",
      "completed",
    ]);
    const [first, second, third] = turns;
    expect(first?.completedAt).toBe(at(4));
    expect(first?.items.map((item) => [item.item.kind, item.status])).toEqual([
      ["command", "failed"],
      ["assistant_message", "completed"],
    ]);
    expect(first?.items[0]?.item).toMatchObject({
      kind: "command",
      command: "bun run build",
      output: "error TS2345",
    });
    // Keys are stable and unique across the transcript.
    expect(first?.items[0]?.key).toBe(`${first?.key}/toolu_1`);
    expect(second?.items.map((item) => [item.item.kind, item.status])).toEqual([
      ["file_change", "cancelled"],
    ]);
    // The CLI may still be running the last command: it stays open.
    expect(third?.completedAt).toBeNull();
    expect(third?.items.map((item) => item.status)).toEqual(["in_progress"]);
  });

  it("ends a last turn that has been quiet a while, without closing it for good", () => {
    const reader = new ClaudeCodeTranscriptReader();
    for (const line of session) reader.push(line);
    const quiet = reader.read({ now: new Date(at(21 + 11 * 60)) });
    expect(quiet?.turns.at(-1)?.completedAt).toBe(at(21));
    expect(quiet?.turns.at(-1)?.items.map((item) => item.status)).toEqual([
      "cancelled",
    ]);
    // The long command's result still lands.
    reader.push(toolResult(700, { id: "toolu_3", content: "diff --git" }));
    const later = reader.read({ now: new Date(at(701)) });
    expect(later?.turns.at(-1)?.items[0]).toMatchObject({
      status: "completed",
      item: { output: "diff --git" },
    });
  });

  it("reads the same whether lines arrive at once or one by one", () => {
    const reader = new ClaudeCodeTranscriptReader();
    for (const line of session) reader.push(line);
    const now = new Date(at(30));
    expect(reader.read({ now })).toEqual(
      readClaudeCodeTranscript({ content: session.join("\n"), now }),
    );
  });

  it("prefers the person's own title, and skips a file nobody asked anything in", () => {
    const titled = readClaudeCodeTranscript({
      content: [
        ...session,
        JSON.stringify({
          type: "custom-title",
          customTitle: "My build",
          sessionId: SESSION,
        }),
      ].join("\n"),
    });
    expect(titled?.title).toBe("My build");
    expect(
      readClaudeCodeTranscript({
        content: [session[0], session[2], "{not json"].join("\n"),
      }),
    ).toBeUndefined();
  });

  it("marks a turn the API failed as failed", () => {
    const transcript = readClaudeCodeTranscript({
      content: [
        prompt(0, "Hello"),
        assistant(
          1,
          {
            id: "msg_err",
            block: { type: "text", text: "API Error: 529 Overloaded" },
          },
          { isApiErrorMessage: true },
        ),
      ].join("\n"),
    });
    expect(transcript?.turns[0]).toMatchObject({
      status: "failed",
      error: "API Error: 529 Overloaded",
    });
  });
});
