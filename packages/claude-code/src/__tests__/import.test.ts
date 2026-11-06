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
  input: { id: string; content: string; error?: boolean; result?: object },
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
    toolUseResult: input.result ?? {
      stdout: input.content,
      stderr: "",
      interrupted: false,
    },
  });

/** A prompt the person typed, as current CLIs mark it. */
const typed = (second: number, text: string, extra = {}) =>
  prompt(second, text, {
    origin: { kind: "human" },
    promptSource: "sdk",
    turnOrigin: "human",
    ...extra,
  });

const answer = (second: number, text: string, extra = {}) =>
  assistant(
    second,
    { id: `msg_${second}`, block: { type: "text", text }, stop: "end_turn" },
    extra,
  );

const turnDuration = (second: number) =>
  JSON.stringify({
    ...common(second),
    type: "system",
    subtype: "turn_duration",
    durationMs: 1000,
  });

/** A background subagent's launch: its call, and the CLI's word that it runs on. */
const backgroundAgent = (second: number, id: string) => [
  assistant(second, {
    id: `msg_${id}`,
    block: {
      type: "tool_use",
      id,
      name: "Agent",
      input: {
        description: "Audit the docs",
        subagent_type: "general-purpose",
        prompt: "Find stale pages.",
        run_in_background: true,
      },
    },
    stop: "tool_use",
  }),
  toolResult(second + 1, {
    id,
    content: "Async agent launched successfully.",
    result: {
      isAsync: true,
      status: "async_launched",
      agentId: "a0c1",
      description: "Audit the docs",
    },
  }),
];

const notification = (input: { id: string; status: string; result: string }) =>
  [
    "<task-notification>",
    "<task-id>a0c1</task-id>",
    `<tool-use-id>${input.id}</tool-use-id>`,
    "<output-file>/tmp/claude/tasks/a0c1.output</output-file>",
    `<status>${input.status}</status>`,
    '<summary>Agent "Audit the docs" finished</summary>',
    `<result>${input.result}</result>`,
    "</task-notification>",
  ].join("\n");

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

describe("what the CLI does by itself", () => {
  it("reads a task's notification as the subagent ending, not as a prompt", () => {
    const launched = [
      typed(0, "Audit the docs"),
      ...backgroundAgent(1, "toolu_bg"),
      answer(3, "An agent is auditing the docs."),
      turnDuration(3),
    ];
    const reader = new ClaudeCodeTranscriptReader();
    for (const line of launched) reader.push(line);
    // The turn is over; its subagent works on.
    const waiting = reader.read({ now: new Date(at(10)) });
    expect(waiting?.turns[0]).toMatchObject({ completedAt: at(3) });
    expect(waiting?.turns[0]?.items[0]).toMatchObject({
      status: "in_progress",
      item: { kind: "subagent", title: "Audit the docs" },
    });
    for (const line of [
      prompt(
        20,
        notification({
          id: "toolu_bg",
          status: "completed",
          result: "Two pages are stale.",
        }),
        {
          origin: { kind: "task-notification" },
          promptSource: "system",
          turnOrigin: "task_notification",
        },
      ),
      answer(21, "The agent found two stale pages."),
    ])
      reader.push(line);
    const done = reader.read({ now: new Date(at(30)) });
    expect(done?.turns).toHaveLength(1);
    const [turn] = done?.turns ?? [];
    expect(turn).toMatchObject({
      input: { text: "Audit the docs" },
      completedAt: at(21),
    });
    expect(turn?.items.map((item) => [item.item.kind, item.status])).toEqual([
      ["subagent", "completed"],
      ["assistant_message", "completed"],
      ["assistant_message", "completed"],
    ]);
    expect(turn?.items[0]?.item).toMatchObject({
      result: "Two pages are stale.",
    });
  });

  it("ends a subagent in the turn that started it, and reads a monitor's event as no prompt", () => {
    const transcript = readClaudeCodeTranscript({
      content: [
        typed(0, "Audit the docs"),
        ...backgroundAgent(1, "toolu_bg"),
        answer(3, "An agent is on it."),
        typed(10, "Meanwhile, fix the typo"),
        answer(11, "Fixed."),
        // Delivered while Claude worked: only an attachment says so.
        JSON.stringify({
          ...common(30),
          type: "attachment",
          attachment: {
            type: "queued_command",
            prompt: notification({
              id: "toolu_bg",
              status: "failed",
              result: "The docs folder is missing.",
            }),
            commandMode: "task-notification",
            origin: { kind: "task-notification" },
            timestamp: at(30),
          },
        }),
        prompt(
          40,
          '<ci-monitor-event source="github">Checks passed</ci-monitor-event>',
          { promptSource: "sdk", turnOrigin: "sdk" },
        ),
        answer(41, "CI passed."),
      ].join("\n"),
      now: new Date(at(50)),
    });
    expect(transcript?.turns.map((turn) => turn.input?.text)).toEqual([
      "Audit the docs",
      "Meanwhile, fix the typo",
    ]);
    const [first, second] = transcript?.turns ?? [];
    expect(first?.completedAt).toBe(at(3));
    expect(first?.items[0]).toMatchObject({
      status: "failed",
      item: { kind: "subagent", result: "The docs folder is missing." },
    });
    expect(second?.completedAt).toBe(at(41));
    expect(second?.items.map((item) => item.item)).toMatchObject([
      { text: "Fixed." },
      { text: "CI passed." },
    ]);
  });

  it("reads a subagent that never reported as stopped once the transcript is quiet", () => {
    const transcript = readClaudeCodeTranscript({
      content: [
        typed(0, "Audit the docs"),
        ...backgroundAgent(1, "toolu_bg"),
        answer(3, "An agent is on it."),
        typed(10, "Thanks"),
        answer(11, "You're welcome."),
      ].join("\n"),
      now: new Date(at(11 + 11 * 60)),
    });
    expect(transcript?.turns[0]?.items[0]?.status).toBe("cancelled");
  });

  it("starts a turn without a prompt when the CLI goes back to work after an interrupt", () => {
    const transcript = readClaudeCodeTranscript({
      content: [
        typed(0, "Audit the docs"),
        ...backgroundAgent(1, "toolu_bg"),
        prompt(3, [
          { type: "text", text: "[Request interrupted by user for tool use]" },
        ]),
        prompt(
          20,
          notification({
            id: "toolu_bg",
            status: "completed",
            result: "Done.",
          }),
          { origin: { kind: "task-notification" }, promptSource: "system" },
        ),
        answer(21, "The audit finished after all."),
      ].join("\n"),
      now: new Date(at(30)),
    });
    expect(
      transcript?.turns.map((turn) => [turn.input?.text ?? null, turn.status]),
    ).toEqual([
      ["Audit the docs", "interrupted"],
      [null, "completed"],
    ]);
    expect(transcript?.turns[0]?.items[0]?.status).toBe("completed");
  });
});

describe("messages typed while Claude worked", () => {
  const lines = [
    typed(0, "Run the tests"),
    assistant(1, {
      id: "msg_t",
      block: {
        type: "tool_use",
        id: "toolu_t",
        name: "Bash",
        input: { command: "bun test" },
      },
      stop: "tool_use",
    }),
    JSON.stringify({
      ...common(2),
      uuid: "00000000-0000-4000-8000-0000000000aa",
      type: "attachment",
      attachment: {
        type: "queued_command",
        prompt: "Also check lint",
        source_uuid: "00000000-0000-4000-8000-0000000000ab",
        commandMode: "prompt",
        origin: { kind: "human" },
        humanTurn: true,
        timestamp: at(2),
      },
    }),
    toolResult(3, { id: "toolu_t", content: "12 pass" }),
    answer(4, "Tests pass; lint is clean too."),
  ];

  it("reads a queued message as the person's, its call's result in the turn that made it", () => {
    const transcript = readClaudeCodeTranscript({
      content: lines.join("\n"),
      now: new Date(at(10)),
    });
    expect(transcript?.turns.map((turn) => turn.input)).toEqual([
      expect.objectContaining({ text: "Run the tests" }),
      {
        key: "00000000-0000-4000-8000-0000000000aa",
        text: "Also check lint",
        at: at(2),
      },
    ]);
    const [first, second] = transcript?.turns ?? [];
    expect(first?.completedAt).toBe(at(1));
    expect(first?.items[0]).toMatchObject({
      status: "completed",
      item: { kind: "command", output: "12 pass" },
    });
    expect(second?.key).toBe("00000000-0000-4000-8000-0000000000aa");
    expect(second?.items.map((item) => item.item.kind)).toEqual([
      "assistant_message",
    ]);
  });

  it("keeps the same turns read line by line", () => {
    const reader = new ClaudeCodeTranscriptReader();
    const now = new Date(at(10));
    const keys: string[][] = [];
    for (const line of lines) {
      reader.push(line);
      keys.push(reader.read({ now })?.turns.map((turn) => turn.key) ?? []);
    }
    expect(keys.at(-1)).toEqual(keys[2]);
    expect(reader.read({ now })).toEqual(
      readClaudeCodeTranscript({ content: lines.join("\n"), now }),
    );
  });
});

describe("a forked chat", () => {
  const ORIGINAL = "5f0bf137-809c-4c95-85ab-121e10cfb0ab";
  // A fork's file starts with its original's records, ids and all.
  const copied = [
    typed(0, "Plan the release", { sessionId: ORIGINAL }),
    answer(1, "Here is a plan.", { sessionId: ORIGINAL }),
  ];
  const own = [
    JSON.stringify({
      type: "custom-title",
      customTitle: "Release, take two",
      sessionId: SESSION,
    }),
    typed(60, "Try a smaller release"),
    answer(61, "A smaller plan."),
  ];

  it("is its own session, started at its own first record", () => {
    for (const sessionId of [SESSION, undefined]) {
      const transcript = readClaudeCodeTranscript({
        content: [...copied, ...own].join("\n"),
        now: new Date(at(70)),
        ...(sessionId ? { sessionId } : {}),
      });
      expect(transcript).toMatchObject({
        nativeSessionId: SESSION,
        startedAt: at(60),
        title: "Release, take two",
      });
      expect(transcript?.turns.map((turn) => turn.input?.text)).toEqual([
        "Plan the release",
        "Try a smaller release",
      ]);
    }
  });

  it("reads as nothing before its own first record, told its id", () => {
    const reader = new ClaudeCodeTranscriptReader({ sessionId: SESSION });
    for (const line of copied) reader.push(line);
    expect(reader.read({ now: new Date(at(70)) })).toBeUndefined();
  });
});

describe("a turn without an end record", () => {
  it("ends at its own last record, not at the next prompt", () => {
    const transcript = readClaudeCodeTranscript({
      content: [
        typed(0, "Explain the cache"),
        assistant(1, {
          id: "msg_cut",
          block: { type: "text", text: "The cache keeps" },
        }),
        typed(30, "Go on"),
      ].join("\n"),
      now: new Date(at(40)),
    });
    expect(transcript?.turns[0]?.completedAt).toBe(at(1));
  });
});
