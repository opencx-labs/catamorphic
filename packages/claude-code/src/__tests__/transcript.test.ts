import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { policedServer } from "../adapter.js";
import {
  apiRetryLine,
  ClaudeTranscript,
  lastSentence,
  parseMcpToolName,
} from "../transcript.js";

const retry = (
  attempt: number,
  error: "overloaded" | "rate_limit" | "server_error" | "unknown",
  errorStatus: number | null,
): SDKMessage => ({
  type: "system",
  subtype: "api_retry",
  attempt,
  max_retries: 10,
  retry_delay_ms: 1_000,
  error_status: errorStatus,
  error,
  uuid: `00000000-0000-4000-8000-00000000000${attempt}`,
  session_id: "session",
});

describe("API retries", () => {
  // The CLI backs off for minutes (ten attempts against a failing API);
  // a turn that only said "Working" looked hung.
  it("say so on the activity line, attempt by attempt", () => {
    const events: HarnessEvent[] = [];
    const transcript = new ClaudeTranscript(
      (event) => events.push(event),
      new Set(),
      [],
    );
    transcript.handle(retry(1, "server_error", 500));
    transcript.handle(retry(2, "server_error", 500));
    expect(events.filter((event) => event.type === "status")).toEqual([
      {
        type: "status",
        text: "The Claude API returned an error (500). Trying again, attempt 1 of 10",
      },
      {
        type: "status",
        text: "The Claude API returned an error (500). Trying again, attempt 2 of 10",
      },
    ]);
    // The diagnostic stays for logs.
    expect(events.some((event) => event.type === "diagnostic")).toBe(true);
  });

  it("come down once the API answers", () => {
    const events: HarnessEvent[] = [];
    const transcript = new ClaudeTranscript(
      (event) => events.push(event),
      new Set(),
      [],
    );
    transcript.handle(retry(1, "overloaded", 529));
    transcript.handle({
      type: "stream_event",
      event: {
        type: "message_start",
        message: {
          id: "message-1",
          type: "message",
          role: "assistant",
          model: "claude",
          content: [],
          container: null,
          context_management: null,
          diagnostics: null,
          stop_details: null,
          stop_reason: null,
          stop_sequence: null,
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: null,
            cache_read_input_tokens: null,
            fallback_credit: null,
            inference_geo: null,
            input_tokens: 1,
            iterations: null,
            output_tokens: 0,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: null,
            speed: null,
          },
        },
      },
      parent_tool_use_id: null,
      uuid: "00000000-0000-4000-8000-000000000009",
      session_id: "session",
    });
    expect(events.filter((event) => event.type === "status").at(-1)).toEqual({
      type: "status",
      text: "Working",
    });
  });

  it("names the problem in plain words", () => {
    const line = (
      error: "overloaded" | "rate_limit" | "unknown",
      status: number | null,
    ) =>
      apiRetryLine({
        attempt: 3,
        max_retries: 10,
        error,
        error_status: status,
      });
    expect(line("overloaded", 529)).toBe(
      "The Claude API is overloaded. Trying again, attempt 3 of 10",
    );
    expect(line("rate_limit", 429)).toBe(
      "The Claude API rate limit was reached. Trying again, attempt 3 of 10",
    );
    expect(line("unknown", null)).toBe(
      "Can't reach the Claude API. Trying again, attempt 3 of 10",
    );
  });
});

describe("MCP tool names", () => {
  it("name the longest configured server, `__` in its name too", () => {
    const servers = ["fix", "fix__ture"];
    expect(parseMcpToolName("mcp__fix__ture__lookup", servers)).toEqual({
      server: "fix__ture",
      tool: "lookup",
    });
    expect(parseMcpToolName("mcp__fix__lookup", servers)).toEqual({
      server: "fix",
      tool: "lookup",
    });
  });

  it("split an unknown server's name at the first separator", () => {
    expect(parseMcpToolName("mcp__other__a__b", ["fix"])).toEqual({
      server: "other",
      tool: "a__b",
    });
    expect(parseMcpToolName("Bash", ["fix"])).toBeUndefined();
  });
});

describe("policed servers", () => {
  it("are the longest configured name, and never a prototype key", () => {
    const policies = { fix__ture: [{ default: "ask" as const }] };
    expect(policedServer("mcp__fix__ture__lookup", policies)).toEqual({
      server: "fix__ture",
      tool: "lookup",
    });
    expect(policedServer("mcp__fix__lookup", policies)).toBeUndefined();
    for (const name of ["toString", "constructor", "valueOf", "__proto__"])
      expect(policedServer(`mcp__${name}__x`, policies), name).toBeUndefined();
  });
});

type Block = Extract<
  SDKMessage,
  { type: "assistant" }
>["message"]["content"][number];

/** One main-thread response from the API, as the SDK reports it whole. */
const response = (id: string, content: Block[]): SDKMessage => ({
  type: "assistant",
  message: {
    id,
    type: "message",
    role: "assistant",
    model: "claude",
    content,
    container: null,
    context_management: null,
    diagnostics: null,
    stop_details: null,
    stop_reason: "tool_use",
    stop_sequence: null,
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      fallback_credit: null,
      inference_geo: null,
      input_tokens: 1,
      iterations: null,
      output_tokens: 1,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
      speed: null,
    },
  },
  parent_tool_use_id: null,
  uuid: `00000000-0000-4000-8000-0000000000${id.slice(-2)}`,
  session_id: "session",
});
const thinking = (text: string): Block => ({
  type: "thinking",
  thinking: text,
  signature: "signature",
});
const bash = (id: string, description: string): Block => ({
  type: "tool_use",
  id,
  name: "Bash",
  input: { command: "rg -n vad src", description },
});

describe("the agent's own words", () => {
  // Claude's summarized thinking is plain prose that ends on what it does
  // next; its own UI shows none of it, so the live line said "Thinking..."
  // and generic verbs while the agent had said what it was doing.
  it("come from its thinking and hold through the steps of that response", () => {
    const events: HarnessEvent[] = [];
    const transcript = new ClaudeTranscript(
      (event) => events.push(event),
      new Set(),
      [],
    );
    transcript.handle(
      response("message-01", [
        thinking(
          "Found it: the caller did say yes. Now checking the end-of-call workflows.",
        ),
        bash("tool-1", "Read the VAD options"),
        bash("tool-2", "Show the workflows"),
      ]),
    );
    transcript.handle(
      response("message-02", [
        thinking("**Reading the parser**\n\nIt walks the AST."),
        bash("tool-3", "Show the parser"),
        {
          type: "tool_use",
          id: "tool-4",
          name: "Task",
          input: { description: "Explore the parser", prompt: "Look around" },
        },
      ]),
    );
    // Thinking that says nothing, or none at all, hands the line back to
    // the steps.
    transcript.handle(
      response("message-03", [thinking(""), bash("tool-5", "Run the tests")]),
    );
    transcript.handle(
      response("message-04", [bash("tool-6", "Run them again")]),
    );
    expect(events.filter((event) => event.type === "status")).toEqual([
      { type: "status", text: "Now checking the end-of-call workflows." },
      { type: "status", text: "Reading the parser" },
    ]);
    const steps = events.flatMap((event) =>
      event.type === "item.started" &&
      (event.item.kind === "command" || event.item.kind === "subagent")
        ? [[event.key, event.activity]]
        : [],
    );
    expect(steps).toEqual([
      ["tool-1", "Now checking the end-of-call workflows."],
      ["tool-2", "Now checking the end-of-call workflows."],
      ["tool-3", "Reading the parser"],
      // A subagent says what it was delegated.
      ["tool-4", undefined],
      ["tool-5", undefined],
      ["tool-6", undefined],
    ]);
  });

  it("are the last sentence of the last paragraph, as plain text", () => {
    expect(
      lastSentence(
        'Noted the **Ñ** guidance. The bot asked "¿Puede repetirlo?", then spoke over 9.2% of callers.\n\nNow I\'ll check `end_of_call.ts` and src/**/*.ts.',
      ),
    ).toBe("Now I'll check end_of_call.ts and src/**/*.ts.");
    expect(lastSentence("解析器を読んだ。次にテストを実行する。")).toBe(
      "次にテストを実行する。",
    );
    expect(lastSentence("e.g. the parser. it fails")).toBe(
      "e.g. the parser. it fails",
    );
    // A closing list or code block is not a sentence.
    expect(
      lastSentence("Let me check:\n\n- the parser\n- the walker"),
    ).toBeUndefined();
    expect(lastSentence("Here:\n\n```ts\nconst a = 1;\n```")).toBeUndefined();
    expect(lastSentence("  \n ")).toBeUndefined();
  });
});
