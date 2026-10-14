import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { policedServer } from "../adapter.js";
import {
  apiRetryLine,
  ClaudeTranscript,
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
