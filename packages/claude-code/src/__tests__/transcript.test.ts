import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { apiRetryLine, ClaudeTranscript } from "../transcript.js";

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
