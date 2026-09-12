import type {
  CodingAgentProvider,
  ProviderSession,
} from "@catamorphic/sandbox";
import { describe, expect, it } from "vitest";
import { classifyAgentError, FriendlyAgentErrors } from "./agent-errors.js";

describe("classifyAgentError", () => {
  it("classifies CLI OAuth session failures as auth", () => {
    // The exact message the Claude Code SDK emits when the local account's
    // access token expired and the refresh failed (laptop slept, or a
    // sibling client rotated the refresh token).
    expect(
      classifyAgentError(
        "Failed to authenticate: OAuth session expired and could not be refreshed",
      ),
    ).toBe("auth");
    expect(classifyAgentError("OAuth token revoked")).toBe("auth");
    expect(
      classifyAgentError("Your session has expired. Please run /login"),
    ).toBe("auth");
  });

  it("keeps the classic provider auth signatures", () => {
    expect(classifyAgentError("401 User not found.")).toBe("auth");
    expect(classifyAgentError("invalid x-api-key")).toBe("auth");
  });

  it("does not classify tool output or interrupts", () => {
    expect(
      classifyAgentError("Tool curl failed: 401 unauthorized from example.com"),
    ).toBeUndefined();
    expect(classifyAgentError("Interrupted.")).toBeUndefined();
  });

  it("leaves ordinary failures unclassified", () => {
    expect(classifyAgentError("The model refused to answer")).toBeUndefined();
  });
});

it("explains native writer ownership without classifying it for automatic retry", async () => {
  const session: ProviderSession = {
    providerSessionId: "native-test-thread",
    sessionId: "test-session",
    projectId: "test-project",
    sandboxId: "local",
    workingDirectory: "/test",
  };
  const original =
    "thread 01a090c8-1302-70e3-8055-5a412ec59c75 already has an active writer";
  const inner: CodingAgentProvider = {
    name: "codex",
    async startSession() {
      return session;
    },
    async *sendMessage() {
      yield { type: "error", content: original };
      yield { type: "error", content: `Tool read failed: ${original}` };
    },
    async dispose() {},
  };
  const events = [];
  for await (const event of new FriendlyAgentErrors(
    inner,
    "Codex",
    "Codex",
  ).sendMessage(session, "Continue"))
    events.push(event);
  expect(events[0]?.content).toContain("Close it there, then retry here");
  expect(events[0]?.content).not.toContain("01a090c8");
  expect(events[0]?.errorKind).toBeUndefined();
  expect(events[1]?.content).toBe(`Tool read failed: ${original}`);
});
